// Tests for the 2026-11-15 agent upgrades: spec digest, plan check, cut-off test file guard, empty-spec guard.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import * as A from "./agent.mjs";
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name); } };

// 1. spec digest: every test name appears, with its assert lines, built without a model
const spec = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        \"\"\"adds a book\"\"\"\n        self.assertEqual(1, 1)\n        self.assertIn('x', 'xy')\n        self.assertTrue(True)\n    def test_b(self):\n        self.assertNotEqual(1, 2)\n";
const d = A.lockedSpecDigest(spec);
check("digest lists both tests", d && d.total === 2 && d.shown === 2 && /test_a/.test(d.text) && /test_b/.test(d.text));
check("digest keeps docstring and only two asserts per test", /adds a book/.test(d.text) && !/assertTrue/.test(d.text));
check("digest respects its size cap", A.lockedSpecDigest(spec.repeat(1) + "    def test_c(self):\n        self.assertEqual(3, 3)\n", 80).shown < 3);
check("digest of a file without tests is null", A.lockedSpecDigest("x = 1\n") === null);

// 2. plan check
check("first step that only makes a runtime data file is dropped", A.dropDataFileSteps(["Create `library.json` with empty lists", "Implement add"], "Build a tracker. Save data in a JSON file.").length === 1);
check("data file named in the task is kept", A.dropDataFileSteps(["Create `config.json` with keys", "Implement add"], "Create config.json with keys a b").length === 2);
check("a code step is kept", A.dropDataFileSteps(["Create tracker.py", "Add tests"], "").length === 2);
check("a one-step plan is never emptied", A.dropDataFileSteps(["Create data.json"], "").length === 1);

