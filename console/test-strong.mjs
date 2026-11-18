// test-strong.mjs: engine hardening from the first public benchmark (2026-11-16, 6 JS tasks, 1 pass).
// NO real model, NO GPU. Real temp folders, real test runners (jest from the benchmark folder, python unittest/pytest, node --test),
// and one FAKE local model server that drives the REAL agent end to end (like test-repair-loop.mjs).
//   1. RED GATE: a run may only say "done" when the last real test run is green AND a file changed.
//   2. NO DRAFT IS LOST: a restore keeps the overwritten draft in .eta/drafts/<file>.<n>.
//   3. ONLY MEASUREMENTS TRIGGER ACTIONS: a "parse error" claim is re-measured before it may cause a repair.
//   4. TEST LANGUAGE MATCHES THE PROJECT: no Python test file in a JavaScript project (and no wrong-language spec).
//   6. REAL FAILURE TEXT: extractFailures() reads jest/vitest/mocha/node:test/pytest/unittest/go/cargo/maven output.
//   8. PER-PHASE TIME BUDGET: optional phases stop at 35% of the budget before the first write.
// Run: node test-strong.mjs
import fs from "fs"; import os from "os"; import path from "path"; import http from "http";
import { fileURLToPath } from "url";
import { extractFailures, failuresBlock, countFailing } from "./failtext.mjs";
import { snapshotCode, changedSince, redGateVerdict, claimKind, testLangOf, projectTestLangs, wrongLanguageTest, testsAlreadyGiven, saveDrafts, Watchdog } from "./watchdog.mjs";
import { Agent, setProvider, provider, summarizeTests, execTool } from "./agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "test-strong-fixtures");
const BENCH = "D:\\eta-ide\\dev-scratch\\bench";
let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.substring(0, 600) + ")"}`); };
const fx = (f) => fs.readFileSync(path.join(FIX, f), "utf8");
const NL = String.fromCharCode(10);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), "eta-strong-" + p + "-"));
const w = (root, f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const n of fs.readdirSync(a, { withFileTypes: true })) { const s = path.join(a, n.name), d = path.join(b, n.name); if (n.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d); } };
const HAVE_JEST = fs.existsSync(path.join(BENCH, "node_modules", "jest")) && fs.existsSync(path.join(BENCH, "tasks-poly", "js-phone-number", "start"));
// a jest project copy: must live under the bench folder so node_modules resolve from there
function jestCopy(task, name) {
  const d = path.join(BENCH, "vtmp", "strongtest-" + name + "-" + process.pid);
  fs.rmSync(d, { recursive: true, force: true });
  copyDir(path.join(BENCH, "tasks-poly", task, "start"), d);
  return d;
}

console.log("6. extractFailures on REAL saved outputs (made by running the real runners, see test-strong-fixtures/)");
{
  const a = extractFailures(fx("jest-nan.txt"));
  ok(a.length === 2 && a[0].expected === "2" && a[0].received === "NaN", "jest: 'Expected: 2 Received: NaN' read exactly", a[0]);
  ok(a[1].expected === '"Denominator must not be zero"' && a[1].received === '"nope"', "jest: toThrow('...') expected and received message read exactly", a[1]);
  ok(a[0].line === "ratio.spec.js:3", "jest: the line is the test's file:line, not node_modules", a[0].line);
  const p = extractFailures(fx("jest-phone-partial.txt"));
  ok(p[0].expected === '"Incorrect number of digits"' && p[0].received === '"wrong length"', "jest (phone-number): toThrow(new Error('...')) message pair", p[0]);
  ok(p[1].received === "(the function did not throw)" && p[1].expected === '"11 digits must start with 1"', "jest: 'Received function did not throw' is reported as such", p[1]);
  ok(/Phone Number › Cleanup user-entered phone numbers › invalid when 9 digits/.test(p[0].name), "jest: full test name kept", p[0].name);
  const s = extractFailures(fx("jest-phone-stub.txt"));
  ok(s[0].message === "Remove this statement and implement this function" && s[0].line === "phone-number.js:7", "jest stub: the thrown stub message and the stub's line", s[0]);
  const ps = extractFailures(fx("jest-phone-parse.txt"));
  ok(ps.length === 1 && /^SyntaxError: .*Unexpected token \(2:25\)$/.test(ps[0].message) && ps[0].line === "phone-number.js:2", "jest: 'Test suite failed to run' gives the SyntaxError and file:line", ps[0]);
  const py = extractFailures(fx("pytest-listops-stub.txt"));
  ok(py.length === 2 && py[0].received === "None" && py[0].expected === "[1, 2, 3, 4]" && py[0].line === "list_ops_test.py:27", "pytest (unittest-style asserts): None != [1, 2, 3, 4] with file:line", py[0]);
  const pp = extractFailures(fx("pytest-plain.txt"));
  ok(pp[0].received === "-1" && pp[0].expected === "5" && pp[0].line === "test_calc.py:4", "pytest plain assert: assert -1 == 5", pp[0]);
  ok(pp[1].expected === "'bad token'" && pp[1].received === "'wrong message'", "pytest.raises(match=...): expected regex and actual message", pp[1]);
  const ut = extractFailures(fx("unittest-listops-stub.txt"));
  ok(ut[0].name === "test_append_empty_list_to_list" && ut[0].received === "None" && ut[0].line === "list_ops_test.py:27", "unittest: name, values and the test line (not unittest/case.py)", ut[0]);
  const nt = extractFailures(fx("nodetest-math.txt"));
  ok(nt[0].name === "adds two numbers" && nt[0].expected === "2" && nt[0].received === "0" && nt[0].line === "math.test.mjs:4", "node:test spec reporter: 0 !== 2", nt[0]);
  ok(/Missing expected exception/.test(nt[1].message) && nt[1].expected === "{ message: 'bad input' }", "node:test: assert.throws message", nt[1]);
  ok(extractFailures(fx("jest-nan.txt"), 1).length === 1, "max limits the count");
  const blk = failuresBlock(fx("jest-nan.txt"));
  ok(/^FIRST FAILING TESTS/.test(blk) && /expected: 2\n\s+received: NaN/.test(blk) && /expected: "Denominator must not be zero"/.test(blk), "failuresBlock: exact strings at the top", blk);
  ok(countFailing(fx("jest-phone-partial.txt")) === 15 && countFailing(fx("jest-nan.txt")) === 2, "countFailing reads jest's Tests line (15), not the suite line (1)", [countFailing(fx("jest-phone-partial.txt"))]);
  ok(countFailing(fx("unittest-listops-stub.txt")) === 24 && countFailing(fx("pytest-plain.txt")) === 2 && countFailing(fx("nodetest-math.txt")) === 2, "countFailing: unittest 24, pytest 2, node:test 2");
  const sj = summarizeTests(fx("jest-phone-partial.txt"));
  ok(sj && sj.pass === 3 && sj.fails === 15 && sj.total === 18, "summarizeTests (agent.mjs) now reads jest's Tests line: 3 passed, 15 failed", sj);
}

console.log("6b. extractFailures on hand-written samples (runner not installed here: vitest, mocha, TAP, go, cargo, maven)");
{
  // These follow each runner's documented output format; they are NOT captured from a real run on this PC.
  const vitest = [" FAIL  src/sum.test.js > sum > adds", "AssertionError: expected 3 to be 4 // Object.is equality", "", "- Expected", "+ Received", "", "- 4", "+ 3", "", " ❯ src/sum.test.js:5:20", "", "⎯⎯⎯⎯⎯⎯⎯⎯⎯", " Test Files  1 failed (1)", "      Tests  1 failed (1)"].join(NL);
  const v = extractFailures(vitest);
  ok(v[0] && v[0].received === "3" && /^4/.test(v[0].expected) && v[0].line === "sum.test.js:5", "vitest: expected 3 to be 4", v[0]);
  const mocha = ["  Calc", "    1) adds", "", "  0 passing (5ms)", "  1 failing", "", "  1) Calc", "       adds:", "", "      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "3 !== 4", "", "      + expected - actual", "      at Context.<anonymous> (test/calc.test.js:5:12)"].join(NL);
  const m = extractFailures(mocha);
  ok(m[0] && m[0].received === "3" && m[0].expected === "4" && m[0].line === "calc.test.js:5" && /Calc adds/.test(m[0].name), "mocha: 3 !== 4 with name and line", m[0]);
  const tap = ["TAP version 13", "not ok 1 - adds", "  ---", "  duration_ms: 1.2", "  location: 'D:\\p\\math.test.mjs:4:1'", "  failureType: 'testCodeFailure'", "  error: |-", "    Expected values to be strictly equal:", "  expected: 2", "  actual: 0", "  ...", "ok 2 - other"].join(NL);
  const t = extractFailures(tap);
  ok(t[0] && t[0].name === "adds" && t[0].expected === "2" && t[0].received === "0" && t[0].line === "math.test.mjs:4", "node:test TAP: not ok + yaml expected/actual", t[0]);
  const go = ["=== RUN   TestAdd", "--- FAIL: TestAdd (0.00s)", "    add_test.go:12: Add(1, 1) = 3; want 2", "FAIL", "FAIL\texample.com/m\t0.002s"].join(NL);
  const g = extractFailures(go);
  ok(g[0] && g[0].name === "TestAdd" && g[0].line === "add_test.go:12" && /want 2/.test(g[0].message), "go test: name, file:line and message", g[0]);
  const go2 = extractFailures("--- FAIL: TestX (0.00s)\n    x_test.go:9: got 5, want 7\nFAIL");
  ok(go2[0].received === "5" && go2[0].expected === "7", "go test: got/want pair", go2[0]);
  const cargo = ["running 1 test", "test tests::adds ... FAILED", "", "failures:", "", "---- tests::adds stdout ----", "thread 'tests::adds' panicked at src/lib.rs:10:9:", "assertion `left == right` failed", "  left: 3", " right: 4", "", "failures:", "    tests::adds", "", "test result: FAILED. 0 passed; 1 failed; 0 ignored"].join(NL);
  const c = extractFailures(cargo);
  ok(c[0] && c[0].name === "tests::adds" && c[0].received === "3" && c[0].expected === "4" && c[0].line === "lib.rs:10", "cargo test: left/right and the panic line", c[0]);
  ok(countFailing(cargo) === 1, "countFailing: cargo");
  const mvn = ["[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0", "[ERROR] testAdd(com.x.CalcTest)  Time elapsed: 0.01 s  <<< FAILURE!", "org.opentest4j.AssertionFailedError: expected: <4> but was: <3>", "\tat com.x.CalcTest.testAdd(CalcTest.java:12)"].join(NL);
  const j = extractFailures(mvn);
  ok(j[0] && j[0].name === "CalcTest.testAdd" && j[0].expected === "4" && j[0].received === "3" && j[0].line === "CalcTest.java:12", "maven/junit: expected <4> but was <3> and the line", j[0]);
  const fb = extractFailures("weird output\nline two\nboom");
  ok(fb.length === 1 && fb[0].fallback && /boom/.test(fb[0].message), "unknown format: falls back to the last lines", fb);
  const long = Array.from({ length: 80 }, (_, i) => "line " + i).join(NL);
  ok(extractFailures(long)[0].message.split(NL).length === 30, "fallback keeps the last 30 lines");
  ok(Array.isArray(extractFailures(null)) && extractFailures("").length === 0 && failuresBlock(undefined) === "", "no input: empty, never throws");
  ok(/^LAST LINES OF THE REAL TEST OUTPUT/.test(failuresBlock("x\ny")), "failuresBlock fallback is labelled honestly");
}

console.log("1. RED GATE verdict (pure)");
{
  const a = redGateVerdict({ testCmd: "npm test", green: false, fails: 13, changeKnown: true, changedImpl: false });
  ok(!a.ok && a.status === "not-done" && a.text === "NOT DONE: tests still failing (13 failing); NOT DONE: no file was changed", "red + untouched stub: both facts said plainly", a);
  const b = redGateVerdict({ testCmd: "npm test", green: false, fails: 7, changedImpl: true });
  ok(b.code === "tests-failing" && b.text === "NOT DONE: tests still failing (7 failing)", "red + changed", b);
  const c = redGateVerdict({ testCmd: "npm test", green: true, changedImpl: false, changedTests: true });
  ok(c.code === "no-change" && /only test files were/.test(c.text), "green but only a test file changed (task needed source): NOT DONE", c);
  ok(redGateVerdict({ testCmd: "x", green: true, changedImpl: false, changedTests: true, testOnlyTask: true }).ok, "a test-only task may change only tests");
  ok(redGateVerdict({ testCmd: "npm test", green: true, changedImpl: true }).status === "done", "green + changed: done");
  const d = redGateVerdict({ testCmd: "pytest", couldNotRun: "the test runner is not installed on this PC", changedImpl: true });
  ok(d.code === "tests-could-not-run" && /^NOT DONE: tests could not run/.test(d.text), "tests could not run: its own status", d);
  const e = redGateVerdict({ testCmd: "", changedImpl: true });
  ok(e.ok && e.code === "no-tests" && /not checked by tests/.test(e.text), "no test command: done, but labelled unverified (not NOT DONE: precision first)", e);
  ok(redGateVerdict({ testCmd: "x", green: true, changeKnown: false, changedImpl: false }).ok, "change not known (huge repo): never flagged 'no change'");
  ok(redGateVerdict({ testCmd: "x", green: false, fails: Infinity, changedImpl: true }).text === "NOT DONE: tests still failing (some failing)", "unknown count: 'some'");
  const pe = redGateVerdict({ testCmd: "x", green: false, fails: 1, preFails: 1, preExisting: true, changedImpl: true });
  ok(pe.ok && pe.code === "done-preexisting-failures" && /already failed before this run/.test(pe.text), "suite red BEFORE the run, not worse, run changed code: not charged (said plainly)", pe);
  const pw = redGateVerdict({ testCmd: "x", green: false, fails: 3, preFails: 1, preExisting: true, changedImpl: true });
  ok(!pw.ok && pw.text === "NOT DONE: tests still failing (3 failing); 1 were already failing at the start", "pre-existing red but WORSE: NOT DONE", pw.text);
  ok(!redGateVerdict({ testCmd: "x", green: false, fails: 1, preFails: 1, preExisting: true, changedImpl: false }).ok, "pre-existing red and nothing changed: NOT DONE");
  ok(countFailing("all good\n3 errors found in the input\nOK") === null && countFailing("== 2 failed, 1 passed in 0.15s ==") === 2, "countFailing reads only a runner's summary line, not program text");
  const before = new Map([["a.js", "1"], ["b.js", "2"]]), after = new Map([["a.js", "1"], ["b.js", "3"], ["c.js", "x"]]);
  ok(JSON.stringify(changedSince(before, after)) === '["b.js","c.js"]' && changedSince(before, new Map([["a.js", "1"]])).includes("b.js"), "changedSince: edited, new and deleted files");
}

console.log("3/4. claims, test languages (pure + real folders)");
{
  ok(claimKind("The test suite fails to run because Jest cannot parse the ESM syntax") !== "", "benchmark reviewer text is a measurable claim", claimKind("The test suite fails to run because Jest cannot parse the ESM syntax"));
  ok(claimKind("tests fail for negative input") === "tests", "a 'tests fail' claim");
  ok(claimKind("there is a jest parse error in x.js") === "compile" && claimKind("SyntaxError: unexpected token") === "compile" && claimKind("the file does not compile") === "compile", "compile claims");
  ok(claimKind("clean() should strip the country code") === "", "a logic remark is not a measurable claim (left alone)");
  ok(testLangOf("a/b.spec.js") === "javascript" && testLangOf("test_x.py") === "python" && testLangOf("x_test.go") === "go" && testLangOf("README.md") === "", "testLangOf");
  ok(testsAlreadyGiven("Edit this file: rest-api.js (it contains only a starting stub). The test file rest-api.spec.js is already in this folder: do NOT change it"), "benchmark wording: tests already given");
  ok(!testsAlreadyGiven("Write a function add(a, b) and tests for it."), "a task that asks for tests: not given");
  if (HAVE_JEST) {
    const js = jestCopy("js-rest-api", "langs");
    const L = await projectTestLangs(js);
    ok(L.allowed.has("javascript") && !L.allowed.has("python") && L.primary === "javascript", "rest-api project: JavaScript only", { a: [...L.allowed], p: L.primary });
    const why = wrongLanguageTest("test_main.py", L);
    ok(/^REFUSED: test_main\.py is a python test file, but this is a javascript project/.test(why) && /\.test\.js or <name>\.spec\.js/.test(why), "test_main.py in a JS project: refused, names the right language and pattern", why);
    ok(wrongLanguageTest("rest-api.test.js", L) === "" && wrongLanguageTest("helper.py", L) === "", "a JS test and a non-test .py file are not refused");
    fs.rmSync(js, { recursive: true, force: true });
  }
  const py = tmp("pylang"); w(py, "calc.py", "def add(a, b):\n    return a + b\n"); w(py, "test_calc.py", "import unittest\n");
  const LP = await projectTestLangs(py);
  ok(/REFUSED: calc\.spec\.js is a javascript test file/.test(wrongLanguageTest("calc.spec.js", LP)), "calc.spec.js in a Python project: refused");
  const mixed = tmp("mixed"); w(mixed, "package.json", "{}"); w(mixed, "tool.py", "x = 1\n");
  ok(wrongLanguageTest("test_tool.py", await projectTestLangs(mixed)) === "", "mixed project (package.json + Python source): Python tests allowed");
  const empty = tmp("empty");
  ok(wrongLanguageTest("test_x.py", await projectTestLangs(empty)) === "", "empty folder: nothing is refused");
  for (const d of [py, mixed, empty]) fs.rmSync(d, { recursive: true, force: true });
}

console.log("2. drafts are kept (pure + watchdog best-state restore)");
{
  const d = tmp("drafts");
  const s1 = await saveDrafts(d, [{ rel: "src/a.js", content: "draft one" }]);
  const s2 = await saveDrafts(d, [{ rel: "src/a.js", content: "draft two" }]);
  const s3 = await saveDrafts(d, [{ rel: "src/a.js", content: "draft one" }, { rel: "b.py", content: "  " }]);
  ok(s1[0] === ".eta/drafts/src__a.js.1" && s2[0] === ".eta/drafts/src__a.js.2" && s3.length === 1 && s3[0] === s1[0], "numbered drafts; the same text is saved once; empty text is skipped", [s1, s2, s3]);
  ok(fs.readFileSync(path.join(d, ".eta", "drafts", "src__a.js.2"), "utf8") === "draft two", "draft text kept exactly");
  // the watchdog's best-state restore calls keep() with the files it is about to overwrite, BEFORE writing
  w(d, "m.js", "best"); const wd = new Watchdog(); await wd.capture(d, { good: 5, fails: 0 });
  w(d, "m.js", "worse draft");
  let seen = null; const got = await wd.restoreBestIfWorse(d, { good: 1, fails: 4 }, () => {}, () => false, async (ps) => { seen = { ps, text: fs.readFileSync(path.join(d, "m.js"), "utf8") }; });
  ok(got && seen && seen.ps.includes("m.js") && seen.text === "worse draft" && fs.readFileSync(path.join(d, "m.js"), "utf8") === "best", "best-state restore: keep() sees the draft before it is overwritten", seen);
  fs.rmSync(d, { recursive: true, force: true });
}

// ---- agent methods on real folders (no model call happens in any of these) ----
const STUB = "def add(a, b):\n    raise NotImplementedError('Remove this statement and implement this function')\n";
const GOOD = "def add(a, b):\n    return a + b\n";
const TESTS = "import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_neg(self):\n        self.assertEqual(add(-1, 1), 0)\n\nif __name__ == '__main__':\n    unittest.main()\n";
const UCMD = 'python -B -m unittest discover -p "test*.py"';
function pyProject(name, impl = STUB) { const d = tmp(name); w(d, "calc.py", impl); w(d, "test_calc.py", TESTS); return d; }
const quiet = () => {};

console.log("1. RED GATE on real folders (agent.finalTruth)");
{
  if (HAVE_JEST) {
    const js = jestCopy("js-phone-number", "red");
    const ag = new Agent(js, { model: "fake", numCtx: 16384 }); ag.task = "Implement phone-number.js"; ag._startSnap = await snapshotCode(js);
    const logs = []; const v = await ag.finalTruth("npm test --silent", (e) => logs.push(e));
    ok(v && !v.ok && v.status === "not-done" && v.text === "NOT DONE: tests still failing (18 failing); NOT DONE: no file was changed", "jest, untouched stub: NOT DONE with the real count (18) and 'no file was changed'", v && v.text);
    ok(ag.failedCmds.has("npm test --silent"), "the failing command flag now agrees with the real state (memory cannot say PASSED)");
    ok(logs.some((e) => /^final status: NOT DONE/.test(e.text || "")), "logged");
    const mem = ag.memory.groundTruthFacts("t", Object.assign(ag, { testCmd: "npm test --silent" }));
    ok(!/Test command that PASSED/.test(mem) && /still failing at the end/.test(mem), "memory note: not 'PASSED' for a red run", mem);
    fs.rmSync(js, { recursive: true, force: true });
  } else ok(true, "SKIPPED jest red-gate check (benchmark folder not present)");
  const p = pyProject("rg1"); const ag = new Agent(p, { model: "fake", numCtx: 16384 }); ag.task = "make add work"; ag._startSnap = await snapshotCode(p);
  w(p, "calc.py", GOOD); ag.failedCmds.set(UCMD, true);
  const v = await ag.finalTruth(UCMD, quiet);
  ok(v.ok && v.status === "done" && v.code === "done" && !ag.failedCmds.has(UCMD), "python: green + changed: done, stale failing flag cleared", v);
  w(p, "calc.py", "def add(a, b):\n    return a - b\n");
  const v2 = await ag.finalTruth(UCMD, quiet);
  ok(!v2.ok && v2.text === "NOT DONE: tests still failing (2 failing)", "python: changed but red", v2.text);
  const v3 = await ag.finalTruth("eta_no_such_runner_xyz --run", quiet);
  ok(!v3.ok && v3.code === "tests-could-not-run" && /tests could not run/.test(v3.text), "a test command that cannot run: 'tests could not run'", v3);
  fs.rmSync(p, { recursive: true, force: true });
  const n = tmp("notests"); w(n, "hello.py", "print('hi')\n");
  const ag2 = new Agent(n, { model: "fake", numCtx: 16384 }); ag2.task = "say hi"; ag2._startSnap = await snapshotCode(n);
  w(n, "hello.py", "print('hello')\n");
  const v4 = await ag2.finalTruth(null, quiet);
  ok(v4.ok && v4.code === "no-tests", "no test command anywhere: done but 'not checked by tests'", v4);
  w(n, "README.md", "x"); ag2.files.add("README.md"); ag2.createdFiles.add("README.md");
  const ag3 = new Agent(n, { model: "fake", numCtx: 16384 }); ag3.task = "write a README"; ag3._startSnap = await snapshotCode(n);
  fs.writeFileSync(path.join(n, "NOTES.md"), "new"); ag3.files.add("NOTES.md"); ag3.createdFiles.add("NOTES.md");
  const v5 = await ag3.finalTruth(null, quiet);
  ok(v5.ok, "a new non-code file (outside the code snapshot) counts as a change", v5);
  fs.rmSync(n, { recursive: true, force: true });
}

console.log("2. restoreBaselineIfWorse keeps the draft (real python run)");
{
  const p = pyProject("rb", GOOD.replace("a + b", "a + b if a else b"));
  const ag = new Agent(p, { model: "fake", numCtx: 16384 }); ag.task = "x";
  ag.baselineFiles = { "calc.py": fs.readFileSync(path.join(p, "calc.py"), "utf8") };
  await ag.snapshotBaseline(UCMD); ag.baselineFiles["calc.py"] = fs.readFileSync(path.join(p, "calc.py"), "utf8");
  const draft = "def add(a, b)\n    return a +\n"; w(p, "calc.py", draft);
  const logs = []; const r = await ag.restoreBaselineIfWorse(UCMD, (e) => logs.push(e));
  const dd = path.join(p, ".eta", "drafts");
  const kept = fs.existsSync(dd) ? fs.readdirSync(dd) : [];
  ok(r === true && kept.includes("calc.py.1") && fs.readFileSync(path.join(dd, "calc.py.1"), "utf8") === draft, "measured-worse restore happens, and the broken draft is kept in .eta/drafts/calc.py.1", { r, kept });
  ok(ag._savedDrafts.includes(".eta/drafts/calc.py.1") && logs.some((e) => /drafts kept before the baseline restore/.test(e.text || "")), "the kept draft is reported");
  fs.rmSync(p, { recursive: true, force: true });
}

console.log("3. a reviewer claim is re-measured (agent._claimHolds)");
{
  const p = pyProject("claim", GOOD);
  const ag = new Agent(p, { model: "fake", numCtx: 16384 });
  const c1 = await ag._claimHolds("NEEDS_WORK - jest parse error: the file cannot be parsed", ["calc.py"], UCMD);
  ok(c1.kind === "compile" && c1.holds === false && /passes/.test(c1.why), "green project: 'parse error' claim NOT reproduced", c1);
  w(p, "calc.py", "def add(a, b):\n    return a - b\n");
  const c2 = await ag._claimHolds("the tests fail for negative numbers", ["calc.py"], UCMD);
  ok(c2.kind === "tests" && c2.holds === true, "red project: the claim holds (repair may go on)", c2);
  w(p, "calc.py", "def add(a, b)\n    return 1\n");
  const c3 = await ag._claimHolds("syntax error in calc.py", ["calc.py"], null);
  ok(c3.holds === true && /calc\.py/.test(c3.why), "no test command: a real syntax error is found by the gate", c3);
  w(p, "calc.py", GOOD);
  const c4 = await ag._claimHolds("syntax error in calc.py", ["calc.py"], null);
  ok(c4.holds === false, "no test command, clean file: the syntax claim is dropped", c4);
  const c5 = await ag._claimHolds("clean() should strip the country code", ["calc.py"], UCMD);
  ok(c5.kind === "" && c5.holds === true, "not a measurable claim: left alone");
  fs.rmSync(p, { recursive: true, force: true });
}

console.log("4. write_file refuses a wrong-language test file; the test author is not used");
if (HAVE_JEST) {
  const js = jestCopy("js-rest-api", "wf");
  const ag = new Agent(js, { model: "fake", numCtx: 16384, autoApprove: true }); ag.task = fs.readFileSync(path.join(BENCH, "tasks-poly", "js-rest-api", "task.txt"), "utf8");
  ag._testLangs = await projectTestLangs(js);
  const logs = []; const r = await ag.writeFile({ path: "test_main.py" }, [], (e) => logs.push(e), { autoApprove: true, root: js, files: ag.files }, "");
  ok(/^REFUSED: test_main\.py is a python test file/.test(r) && !fs.existsSync(path.join(js, "test_main.py")), "write_file test_main.py in the rest-api project: refused, nothing written", r);
  ag.lockedFiles = new Set(["rest-api.spec.js"]);
  const why = ag._authoringBlocked(ag.task);
  ok(/tests already exist/.test(why) && /rest-api\.spec\.js/.test(why), "the test author is skipped: the task says the spec file is already there", why);
  ag.lockedFiles = new Set();
  ok(/test_main\.py would be a python test file/.test(ag._authoringBlocked("Implement the API. All tests must pass.")), "the test author is skipped: its Python file does not fit a JS project");
  const pw = await ag.authorOneTestFile("test_rest.py", ag.task, quiet);
  ok(pw === false && !fs.existsSync(path.join(js, "test_rest.py")), "authorOneTestFile never writes (or locks) a wrong-language spec");
  fs.rmSync(js, { recursive: true, force: true });
} else ok(true, "SKIPPED jest folder checks");
{
  const p = pyProject("pyauthor"); const ag = new Agent(p, { model: "fake", numCtx: 16384 }); ag._testLangs = await projectTestLangs(p);
  ok(ag._authoringBlocked("Write calc.py with add() and unit tests for it.") === "", "python project: authoring still allowed");
  fs.rmSync(p, { recursive: true, force: true });
}

console.log("6. run_tests tool: a failing run leads with the exact failures");
if (HAVE_JEST) {
  const js = jestCopy("js-phone-number", "rt");
  fs.writeFileSync(path.join(js, "phone-number.js"), "export const clean = (s) => {\n  const d = s.replace(/\\D/g, '');\n  if (d.length < 10) throw new Error('wrong length');\n  return d.length === 11 ? Number(d.slice(1)) : d;\n};\n");
  const out = await execTool("run_tests", { command: "npm test --silent" }, { root: js, log: quiet, files: new Set(), autoApprove: true });
  const lines = String(out).split(/\r?\n/);
  ok(/COMMAND FAILED/.test(lines[0]) && /^FIRST FAILING TESTS/.test(lines[1]) && /expected: "Incorrect number of digits"/.test(out) && /FULL OUTPUT:/.test(out), "run_tests result: FAILED line, then the first failures, then the full output", lines.slice(0, 8));
  fs.rmSync(js, { recursive: true, force: true });
} else ok(true, "SKIPPED run_tests jest check");

console.log("8. per-phase time budget");
{
  const ag = new Agent(os.tmpdir(), { timeBudgetMs: 10 * 60000 }); ag._phaseSkips = []; ag._firstWriteAt = 0;
  const logs = []; ag.startTime = Date.now() - 3 * 60000;
  ok(ag.prePhaseOver((e) => logs.push(e), "test author") === false, "30% used: optional phases still run");
  ag.startTime = Date.now() - 4 * 60000;
  ok(ag.prePhaseOver((e) => logs.push(e), "test author") === true && ag.prePhaseOver((e) => logs.push(e), "test author") === true && logs.length === 1, "40% used before any write: skipped, logged once", logs.map((e) => e.text));
  ag._firstWriteAt = Date.now();
  ok(ag.prePhaseOver(quiet, "x") === false, "after the first write the rule is off");
}

// ---- END TO END: the real agent, driven by a fake local model server ----
// The fake model is LAZY: it never writes the implementation and claims success. The engine must not say `done`.
let MODE = "lazy";
const GOOD_JS = "export const add = (a, b) => a + b;\n";
function reply(messages) {
  const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : "");
  const sys = messages[0]?.role === "system" ? text(messages[0]) : "";
  const last = text(messages[messages.length - 1]);
  const all = messages.map(text).join("\n");
  if (/You are the Planner/.test(all)) return "1. Edit calc.py so the tests pass.";
  if (/You are the Reviewer/.test(all)) return MODE === "lazy" ? "APPROVED" : "NEEDS_WORK\n- jest parse error: the test suite fails to run because calc.py cannot be parsed";
  if (/Now output the COMPLETE content of the file/.test(last)) return MODE === "lazy" ? "OK" : GOOD;
  if (sys.startsWith("You are Eta's Executor")) {
    if (MODE === "good" && !/RESULT write_file/.test(all)) return JSON.stringify({ say: "Writing calc.py.", tool: "write_file", args: { path: "calc.py" } });
    if (MODE === "pytest-in-js" && !/REFUSED: test_main\.py/.test(all)) return JSON.stringify({ say: "Writing tests.", tool: "write_file", args: { path: "test_main.py" } });
    return JSON.stringify({ say: "All tests passed, done.", tool: "finish", args: { summary: "All tests passed. Test command PASSED." } });
  }
  return "OK";
}
function startFake() {
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake" }] })); }
      if (!req.url.endsWith("/chat/completions")) { res.statusCode = 404; return res.end("{}"); }
      let body = {}; try { body = JSON.parse(b); } catch {}
      const out = reply(body.messages || []);
      if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`); res.write("data: [DONE]\n\n"); return res.end(); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}
