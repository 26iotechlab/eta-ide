// The watchdog: facts checked by plain code. Real temp folders, no model, no GPU.
import { Watchdog, snapshotCode, contractQuoteProblems, betterScore } from "./watchdog.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const NL = String.fromCharCode(10);
const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-wd-"));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const r = (f) => fs.readFileSync(path.join(d, f), "utf8");
w("lib/fines.py", "def days_late(a, b):" + NL + "    return (b - a).days + 1" + NL);
w("lib/__init__.py", '"""Library."""' + NL);
w("lib/models.py", "class M:" + NL + "    pass" + NL);
w("tests/test_x.py", "def test_a():" + NL + "    pass" + NL);
w("node_modules/x/index.js", "x");

// snapshot
const snap = await snapshotCode(d);
t(snap.has("lib/fines.py") && snap.has("tests/test_x.py") && !snap.has("node_modules/x/index.js"), "snapshot sees code files, skips node_modules");

// 1. missing path
const wd = new Watchdog();
const tc = { name: "edit_file", args: { path: "", search: "a" } };
t(/using lib\/fines\.py/.test(wd.repairCall(tc, "lib/fines.py")) && tc.args.path === "lib/fines.py", "an edit without a path gets the step's file");
t(wd.repairCall({ name: "edit_file", args: { path: "lib/models.py" } }, "lib/fines.py") === "", "a call with a path is left alone");
t(wd.repairCall({ name: "read_file", args: {} }, "lib/fines.py") === "", "only write tools are repaired");
t(wd.repairCall({ name: "edit_file", args: {} }, "") === "", "no step file: nothing to fill in");
t(wd.repairCall({ name: "write_file" }, "a.py") === "", "no args object: no crash");

// 2. scope guard: models.py and __init__.py have no job, fines.py does
const before = await snapshotCode(d);
w("lib/fines.py", "def days_late(a, b):" + NL + "    return (b - a).days" + NL);
w("lib/__init__.py", "from lib.models import M" + NL);
w("lib/models.py", "class M:" + NL + "    x = 1" + NL);
w("lib/new_helper.py", "y = 2" + NL);
const logs = [];
const put = await wd.enforceScope(d, before, new Set(["lib/fines.py", "tests/test_x.py"]), (e) => logs.push(e));
t(put.sort().join() === "lib/__init__.py,lib/models.py", "files with no job are put back: " + put.join());
t(/\.days\s*$/m.test(r("lib/fines.py")) && !/\+ 1/.test(r("lib/fines.py")), "the file with a job keeps its change");
t(r("lib/__init__.py") === '"""Library."""' + NL && r("lib/models.py") === "class M:" + NL + "    pass" + NL, "put-back files have their old content");
t(fs.existsSync(path.join(d, "lib/new_helper.py")), "a brand new file is not deleted by the scope guard");
t(logs.some((e) => /watchdog: lib\/__init__\.py, lib\/models\.py were changed/.test(e.text)) && logs.some((e) => e.type === "narration"), "the user is told");
// a deleted file without a job comes back
fs.rmSync(path.join(d, "lib/models.py"));
t((await wd.enforceScope(d, before, new Set(["lib/fines.py"]), () => {})).includes("lib/models.py") && fs.existsSync(path.join(d, "lib/models.py")), "a file with no job that was deleted comes back");

