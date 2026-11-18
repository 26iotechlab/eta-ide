// Revert only the file that broke a test; keep the good fixes. Real python + pytest-style runner, no model, no GPU.
import { Agent, dropBuiltinNames } from "./agent.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
t(dropBuiltinNames(["return", "self", "if", "bulk_discount"]).join() === "bulk_discount", "python words are never names a file must define");
let hasPy = true; try { execFileSync("python", ["--version"], { stdio: "ignore" }); } catch { hasPy = false; }
if (!hasPy) console.log("(python not found: behaviour test skipped)");
else {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-guilty-"));
  const w = (f, s) => fs.writeFileSync(path.join(d, f), s);
  const base = { "a.py": "def fa():\n    return 1\n", "b.py": "def fb():\n    return 2\n", "c.py": "def fc():\n    return 3\n" };
  for (const [f, s] of Object.entries(base)) w(f, s);
  // stand-in runner prints pytest-like lines
  w("runner.py", "import importlib,sys\nsys.path.insert(0,'.')\nres=[]\nfor n,exp in (('a',1),('b',2),('c',3)):\n    m=importlib.import_module(n); v=getattr(m,'f'+n)()\n    print(('PASSED' if v==exp else 'FAILED')+' test_'+n)\nprint('%d passed, %d failed' % (sum(1 for _ in []),0))\n");
  const a = Object.create(Agent.prototype);
  a.root = d; a.baselineFiles = { ...base }; a.baselineGood = 3; a.baselineFails = 0; a.gates = {}; a.files = new Set(["a.py", "b.py", "c.py"]);
  a._goodness = (o) => (String(o).match(/^PASSED/gm) || []).length; a._failCount = (o) => (String(o).match(/^FAILED/gm) || []).length;
  // the run improved nothing in a.py but changed it harmlessly, broke b.py, and changed c.py harmlessly
  w("a.py", "def fa():\n    return 1  # fixed\n"); w("b.py", "def fb():\n    return 99\n"); w("c.py", "def fc():\n    return 3  # fixed\n");
  const logs = [];
  const ok = await a._revertGuiltyOnly("python runner.py", (e) => logs.push(e), 2, 1);
  t(ok === true, "the guilty file is found and the project is no longer worse");
  t(fs.readFileSync(path.join(d, "b.py"), "utf8") === base["b.py"], "the guilty file is put back");
  t(/fixed/.test(fs.readFileSync(path.join(d, "a.py"), "utf8")) && /fixed/.test(fs.readFileSync(path.join(d, "c.py"), "utf8")), "the good changes stay");
  t(logs.some((e) => /baseline-restore \(partial\): reverted only b\.py/.test(e.text || "")) && !a.files.has("b.py") && a.files.has("a.py"), "the report names the reverted file and keeps the rest in the written list");
  // two files broken at once: single reverts cannot fix it, so the caller does the full restore
  w("a.py", "def fa():\n    return 10\n"); w("b.py", "def fb():\n    return 99\n");
  const ok2 = await a._revertGuiltyOnly("python runner.py", () => {}, 1, 2);
  t(ok2 === true || ok2 === false, "two broken files do not crash");
  // only one changed file: nothing to isolate
  for (const [f, s] of Object.entries(base)) w(f, s); w("b.py", "def fb():\n    return 99\n");
  t((await a._revertGuiltyOnly("python runner.py", () => {}, 2, 1)) === false, "a single changed file is left to the normal full restore");
  fs.rmSync(d, { recursive: true, force: true });
}

const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/await this\._revertGuiltyOnly\(testCmd, emit, finalGood, finalFails\)/.test(src), "restoreBaselineIfWorse tries the one-file revert first");
t(/time budget: raised to/.test(src) && /todo \* 4 \* 60000/.test(src), "the time ceiling grows with the number of files");
t(/second look: \$\{miss\.join/.test(src) && /STILL MISSING \(the first pass/.test(src), "a second look asks again for names the contract needs but nobody defined");
console.log(`guilty: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
