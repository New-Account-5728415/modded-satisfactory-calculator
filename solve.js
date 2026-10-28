/*Copyright 2021 Kirk McDonald

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.*/

import { getCycleRecipes } from "./cycle.js"
import { Matrix } from "./matrix.js"
import { Rational, minusOne, zero, one, half } from "./rational.js"
import { Ingredient } from "./recipe.js"
import { simplex } from "./simplex.js"
import { Totals } from "./totals.js"

// Terminating nodes of a solution-graph.
class OutputRecipe {
    constructor(outputs) {
        this.name = "output"
        this.ingredients =  []
        for (let [item, rate] of outputs) {
            this.ingredients.push(new Ingredient(item, rate))
        }
        this.products = []
    }
    isReal() {
        return false
    }
}

class SurplusRecipe extends OutputRecipe {
    constructor(output) {
        super(output)
        this.name = "surplus"
    }
}

class Result {
    constructor() {
        this.recipeRates = new Map()
        this.remaining = new Map()
        this.targets = []
    }
    add(recipe, rate) {
        let x = this.recipeRates.get(recipe) || zero
        this.recipeRates.set(recipe, x.add(rate))
    }
    remainder(item, rate) {
        let x = this.remaining.get(item) || zero
        this.remaining.set(item, x.add(rate))
    }
    unfinishedTarget(item, rate, recipe) {
        this.targets.push({item, rate, recipe})
    }
    combine(other) {
        for (let [recipe, rate] of other.recipeRates) {
            this.add(recipe, rate)
        }
        for (let [item, rate] of other.remaining) {
            this.remainder(item, rate)
        }
        this.targets = this.targets.concat(other.targets)
    }
}

function traverse(spec, cyclic, item, rate, forceRecipe) {
    let result = new Result()
    // With somersloops to place, every recipe goes through the solver.
    if (spec.sloopBudget !== null) {
        result.remainder(item, rate)
        if (forceRecipe !== undefined && forceRecipe !== null) {
            result.unfinishedTarget(item, rate, forceRecipe)
        }
        return result
    }
    let recipe = forceRecipe
    if (recipe === undefined || recipe === null) {
        let itemRecipes = spec.getRecipes(item)
        if (itemRecipes.length > 1 || itemRecipes[0].products.length > 1 || cyclic.has(itemRecipes[0])) {
            result.remainder(item, rate)
            return result
        }
        recipe = itemRecipes[0]
    } else {
        if (recipe.products.length > 1 || cyclic.has(recipe)) {
            result.remainder(item, rate)
            result.unfinishedTarget(item, rate, recipe)
            return result
        }
    }
    let gives = recipe.gives(item)
    let recipeRate = rate.div(gives)
    result.add(recipe, recipeRate)
    if (spec.ignore.has(item)) {
        console.log("ignored:", item)
        return result
    }
    for (let ing of recipe.ingredients) {
        let sub = traverse(spec, cyclic, ing.item, recipeRate.mul(ing.amount))
        result.combine(sub)
    }
    return result
}

function recursiveSolve(spec, cyclic, outputs) {
    let result = new Result()
    for (let {item, rate, recipe} of outputs) {
        let sub = traverse(spec, cyclic, item, rate, recipe)
        result.combine(sub)
    }
    return result
}


// Somersloops the solver may place (spec.sloopBudget). For a recipe made in
// a building with somersloop slots, one somersloop adds 1/slots of a
// building's output (of each product, net of what the recipe itself uses),
// with no extra inputs. This row stands for that extra output; its rate is
// the number of somersloops.
class SloopRecipe {
    constructor(recipe, perSloop) {
        this.recipe = recipe
        this.name = "Somersloops: " + recipe.name
        this.ingredients = []
        this.products = perSloop
        this.icon = recipe.icon
        this.isSloop = true
    }
    isReal() {
        return false
    }
}

// Whether the solver may put somersloops on this recipe.
function sloopable(spec, recipe) {
    if (spec.sloopBudget === null || !recipe.isReal() || recipe.isSupply || recipe.isResource() || recipe.isDisable()) {
        return false
    }
    let building = spec.getBuilding(recipe)
    if (building === null || building.maxSomersloop === null || building.maxSomersloop === undefined || building.maxSomersloop.isZero()) {
        return false
    }
    // Recipes given somersloops by hand keep exactly those.
    return !spec.somersloop.has(recipe)
}

