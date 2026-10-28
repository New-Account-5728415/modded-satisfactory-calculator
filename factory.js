/*Copyright 2019-2021 Kirk McDonald

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.*/
import { Formatter } from "./align.js"
import { renderDebug } from "./debug.js"
import { displayItems } from "./display.js"
import { formatSettings } from "./fragment.js"
import { PriorityList } from "./priority.js"
import { Rational, zero, half, one } from "./rational.js"
import { DISABLED_RECIPE_PREFIX } from "./recipe.js"
import { solve } from "./solve.js"
import { SupplyInput } from "./supply.js"
import { BuildTarget } from "./target.js"
import { reapTooltips } from "./tooltip.js"
import { renderTotals } from "./visualize.js"

const DEFAULT_ITEM_KEY = "supercomputer"

let minerCategories = new Set(["mineral", "oil"])

export let resourcePurities = [
    {key: "0", name: "Impure", factor: half},
    {key: "1", name: "Normal", factor: one},
    {key: "2", name: "Pure", factor: Rational.from_float(2)},
]

export let DEFAULT_PURITY = resourcePurities[1]

export let DEFAULT_BELT = "belt1"
export let DEFAULT_PIPE = "pipe1"

const OVERCLOCK_POWER_EXPONENT = Math.log2(2.5)

