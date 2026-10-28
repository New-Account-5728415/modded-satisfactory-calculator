/*Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.*/
import { spec } from "./factory.js"
import { renderIngredient } from "./recipe.js"

// The recipe selection tab: recipes grouped by the item they make (their
// first product), items grouped by tier, with search, filters and bulk
// actions. Turning a recipe on or off works exactly as before
// (spec.setEnable / spec.setDisable).

const STORE_KEY = "calc.recipeTab"

// Search text carried over when the tab is redrawn (e.g. on regrouping).
let carriedSearch = ""

// Per-viewer conveniences (collapsed tiers, filter choices). Browser storage
// can be unavailable, so every access is guarded and the tab works without it.
function loadState() {
    try {
        return JSON.parse(window.localStorage.getItem(STORE_KEY)) || {}
    } catch (e) {
        return {}
    }
}

function saveState(state) {
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(state))
    } catch (e) {
        // ignore
    }
}

function isAlternate(recipe) {
    return recipe.name.startsWith("Alternate:")
}

function shortName(recipe) {
    return recipe.name.replace(/^Alternate:\s*/, "")
}

// Tiers come from each item's "tier" in data.json; -1 holds the starting items.
function tierLabel(tier) {
    return tier < 0 ? "Starting items" : `Tier ${tier}`
}

function metaText(recipe) {
    if (recipe.isResource()) {
        return "Extracted"
    }
    let parts = []
    let buildings = recipe.category === null ? null : spec.buildings.get(recipe.category)
    if (buildings && buildings.length > 0) {
        parts.push(buildings[0].name)
    }
    if (recipe.time && !recipe.time.isZero()) {
        let t = recipe.time.toFloat()
        parts.push(`${Number.isInteger(t) ? t : t.toFixed(2)} s`)
    }
    return parts.join(" · ")
}

// Generators aren't recipes in data.json, so the tier each one makes its
// fuel useful in is listed here (from the game's data: Biomass Burner in
// the HUB upgrades, Coal-Powered Generator at Tier 3, Fuel-Powered
// Generator at Tier 5, Nuclear Power Plant at Tier 8).
const GENERATOR_TIERS = [
    [-1, ["leaves", "wood", "mycelia", "biomass", "solid-biofuel", "packaged-liquid-biofuel"]],
    [3, ["coal", "compacted-coal", "petroleum-coke", "water"]],
    [5, ["fuel", "turbofuel", "liquid-biofuel", "rocket-fuel", "ionized-fuel"]],
    [8, ["uranium-fuel-rod", "plutonium-fuel-rod", "ficsonium-fuel-rod"]],
]

function buildingTier(recipe) {
    if (recipe.isResource() || recipe.category === null) {
        return null
    }
    let buildings = spec.buildings.get(recipe.category)
    if (!buildings || buildings.length === 0 || buildings[0].tier === undefined) {
        return null
    }
    return buildings[0].tier
}

// Latest of the recipe's building tier and the given tiers of its items.
function latestTier(recipe, itemTier) {
    let tier = -Infinity
    for (let ing of recipe.ingredients.concat(recipe.products)) {
        tier = Math.max(tier, itemTier(ing.item))
    }
    let b = buildingTier(recipe)
    if (b !== null) {
        tier = Math.max(tier, b)
    }
    return tier === -Infinity ? 0 : tier
}

// When each raw resource (anything that is mined or extracted) becomes
// useful: the earliest tier of any recipe that uses it, or of a generator
// that burns it. Bauxite is listed at Tier 0 in data.json, but nothing can
// use it before the Refinery's Alumina Solution at Tier 7, so it counts as
// Tier 7. A resource is never moved earlier than its own tier. Other items
// keep their own tier, since many are also building materials (Concrete is
// needed for foundations long before any recipe uses it).
function usefulTiers() {
    let useful = new Map()
    let generatorTier = new Map()
    for (let [tier, keys] of GENERATOR_TIERS) {
        for (let key of keys) {
            let item = spec.items.get(key)
            if (item && !generatorTier.has(item)) {
                generatorTier.set(item, tier)
            }
        }
    }
    let ownTier = item => item.tier
    for (let item of spec.items.values()) {
        if (!item.recipes.some(r => r.isResource())) {
            continue
        }
        let earliest = generatorTier.has(item) ? generatorTier.get(item) : Infinity
        for (let recipe of item.uses) {
            earliest = Math.min(earliest, latestTier(recipe, ownTier))
        }
        if (earliest !== Infinity && earliest > item.tier) {
            useful.set(item, earliest)
        }
    }
    return useful
}

