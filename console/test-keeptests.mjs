// "add a test" tasks: existing tests must stay exactly as they were. No GPU.
import { splitPyBlocks, restoreOriginalTests } from "./agent.mjs";
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

const orig = `import pytest
from shop.cart import Cart


def test_a():
    assert 1 == 1


def test_b():
    c = Cart()
    assert c.total() == 48.50
`;
// model edits an existing assertion and adds a new test
const cur = orig.replace("48.50", "44.99") + `

def test_new():
    assert True
`;
const r = restoreOriginalTests(orig, cur);
t(r.changed && r.restored.join() === "test_b", "changed existing test is restored: " + JSON.stringify(r.restored));
t(r.text.includes("48.50") && !r.text.includes("44.99"), "original assertion is back");
t(/def test_new\(\)/.test(r.text), "the new test is kept");
t(/import pytest/.test(r.text) && /def test_a/.test(r.text), "imports and untouched tests are kept");

// deleted test comes back
const del = restoreOriginalTests(orig, "import pytest\nfrom shop.cart import Cart\n\n\ndef test_a():\n    assert 1 == 1\n");
t(del.readded.join() === "test_b" && /48\.50/.test(del.text), "a deleted test is put back");

// only adding: nothing to do
const addOnly = restoreOriginalTests(orig, orig + "\n\ndef test_extra():\n    assert 2 == 2\n");
t(!addOnly.changed, "adding a test alone changes nothing");
// non-test helper edits are not touched
const helper = restoreOriginalTests("def helper():\n    return 1\n\ndef test_a():\n    assert helper() == 1\n", "def helper():\n    return 2\n\ndef test_a():\n    assert helper() == 1\n");
t(!helper.changed, "only test_ functions are protected");
// the result is valid and idempotent
const again = restoreOriginalTests(orig, r.text);
t(!again.changed, "restoring twice changes nothing more");
t(splitPyBlocks(r.text).filter((b) => /^test/.test(b.name)).length === 3, "three tests in the result");

const src = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/await this\.protectExistingTests\(emit\);\r?\n\s*if \(testCmd && baselineOk === false\)/.test(src), "guard runs before the test gate");
t(/this\._origTests\[rel\] = await fs\.readFile/.test(src), "originals are captured only for add-a-test tasks");

{
  const { Agent } = await import("./agent.mjs");
  const a = Object.create(Agent.prototype);
  const out = "FAILED tests/test_cart.py::test_new_total - assert 48.5 == 44.99"+String.fromCharCode(10)+"FAILED tests/test_cart.py::TestX::test_old - boom"+String.fromCharCode(10)+"1 failed";
  t(a.failingTestNames(out).join() === "test_new_total,test_old", "pytest failing names: " + a.failingTestNames(out));
  t(a.failingTestNames("FAIL: test_x (tests.test_a.T)"+String.fromCharCode(10)+"ERROR: test_y (tests.test_a.T)").join() === "test_x,test_y", "unittest failing names");
  // only a new test fails -> repair the test, no code edit
  const b = Object.create(Agent.prototype); b._origTests = { "tests/t.py": orig }; b.stopped = false; b.overBudget = () => false;
  let ran = 0; b.execute = async () => { ran++; return []; }; b.protectExistingTests = async () => {};
  t((await b.repairNewTestOnly("FAILED tests/t.py::test_brand_new - assert", {}, () => {}, "sys")) === true && ran === 1, "only a new test fails: new-test repair runs");
  const c = Object.create(Agent.prototype); c._origTests = { "tests/t.py": orig }; c.stopped = false; c.overBudget = () => false; c.execute = async () => { ran++; return []; };
  t((await c.repairNewTestOnly("FAILED tests/t.py::test_b - assert", {}, () => {}, "sys")) === false, "an OLD test fails: real code problem, no new-test repair");
  t((await c.repairNewTestOnly("FAILED tests/t.py::test_brand_new", {}, () => {}, "sys")) === true && (await c.repairNewTestOnly("FAILED tests/t.py::test_brand_new", {}, () => {}, "sys")) === false, "runs at most once");
  t(/await this\.repairNewTestOnly\(out, ctx, emit, baseSystem, testCmd\)\) continue;/.test(src), "wired into the test gate before the code repair");
}
console.log(`keeptests: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

// exact quoted wording (task 05) + tests folder (task 07)
{
  const { taskQuotedLiterals, missingQuotedLiterals } = await import("./agent.mjs");
  const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
  const task = 'If no product has that category, print "no products in category NAME" and exit with code 1. Our products.csv now has a "category" column.';
  const lits = taskQuotedLiterals(task);
  t(lits.length === 1 && lits[0].fixed === "no products in category", "finds the printed wording, ignores a quoted column name: " + JSON.stringify(lits));
  t(missingQuotedLiterals(task, "print(f\"No products found in category '{x}'\")").length === 1, "the model's different wording is caught");
  t(missingQuotedLiterals(task, "print(f\"no products in category {args.category}\")").length === 0, "the exact wording passes (case and placeholder tolerated)");
  t(taskQuotedLiterals('Run it with "python main.py --help" first').length === 0, "a quoted command is not an output requirement");
  t(taskQuotedLiterals('Use the word "other" when empty').length === 0, "a single quoted word is ignored");
  t(taskQuotedLiterals('The page title says "Tip Calculator Pro" at the top').length === 1, "a title that the page says is a requirement");
  const src2 = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
  t(/fs\.mkdir\(path\.dirname\(full\), \{ recursive: true \}\)/.test(src2), "spec-first creates the tests folder before writing (task 07 ENOENT)");
  t(/await this\.fixMissingLiterals\(task, ctx, emit, baseSystem\);/.test(src2), "wording fix runs before the test gate");
  console.log(`literals: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