// 3. best state
const wb = new Watchdog();
w("lib/fines.py", "GOOD" + NL);
t(await wb.capture(d, { good: 10, fails: 3 }) === true, "first state is remembered");
w("lib/fines.py", "WORSE" + NL);
t(await wb.capture(d, { good: 8, fails: 5 }) === false, "a worse state is not remembered");
t(await wb.restoreBestIfWorse(d, { good: 10, fails: 3 }, () => {}) === false, "same score: nothing to restore");
const lg = [];
t(await wb.restoreBestIfWorse(d, { good: 8, fails: 5 }, (e) => lg.push(e), (f) => f.startsWith("tests/")) === true && r("lib/fines.py") === "GOOD" + NL, "a worse final state gets the best one back");
t(lg.some((e) => /put back the best state seen/.test(e.text)), "the restore is logged");
w("lib/fines.py", "BETTER" + NL);
t(await wb.capture(d, { good: 10, fails: 0 }) === true && wb.best.files.get("lib/fines.py") === "BETTER" + NL, "a better state replaces the old best (fewer failing)");
t(betterScore({ good: 5, fails: 9 }, { good: 4, fails: 0 }) && !betterScore({ good: 4, fails: 0 }, { good: 4, fails: 0 }), "scoring: more passing wins, equal is not better");
// test files are not touched by the best-state restore
w("tests/test_x.py", "changed" + NL); w("lib/fines.py", "WORSE2" + NL);
await wb.restoreBestIfWorse(d, { good: 1, fails: 9 }, () => {}, (f) => f.startsWith("tests/"));
t(r("tests/test_x.py") === "changed" + NL && r("lib/fines.py") === "BETTER" + NL, "test files are left to their own guards");

// 4. plan quotes
w("lib/fines.py", "def days_late(a, b):" + NL + "    return (b - a).days + 1" + NL);
const c1 = "lib/fines.py: In `days_late`, change `return (b - a).days + 1` to `return (b - a).days`.";
t((await contractQuoteProblems(d, c1)).length === 0, "a quote that exists is fine (spacing ignored)");
const c2 = "lib/fines.py: change `return (when - due).days + 99` to `return 0`.";
t((await contractQuoteProblems(d, c2)).join() === "return (when - due).days + 99", "a quote that exists nowhere is reported");
t((await contractQuoteProblems(d, "change `days_late` to `late_days`")).length === 0, "a bare name (no code shape) is not judged");
t((await contractQuoteProblems(d, "nothing quoted here")).length === 0, "no quotes: nothing to check");

// 5. report
const w2 = new Watchdog(); t(w2.report() === "", "nothing corrected: no report");
w2.note("scope", "a"); w2.note("scope", "b"); w2.note("missing-path", "c");
t(/watchdog corrected 3 slips: scope x2, missing-path x1/.test(w2.report()), "the report counts by rule: " + w2.report());