// The tier a recipe becomes usable in: the latest tier among its building
// (each building's "tier" in data.json) and every item it uses or makes
// (each item's "tier", or for raw resources the tier they become useful).
// So a Converter recipe lands in the Converter's tier, an alternate made in
// a Refinery is never earlier than the Refinery, and mining Bauxite sits
// with the Alumina Solution recipe.
function recipeTier(recipe, useful) {
    return latestTier(recipe, item => useful.has(item) ? useful.get(item) : item.tier)
}

// Groups of recipes keyed by tier and the item they mainly make, sorted by
// tier and name. groupBy "recipe" places each recipe by its own tier (so an
// item can show up in more than one tier); "item" places every recipe under
// its item's tier.
function getProductGroups(groupBy) {
    let groups = new Map()
    let perItem = new Map()
    let useful = usefulTiers()
    for (let recipe of spec.recipes.values()) {
        if (recipe.products.length === 0) {
            continue
        }
        let item = recipe.products[0].item
        perItem.set(item, (perItem.get(item) || 0) + 1)
        let tier = groupBy === "item" ? item.tier : recipeTier(recipe, useful)
        let key = tier + "|" + item.key
        let group = groups.get(key)
        if (group === undefined) {
            group = {item, tier, recipes: []}
            groups.set(key, group)
        }
        group.recipes.push(recipe)
    }
    let result = Array.from(groups.values())
    for (let group of result) {
        // standard recipes first, then alternates, each alphabetically
        group.recipes.sort((a, b) => (isAlternate(a) - isAlternate(b)) || a.name.localeCompare(b.name))
        group.itemRecipeCount = perItem.get(group.item)
    }
    result.sort((a, b) => (a.tier - b.tier) || (a.item.tier - b.item.tier) || a.item.name.localeCompare(b.item.name))
    return result
}

function searchText(group, recipe) {
    let names = [recipe.name, group.item.name]
    for (let ing of recipe.ingredients.concat(recipe.products)) {
        names.push(ing.item.name)
    }
    return names.join("\n").toLowerCase()
}

