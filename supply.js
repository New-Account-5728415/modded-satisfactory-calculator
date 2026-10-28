/*Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.*/
import { makeDropdown, addInputs } from "./dropdown.js"
import { spec } from "./factory.js"
import { Rational, zero } from "./rational.js"
import { resetSearch, searchTargets } from "./target.js"

// An item already being made by an existing production line, available to
// the factory at up to the given rate. The solver uses it before building
// anything to make that item; whatever isn't needed is simply not drawn.

let supplyCount = 0

export class SupplyInput {
    constructor(item, tiers) {
        this.item = item
        this.rate = zero
        let self = this

        let element = d3.create("li")
            .classed("supply", true)
        element.append("button")
            .classed("targetButton ui", true)
            .text("x")
            .attr("title", "Remove this input.")
            .on("click", () => {
                spec.removeSupply(self)
                spec.updateSolution()
            })
        element.append("span")
            .classed("supply-label", true)
            .text("Supplied:")
        this.element = element.node()

        let dropdown = makeDropdown(
            element,
            d => d.select(".search").node().focus(),
            d => resetSearch(d.node()),
        )
        dropdown.append("input")
            .classed("search", true)
            .attr("placeholder", "Search")
            .on("keyup", searchTargets)
        let itemSpan = dropdown.selectAll("div")
            .data(tiers)
            .join("div")
                .selectAll("span")
                .data(d => d)
                .join("span")
        let itemLabel = addInputs(
            itemSpan,
            `supply-${supplyCount}`,
            d => d === item,
            d => {
                self.item = d
                spec.updateSolution()
            },
        )
        itemLabel.append("img")
            .classed("icon", true)
            .attr("src", d => d.icon.path())
            .attr("title", d => d.name)
        supplyCount++

        this.rateLabel = element.append("label").node()
        this.rateInput = element.append("input")
            .attr("type", "text")
            .attr("value", "")
            .attr("size", 5)
            .attr("title", "The most this existing line can supply. The plan uses as much of it as helps, and builds the rest.")
            .on("change", function() {
                self.setRate(this.value)
                spec.updateSolution()
            })
            .node()
        this.usedLabel = element.append("span")
            .classed("supply-used", true)
            .node()
        this.setRateLabel()
    }
    setRateLabel() {
        this.rateLabel.textContent = " Items/" + spec.format.longRate + ": "
    }
    // value: text in the current display unit (e.g. items per minute)
    setRate(value) {
        try {
            this.rate = Rational.from_string(String(value).trim() || "0").div(spec.format.rateFactor)
        } catch (e) {
            this.rate = zero
        }
        if (this.rate.less(zero)) {
            this.rate = zero
        }
    }
    // Rate in items per second.
    getRate() {
        this.setRateLabel()
        if (document.activeElement !== this.rateInput) {
            this.rateInput.value = this.rate.isZero() ? "" : spec.format.rate(this.rate)
        }
        return this.rate
    }
    showUsed(totals) {
        let used = zero
        if (this.item && totals) {
            used = totals.rates.get(this.item.supplyRecipe) || zero
        }
        if (this.rate.isZero()) {
            this.usedLabel.textContent = ""
        } else {
            this.usedLabel.textContent = ` used: ${spec.format.rate(used)}`
        }
    }
}