/* Builds and solves the tableau.

Columns:
[surplus items] [pseudo] [supply caps] [sloop caps] [sloop budget] [sloop limits] [tax] [recipes] [result] [cost]

Rows:
[recipes, then one SloopRecipe per recipe that can take somersloops]
[tax]
[result]

Each supplied item (an input from an existing production line) has a
SupplyRecipe with no cost, and a cap column limiting its rate to what was
entered. Each SloopRecipe has a cap column (no more somersloops than the
recipe's buildings have slots), all of them share the budget column, and on
the second pass each also gets a limit column (a whole number).

Returns {rates, sloops, surplus}: real recipe rates, somersloops per recipe,
and leftover items.
*/
function runLP(spec, recipes, partialSolution, sloopLimits, sloopBudget, excluded) {
    let products = new Set()
    let items = []
    let itemColumns = new Map()
    let recipeArray = []
    let recipeRows = new Map()

    for (let recipe of recipes) {
        recipeRows.set(recipe, recipeArray.length)
        recipeArray.push(recipe)
        for (let ing of recipe.products) {
            if (!products.has(ing.item)) {
                itemColumns.set(ing.item, items.length)
                items.push(ing.item)
            }
            products.add(ing.item)
        }
    }
    // Somersloop rows go after the real recipes.
    let sloopRows = []
    if (sloopBudget !== null && zero.less(sloopBudget)) {
        for (let recipe of recipes) {
            if (!sloopable(spec, recipe) || (excluded && excluded.has(recipe))) {
                continue
            }
            if (sloopLimits !== null && !zero.less(sloopLimits.get(recipe) || zero)) {
                continue
            }
            let slots = spec.getBuilding(recipe).maxSomersloop
            let perBuilding = spec.getRecipeRate(recipe)  // crafts per second
            let perSloop = []
            for (let ing of recipe.products) {
                let net = ing.amount.sub(recipe.uses(ing.item))
                if (zero.less(net)) {
                    perSloop.push(new Ingredient(ing.item, net.mul(perBuilding).div(slots)))
                }
            }
            if (perSloop.length === 0) {
                continue
            }
            let sr = new SloopRecipe(recipe, perSloop)
            recipeRows.set(sr, recipeArray.length)
            recipeArray.push(sr)
            sloopRows.push(sr)
        }
    }

    let supplyRecipes = recipeArray.filter(r => r.isSupply)
    let capStart = items.length + partialSolution.targets.length
    let sloopCapStart = capStart + supplyRecipes.length
    let budgetCol = sloopCapStart + sloopRows.length
    let budgetCols = sloopRows.length > 0 ? 1 : 0
    let limitStart = budgetCol + budgetCols
    let limitCols = sloopLimits === null ? 0 : sloopRows.length
    let tax = limitStart + limitCols
    let columns = tax + recipeArray.length + 3
    let rows = recipeArray.length + 2
    let A = new Matrix(rows, columns)

    // Set recipe inputs/outputs
    for (let i = 0; i < recipeArray.length; i++) {
        let recipe = recipeArray[i]
        for (let ing of recipe.products) {
            let j = itemColumns.get(ing.item)
            A.addIndex(i, j, ing.amount)
        }
        for (let ing of recipe.ingredients) {
            let j = itemColumns.get(ing.item)
            A.addIndex(i, j, zero.sub(ing.amount))
        }
        if (recipe.isSloop) {
            // Somersloops are free: no cost and no tax.
            A.setIndex(i, tax + i + 1, one)
            continue
        }
        // Apply prod bonus (somersloops set by hand)
        let prodBonus = one.add(spec.getSomersloop(recipe))
        if (one.less(prodBonus)) {
            for (let ing of recipe.products) {
                let j = itemColumns.get(ing.item)
                let n = A.index(i, j)
                if (zero.less(n)) {
                    A.setIndex(i, j, n.mul(prodBonus))
                }
            }
        }
        A.setIndex(i, tax, minusOne)
        A.setIndex(i, tax + i + 1, one)
    }
    // Set psuedo-items corresponding to remaining building-count targets.
    for (let i = 0; i < partialSolution.targets.length; i++) {
        let {recipe, item, rate} = partialSolution.targets[i]
        let row = recipeRows.get(recipe)
        let col = items.length + i
        let itemCol = itemColumns.get(item)
        let product = A.index(row, itemCol)
        A.setIndex(row, col, product)
        A.setIndex(rows - 1, col, zero.sub(rate))
    }
    // Supply caps: rate of the supply recipe <= the supplied rate.
    for (let k = 0; k < supplyRecipes.length; k++) {
        let recipe = supplyRecipes[k]
        A.setIndex(recipeRows.get(recipe), capStart + k, minusOne)
        A.setIndex(rows - 1, capStart + k, spec.supply.get(recipe.products[0].item))
    }
    // Somersloop caps: sloops <= slots * buildings, where buildings =
    // recipe-rate / (crafts per second of one building). Then the budget, and
    // on the second pass the whole-number limits.
    for (let k = 0; k < sloopRows.length; k++) {
        let sr = sloopRows[k]
        let slots = spec.getBuilding(sr.recipe).maxSomersloop
        A.setIndex(recipeRows.get(sr.recipe), sloopCapStart + k, slots.div(spec.getRecipeRate(sr.recipe)))
        A.setIndex(recipeRows.get(sr), sloopCapStart + k, minusOne)
        A.setIndex(recipeRows.get(sr), budgetCol, minusOne)
        if (limitCols > 0) {
            A.setIndex(recipeRows.get(sr), limitStart + k, minusOne)
            A.setIndex(rows - 1, limitStart + k, sloopLimits.get(sr.recipe))
        }
    }
    if (budgetCols > 0) {
        A.setIndex(rows - 1, budgetCol, sloopBudget)
    }
    A.setIndex(rows - 2, tax, one)
    A.setIndex(rows - 1, columns - 2, one)

    // Set target rates
    for (let [item, rate] of partialSolution.remaining) {
        let col = itemColumns.get(item)
        A.setIndex(rows - 1, col, zero.sub(rate))
    }

    // Set cost function
    let min = null
    let max = zero
    for (let x of A.mat) {
        if (x.isZero()) {
            continue
        }
        x = x.abs()
        if (min === null || x.less(min)) {
            min = x
        }
        if (max.less(x)) {
            max = x
        }
    }
    let two = Rational.from_float(2)
    let cost_ratio = max.div(min).mul(two)
    // The cost ratio must be greater than 1.
    if (cost_ratio.less(two)) {
        cost_ratio = two
    }
    A.setIndex(rows - 2, columns - 1, one)
    let P = cost_ratio
    for (let p of spec.priority) {
        let N = zero
        let maxWeight = null
        for (let {recipe, weight} of p) {
            if (maxWeight === null || maxWeight.less(weight)) {
                maxWeight = weight
            }
        }
        for (let {recipe, weight} of p) {
            if (recipeRows.has(recipe)) {
                let normalizedWeight = maxWeight.div(weight)
                N = N.add(normalizedWeight)
                A.setIndex(recipeRows.get(recipe), columns - 1, P.mul(normalizedWeight))
            }
        }
        if (!N.isZero()) {
            P = P.mul(cost_ratio).mul(N)
        }
    }

    spec.lastTableau = A.copy()
    spec.lastMetadata = {
        "items": items,
        "recipes": recipeArray,
        "targets": partialSolution.targets,
        "supplyRecipes": supplyRecipes,
        "sloopRows": sloopRows,
        "budgetCols": budgetCols,
        "limitCols": limitCols,
    }

    // Solve.
    simplex(A)

    spec.lastSolution = A

    let rates = new Map()
    let sloops = new Map()
    for (let i = 0; i < recipeArray.length; i++) {
        let rate = A.index(A.rows - 1, tax + i + 1)
        if (!zero.less(rate)) {
            continue
        }
        let recipe = recipeArray[i]
        if (recipe.isSloop) {
            sloops.set(recipe.recipe, rate)
        } else {
            rates.set(recipe, rate)
        }
    }
    let surplus = new Map()
    for (let i = 0; i < items.length; i++) {
        let rate = A.index(A.rows - 1, i)
        if (zero.less(rate)) {
            surplus.set(items[i], rate)
        }
    }
    return {rates, sloops, surplus}
}

