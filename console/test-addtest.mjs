// The test-adding step: ONE direct model call, the new tests appended by code. A fake model answer, real files. No GPU.
import { Agent } from "./agent.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const NL = String.fromCharCode(10);
const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-addtest-"));
fs.mkdirSync(path.join(d, "tests"));
const orig = ["import unittest", "from lib import fee", "", "", "class T(unittest.TestCase):", "    def test_old(self):", "        self.assertEqual(fee(0), 0)", ""].join(NL);
const tf = path.join(d, "tests", "test_x.py");
fs.writeFileSync(tf, orig);
fs.writeFileSync(path.join(d, "lib.py"), ["def fee(n):", "    return n * 0.25", ""].join(NL));
const mk = (reply) => { const a = Object.create(Agent.prototype); a.root = d; a.files = new Set(); a.gates = {}; a.memModel = "m"; a.baselineFiles = { "lib.py": ["def fee(n):", "    return n * 0.5", ""].join(NL) }; a.eta = { ask: async () => reply }; return a; };

const good = ["def test_old():", "    pass", "", "def test_fee_one_day():", "    assert 1 == 1", "", "def test_fee_three_days():", "    assert 3 == 3"].join(NL);
const a = mk("```python" + NL + "Here you go:" + NL + good + NL + "```");
const ok = await a._appendTestsByCall("fix the fee", "tests/test_x.py", 2, () => {});
const after = fs.readFileSync(tf, "utf8");
t(ok === true && /test_fee_one_day/.test(after) && /test_fee_three_days/.test(after) && after.startsWith(orig.trim()), "new tests are appended and the old file stays");
t(/test_old_new/.test(after), "a test name that already exists is renamed, never overwritten");
t(a.files.has("tests/test_x.py"), "the test file counts as written");

fs.writeFileSync(tf, orig);
t((await mk("I cannot do that")._appendTestsByCall("x", "tests/test_x.py", 1, () => {})) === false, "no test in the reply: nothing written");
t((await mk("def test_bad(:" + NL + "    pass")._appendTestsByCall("x", "tests/test_x.py", 1, () => {})) === false && fs.readFileSync(tf, "utf8") === orig, "broken code is not kept, the file is put back");
t((await mk("def test_a():" + NL + "    pass")._appendTestsByCall("x", "tests/missing.py", 1, () => {})) === false, "a missing test file is not created here");
fs.rmSync(d, { recursive: true, force: true });

const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/viaCall = await this\._appendTestsByCall\(task, tf, wantTests, emit\)/.test(src), "the add-test step tries the direct call first");
console.log(`addtest: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