// 6. spec evidence: the task states rules in words, the code must show them
import { specEvidenceGaps } from "./watchdog.mjs";
const T10 = "It prints  tagged #1 with food  (the tag in lower case). The list command works with --tag FOOD too (not case-sensitive). Tags sorted alphabetically. For an unknown note id, print no note and exit with code 1.";
t(specEvidenceGaps(T10, ["def add(tag):" + NL + "    return tag"]).length >= 3, "lower case, sorted and exit code are all missing from code that shows none of them");
const good = ["def add(tag):", "    tag = tag.lower()", "    return sorted(tags)", "import sys", "sys.exit(1)"].join(NL);
t(specEvidenceGaps(T10, [good]).length === 0, "code that shows them: no gap");
t(specEvidenceGaps("Fix the discount in cart.py.", ["x = 1"]).length === 0, "a task with no such words: no gap");
t(specEvidenceGaps(T10, []).length === 0, "no changed source: nothing to judge");
t(specEvidenceGaps("print the total rounded to 2 decimal places", ["return total"]).some((g) => /round/.test(g.hint)), "rounding rule found");
t(specEvidenceGaps("exit with code 0 on success", ["pass"]).length === 0, "exit code 0 is the default, never demanded");
t(/await this\.fixSpecGaps\(task, ctx, emit, baseSystem\)/.test(fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8")), "the engine goes back for rules the code does not show");

// 7. library names that do not exist (stdlib introspection, real python)
import { stdlibApiProblems } from "./watchdog.mjs";
const okCode = ["import os, json, re, collections.abc", "import datetime as dt", "from datetime import timedelta, date", "from collections import defaultdict", "",
  "def f(p):", "    d = dt.datetime.now() + timedelta(days=1)", "    x = os.path.join(p, 'a')", "    y = json.dumps({'a': 1})", "    z = re.IGNORECASE", "    m = collections.abc.Mapping",
  "    return os.sep, d, x, y, z, m, date.today(), defaultdict(int)", ""].join(NL);
const badCode = ["import os, json", "import datetime", "from math import squareroot", "", "def g(p):", "    a = os.path.exits(p)", "    b = json.parse('1')", "    c = datetime.now_utc()", "    return a, b, c", ""].join(NL);
const shadow = ["import os", "def h(os):", "    return os.anything_goes()", ""].join(NL);
const thirdParty = ["import requests", "import numpy as np", "def k():", "    return requests.nonexistent(), np.nope()", ""].join(NL);
const objMethods = ["import os", "def m(path):", "    f = open(path)", "    return f.nonexistent_method(), os.getcwd().nope", ""].join(NL);
const res = await stdlibApiProblems({ "ok.py": okCode, "bad.py": badCode, "shadow.py": shadow, "third.py": thirdParty, "obj.py": objMethods, "notes.txt": "os.nothing" });
t(!res.some((x) => x.file === "ok.py"), "correct standard-library code: no finding: " + JSON.stringify(res.filter((x) => x.file === "ok.py")));
const bad = res.filter((x) => x.file === "bad.py").map((x) => x.msg).join(" | ");
t(/os\.path has no attribute exits/.test(bad) && /json has no attribute parse/.test(bad) && /datetime has no attribute now_utc/.test(bad) && /math has no name squareroot/.test(bad), "all four invented names are found: " + bad);
t(!res.some((x) => x.file === "shadow.py"), "a name the file itself defines (a parameter called os) is never judged");
t(!res.some((x) => x.file === "third.py"), "third-party libraries are never judged");
t(!res.some((x) => x.file === "obj.py"), "methods of objects are never judged");
t(res.every((x) => /\.py$/.test(x.file)), "only python files are looked at");
t((await stdlibApiProblems({}, "python")).length === 0 && (await stdlibApiProblems({ "a.py": "x = (" }, "python")).length === 0, "empty input and a syntax error give no findings");
t((await stdlibApiProblems({ "a.py": badCode }, "no-such-python-binary")).length === 0, "no python on the PC: fail-open, no findings");

// 8. the same fact check for JavaScript
import { nodeApiProblems, libraryApiProblems } from "./watchdog.mjs";
const jsOk = ["const fs = require('fs');", "const path = require('node:path');", "import os from 'os';", "import { readFileSync, existsSync } from 'fs';",
  "// Math.clamp(1,2,3) in a comment and 'JSON.parse2' in a string are not code", "const s = 'Math.clamp(1)';",
  "function f(p) {", "  const a = fs.readFileSync(p, 'utf8') + path.join('a', 'b') + os.EOL + JSON.stringify({ a: 1 });", "  const b = Math.max(1, 2) + Number.parseFloat('1') + Object.keys({}).length + Array.isArray([]);", "  const c = fs.promises.readFile; console.log(a, b, c, Date.now(), Promise.resolve(1));", "  return fs.constants.R_OK;", "}", ""].join(NL);
const jsBad = ["const fs = require('fs');", "import { readFileSyncc } from 'fs';", "function g(p) {", "  const a = fs.readFileSyncc(p);", "  const b = Math.clamp(1, 0, 5);", "  const c = Object.hasOwnProperties({}, 'a');", "  const d = JSON.parse2('1');", "  console.print(a, b, c, d);", "  return fs.promises.readFileX;", "}", ""].join(NL);
const jsShadow = ["const Math = { clamp: (a) => a };", "const fs = require('fs');", "function h(fs) { return fs.whatever(); }", "const x = Math.clamp(1);", ""].join(NL);
const jsPkg = ["const express = require('express');", "const _ = require('lodash');", "const app = express(); app.nonexistent(); _.nope();", "document.getElementByID('x'); window.foo();", ""].join(NL);
const jr = await nodeApiProblems({ "ok.js": jsOk, "bad.js": jsBad, "shadow.js": jsShadow, "pkg.js": jsPkg, "x.py": "import os" });
t(!jr.some((x) => x.file === "ok.js"), "correct JavaScript (also names inside comments and strings): no finding: " + JSON.stringify(jr.filter((x) => x.file === "ok.js")));
const jb = jr.filter((x) => x.file === "bad.js").map((x) => x.msg).join(" | ");
t(/fs\.readFileSyncc does not exist/.test(jb) && /Math\.clamp does not exist/.test(jb) && /Object\.hasOwnProperties does not exist/.test(jb) && /JSON\.parse2 does not exist/.test(jb) && /console\.print does not exist/.test(jb) && /fs has no export readFileSyncc/.test(jb) && /fs\.promises\.readFileX does not exist/.test(jb), "all invented JavaScript names are found: " + jb);
t(!jr.some((x) => x.file === "shadow.js"), "a name the file declares itself (Math, a parameter called fs) is never judged");
t(!jr.some((x) => x.file === "pkg.js"), "npm packages and browser DOM names are never judged");
t((await nodeApiProblems({}, process.execPath)).length === 0 && (await nodeApiProblems({ "a.js": "function ( {" })).length === 0, "empty input and a syntax error give no findings");
t((await nodeApiProblems({ "a.js": jsBad }, "no-such-node-binary")).length === 0, "no node binary: fail-open");
const both = await libraryApiProblems({ "bad.js": jsBad, "bad.py": badCode });
t(both.some((x) => x.file === "bad.js") && both.some((x) => x.file === "bad.py"), "one call checks both languages");

// 9. test output of JavaScript runners is understood (best-state restore needs a score)
import { summarizeTests, detectTestCmd } from "./agent.mjs";
const nodeOut = ["TAP version 13", "# tests 6", "# pass 5", "# fail 1"].join(NL);
t(summarizeTests(nodeOut).pass === 5 && summarizeTests(nodeOut).fails === 1, "node:test (TAP) summary is read");
t(summarizeTests("ℹ tests 4" + NL + "ℹ pass 4" + NL + "ℹ fail 0").pass === 4, "node:test (spec) summary is read");
t(summarizeTests("  3 passing (12ms)" + NL + "  2 failing").fails === 2, "mocha summary is read");
t(summarizeTests("Tests:       1 failed, 5 passed, 6 total").pass === 5, "jest summary is read");
const jd = fs.mkdtempSync(path.join(os.tmpdir(), "eta-js-"));
fs.writeFileSync(path.join(jd, "app.js"), "x"); fs.writeFileSync(path.join(jd, "app.test.js"), "x");
t(await detectTestCmd(jd) === "node --test", "a project with app.test.js gets node --test");
fs.rmSync(jd, { recursive: true, force: true });
const jd2 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-js2-"));
fs.writeFileSync(path.join(jd2, "app.js"), "x");
t(await detectTestCmd(jd2) === null, "no tests: still no test command");
fs.rmSync(jd2, { recursive: true, force: true });


// 10. other languages: test output is understood
const ST = (x) => summarizeTests(x.join(NL));
t(ST(["running 3 tests", "test result: ok. 3 passed; 0 failed; 0 ignored;", "test result: FAILED. 4 passed; 2 failed; 0 ignored;"]).fails === 2, "Rust: sums every test binary");
t(ST(["error[E0425]: cannot find value `x` in this scope", "error: could not compile `demo`"]).ok === false, "Rust: compile error is a failure");
t(ST(["[INFO] Tests run: 5, Failures: 1, Errors: 1, Skipped: 0"]).fails === 2, "Maven: failures plus errors");
t(ST(["[ERROR] COMPILATION ERROR :", "[INFO] BUILD FAILURE"]).ok === false, "Maven: compile error is a failure");
t(ST(["5 tests completed, 2 failed"]).pass === 3, "Gradle summary");
t(ST(["Failed!  - Failed:     1, Passed:     4, Skipped:     0, Total:     5"]).fails === 1, ".NET summary");
t(ST(["67% tests passed, 1 tests failed out of 3"]).pass === 2, "ctest summary");
t(ST(["===============", "All tests passed (12 assertions in 4 test cases)"]).pass === 4, "Catch2 all green");
t(ST(["[  PASSED  ] 3 tests.", "[  FAILED  ] 1 tests, listed below:"]).fails === 1, "GoogleTest summary");
t(ST(["foo.cpp:3:5: error: 'x' was not declared in this scope"]).ok === false, "C++: compile error is a failure");
t(ST(["--- FAIL: TestA (0.00s)", "--- PASS: TestB (0.00s)", "FAIL", "FAIL	demo	0.01s"]).fails === 1, "Go -v: fail and pass counted");
t(ST(["# demo", "./a.go:5:2: undefined: foo", "FAIL	demo [build failed]"]).ok === false, "Go: build failure");
t(ST(["ok  	demo	0.004s"]).ok === true, "Go: package ok");
t(summarizeTests("1 passed in 0.1s").pass === 1 && summarizeTests(["Ran 2 tests in 0.1s", "", "OK"].join(NL)).ok, "Python readers still work");
t(summarizeTests("nothing useful") === null, "unknown text stays unknown");
{
  const mkd = (names) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-l-")); for (const n of names) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), "x"); } return d; };
  for (const [names, want] of [[["go.mod", "a.go"], "go test ./..."], [["Cargo.toml"], "cargo test"], [["pom.xml"], "mvn -q test"], [["x.csproj"], "dotnet test"], [["build.gradle"], "gradle test"]]) {
    const d = mkd(names); t((await detectTestCmd(d)) === want, "test command for " + names[0] + " is " + want); fs.rmSync(d, { recursive: true, force: true });
  }
}
import { isTestFile } from "./agent.mjs";
import { isTestPath } from "./localize.mjs";
t(isTestFile("src/test/java/AppTest.java") && isTestFile("a_test.go") && isTestFile("app.spec.ts") && !isTestFile("src/main.rs"), "test files of other languages are recognized");
t(isTestPath("tests/it.rs") && isTestPath("FooTest.java") && isTestPath("x_test.cpp") && !isTestPath("src/lib.rs"), "file finder skips test files of other languages");

// wiring in the engine
const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/this\.watch\?\.repairCall\(tc, this\._stepFile\)/.test(src), "tool calls without a path are repaired in execute()");
t(/await this\._runOneFileInner\(/.test(src) && /this\.watch\.enforceScope\(/.test(src), "each file step runs under the scope guard");
t(/this\.watch\?\.capture\(this\.root/.test(src) && /restoreBestIfWorse\(this\.root/.test(src), "the best tested state is kept and restored");
t(/contractQuoteProblems\(this\.root, contract\)/.test(src), "a guessing plan is sent back");
t(/this\.watch = new Watchdog\(\)/.test(src) && /this\.watch\?\.report\(\)/.test(src), "fresh watchdog per run and a report at the end");
t(/await this\.fixSpecGaps\(task, ctx, emit, baseSystem\)/.test(src) && /no changed file shows it/.test(src), "the engine goes back for rules the code does not show");
fs.rmSync(d, { recursive: true, force: true });

// ===== STRONG2 rules 14-21 (pure functions; the wiring inside the real agent is tested in test-lang2.mjs) =====
{
  const W = await import("./watchdog.mjs");
  const { expectedErrorStrings } = await import("./failtext.mjs");
  // 14 untouched target
  const s0 = new Map([["calc.py", "def add(a, b):\n    pass\n"], ["util.py", "x = 1\n"]]);
  const stubsOf = (f, t) => (/pass\n$/.test(t) ? [{ name: "add" }] : []);
  t(JSON.stringify(W.untouchedTargets(s0, new Map(s0), ["calc.py"], stubsOf)) === JSON.stringify([{ file: "calc.py", why: "unchanged since the start, still a stub (add)" }]), "B1: an unchanged stub target is found");
  t(W.untouchedTargets(s0, new Map([["calc.py", "def add(a, b):\n    return a + b\n"]]), ["calc.py"], stubsOf).length === 0, "B1: a written target is fine");
  t(W.untouchedTargets(s0, new Map([["calc.py", "# new\ndef add(a, b):\n    pass\n"]]), ["calc.py"], stubsOf)[0].why === "still has stub markers (add)", "B1: changed but still a stub is reported");
  t(W.untouchedTargets(s0, new Map(s0), ["calc.py"], () => { throw new Error("x"); })[0].why === "unchanged since the start", "B1: a crashing stub detector = no stub info (fail-open)");
  t(W.untouchedTargets(null, null, ["a"], null).length === 0, "B1: no snapshots: nothing");
  // 15 wrong-language file
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "eta-wd2-"));
  fs.writeFileSync(path.join(wd, "go.mod"), "module x"); fs.writeFileSync(path.join(wd, "main.go"), "package main");
  const L = await W.projectLangs(wd);
  t(L.has("go") && !L.has("python"), "B2: project languages from go.mod and main.go");
  t(/sum\.py is a python file, but this project uses go/.test(W.wrongLanguageFile("sum.py", L, "add Sum to main.go")), "B2: a Python file in a Go project is wrong");
  t(W.wrongLanguageFile("sum.py", L, "write a small python helper script") === "" && W.wrongLanguageFile("tools/gen.py", L, "create tools/gen.py") === "", "B2: the task names the language or the file: fine");
  t(W.wrongLanguageFile("util.go", L, "x") === "" && W.wrongLanguageFile("README.md", L, "x") === "" && W.wrongLanguageFile("conftest.py", L, "x") === "", "B2: same language, non-code and config files are never judged");
  t(W.wrongLanguageFile("a.py", new Set(), "x") === "", "B2: an empty project (no languages known): nothing is judged");
  fs.writeFileSync(path.join(wd, "index.html"), "<html></html>");
  t((await W.projectLangs(wd)).has("javascript"), "B2: a web page in the project allows its script");
  fs.rmSync(wd, { recursive: true, force: true });
  // 16 test weakening (every language)
  const pairs = [
    ["test_a.py", "def test_a():\n    assert f(1) == 2\n\ndef test_b():\n    assert f(2) == 3\n", "def test_a():\n    assert f(1) == 2\n", /1 fewer test/],
    ["test_a.py", "def test_a():\n    assert f(1) == 2\n", "import pytest\n@pytest.mark.skip\ndef test_a():\n    assert f(1) == 2\n", /new skip/],
    ["test_a.py", "def test_a():\n    assert f(1) == 2\n", "def test_a():\n    assert True\n", /always-true/],
    ["a.test.js", "it('a', () => { expect(f(1)).toBe(2); });\nit('b', () => { expect(f(2)).toBe(3); });\n", "it('a', () => { expect(f(1)).toBe(2); });\nxit('b', () => { expect(f(2)).toBe(3); });\n", /fewer test|new skip/],
    ["a.test.js", "test('a', () => { expect(f(1)).toBe(2); });\n", "test.only('a', () => { expect(f(1)).toBe(2); });\n", /new skip\/only/],
    ["a.test.js", "test('a', () => { expect(f(1)).toBe(2); });\n", "test('a', () => { expect(true).toBe(true); });\n", /always-true/],
    ["calc_test.go", "func TestA(t *testing.T) {\n\tif f(1) != 2 {\n\t\tt.Errorf(\"bad\")\n\t}\n}\n", "func TestA(t *testing.T) {\n\tt.Skip(\"later\")\n\tif f(1) != 2 {\n\t\tt.Errorf(\"bad\")\n\t}\n}\n", /new skip/],
    ["tests/it.rs", "#[test]\nfn a() { assert_eq!(f(1), 2); }\n", "#[test]\n#[ignore]\nfn a() { assert_eq!(f(1), 2); }\n", /new skip/],
    ["CalcTest.java", "@Test\nvoid a() { assertEquals(2, f(1)); }\n", "@Disabled\n@Test\nvoid a() { assertEquals(2, f(1)); }\n", /new skip/],
    ["CalcTest.java", "@Test\nvoid a() { assertEquals(2, f(1)); }\n@Test\nvoid b() { assertEquals(3, f(2)); }\n", "@Test\nvoid a() { assertEquals(2, f(1)); }\n// @Test\n// void b() { assertEquals(3, f(2)); }\n", /1 fewer test/],
    ["CalcTests.cs", "[Fact]\npublic void A() { Assert.Equal(2, F(1)); }\n", "[Fact(Skip = \"later\")]\npublic void A() { Assert.Equal(2, F(1)); }\n", /new skip/],
    ["calc_spec.rb", "it 'adds' do\n  expect(add(1, 1)).to eq(2)\nend\n", "xit 'adds' do\n  expect(add(1, 1)).to eq(2)\nend\n", /fewer test|new skip/],
    ["CalcTest.php", "public function testAdd() { $this->assertEquals(2, add(1, 1)); }\n", "public function testAdd() { $this->markTestSkipped('x'); $this->assertEquals(2, add(1, 1)); }\n", /new skip/],
    ["CalcTests.swift", "func testAdd() { XCTAssertEqual(add(1, 1), 2) }\n", "func testAdd() { XCTAssertTrue(true) }\n", /always-true|fewer assertion/],
  ];
  for (const [f, a, b, want] of pairs) { const why = W.testWeakening(a, b, f); t(want.test(why), `B3: ${f} weakening is seen (${why || "nothing"})`); }
  t(W.testWeakening("def test_a():\n    assert f(1) == 2\n", "def test_a():\n    assert f(1) == 2\n\ndef test_b():\n    assert f(0) == 1\n", "test_a.py") === "", "B3: ADDING a test is not weakening");
  t(W.testWeakening("it('a', () => { expect(f(1)).toBe(2); });\n", "it('a', () => { expect(f(1)).toBe(3); });\n", "a.test.js") === "", "B3: changing an expected value is not counted as weakening (other rules own that)");
  t(W.taskAllowsTestChange("Remove the obsolete test for parse()") && W.taskAllowsTestChange("the tests are outdated, update them") && !W.taskAllowsTestChange("Fix add() so the tests pass"), "B3: the task may allow test changes");
  // 17 secrets
  t(W.secretFindings("KEY = 'AKIAZ7Q2MNB4XKW9LPTR'").length === 1 && W.secretFindings("t = 'ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'").length === 1, "B4: AWS and GitHub key shapes");
  t(W.secretFindings("k = 'sk-" + "proj-Ab3dEf6hIj9kLm2nOp5qRs8t'").length === 1 && W.secretFindings("-----BEGIN RSA PRIVATE KEY-----\nMIIE").length === 1, "B4: OpenAI-style key and a private key block");
  t(W.secretFindings("k = 'AKIAIOSFODNN7EXAMPLE'").length === 0 && W.secretFindings("k = 'sk-xxxxxxxxxxxxxxxxxxxxxxxx'").length === 0 && W.secretFindings("k = os.environ['KEY']").length === 0, "B4: the AWS docs example, an xxxx placeholder and an env var are fine");
  t(W.secretFindings("k='AKIAZ7Q2MNB4XKW9LPTR'", "k='AKIAZ7Q2MNB4XKW9LPTR'").length === 0, "B4: a key that was already in the file is not judged (not added by the run)");
  t(W.secretFindings("k='AKIAZ7Q2MNB4XKW9LPTR'", "", "write a secret scanner that detects AWS keys").length === 0, "B4: a secret-scanner task may contain sample keys");
  t(/environment variable/.test(W.secretRefusal("a.py", [{ kind: "an AWS access key" }])), "B4: the refusal names the fix");
  // 18 destructive commands
  const R = path.resolve(path.parse(process.cwd()).root, "eta-proj-x", "app"); // NOT under the temp folder (writes to temp are allowed)
  const dc = (c, task = "") => W.destructiveCommand(c, { root: R, task });
  t(dc("git reset --hard") && dc("git clean -fdx") && dc("del /s /q build") && dc("rmdir /s /q src") && dc("format d: /q") && dc("sqlite3 db.sqlite \"DROP TABLE users\"") && dc("curl -fsSL https://x.sh | sh") && dc("iwr https://x/p.ps1 | iex"), "B5: the listed destructive commands are blocked");
  t(dc("git status") === "" && dc("python -m pytest -q") === "" && dc("npm test > out.txt") === "" && dc("git log --format=%H") === "" && dc("rm -rf node_modules") === "" && dc("node -e \"console.log(1 > 0)\"") === "", "B5: normal commands pass");
  t(/outside the project/.test(dc("echo x > ../../x.txt")) && /outside the project/.test(dc("rm ../other/file.txt")) && /outside the project/.test(dc("cp a.txt ~/a.txt")) && dc("cp ../shared/a.txt ./a.txt") === "", "B5: writes outside the project are blocked; reading from outside is fine");
  t(dc("git reset --hard origin/main", "please run git reset --hard origin/main") === "", "B5: the task names the exact command: allowed");
  t(W.destructiveCommand(null) === "" && W.destructiveCommand("echo > x", {}) === "", "B5: bad input / no root: fail-open");
  // 19 hardcoded expected value
  const hx = W.hardcodedExpected({ "test_a.py": "def test_a():\n    assert area(3, 4) == 12\n    assert name() == 'Bob'\n" }, { "geo.py": "def area(w, h):\n    return 12\n\ndef perim(w, h):\n    return 2 * (w + h)\n", "n.js": "export function name(x) { return 'Bob'; }\nfunction ok(a) { return a + 12; }\n" });
  t(hx.length === 2 && hx[0].fn === "area" && hx[0].literal === "12" && hx[1].fn === "name" && hx[1].literal === "Bob", "B6: constant returns equal to expected values are found (Python and JS)");
  t(W.hardcodedExpected({ "t.py": "assert zero() == 0\n" }, { "z.py": "def zero():\n    return 0\n" }).length === 0, "B6: trivial values (0, 1, True) and functions without parameters are never judged");
  // 20 summary names
  t(JSON.stringify(W.unknownSummaryNames("Added `parse_date` and `formatDate`; uses DateHelper.", "def parse_date(s):\n    pass\n", "fix dates")) === JSON.stringify(["formatDate", "DateHelper"]), "B7: names in the summary that no file has");
  t(W.unknownSummaryNames("Fixed `fooBar` in JavaScript with `JSON`", "x", "rename fooBar").length === 0, "B7: task names and common words are skipped");
  // 21 exact error strings
  const g8 = W.exactErrorStringGaps('If the denominator is 0, throw an error with the message "Denominator must not be zero". The file "calc.js" holds it.', ["function f() { throw new Error('nope'); }"]);
  t(g8.length === 1 && g8[0].phrase === "Denominator must not be zero" && /EXACT error message/.test(g8[0].hint), "B8: a quoted error message the code lacks", g8);
  t(W.exactErrorStringGaps('raise ValueError("bad input")', ['raise ValueError("bad input")']).length === 0, "B8: present: no gap");
  t(W.exactErrorStringGaps('print "hello world" on start', ["print('hi')"]).length === 0, "B8: a quote far from error words is not an error message");
  t(W.exactErrorStringGaps("", ["x"], ["Invalid number"])[0].phrase === "Invalid number", "B8: strings the tests expect are checked too");
  const es = expectedErrorStrings("expect(() => f(0)).toThrow('Denominator must not be zero');\nwith pytest.raises(ValueError, match=r'^bad .*$'):\n  f()\nwith pytest.raises(ValueError, match='plain text'):\n  g()\nassertEquals(\"Invalid age\", e.getMessage());\n$this->expectExceptionMessage('No such user');\nif err.Error() != \"empty stack\" {\n");
  t(JSON.stringify(es) === JSON.stringify(["Denominator must not be zero", "plain text", "No such user", "Invalid age", "empty stack"]), "B8: failtext reads expected messages from jest, pytest (not a regex), JUnit, PHPUnit, Go", es);
  // report: STRONG2 rules list their text
  const wdg = new W.Watchdog(); wdg.note("scope", "put back a.py"); wdg.note("secret-blocked", "config.py: an AWS access key");
  t(wdg.report() === "watchdog corrected 2 slips: scope x1, secret-blocked x1\n  - secret-blocked: config.py: an AWS access key", "report(): new rules add a detail line; old rules keep the old one-line format");
  const old1 = new W.Watchdog(); old1.note("scope", "x");
  t(old1.report() === "watchdog corrected 1 slip: scope x1", "report(): unchanged when only old rules fired");
}
console.log(`watchdog: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