function sloopSlots(spec, recipe) {
    return spec.getBuilding(recipe).maxSomersloop
}

// Buildings (fractional) a recipe runs in at the given rates.
function buildingsFor(spec, recipe, rates) {
    let rate = rates.get(recipe) || zero
    return rate.div(spec.getRecipeRate(recipe))
}

// Whole somersloops needed for the given slot-units: one each in full-speed
// buildings, and for any remainder in the part-speed building, enough that
// (count x that building's speed) covers it.
function physicalSloops(spec, recipe, units, buildings) {
    let slots = sloopSlots(spec, recipe)
    let fullSlots = slots.mul(buildings.floor())
    if (!fullSlots.less(units)) {
        return units.ceil()
    }
    let speed = buildings.sub(buildings.floor())
    let extra = units.sub(fullSlots).div(speed).ceil()
    if (slots.less(extra)) {
        extra = slots
    }
    return fullSlots.add(extra)
}

export function solve(spec, fullOutputs) {
    spec.autoSloops = new Map()
    let outputs = new Map()
    for (let {item, rate, recipe} of fullOutputs) {
        rate = rate.add(outputs.get(item) || zero)
        outputs.set(item, rate)
    }
    let recipes = spec.getRecipeGraph(outputs)
    let cyclic = getCycleRecipes(recipes)
    let partialSolution = recursiveSolve(spec, cyclic, fullOutputs)
    let solution = partialSolution.recipeRates
    spec.lastPartial = partialSolution

    if (partialSolution.remaining.size === 0) {
        spec.lastTableau = null
        spec.lastMetadata = null
        spec.lastSolution = null
        solution.set(new OutputRecipe(outputs), one)
        return new Totals(spec, outputs, solution, new Map())
    }

    recipes = spec.getRecipeGraph(partialSolution.remaining)

    // Somersloops. The solver works in "slot-units": one unit is one slot
    // of a building running at full speed. Whole somersloops go into
    // full-speed buildings one-for-one; any that must go into the last,
    // part-speed building count for less, so more are needed there. The
    // budget is re-solved smaller until the real count fits.
    // Somersloops that would mostly sit idle (in a building running at
    // under half speed) are taken back out, so they stay available.
    let budget = spec.sloopBudget
    let excluded = new Set()
    let pass = null
    let physical = new Map()
    let fits = spec.sloopBudget === null
    for (let attempt = 0; attempt < 12 && !fits; attempt++) {
        pass = runLP(spec, recipes, partialSolution, null, budget, excluded)
        // Whole somersloops in full-speed buildings: round those down.
        let limits = new Map()
        let rounded = false
        for (let [recipe, units] of pass.sloops) {
            let fullSlots = sloopSlots(spec, recipe).mul(buildingsFor(spec, recipe, pass.rates).floor())
            if (!units.isInteger() && !fullSlots.less(units)) {
                limits.set(recipe, units.floor())
                rounded = true
            } else {
                limits.set(recipe, units)
            }
        }
        if (rounded) {
            pass = runLP(spec, recipes, partialSolution, limits, budget, excluded)
        }
        physical = new Map()
        let total = zero
        let dropped = false
        for (let [recipe, units] of pass.sloops) {
            let n = physicalSloops(spec, recipe, units, buildingsFor(spec, recipe, pass.rates))
            if (!zero.less(n)) {
                continue
            }
            if (units.div(n).less(half)) {
                excluded.add(recipe)
                dropped = true
                continue
            }
            physical.set(recipe, {units, n})
            total = total.add(n)
        }
        if (dropped) {
            continue
        }
        if (!spec.sloopBudget.less(total)) {
            fits = true
            break
        }
        // Over budget: try again with the budget scaled down to fit.
        budget = budget.mul(spec.sloopBudget).div(total).floor()
        if (!zero.less(budget)) {
            break
        }
    }
    if (!fits || pass === null) {
        // No somersloops to place, or none that fit: solve without them.
        physical = new Map()
        pass = runLP(spec, recipes, partialSolution, null, null, excluded)
    }
    for (let [recipe, rate] of pass.rates) {
        solution.set(recipe, (solution.get(recipe) || zero).add(rate))
    }
    // Record where the solver put somersloops: the real count, and the
    // fraction of the recipe's slots they amount to (used by recipe.gives()).
    for (let [recipe, {units, n}] of physical) {
        let buildings = buildingsFor(spec, recipe, pass.rates)
        spec.autoSloops.set(recipe, {count: n, fraction: units.div(sloopSlots(spec, recipe).mul(buildings))})
    }
    solution.set(new OutputRecipe(outputs), one)
    let surplus = pass.surplus
    if (surplus.size > 0) {
        solution.set(new SurplusRecipe(surplus), one)
    }
    return new Totals(spec, outputs, solution, surplus)
    //return {"solution": solution, "surplus": surplus}
}