// 3. authorOneTestFile guards (fake model)
async function author(content, rel = "test_x.py") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-upg-"));
  const logs = [];
  const fake = { root: tmp, task: "Build thing in thing.py", eta: { chat: async () => ({ content, finish: "length" }) }, stopped: false, contract: null,
    files: new Set(), createdFiles: new Set(), lockedFiles: new Set(), authoritativeTests: {}, testSnapshots: {}, gates: {}, baselineFiles: {},
    verifyAuthoredTests: async () => null, _captureBaseline: () => {} };
  const r = await A.Agent.prototype.authorOneTestFile.call(fake, rel, fake.task, (e) => logs.push(e.text || ""));
  return { r, fake, logs, exists: fs.existsSync(path.join(tmp, rel)), disk: fs.existsSync(path.join(tmp, rel)) ? fs.readFileSync(path.join(tmp, rel), "utf8") : "" };
}
const good = "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 1)\n\n    def test_b(self):\n";
const cutFile = good + "        \"\"\"Test that day 14\n";
const a1 = await author(cutFile);
check("cut-off test file: incomplete last test dropped, file compiles and is locked", a1.r === true && /test_a/.test(a1.disk) && !/test_b/.test(a1.disk) && a1.fake.lockedFiles.has("test_x.py"));
check("cut-off is reported in the log", a1.logs.some((t) => /cut off/.test(t)));
const a2 = await author("import unittest\nimport os\n");
check("a test file with no tests in it is not locked", a2.r === false && !a2.fake.lockedFiles.has("test_x.py"));
check("the empty file is removed", a2.exists === false);
// 4. writer: a refusal or a cut-off reply is never written; the second try (bigger limit) is used
async function writer(replies, rel = "thing.py") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-wr-")); let n = 0; const logs = []; const caps = [];
  const fake = { root: tmp, task: "t", plan: "p", files: new Set(), createdFiles: new Set(), lockedFiles: new Set(), gates: {}, baselineFiles: {},
    eta: { model: "m", numCtx: 8192, chat: async (m, a, b, cap) => { caps.push(cap); return replies[Math.min(n++, replies.length - 1)]; } },
    _captureBaseline: () => {}, unwrapActionJson: (c) => c, _lspNote: async () => "", checkpoint: null, onFileEdit: null, memory: null };
  const out = await A.Agent.prototype._writeFile.call(fake, { path: rel }, [], (e) => logs.push(e.text || ""), { autoApprove: true, approve: async () => true }, "");
  return { out, logs, caps, disk: fs.existsSync(path.join(tmp, rel)) ? fs.readFileSync(path.join(tmp, rel), "utf8") : null };
}
const F1 = "def f():\n    return 1\n", F2 = "def f():\n    return 2\n";
const w1 = await writer([{ content: "I cannot fulfill this request. The test file is incomplete.", finish: "stop" }, { content: F1, finish: "stop" }]);
check("a refusal text is not written, the second try is", String(w1.disk).trim() === F1.trim() && w1.logs.some((t) => /refusal/.test(t)));
const w2 = await writer([{ content: "def f():\n    ret", finish: "length" }, { content: F2, finish: "stop" }]);
check("a cut-off reply is not written, the retry has a bigger limit", String(w2.disk).trim() === F2.trim() && w2.caps[1] > w2.caps[0]);
const w3 = await writer([{ content: "I'm sorry, I can't help.", finish: "stop" }]);
check("two bad replies write nothing and say so", w3.disk === null && /twice/.test(String(w3.out)));
const w4 = await writer([{ content: '{"say":"x","tool":"write_file","args":{"path":"a.json"}}', finish: "stop" }, { content: '{"books": []}', finish: "stop" }], "a.json");
check("a tool call written as .json content is rejected", String(w4.disk).trim() === `{"books": []}`);
// 5. expected failures are not debt
const STEP = "Run `python library.py checkout 999 Alice` to verify rejection of unknown ID.";
check("an error case that fails with the program's own message is expected", A.isExpectedFailure(STEP, "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\nError: Book with id 999 not found"));
check("a crash trace is still a failure", !A.isExpectedFailure(STEP, "⚠ COMMAND FAILED (exit 1)\nTraceback (most recent call last):\n  File x\nNameError: name 'y' is not defined"));
check("a normal step that fails is still a failure", !A.isExpectedFailure("Create library.py and run python library.py list", "⚠ COMMAND FAILED (exit 1)\nError: cannot open data"));
check("a missing file is still a failure", !A.isExpectedFailure("verify rejection of bad input", "⚠ COMMAND FAILED\npython: can't open file 'x.py': [Errno 2] No such file or directory"));
// 6. test runner choice: no pytest on the PC -> run unittest files with the built-in unittest
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-run-"));
  fs.writeFileSync(path.join(tmp, "test_a.py"), "import unittest\n\nclass T(unittest.TestCase):\n    def test_x(self):\n        pass\n");
  fs.mkdirSync(path.join(tmp, "tests")); fs.writeFileSync(path.join(tmp, "tests", "test_b.py"), "import unittest\n");
  fs.writeFileSync(path.join(tmp, "test_p.py"), "def test_x():\n    assert True\n");
  check("no pytest + unittest file: built-in unittest", A.derivedTestCmd(tmp, ["test_a.py"], false) === "python -B -m unittest test_a");
  check("no pytest + file in a folder: dotted module name", A.derivedTestCmd(tmp, ["tests/test_b.py"], false) === "python -B -m unittest tests.test_b");
  check("pytest installed: pytest as before", A.derivedTestCmd(tmp, ["test_a.py"], true) === "python -B -m pytest test_a.py -q");
  check("a pytest-style file keeps pytest", A.derivedTestCmd(tmp, ["test_p.py"], false) === "python -B -m pytest test_p.py -q");
}
// 7. the command itself can mark an error case
check("a command with a 'nonexistent' file and the program's own error is expected", A.isExpectedFailure("Verify the script runs.", "COMMAND FAILED (exit 2)\nError: file 'nonexistent.csv' not found", "python csvstats.py nonexistent.csv value"));
check("the same output for a normal command is still a failure", !A.isExpectedFailure("Verify the script runs.", "COMMAND FAILED (exit 2)\nError: file 'data.csv' not found", "python csvstats.py data.csv value"));
check("an empty argument marks an error case", A.isExpectedFailure("Check it.", "COMMAND FAILED (exit 1)\nError: Title cannot be empty", 'python library.py add "" Author'));
// 8. "add a test" tasks
const BUG = "Bug report: 10 mugs got no discount. Please find and fix the bug, and add a test for it.";
check("task asks to add a test", A.taskAsksToAddTest(BUG));
check("'do not add a test' is not a request", !A.taskAsksToAddTest("Fix the bug. Do not add a test."));
check("a task without any test request", !A.taskAsksToAddTest("Fix the bug in cart.py."));
check("a missing test step is added at the end", A.ensureTestStep(["Fix cart.py", "Run the tests"], BUG, "tests/test_cart.py").length === 3 && /tests\/test_cart\.py/.test(A.ensureTestStep(["Fix cart.py", "Run the tests"], BUG, "tests/test_cart.py")[2]));
check("a plan that already adds a test is left alone", A.ensureTestStep(["Fix cart.py", "Add a test for the fix"], BUG).length === 2);
check("a task with no test request is left alone", A.ensureTestStep(["Fix cart.py"], "Fix the bug.").length === 1);
check("python builtins are not contract names", JSON.stringify(A.dropBuiltinNames(["sum", "len", "units", "add_item"])) === JSON.stringify(["units", "add_item"]));
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exitCode = fail ? 1 : 0;
