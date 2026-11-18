// False alarms on a project that is actually right (live task 09): wrong NEW tests must never make the engine "fix" correct code,
// and stale failures / an unconfirmed reviewer opinion must not be reported as a failing project. Real python, fake model answers. No GPU.
import { Agent } from "./agent.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const NL = String.fromCharCode(10);
let hasPy = true; try { execFileSync("python", ["--version"], { stdio: "ignore" }); } catch { hasPy = false; }
const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");

if (!hasPy) console.log("(python not found: behaviour tests skipped)");
else {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-fa-"));
  fs.mkdirSync(path.join(d, "tests"));
  fs.writeFileSync(path.join(d, "lib.py"), ["def fee(n):", "    return n * 0.25", ""].join(NL));
  const orig = ["from lib import fee", "", "", "def test_old():", "    assert fee(0) == 0", ""].join(NL);
  const withNew = orig + ["", "", "def test_new_wrong():", "    assert fee(1) == 0.5", "", "", "def test_new_good():", "    assert fee(2) == 0.5", ""].join(NL);
  const tf = path.join(d, "tests", "test_x.py");
  // stand-in runner: prints pytest-style FAILED lines
  fs.writeFileSync(path.join(d, "runner.py"), ["import re,sys", "sys.path.insert(0,'.')", "from lib import fee", "src=open('tests/test_x.py').read()", "bad=0", "for m in re.finditer(r'def (test_\\w+)\\(\\):\\n    assert (.+)', src):", "    if not eval(m.group(2)): print('FAILED tests/test_x.py::%s - assert' % m.group(1)); bad+=1", "if bad: print('COMMAND FAILED')", ""].join(NL));
  const mk = (reply) => {
    const a = Object.create(Agent.prototype);
    a.root = d; a._origTests = { "tests/test_x.py": orig }; a.files = new Set(); a.gates = {}; a.memModel = "m"; a.task = "fix the fee";
    a.failedCmds = new Map([["python runner.py", true], ["rm -rf x && python -m pytest tests/test_x.py -v", true]]);
    a.eta = { ask: async () => reply };
    a.failingTestNames = Agent.prototype.failingTestNames;
    return a;
  };
  const failOut = "FAILED tests/test_x.py::test_new_wrong - assert" + NL + "COMMAND FAILED";

  // 1. a good rewrite replaces only the failing new test
  fs.writeFileSync(tf, withNew);
  const a = mk("```python" + NL + "def test_new_wrong():" + NL + "    assert fee(1) == 0.25" + NL + "```");
  const ok = await a._regenFailingNewTests(failOut, ["test_new_wrong"], () => {});
  const after = fs.readFileSync(tf, "utf8");
  t(ok === true && /assert fee\(1\) == 0\.25/.test(after) && !/fee\(1\) == 0\.5/.test(after), "the failing new test is rewritten from the real output");
  t(/test_new_good/.test(after) && /test_old/.test(after), "the other tests are untouched");
  // 2. a useless reply changes nothing
  fs.writeFileSync(tf, withNew);
  t((await mk("sorry, no")._regenFailingNewTests(failOut, ["test_new_wrong"], () => {})) === false && fs.readFileSync(tf, "utf8") === withNew, "a reply without the tests changes nothing");
  // 3. second time only new tests fail: they are removed and the code is never touched
  fs.writeFileSync(tf, withNew);
  const b = mk("x"); b._newTestRepaired = true;
  const logs = [];
  const r = await b.repairNewTestOnly(failOut, {}, (e) => logs.push(e), "sys", "python runner.py");
  const after3 = fs.readFileSync(tf, "utf8");
  t(r === true && !/test_new_wrong/.test(after3) && /test_new_good/.test(after3) && /test_old/.test(after3), "second time: the bad new test is removed, good and old tests stay");
  t(fs.readFileSync(path.join(d, "lib.py"), "utf8").includes("0.25"), "the source code is never touched");
  t(b.failedCmds.size === 0 && b._finalGreen === true, "after the tests pass, earlier failed runs no longer count as failing");
  // 4. an OLD test failing is a real code problem: not handled here
  const c = mk("x"); const oldFail = "FAILED tests/test_x.py::test_old - assert";
  t((await c.repairNewTestOnly(oldFail, {}, () => {}, "sys", "python runner.py")) === false, "an old failing test is left to the normal repair");
  fs.rmSync(d, { recursive: true, force: true });
}
t(/reviewer opinion \(NOT confirmed - every test passes\)/.test(src), "a reviewer opinion that every test contradicts is labelled as unconfirmed");
t(/this\._newTestRepaired = false; this\._finalGreen = false/.test(src), "per-run flags start clean");
t(/before any lever can touch the code/.test(src) && /new-test check before the repair ladder failed/.test(src), "the repair ladder is never reached when only new tests fail");
console.log(`falsealarm: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
