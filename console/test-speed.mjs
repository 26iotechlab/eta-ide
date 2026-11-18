// Speed + strength fixes found by timing the live task-04 runs. No GPU.
import { contractSaysNoChange, gapIsAboutOtherFile, fileSectionOf } from "./agent.mjs";
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const NL = String.fromCharCode(10);

// 1. a file the contract leaves alone is skipped (wording copied from live contracts)
t(contractSaysNoChange("No changes needed; `bulk_discount` and `tax` signatures/behavior are correct."), "live wording 1");
t(contractSaysNoChange("No changes needed; bulk_discount(subtotal, units) correctly applies 10% off when units >= 10, and tax(amount) applies 8% tax on the discounted amount."), "live wording 2");
t(contractSaysNoChange("This file is already correct and satisfies the contract."), "already correct");
t(!contractSaysNoChange("Change units() to return sum(qty for _, _, qty in self.items) instead of len(self.items)."), "a real change is not skipped");
t(!contractSaysNoChange("Add a category field. Keep the rest unchanged."), "a change that also says unchanged later is not skipped");
t(!contractSaysNoChange(""), "empty section is not skipped");

const contract = ["**shop/pricing.py**: No changes needed; fine.", "**shop/cart.py**: Change units() to sum quantities."].join(NL);
t(contractSaysNoChange(fileSectionOf(contract, "shop/pricing.py")) && !contractSaysNoChange(fileSectionOf(contract, "shop/cart.py")), "per-file sections of one contract");
t(fileSectionOf(["- shop/a.py: Add x.", "- shop/b.py: No change needed."].join(NL), "shop/b.py") === "No change needed.", "dash style");
const h = ["### shop/a.py", "Add x.", "### shop/b.py", "No changes needed."].join(NL);
t(fileSectionOf(h, "shop/b.py").includes("No changes") && !fileSectionOf(h, "shop/a.py").includes("No changes"), "markdown heading style");
const colon = ["shop/a.py:", "Add x.", "", "shop/b.py:", "No changes needed."].join(NL);
t(fileSectionOf(colon, "shop/b.py").includes("No changes"), "colon heading style");
t(fileSectionOf("nothing here", "shop/b.py") === "", "unknown file gives empty, never a skip");

// 2. an answer about a different file is not an answer about this one
t(gapIsAboutOtherFile("`units()` in cart.py should return sum", "shop/pricing.py", ["shop/cart.py", "shop/pricing.py"]), "gap about cart.py for pricing.py is ignored");
t(!gapIsAboutOtherFile("tax() in pricing.py rounds wrongly", "shop/pricing.py", ["shop/cart.py", "shop/pricing.py"]), "gap about this file is kept");
t(!gapIsAboutOtherFile("the discount is not applied", "shop/pricing.py", ["shop/cart.py", "shop/pricing.py"]), "gap naming no file is kept");

// 3. wired into the engine
const src = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/contractSaysNoChange\(fileSectionOf\(this\.contract, f\)\)/.test(src), "_runOneFile skips no-change files");
t(/!this\.files\.has\(file\)\) return \{ ok: true, gap: "" \}/.test(src), "the free-text judge only sees changed files");
t(/gapIsAboutOtherFile\(_gap, file,/.test(src), "inspector drops answers about other files");
t(/nothing new is being learned, ending this pass/.test(src) && /_noInfoTick/.test(src), "no-new-information guard is in execute()");

t(/this\._editIntent = String\(tc\.say/.test(src) && /intentCtx/.test(src), "the edit writer is told what the executor wants changed");
console.log(`speed: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
