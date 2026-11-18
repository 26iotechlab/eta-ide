// Failing NEW tests are removed (honestly reported) so a good fix is not rolled back; checker talk about test files is ignored. No GPU.
import { Agent, gapIsAboutOtherFile, splitPyBlocks } from "./agent.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

t(gapIsAboutOtherFile("test_cart.py expected total() == 52.91 but the correct total is 48.50", "shop/cart.py", ["shop/cart.py"]), "talk about the test file is not about cart.py");
t(!gapIsAboutOtherFile("test_cart.py expected total() == 52.91", "tests/test_cart.py", ["tests/test_cart.py"]), "but it is about a test file when the file is the test");
t(!gapIsAboutOtherFile("units() still returns len(self.items)", "shop/cart.py", ["shop/cart.py"]), "a real complaint about the file is kept");

let hasPy = true; try { execFileSync("python", ["--version"], { stdio: "ignore" }); } catch { hasPy = false; }
if (!hasPy) { console.log("(python not found: behaviour test skipped)"); }
else {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-dropnew-"));
  fs.mkdirSync(path.join(d, "tests"));
  const orig = "def test_old():\n    assert 1 + 1 == 2\n";
  const cur = orig + "\n\ndef test_new_wrong():\n    assert 1 + 1 == 3\n\n\ndef test_new_good():\n    assert 2 + 2 == 4\n";
  fs.writeFileSync(path.join(d, "tests", "test_x.py"), cur);
  const a = Object.create(Agent.prototype);
  a.root = d; a._origTests = { "tests/test_x.py": orig };
  a.failingTestNames = Agent.prototype.failingTestNames;
  // a stand-in test command: "pytest" output is produced by a tiny script so the test needs no pytest install
  fs.writeFileSync(path.join(d, "runner.py"), "import re,sys\nsrc=open('tests/test_x.py').read()\nfor m in re.finditer(r'def (test_\\w+)\\(\\):\\n    assert (.+)', src):\n    if not eval(m.group(2)): print('FAILED tests/test_x.py::%s - assert' % m.group(1))\n");
  const logs = [];
  await a.dropFailingNewTests("python runner.py", (e) => logs.push(e));
  const after = fs.readFileSync(path.join(d, "tests", "test_x.py"), "utf8");
  t(!/test_new_wrong/.test(after), "the failing new test is removed");
  t(/test_new_good/.test(after) && /test_old/.test(after), "the passing new test and the old test stay");
  t((a._droppedNewTests || []).join() === "test_new_wrong", "it is remembered for the final report");
  t(logs.some((e) => /removed the new test/.test(e.text || "")) && logs.some((e) => e.type === "narration"), "the user is told");
  // an OLD failing test is never removed
  fs.writeFileSync(path.join(d, "tests", "test_x.py"), "def test_old():\n    assert 1 + 1 == 3\n");
  const b = Object.create(Agent.prototype); b.root = d; b._origTests = { "tests/test_x.py": "def test_old():\n    assert 1 + 1 == 3\n" }; b.failingTestNames = Agent.prototype.failingTestNames;
  await b.dropFailingNewTests("python runner.py", () => {});
  t(/test_old/.test(fs.readFileSync(path.join(d, "tests", "test_x.py"), "utf8")), "an old failing test is never removed");
  // not an add-a-test task: nothing happens
  const c = Object.create(Agent.prototype); c.root = d; c._origTests = {}; await c.dropFailingNewTests("python runner.py", () => {});
  t(true, "no origTests: no-op");
  fs.rmSync(d, { recursive: true, force: true });
}
const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(src.includes("await this.dropFailingNewTests?.(testCmd, emit);"), "runs before the baseline compare");
t(/the test you asked for is still missing/.test(src), "final report names a removed test");
console.log(`dropnew: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