export function renderRecipeTab() {
    let state = loadState()
    state.collapsed = state.collapsed || {}
    let filter = state.filter || "all"
    let showSingles = !!state.singles
    let groupBy = state.groupBy === "item" ? "item" : "recipe"

    let allGroups = getProductGroups(groupBy)

    // ---------------------------------------------------------------- controls
    let controls = d3.select("#recipe_controls")
    controls.selectAll("*").remove()
    let search = controls.append("input")
        .attr("type", "search")
        .attr("id", "recipe_search")
        .attr("placeholder", "Search recipes or items…")
        .attr("autocomplete", "off")
        .property("value", carriedSearch)
    carriedSearch = ""
    let filterSelect = controls.append("select")
        .attr("id", "recipe_filter")
        .attr("title", "Which recipes to show")
    filterSelect.selectAll("option")
        .data([["all", "All recipes"], ["alt", "Alternates only"], ["on", "Turned on"], ["off", "Turned off"]])
        .join("option")
            .attr("value", d => d[0])
            .property("selected", d => d[0] === filter)
            .text(d => d[1])
    let groupSelect = controls.append("select")
        .attr("id", "recipe_groupby")
        .attr("title", "How recipes are sorted into tiers")
    groupSelect.selectAll("option")
        .data([["recipe", "Tier: when the recipe is usable"], ["item", "Tier: of the item made"]])
        .join("option")
            .attr("value", d => d[0])
            .property("selected", d => d[0] === groupBy)
            .text(d => d[1])
    let singlesLabel = controls.append("label")
        .classed("recipe-singles", true)
    let singles = singlesLabel.append("input")
        .attr("type", "checkbox")
        .property("checked", showSingles)
    singlesLabel.append("span").text(" Include items with only one recipe")

    let buttons = controls.append("span").classed("recipe-buttons", true)
    let button = (text, title, handler) => buttons.append("button")
        .attr("type", "button")
        .attr("title", title)
        .text(text)
        .on("click", handler)
    button("Expand all", "Open every tier", () => setAllOpen(true))
    button("Collapse all", "Close every tier", () => setAllOpen(false))
    button("Turn on shown", "Turn on every recipe currently shown", () => bulk(true))
    button("Turn off shown", "Turn off every recipe currently shown", () => bulk(false))
    button("Reset to defaults", "Go back to the default recipe selection", reset)
    let status = controls.append("span").classed("recipe-status", true)

    // ---------------------------------------------------------------- tiers, items, recipe cards
    let root = d3.select("#recipe_toggles")
    root.selectAll("*").remove()

    let tiers = new Map()
    for (let group of allGroups) {
        let tier = tiers.get(group.tier)
        if (tier === undefined) {
            tier = []
            tiers.set(group.tier, tier)
        }
        tier.push(group)
    }

    let tierSel = root.selectAll("details")
        .data(Array.from(tiers.entries()))
        .join("details")
            .classed("recipe-tier", true)
            .property("open", d => !state.collapsed[d[0]])
            .on("toggle", function(event, d) {
                // Only remember open/closed when the person did it, not while searching.
                if (search.property("value").trim() !== "") {
                    return
                }
                state.collapsed[d[0]] = !this.open
                saveState(state)
            })
    let summary = tierSel.append("summary")
    summary.append("span").classed("tier-name", true).text(d => tierLabel(d[0]))
    summary.append("span").classed("tier-count", true)
    // Whole-tier switches. They act on every recipe in the tier, including
    // any the search or filters are hiding.
    let tierActions = summary.append("span").classed("tier-actions", true)
    for (let [text, title, baseOnly, enable] of [
        ["Base on", "Turn on every standard (non-alternate) recipe in this tier", true, true],
        ["Base off", "Turn off every standard (non-alternate) recipe in this tier", true, false],
        ["All on", "Turn on every recipe in this tier, standard and alternate", false, true],
        ["All off", "Turn off every recipe in this tier, standard and alternate", false, false],
    ]) {
        tierActions.append("button")
            .attr("type", "button")
            .attr("title", title)
            .text(text)
            .on("click", function(event, d) {
                // Don't let the click open or close the tier.
                event.preventDefault()
                event.stopPropagation()
                setTier(d, baseOnly, enable)
            })
    }

    let groupSel = tierSel.selectAll("div.recipe-item")
        .data(d => d[1])
        .join("div")
            .classed("recipe-item", true)
    let head = groupSel.append("div").classed("recipe-item-head", true)
    head.append(d => d.item.icon.make(32))
    head.append("span").classed("recipe-item-name", true).text(d => d.item.name)
    head.append("span").classed("recipe-item-count", true)

    let cards = groupSel.append("div")
        .classed("recipe-cards", true)
        .selectAll("div.recipe-card")
        .data(group => group.recipes.map(recipe => ({group, recipe, text: searchText(group, recipe)})))
        .join("div")
            .classed("toggle recipe recipe-card", true)
            .classed("alternate", d => isAlternate(d.recipe))
            .classed("selected", d => !spec.disable.has(d.recipe))
            .attr("title", d => d.recipe.name)
            .on("click", function(event, d) {
                if (spec.disable.has(d.recipe)) {
                    spec.setEnable(d.recipe)
                } else {
                    spec.setDisable(d.recipe)
                }
                refreshSelection()
                if (filter === "on" || filter === "off") {
                    applyFilter()
                }
                spec.updateSolution()
            })
    let title = cards.append("div").classed("card-title", true)
    title.append("span").classed("card-name", true).text(d => shortName(d.recipe))
    title.filter(d => isAlternate(d.recipe)).append("span").classed("badge", true).text("ALT")
    let io = cards.append("div").classed("card-io", true)
    let ins = io.append("span").classed("card-ingredients", true)
        .selectAll("span")
        .data(d => d.recipe.ingredients)
        .join("span")
    renderIngredient(ins)
    io.append("span").classed("card-arrow", true).text("→")
    let outs = io.append("span").classed("card-products", true)
        .selectAll("span")
        .data(d => d.recipe.products)
        .join("span")
    renderIngredient(outs)
    cards.append("div").classed("card-meta", true).text(d => metaText(d.recipe))

    // ---------------------------------------------------------------- behaviour
    function refreshSelection() {
        cards.classed("selected", d => !spec.disable.has(d.recipe))
        updateCounts()
    }

    function updateCounts() {
        groupSel.select(".recipe-item-count").text(g => {
            let on = g.recipes.filter(r => !spec.disable.has(r)).length
            return `${on}/${g.recipes.length} on`
        })
        tierSel.select(".tier-count").text(d => {
            let total = 0, on = 0
            for (let g of d[1]) {
                for (let r of g.recipes) {
                    total++
                    if (!spec.disable.has(r)) on++
                }
            }
            return `${on}/${total} on`
        })
    }

    function cardVisible(d, q) {
        if (q !== "" && !d.text.includes(q)) {
            return false
        }
        let on = !spec.disable.has(d.recipe)
        switch (filter) {
            case "alt": return isAlternate(d.recipe)
            case "on": return on
            case "off": return !on
        }
        return true
    }

    function applyFilter() {
        let q = search.property("value").trim().toLowerCase()
        let shown = 0
        cards.style("display", function(d) {
            let groupAllowed = showSingles || d.group.itemRecipeCount > 1
            let v = groupAllowed && cardVisible(d, q)
            d.visible = v
            if (v) shown++
            return v ? null : "none"
        })
        groupSel.style("display", g => cards.filter(d => d.group === g && d.visible).empty() ? "none" : null)
        tierSel.style("display", function(t) {
            let any = !cards.filter(d => d.visible && d.group.tier === t[0]).empty()
            return any ? null : "none"
        })
        if (q !== "") {
            tierSel.property("open", true)
        } else {
            tierSel.property("open", t => !state.collapsed[t[0]])
        }
        status.text(`${shown} recipe${shown === 1 ? "" : "s"} shown`)
    }

    function setAllOpen(open) {
        tierSel.property("open", open)
        tierSel.each(t => { state.collapsed[t[0]] = !open })
        saveState(state)
    }

    function bulk(enable) {
        cards.each(d => {
            if (!d.visible) return
            if (enable && spec.disable.has(d.recipe)) {
                spec.setEnable(d.recipe)
            } else if (!enable && !spec.disable.has(d.recipe)) {
                spec.setDisable(d.recipe)
            }
        })
        refreshSelection()
        applyFilter()
        spec.updateSolution()
    }

    function setTier(tier, baseOnly, enable) {
        for (let g of tier[1]) {
            for (let r of g.recipes) {
                if (baseOnly && isAlternate(r)) {
                    continue
                }
                if (enable && spec.disable.has(r)) {
                    spec.setEnable(r)
                } else if (!enable && !spec.disable.has(r)) {
                    spec.setDisable(r)
                }
            }
        }
        refreshSelection()
        applyFilter()
        spec.updateSolution()
    }

    function reset() {
        for (let r of Array.from(spec.disable)) {
            if (!spec.defaultDisable.has(r)) {
                spec.setEnable(r)
            }
        }
        for (let r of spec.defaultDisable) {
            if (!spec.disable.has(r)) {
                spec.setDisable(r)
            }
        }
        refreshSelection()
        applyFilter()
        spec.updateSolution()
    }

    search.on("input", applyFilter)
    filterSelect.on("change", function() {
        filter = this.value
        state.filter = filter
        saveState(state)
        applyFilter()
    })
    groupSelect.on("change", function() {
        state.groupBy = this.value
        saveState(state)
        carriedSearch = search.property("value")
        renderRecipeTab()
    })
    singles.on("change", function() {
        showSingles = this.checked
        state.singles = showSingles
        saveState(state)
        applyFilter()
    })

    updateCounts()
    applyFilter()
}