const saved = { ...provider }; const savedEnv = process.env.ETA_PROMPT_KEEPER;
process.env.ETA_PROMPT_KEEPER = "0";
const fake = await startFake();
setProvider({ base: `http://127.0.0.1:${fake.port}`, kind: "openai", model: "fake", key: "", noGrammar: true });
async function e2e(root, task, opts = {}) {
  const ag = new Agent(root, { autoApprove: true, timeBudgetMs: 45000, numCtx: 16384, model: "fake", leanPath: false, ...opts }); // LEAN1: these cases test the OLD executor path; the lean path is tested in test-lean1.mjs
  ag.resolveHelperModel = async function () { this._helperBase = null; this._helperKind = null; this._helperModel = this.memModel; return this.memModel; };
  const ev = []; await ag.run(task, (e) => ev.push(e), async () => true);
  return { ag, ev, done: ev.filter((e) => e.type === "done").pop(), logs: ev.filter((e) => e.type === "log").map((e) => e.text), answers: ev.filter((e) => e.type === "answer").map((e) => e.text) };
}
console.log("E2E 1: lazy model on a Python stub (claims 'All tests passed', never writes)");
{
  MODE = "lazy";
  const p = pyProject("e2e-lazy");
  const r = await e2e(p, "Implement add() in calc.py. The test file test_calc.py is already in this folder: do NOT change it; your code must make every test pass.", { testCmd: UCMD, testBaselineOk: true });
  ok(r.done && r.done.status === "not-done" && /^NOT DONE: tests still failing \(2 failing\)/.test(r.done.verdict || ""), "done event: status not-done, verdict 'NOT DONE: tests still failing (2 failing)...'", r.done && { status: r.done.status, verdict: r.done.verdict, outcome: r.done.outcome });
  ok(r.done && r.done.warnings[0] === r.done.verdict, "the verdict is the FIRST warning", r.done && r.done.warnings);
  ok(r.answers.length && /NOT DONE: tests still failing/.test(r.answers[r.answers.length - 1]) && /FIRST FAILING TEST/.test(r.answers[r.answers.length - 1]), "the last answer says NOT DONE and shows the exact failures", r.answers.slice(-1));
  ok(r.logs.some((t) => /spec-first: not authoring new tests - the task says its tests already exist/.test(t)) || !r.logs.some((t) => /spec-first: authoring/.test(t)), "no new test file was authored (the task said the tests exist)", r.logs.filter((t) => /spec-first/.test(t)));
  fs.rmSync(p, { recursive: true, force: true });
}
console.log("E2E 2: a model that writes the right code");
{
  MODE = "good";
  const p = pyProject("e2e-good");
  const r = await e2e(p, "Implement add() in calc.py. The test file test_calc.py is already in this folder: do NOT change it; your code must make every test pass.", { testCmd: UCMD, testBaselineOk: true });
  ok(fs.readFileSync(path.join(p, "calc.py"), "utf8").includes("return a + b"), "PRECONDITION: calc.py holds the fix");
  ok(r.done && r.done.status === "done" && r.done.outcome === "done", "done event: status done (green + changed)", r.done && { status: r.done.status, verdict: r.done.verdict, w: r.done.warnings });
  ok(r.logs.some((t) => /reviewer: advisory only/.test(t)), "(locked spec green: the reviewer is advisory here, as before)", r.logs.filter((t) => /reviewer/.test(t)));
  fs.rmSync(p, { recursive: true, force: true });
}
console.log("E2E 2b: no locked spec (tests in checks/), the reviewer falsely claims a parse error");
{
  MODE = "good";
  const p = tmp("e2e-claim"); w(p, "calc.py", STUB); w(p, "checks/__init__.py", ""); w(p, "checks/test_calc.py", TESTS);
  const cmd = "python -B -m unittest discover -s checks -t .";
  const r = await e2e(p, "Implement add() in calc.py so that it returns the sum of a and b.", { testCmd: cmd, testBaselineOk: true });
  if (process.env.STRONG_VERBOSE) for (const t of r.logs) console.log("   log:", t.substring(0, 200));
  ok(fs.readFileSync(path.join(p, "calc.py"), "utf8").includes("return a + b"), "PRECONDITION: calc.py holds the fix");
  ok(r.logs.some((t) => /^reviewer claim not reproduced \(compile: .*passes\) - dropped, no repair round for it$/.test(t)), "the reviewer's false 'parse error' claim was re-measured with the real test command and dropped", r.logs.filter((t) => /review/i.test(t)));
  ok(!r.ev.some((e) => e.type === "agent" && e.role === "executor" && r.ev.indexOf(e) > r.ev.findIndex((x) => x.type === "review")), "no executor repair round after the review");
  ok(r.done && r.done.status === "done" && !(r.done.warnings || []).some((x) => /reviewer still unsatisfied/.test(x)), "run ends done, no 'reviewer still unsatisfied' warning", r.done && r.done.warnings);
  fs.rmSync(p, { recursive: true, force: true });
}
if (HAVE_JEST) {
  console.log("E2E 3: JavaScript project, the model tries to write a Python test file");
  MODE = "pytest-in-js";
  const js = jestCopy("js-phone-number", "e2e");
  const task = fs.readFileSync(path.join(BENCH, "tasks-poly", "js-phone-number", "task.txt"), "utf8");
  const r = await e2e(js, task); if (process.env.STRONG_VERBOSE) for (const e of r.ev) if (["log","tool","toolResult","error"].includes(e.type)) console.log("   ev:", e.type, e.name || "", String(e.text || e.result || "").substring(0, 220));
  ok(!fs.existsSync(path.join(js, "test_main.py")) && !fs.readdirSync(js).some((f) => /\.py$/.test(f)), "no Python file was written into the JavaScript project", fs.readdirSync(js));
  ok(r.logs.some((t) => /spec-first: not authoring new tests - the task says its tests already exist \(phone-number\.spec\.js/.test(t)), "the spec file the task names is the locked spec; no test author", r.logs.filter((t) => /spec-first|locked/.test(t)));
  ok(r.done && r.done.status === "not-done" && /NOT DONE: tests still failing \(18 failing\); NOT DONE: no file was changed/.test(r.done.verdict || ""), "stub untouched: NOT DONE with 18 failing and 'no file was changed'", r.done && r.done.verdict);
  fs.rmSync(js, { recursive: true, force: true });
  // no spec file yet (so the old lock rule does not apply): only the new language guard stands between the model and test_main.py
  console.log("E2E 4: JavaScript project WITHOUT tests, task asks for tests, the model writes test_main.py");
  const js2 = jestCopy("js-phone-number", "e2e4"); fs.rmSync(path.join(js2, "phone-number.spec.js"));
  const r2 = await e2e(js2, "Implement clean() in phone-number.js and write tests for it. All tests must pass.");
  ok(!fs.readdirSync(js2).some((f) => /\.py$/.test(f)), "no Python file was written", fs.readdirSync(js2));
  ok(r2.logs.some((t) => /spec-first: not authoring new tests - test_\w+\.py would be a python test file in a javascript-language project/.test(t)), "the spec-first author did not write a Python spec", r2.logs.filter((t) => /spec-first/.test(t)));
  ok(r2.logs.some((t) => /test language guard: REFUSED: test_main\.py is a python test file, but this is a javascript project/.test(t)), "write_file test_main.py was refused with the right language named", r2.logs.filter((t) => /language/.test(t)));
  ok(r2.done && r2.done.status === "not-done", "and the run is not 'done'", r2.done && r2.done.verdict);
  fs.rmSync(js2, { recursive: true, force: true });
}
fake.server.close();
if (savedEnv === undefined) delete process.env.ETA_PROMPT_KEEPER; else process.env.ETA_PROMPT_KEEPER = savedEnv;
setProvider(saved);

console.log("server/ui/acp wiring (source checks: the server is not started here)");
{
  const srv = fs.readFileSync(path.join(HERE, "server.mjs"), "utf8");
  ok(/run\.status = e\.status === "not-done" \? "error" : "done"/.test(srv), "server maps a not-done run to the existing failed status 'error'");
  ok(/outcome: r\.outcome \|\| "", verdict: r\.verdict \|\| ""/.test(srv), "/api/run and meta carry outcome + verdict");
  const ui = fs.readFileSync(path.join(HERE, "ui.html"), "utf8");
  ok(/m\.status==="not-done"\?"Not done: "/.test(ui), "the panel says 'Not done: ...' instead of 'Done'");
  const acp = fs.readFileSync(path.join(HERE, "acp.mjs"), "utf8");
  ok(/evt\.run\.status === "done" \|\| evt\.run\.outcome/.test(acp), "ACP ends a measured not-done run like a done run (no internal-error reply)");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