class FactorySpecification {
    constructor() {
        // Game data definitions
        this.items = null
        this.recipes = null
        this.buildings = null
        this.belts = null
        this.pipes = null

        this.itemTiers = []

        this.buildTargets = []

        // Map resource recipe to {miner, purity}
        this.miners = new Map()
        this.minerSettings = new Map()

        // Map recipe to overclock factor
        this.overclock = new Map()

        // Map recipe to somersloop count
        this.somersloop = new Map()
        // Somersloops the solver may place itself (null: none), and where it
        // put them in the last solution: recipe -> {count, fraction}.
        this.sloopBudget = null
        this.autoSloops = new Map()

        // Inputs supplied from existing production lines: list of
        // SupplyInput, and the map of item to rate built from them.
        this.supplyInputs = []
        this.supply = new Map()

        // Clock speed precision, in decimal places of a percent (the game
        // takes 4). null shows fractional building counts instead.
        this.clockDecimals = null

        this.belt = null

        this.ignore = new Set()
        this.disable = new Set()
        this.defaultDisable = new Set()

        this.priority = null
        this.defaultPriority = null

        this.format = new Formatter()

        this.lastTotals = null

        this.lastPartial = null
        this.lastTableau = null
        this.lastMetadata = null
        this.lastSolution = null

        this.debug = false
    }
    setData(items, recipes, buildings, belts, pipes) {
        this.items = items
        let tierMap = new Map()
        this.defaultDisable = new Set()
        for (let [itemKey, item] of items) {
            let tier = tierMap.get(item.tier)
            if (tier === undefined) {
                tier = []
                tierMap.set(item.tier, tier)
            }
            tier.push(item)
            // By default, disable all recipes but one for (most) items that
            // have multiple recipes.
            // Recipes marked off by default in data.json start off, and don't
            // count for the rules below.
            let itemRecipes = []
            for (let recipe of item.recipes) {
                if (recipe.defaultDisabled) {
                    this.defaultDisable.add(recipe)
                } else {
                    itemRecipes.push(recipe)
                }
            }
            if (itemRecipes.length > 1) {
                let chosen = null
                let skip = false
                for (let recipe of itemRecipes) {
                    if (recipe.isResource()) {
                        chosen = recipe
                    }
                    // If any of this item's recipes produce multiple items,
                    // then don't disable any of these recipes, and let the
                    // linear program sort it out.
                    if (recipe.products.length > 1) {
                        skip = true
                    }
                }
                if (skip) {
                    continue
                }
                if (chosen === null) {
                    chosen = itemRecipes[0]
                }
                for (let recipe of itemRecipes) {
                    if (recipe !== chosen) {
                        this.defaultDisable.add(recipe)
                    }
                }
            }
        }
        this.itemTiers = []
        for (let [tier, tierItems] of tierMap) {
            this.itemTiers.push(tierItems)
        }
        this.itemTiers.sort((a, b) => a[0].tier - b[0].tier)
        this.recipes = recipes
        this.resourceNameMap = new Map()
        for (let [key, recipe] of recipes) {
            if (recipe.isResource()) {
                this.resourceNameMap.set(recipe.name, recipe)
            }
        }
        this.buildings = new Map()
        for (let building of buildings) {
            let category = this.buildings.get(building.category)
            if (category === undefined) {
                category = []
                this.buildings.set(building.category, category)
            }
            category.push(building)
            if (minerCategories.has(building.category)) {
                this.miners.set(building.key, building)
            }
        }
        this.belts = belts
        this.belt = belts.get(DEFAULT_BELT)
        this.pipes = pipes
        this.pipe = belts.get(DEFAULT_PIPE)
        this.initMinerSettings()
        this.defaultPriority = this.getDefaultPriorityArray()
        this.priority = null
    }
    setDefaultDisable() {
        this.disable.clear()
        for (let recipe of this.defaultDisable) {
            this.setDisable(recipe)
        }
    }
    isDefaultDisable() {
        if (this.disable.size !== this.defaultDisable.size) {
            return false
        }
        for (let recipe of this.disable) {
            if (!this.defaultDisable.has(recipe)) {
                return false
            }
        }
        return true
    }
    setDisable(recipe) {
        let candidates = new Set()
        let items = new Set()
        for (let ing of recipe.products) {
            let item = ing.item
            items.add(item)
            if (!this.isItemDisabled(item) && !this.ignore.has(item)) {
                candidates.add(item)
            }
        }
        this.disable.add(recipe)
        for (let item of candidates) {
            if (this.isItemDisabled(item)) {
                let resource = this.priority.getResource(item.disableRecipe)
                // The item might already be in the priority list due to being
                // ignored. In this case, do nothing.
                if (resource === null) {
                    let level = this.priority.getLastLevel()
                    let makeNew = true
                    for (let r of level) {
                        if (r.recipe.isDisable()) {
                            makeNew = false
                            break
                        }
                    }
                    if (makeNew) {
                        level = this.priority.addPriorityBefore(null)
                    }
                    let hundred = Rational.from_float(100)
                    this.priority.addRecipe(item.disableRecipe, hundred, level)
                }
            }
        }
        // Update build targets.
        for (let target of this.buildTargets) {
            if (items.has(target.item)) {
                target.displayRecipes()
            }
        }
    }
    setEnable(recipe) {
        // Enabling this recipe could potentially remove these items'
        // disableRecipe from the priority list. The item is only removed if it
        // goes from being disabled to not disabled, and is not ignored.
        //
        // Note that enabling a recipe for an item does not inherently mean the
        // item is not considered "disabled" in this sense. For example, if the
        // enabled recipe is net-negative in its use of the item.
        let candidates = new Set()
        let items = new Set()
        for (let ing of recipe.products) {
            let item = ing.item
            items.add(item)
            if (this.isItemDisabled(item) && !this.ignore.has(item)) {
                candidates.add(item)
            }
        }
        this.disable.delete(recipe)
        for (let item of candidates) {
            if (!this.isItemDisabled(item)) {
                this.priority.removeRecipe(item.disableRecipe)
            }
        }
        // Update build targets.
        for (let target of this.buildTargets) {
            if (items.has(target.item)) {
                target.displayRecipes()
            }
        }
    }
    getDefaultPriorityArray() {
        let a = []
        for (let [recipeKey, recipe] of this.recipes) {
            if (recipe.isResource()) {
                let pri = recipe.defaultPriority
                while (a.length < pri + 1) {
                    a.push(new Map())
                }
                a[pri].set(recipe, recipe.defaultWeight)
            }
        }
        return a
    }
    setDefaultPriority() {
        this.priority = PriorityList.fromArray(this.defaultPriority)
    }
    setPriorities(tiers) {
        let a = []
        for (let tier of tiers) {
            let m = new Map()
            for (let [recipeKey, weight] of tier) {
                let recipe = this.recipes.get(recipeKey)
                if (recipe === undefined && recipeKey.startsWith(DISABLED_RECIPE_PREFIX)) {
                    let itemKey = recipeKey.slice(DISABLED_RECIPE_PREFIX.length)
                    recipe = this.items.get(itemKey).disableRecipe
                }
                m.set(recipe, weight)
            }
            a.push(m)
        }
        this.priority.applyArray(a)
    }
    isDefaultPriority() {
        return this.priority.equalArray(this.defaultPriority)
    }
    initMinerSettings() {
        this.minerSettings = new Map()
        for (let [recipeKey, recipe] of this.recipes) {
            if (minerCategories.has(recipe.category)) {
                let miners = this.buildings.get(recipe.category)
                // Default to miner mk1.
                let miner = miners[0]
                // Default to normal purity.
                let purity = DEFAULT_PURITY
                this.minerSettings.set(recipe, {miner, purity})
            }
        }
    }
    getUses(item) {
        let recipes = []
        for (let recipe of item.uses) {
            if (!this.disable.has(recipe)) {
                recipes.push(recipe)
            }
        }
        return recipes
    }
    // Returns whether the current item requires the use of its DisabledRecipe
    // as a consequence of its recipes being disabled. (It may still require it
    // as a consequence of the item being ignored, independent of this.)
    //
    // It's worth mentioning that this is insufficent to guarantee that no
    // infeasible solutions exist. Catching net-negative single recipes ought
    // to account for the most common cases, but net-negative recipe loops are
    // still possible.
    isItemDisabled(item) {
        for (let recipe of item.recipes) {
            if (!this.disable.has(recipe)) {
                if (recipe.isNetProducer(item)) {
                    return false
                }
            }
        }
        return true
    }
    getRecipes(item) {
        let recipes = []
        for (let recipe of item.recipes) {
            if (!this.disable.has(recipe)) {
                recipes.push(recipe)
            }
        }
        // The disableRecipe's purpose is to provide an item ex nihilo, in
        // cases where solutions are infeasible otherwise. This happens in two
        // cases: When enough recipes have been disabled to prevent its
        // production in any other way, and when the item is being ignored.
        if (this.supply.has(item)) {
            recipes.push(item.supplyRecipe)
        }
        if (this.isItemDisabled(item) || this.ignore.has(item)) {
            let result = [item.disableRecipe]
            if (this.supply.has(item)) {
                result.push(item.supplyRecipe)
            }
            // Still consider any recipes which produce both this item and any
            // other un-ignored items.
            for (let r of recipes) {
                for (let ing of r.products) {
                    if (!this.ignore.has(ing.item)) {
                        result.push(r)
                        break
                    }
                }
            }
            return result
        }
        return recipes
    }
    _getItemGraph(item, recipes) {
        for (let recipe of this.getRecipes(item)) {
            if (recipes.has(recipe)) {
                continue
            }
            recipes.add(recipe)
            for (let ing of recipe.ingredients) {
                this._getItemGraph(ing.item, recipes)
            }
        }
    }
    // Returns the set of recipes which may contribute to the production of
    // the given collection of items.
    getRecipeGraph(items) {
        let graph = new Set()
        for (let [item, rate] of items) {
            this._getItemGraph(item, graph)
        }
        return graph
    }
    getBuilding(recipe) {
        if (recipe.category === null) {
            return null
        } else if (this.minerSettings.has(recipe)) {
            return this.minerSettings.get(recipe).miner
        } else {
            // NOTE: Only miners offer alternative buildings. May need to
            // revisit this if higher tiers of constructors are added.
            return this.buildings.get(recipe.category)[0]
        }
    }
    getOverclock(recipe) {
        return this.overclock.get(recipe) || one
    }
    setOverclock(recipe, overclock) {
        if (overclock.equal(one)) {
            this.overclock.delete(recipe)
        } else {
            this.overclock.set(recipe, overclock)
        }
    }
    // Returns somersloop factor as a fraction from 0 (no somersloops) to 1
    // (all possible somersloops).
    getSomersloop(recipe) {
        let building = this.getBuilding(recipe)
        if (building === null || building.maxSomersloop === null) {
            return zero
        }
        let sloops = this.somersloop.get(recipe)
        if (sloops === undefined) {
            let auto = this.autoSloops.get(recipe)
            return auto === undefined ? zero : auto.fraction
        }
        return sloops.div(building.maxSomersloop)
    }
    // Somersloops the solver placed on this recipe (a Rational count), or null.
    getAutoSloops(recipe) {
        let auto = this.autoSloops.get(recipe)
        return auto === undefined ? null : auto.count
    }
    // Somersloops in use: {placed} by the solver and {manual}, set by hand
    // (per building, times the buildings).
    sloopsUsed(totals) {
        let placed = zero
        for (let [recipe, auto] of this.autoSloops) {
            placed = placed.add(auto.count)
        }
        let manual = zero
        for (let [recipe, count] of this.somersloop) {
            let rate = totals.rates.get(recipe)
            if (rate !== undefined) {
                manual = manual.add(count.mul(this.getCount(recipe, rate).ceil()))
            }
        }
        return {placed, manual}
    }
    setSomersloop(recipe, count) {
        if (count.equal(zero)) {
            this.somersloop.delete(recipe)
        } else {
            this.somersloop.set(recipe, count)
        }
    }
    // Returns the recipe-rate at which a single building can produce a recipe.
    // Returns null for recipes that do not have a building.
    getRecipeRate(recipe) {
        let building = this.getBuilding(recipe)
        if (building === null) {
            return null
        }
        return building.getRecipeRate(this, recipe)
    }
    getResourcePurity(recipe) {
        // XXX: water extractors, blah
        if (this.minerSettings.has(recipe)) {
            return this.minerSettings.get(recipe).purity
        } else {
            return resourcePurities[1]
        }
    }
    setMiner(recipe, miner, purity) {
        this.minerSettings.set(recipe, {miner, purity})
    }
    getCount(recipe, rate) {
        let building = this.getBuilding(recipe)
        if (building === null) {
            return zero
        }
        return building.getCount(this, recipe, rate)
    }
    // With a clock speed precision set: the whole number of buildings, and
    // the clock speed (in percent, rounded up to the precision and at least
    // 1%) they all run at to make the recipe-rate. Otherwise null.
    getMachines(recipe, rate) {
        if (this.clockDecimals === null || this.getBuilding(recipe) === null) {
            return null
        }
        let count = this.getCount(recipe, rate)
        if (count.isZero()) {
            return {count: zero, clock: zero}
        }
        let machines = count.ceil()
        let hundred = Rational.from_float(100)
        let step = Rational.from_float(Math.pow(10, this.clockDecimals)).reciprocate()
        let percent = this.getOverclock(recipe).mul(count).div(machines).mul(hundred)
        let clock = percent.div(step).ceil().mul(step)
        if (clock.less(one)) {
            clock = one
        }
        return {count: machines, clock}
    }
    // Building count as shown in the tables and the diagram.
    countText(recipe, rate) {
        let m = this.getMachines(recipe, rate)
        if (m === null) {
            return this.format.count(this.getCount(recipe, rate))
        }
        if (m.count.isZero()) {
            return "0"
        }
        return `${m.count.toString()} @ ${m.clock.toDecimal(this.clockDecimals, zero)}%`
    }
    getBeltCount(rate) {
        return rate.div(this.belt.rate)
    }
    getPipeCount(rate) {
        return rate.div(this.pipe.rate)
    }
    getPowerUsage(recipe, rate) {
        let building = this.getBuilding(recipe)
        if (building === null) {
            return {average: zero, peak: zero}
        }
        let count = this.getCount(recipe, rate)
        let sloop = one.add(this.getSomersloop(recipe))
        sloop = sloop.mul(sloop)
        let machines = this.getMachines(recipe, rate)
        let auto = this.getAutoSloops(recipe)
        if (auto !== null) {
            // Placed somersloops: whole buildings run at full speed and get
            // them first (a full one draws (1 + 1)^2 = 4x power); any left go
            // in the last, part-speed building.
            let slots = building.maxSomersloop
            let n = machines !== null ? machines.count : count
            let fullBuildings = count.floor()
            let speed = count.sub(fullBuildings)
            let inFull = auto.less(slots.mul(fullBuildings)) ? auto : slots.mul(fullBuildings)
            let inPart = auto.sub(inFull)
            let full = inFull.div(slots).floor()
            let rem = inFull.sub(full.mul(slots))
            let sq = x => x.mul(x)
            // building-equivalents of power
            let units = Rational.from_float(4).mul(full)
            let used = full
            if (!rem.isZero()) {
                units = units.add(sq(one.add(rem.div(slots))))
                used = used.add(one)
            }
            if (used.less(fullBuildings)) {
                units = units.add(fullBuildings.sub(used))
            }
            units = units.add(speed.mul(sq(one.add(inPart.div(slots)))))
            let factor = one
            let overclock = this.overclock.get(recipe)
            if (overclock !== undefined) {
                factor = Rational.from_float(Math.pow(overclock.toFloat(), OVERCLOCK_POWER_EXPONENT))
            }
            let average = building.power.mul(units).mul(factor)
            let peakUnits = units.sub(speed.mul(sq(one.add(inPart.div(slots))))).add(speed.isZero() ? zero : sq(one.add(inPart.div(slots))))
            return {average, peak: building.power.mul(peakUnits).mul(factor)}
        }
        let average = building.power.mul(count).mul(sloop)
        let peak = building.power.mul(count.ceil()).mul(sloop)
        let overclock = this.overclock.get(recipe)
        if (overclock !== undefined) {
            // The result of this exponent will typically be irrational, so
            // this approximation is a necessity. Because overclock is limited
            // to the range [1.0, 2.5], any imprecision introduced by this
            // approximation is minimal (and is probably less than is present
            // in the game itself).
            let overclockFactor = Rational.from_float(Math.pow(overclock.toFloat(), OVERCLOCK_POWER_EXPONENT))
            average = average.mul(overclockFactor)
            peak = peak.mul(overclockFactor)
        }
        return {average, peak}
    }
    addTarget(itemKey) {
        if (itemKey === undefined) {
            itemKey = DEFAULT_ITEM_KEY
        }
        let item = this.items.get(itemKey)
        let target = new BuildTarget(this.buildTargets.length, itemKey, item, this.itemTiers)
        this.buildTargets.push(target)
        d3.select("#targets").insert(() => target.element, "#plusButton")
        return target
    }
    addSupply(itemKey) {
        let item = this.items.get(itemKey === undefined ? DEFAULT_ITEM_KEY : itemKey)
        let input = new SupplyInput(item, this.itemTiers)
        this.supplyInputs.push(input)
        d3.select("#supplies").insert(() => input.element, "#supplyPlus")
        return input
    }
    removeSupply(input) {
        let i = this.supplyInputs.indexOf(input)
        if (i !== -1) {
            this.supplyInputs.splice(i, 1)
        }
        d3.select(input.element).remove()
    }
    removeTarget(target) {
        this.buildTargets.splice(target.index, 1)
        for (let i=target.index; i < this.buildTargets.length; i++) {
            this.buildTargets[i].index--
        }
        d3.select(target.element).remove()
    }
    toggleIgnore(item) {
        if (this.ignore.has(item)) {
            this.ignore.delete(item)
            if (!this.isItemDisabled(item)) {
                this.priority.removeRecipe(item.disableRecipe)
            }
        } else {
            this.ignore.add(item)
            if (!this.isItemDisabled(item)) {
                let level = this.priority.getFirstLevel()
                let makeNew = true
                for (let r of level) {
                    if (r.recipe.isDisable()) {
                        makeNew = false
                        break
                    }
                }
                if (makeNew) {
                    level = this.priority.addPriorityBefore(level)
                }
                let hundred = Rational.from_float(100)
                this.priority.addRecipe(item.disableRecipe, hundred, level)
            }
        }
    }
    solve() {
        this.supply = new Map()
        for (let input of this.supplyInputs) {
            let rate = input.getRate()
            if (input.item && zero.less(rate)) {
                this.supply.set(input.item, (this.supply.get(input.item) || zero).add(rate))
            }
        }
        let outputs = []
        for (let target of this.buildTargets) {
            let item = target.item
            let rate = target.getRate()
            let recipe
            if (target.changedBuilding) {
                recipe = target.recipe
            } else {
                recipe = null
            }
            outputs.push([item, rate, recipe])
        }
        // JS isn't good at using tuples as Map keys/Set items, so just do this
        // quadratically. It's fine.
        let dedupedOutputs = []
        outer: for (let [origItem, origRate, origRecipe] of outputs) {
            for (let i = 0; i < dedupedOutputs.length; i++) {
                let {item, rate, recipe} = dedupedOutputs[i]
                if (recipe === origRecipe && item === origItem) {
                    rate = rate.add(origRate)
                    dedupedOutputs[i] = {item, rate, recipe}
                    continue outer
                }
            }
            dedupedOutputs.push({
                item: origItem,
                rate: origRate,
                recipe: origRecipe,
            })
        }
        let totals = solve(this, dedupedOutputs)
        return totals
    }
    setHash() {
        window.location.hash = "#" + formatSettings()
    }
    // The top-level calculation function. Called whenever the solution
    // requires recalculation.
    updateSolution() {
        this.lastTotals = this.solve()
        this.display()
    }
    // Re-renders the current solution, without re-computing it.
    //
    // This is useful for when settings can be applied without altering the
    // solution. In general, if something would alter recipe-rate ratios, then
    // it requires a new solution. If it only alters building counts (e.g.
    // from changing the speed of a building), then we need merely re-display
    // the existing solution.
    display() {
        // Update build target text boxes, if needed.
        for (let target of this.buildTargets) {
            target.getRate()
        }
        for (let input of this.supplyInputs) {
            input.getRate()
            input.showUsed(this.lastTotals)
        }
        displayItems(this, this.lastTotals)
        renderTotals(this.lastTotals, this.ignore)
        reapTooltips()
        this.setHash()

        if (this.debug) {
            renderDebug()
        }
    }
}

export let spec = new FactorySpecification()
window.spec = spec
