// GATE1 (2026-11-17): the one write gate + the "never worse than the best state" guarantee. Real files in a temp folder,
// no model, no GPU, no network. Reproduces benchmark b2r js-beer-song (a duplicated half-file that passed the old gate).
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { Agent, gate, gatedWrite, writeGateVerdict, summarizeTests, gate1TestHooks } from "./agent.mjs";
import { Watchdog, spliceProblem, cutOffProblem, snapshotCode } from "./watchdog.mjs";

let pass = 0, fail = 0;
const t = (c, m) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m); } };
const NL = "\n";
const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-gate1-"));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const r = (f) => fs.readFileSync(path.join(d, f), "utf8");

// ---- the real broken file from the benchmark (copy kept in dev-scratch); a built-in copy when that folder is gone
const SRC = "D:/eta-ide/dev-scratch/bench/scratch-copy-beer/beer-song.js";
const VERSE = [
  "export const verse = (n) => {",
  "  if (n === 0) {", "    return [", '      "No more bottles of beer on the wall, no more bottles of beer.",', '      "Go to the store and buy some more, 99 bottles of beer on the wall."', "    ];", "  }",
  "  if (n === 1) {", "    return [", '      "1 bottle of beer on the wall, 1 bottle of beer.",', '      "Take it down and pass it around, no more bottles of beer on the wall."', "    ];", "  }",
  "  if (n === 2) {", "    return [", '      "2 bottles of beer on the wall, 2 bottles of beer.",', '      "Take one down and pass it around, 1 bottle of beer on the wall."', "    ];", "  }",
  "  return [", "    `${n} bottles of beer on the wall, ${n} bottles of beer.`,", "    `Take one down and pass it around, ${n - 1} bottles of beer on the wall.`", "  ];", "};"];
const RECITE = ["export const recite = (initialBottlesCount, takeDownCount) => {", "  const verses = [];", "  for (let i = 0; i < takeDownCount; i++) {", '    verses.push(verse(initialBottlesCount - i).join("\\n"));', "  }", "  return verses;", "};"];
let broken;
try { broken = fs.readFileSync(SRC, "utf8"); } catch {
  broken = [...VERSE, "", RECITE[0], "  if (takeDownCount === 0) {", "    return [];", "  }", ...RECITE.slice(1), ...VERSE.slice(7), "", ...RECITE].join(NL);
}
const bl = broken.split(/\r?\n/);
const good = [...bl.slice(0, 25), ...bl.slice(53)].join(NL); // the 31-line draft the run had before the bad edit
t(good.split(NL).length === 32 && (good.match(/export const recite/g) || []).length === 1, "setup: rebuilt the earlier 31-line draft from the broken file");

// A package WITHOUT "type": "module" (as in the benchmark): the old `node --check` passed the broken ESM file here.
w("package.json", JSON.stringify({ name: "beer", version: "1.0.0" }));
w("beer-song.js", broken);
const gb = await gate(d, "beer-song.js", { noPkg: true });
t(!gb.ok && /return|declared|outside/i.test(gb.msg), "gate: the duplicated half-file now FAILS the syntax gate (" + String(gb.msg).split(NL).find((l) => /SyntaxError/.test(l)) + ")");
w("beer-song.js", good);
t((await gate(d, "beer-song.js", { noPkg: true })).ok, "gate: the good ESM draft still passes");
w("jsx.js", 'import React from "react";' + NL + "export const A = () => <div>hi</div>;" + NL);
t((await gate(d, "jsx.js", { noPkg: true })).ok, "gate: a JSX .js file gets no ES-module verdict (fail-open, as before)");

// ---- (ii) splice: the beer-song case through the one write gate
w("beer-song.js", good);
let g = await gatedWrite(d, "beer-song.js", broken, {});
t(!g.ok && g.kind === "splice" && /recite/.test(g.why), "beer-song: gatedWrite rejects the duplicated half-file (" + g.why + ")");
t(r("beer-song.js") === good, "beer-song: the previous draft is back on disk");
t(/REJECTED/.test(g.msg) && /edit_file/.test(g.msg), "beer-song: the model gets a clear error message");
t(/recite/.test(spliceProblem("beer-song.js", good, broken)), "spliceProblem: names the twice-defined function");
// same name only once but the file grew >= 1.6x with a repeated block (a pasted half without its header)
const halfPaste = good + NL + bl.slice(1, 24).join(NL) + NL + bl.slice(54).join(NL) + NL;
t(/repeats a block/.test(spliceProblem("beer-song.js", good, halfPaste)), "spliceProblem: a pasted half-file without a header is caught by the size + repeat rule");
t(spliceProblem("beer-song.js", good, good.replace("No more", "No MORE")) === "", "spliceProblem: a normal edit passes");
// data growth made of quoted text lines (song verses) is not a pasted half-file
{ const q = (n) => Array.from({ length: n }, (_, i) => '  "verse line number ' + i + ' of the song",').join(NL);
  const small = "const V = [" + NL + q(10) + NL + "];" + NL;
  const big = "const V = [" + NL + q(10) + NL + q(10) + NL + "];" + NL;
  t(spliceProblem("verses.js", small, big) === "", "spliceProblem: repeated quoted data lines are not a splice"); }

// ---- (i) syntax regression in JavaScript
w("beer-song.js", good);
g = await gatedWrite(d, "beer-song.js", good.replace("const verses = [];", "const verses = [;"), {});
t(!g.ok && g.kind === "syntax" && /SyntaxError|Unexpected/.test(g.why), "js: a syntax break of a compiling file is rejected with the error lines");
t(r("beer-song.js") === good, "js: previous content restored after the syntax reject");
g = await gatedWrite(d, "beer-song.js", good.replace("No more", "No MORE"), {});
t(g.ok && r("beer-song.js").includes("No MORE"), "js: a good edit is kept");
// a file that was ALREADY broken may be getting fixed: keep the attempt
w("bad.js", "const a = ;" + NL);
g = await gatedWrite(d, "bad.js", "const a = (;" + NL, {});
t(g.ok && r("bad.js") === "const a = (;" + NL, "js: previous text already broken -> the new attempt is kept (it may be a fix)");

// ---- Python
const py = "def add(a, b):" + NL + "    return a + b" + NL + NL + "class Box:" + NL + '    """A box."""' + NL + "    def size(self):" + NL + "        return 1" + NL;
w("calc.py", py);
g = await gatedWrite(d, "calc.py", py.replace("return a + b", "return (a + b"), {});
t(!g.ok && g.kind === "syntax", "python: a syntax break is rejected (py_compile)");
t(r("calc.py") === py, "python: previous content restored");
g = await gatedWrite(d, "calc.py", py + NL + "def add(a, b):" + NL + "    return b + a" + NL, {});
t(!g.ok && g.kind === "splice" && /add/.test(g.why), "python: a second top-level def add() is rejected as a splice");
const cutPy = py.slice(0, py.indexOf('"""A box.') + 6);
t(/cut off/.test(cutOffProblem("calc.py", py, cutPy)), "python: cutOffProblem sees the open docstring at the end");
g = await gatedWrite(d, "calc.py", cutPy, {});
t(!g.ok && r("calc.py") === py, "python: the token-cut file is rejected and restored");
const ovl = "from typing import overload" + NL + "@overload" + NL + "def f(x: int) -> int: ..." + NL + "@overload" + NL + "def f(x: str) -> str: ..." + NL + "def f(x):" + NL + "    return x" + NL;
t(spliceProblem("o.py", "def f(x):" + NL + "    return x" + NL, ovl) === "", "python: @overload twins are not called a splice");
g = await gatedWrite(d, "calc.py", py.replace("return 1", "return 2"), {});
t(g.ok && r("calc.py").includes("return 2"), "python: a good edit is kept");

// ---- Go (no Go tool on this PC: the syntax tool gives no verdict, the plain-text rules still work)
const go = "package main" + NL + NL + "func Add(a, b int) int {" + NL + "\treturn a + b" + NL + "}" + NL + NL + "func (s *Stack) Push(v int) {" + NL + "\ts.items = append(s.items, v)" + NL + "}" + NL + NL + "func (q *Queue) Push(v int) {" + NL + "\tq.items = append(q.items, v)" + NL + "}" + NL;
w("main.go", go);
t(spliceProblem("main.go", go, go) === "", "go: methods with the same name on different types are not a splice");
const cutGo = go.slice(0, go.indexOf("append(s.items"));
g = await gatedWrite(d, "main.go", cutGo, {});
t(!g.ok && g.kind === "cut" && r("main.go") === go, "go: a write cut off by the token limit (open brackets at the end) is rejected and restored");
g = await gatedWrite(d, "main.go", go + NL + "func Add(a, b int) int {" + NL + "\treturn b + a" + NL + "}" + NL, {});
t(!g.ok && g.kind === "splice", "go: a second func Add is rejected");
g = await gatedWrite(d, "main.go", go.replace("a + b", "b + a"), {});
t(g.ok && r("main.go").includes("b + a"), "go: a good edit is kept");

// ---- new files, non-code files
g = await gatedWrite(d, "fresh.py", "def x(:" + NL, {});
t(g.ok && fs.existsSync(path.join(d, "fresh.py")), "a brand-new file is written, never rejected here (the normal gate reports on it)");
w("notes.md", "# a" + NL);
g = await gatedWrite(d, "notes.md", "# a" + NL + "# a" + NL, {});
t(g.ok, "non-code files are not judged");

// ---- fail-open
w("beer-song.js", good);
g = await gatedWrite(d, "beer-song.js", broken, { verdict: async () => { throw new Error("checker crashed"); } });
t(g.ok && r("beer-song.js") === broken, "fail-open: a crashing checker never blocks the write");
g = await gatedWrite(d, "beer-song.js", good, { verdict: async () => null });
t(g.ok && r("beer-song.js") === good, "fail-open: a checker that returns nothing never blocks the write");
t(spliceProblem(null, undefined, {}) === "" && cutOffProblem("x.js", null, 5) === "", "fail-open: the plain-text checks answer \"\" on odd input");
t((await writeGateVerdict(d, "missing/dir/x.js", "a", "b")).ok, "fail-open: writeGateVerdict on a file that is not there says ok");

// ---- scoring: a test file that cannot even load must score WORST, not "0 failing"
const jestBroken = ["FAIL ./beer-song.spec.js", "  ● Test suite failed to run", "", "    SyntaxError: beer-song.js: 'return' outside of function. (37:4)", "", "Test Suites: 1 failed, 1 total", "Tests:       0 total", "Snapshots:   0 total"].join(NL);
const jestNoSyntaxLine = ["FAIL ./beer-song.spec.js", "  ● Test suite failed to run", "    Jest encountered an unexpected token", "Test Suites: 1 failed, 1 total", "Tests:       0 total"].join(NL);
const jestStub = ["FAIL ./beer-song.spec.js", "Test Suites: 1 failed, 1 total", "Tests:       8 failed, 8 total"].join(NL);
const s1 = summarizeTests(jestNoSyntaxLine);
t(s1 && s1.ok === false && s1.total === 0, "summarizeTests: 'Test suite failed to run' + 'Tests: 0 total' is NOT ok (was ok:true)");
const ag0 = new Agent(d, {});
t(ag0._goodness(jestNoSyntaxLine) === -1 && ag0._failCount(jestNoSyntaxLine) === Infinity, "a suite that cannot run scores -1 passing / Infinity failing (worse than the stub's 0 / 8)");
t(ag0._goodness(jestBroken) === -1 && ag0._goodness(jestStub) === 0 && ag0._failCount(jestStub) === 8, "the stub still scores 0 passing / 8 failing");
const sMixed = summarizeTests(["  ● Test suite failed to run", "Test Suites: 1 failed, 1 passed, 2 total", "Tests:       5 passed, 5 total"].join(NL));
t(sMixed && !sMixed.ok && sMixed.pass === 5 && sMixed.fails === 1, "summarizeTests: one suite that cannot load among passing ones counts as a failure");
t(JSON.stringify(summarizeTests("Tests:       3 passed, 3 total")) === JSON.stringify({ total: 3, pass: 3, fails: 0, ok: true }), "summarizeTests: a normal green jest run is unchanged");

// ---- best state ever: every test run counts, the first draft beats a tie with the stub, the end restores it (deadline path)
const b = fs.mkdtempSync(path.join(os.tmpdir(), "eta-gate1-best-"));
const wb = (f, s) => fs.writeFileSync(path.join(b, f), s), rb = (f) => fs.readFileSync(path.join(b, f), "utf8");
wb("package.json", JSON.stringify({ name: "beer", version: "1.0.0", type: "module" }));
// a tiny jest-like runner: prints the jest summary lines the engine reads
wb("run-tests.mjs", [
  "let pass = 0, failed = 0;",
  "try {",
  "  const m = await import('./beer-song.js?' + Date.now());",
  "  const chk = (f) => { try { if (f()) pass++; else failed++; } catch { failed++; } };",
  "  chk(() => m.recite(2, 1) === '2 bottles of beer on the wall, 2 bottles of beer.\\nTake one down and pass it around, 1 bottle of beer on the wall.');",
  "  chk(() => m.recite(1, 1) === '1 bottle of beer on the wall, 1 bottle of beer.\\nTake it down and pass it around, no more bottles of beer on the wall.');",
  "  chk(() => m.recite(3, 2).split('\\n\\n').length === 2);",
  "  chk(() => m.recite(0, 1).startsWith('No more'));",
  "} catch (e) { console.log('FAIL ./beer-song.spec.js'); console.log('  ● Test suite failed to run'); console.log('    ' + String(e && e.message || e).split('\\n')[0]); console.log('Test Suites: 1 failed, 1 total'); console.log('Tests:       0 total'); process.exit(1); }",
  "console.log('Test Suites: ' + (failed ? '1 failed' : '1 passed') + ', 1 total');",
  "console.log('Tests:       ' + [failed ? failed + ' failed' : '', pass ? pass + ' passed' : ''].filter(Boolean).join(', ') + ', ' + (pass + failed) + ' total');",
  "process.exit(failed ? 1 : 0);"].join(NL));
const STUB = "export const recite = (initialBottlesCount, takeDownCount) => {" + NL + "  throw new Error('Remove this statement and implement this function');" + NL + "};" + NL;
wb("beer-song.js", STUB);
const cmd = "node run-tests.mjs";
const ag = new Agent(b, {});
ag.watch = new Watchdog(); ag._detectedTestCmd = cmd; ag._startSnap = await snapshotCode(b); ag.gates = ag.gates || {}; ag.files = new Set(); ag.failedCmds = new Map();
const H = gate1TestHooks; H.taps.set(H.tapKey(b), (c, o) => ag._noteTestRun(c, o));
const events = []; const emit = (e) => events.push(e);
let out = String(await H.run(b, cmd));
t(ag.watch.best && ag.watch.best.start === true && ag.watch.best.score.good === 0 && ag.watch.best.score.fails === 4, "best state: the first test run records the untouched stub (0 passing, 4 failing) as the start");
wb("beer-song.js", good); // the first complete draft: compiles, but ties the stub (every check fails: it returns arrays of lines)
out = String(await H.run(b, cmd));
const drafted = ag.watch.best && ag.watch.best.draft === true && ag.watch.best.files.get("beer-song.js") === good;
t(drafted, "first draft: a compiling draft that TIES the stub becomes the best state");
t(String(await H.run(b, "node -e \"console.log(1)\"")) && ag.watch.best.files.get("beer-song.js") === good, "only THE test command is recorded (another command changes nothing)");
wb("beer-song.js", broken); // the bad edit lands (as it did in the benchmark, past the old gate)
ag.stopped = false; ag._bestGuardDone = false; ag._bestNote = "";
const did = await ag._bestEverGuard(cmd, emit, "deadline");
t(did === true && rb("beer-song.js") === good, "deadline path: the end state (suite cannot run) is replaced by the best draft");
t(/best state restored/.test(ag._bestNote) && /could not run/.test(ag._bestNote), "the final status note says the best state was restored: " + ag._bestNote);
t(events.some((e) => e.type === "log" && /best-state guarantee \(deadline\)/.test(e.text)), "a log line names the deadline path");
t(events.some((e) => e.type === "log" && /drafts kept before/.test(e.text)), "the broken end state is kept as a draft before the restore");
t((await ag._bestEverGuard(cmd, emit, "exit")) === false, "the guarantee runs once per run (the exit call after the end call does nothing)");
// a better state later, then a worse one: the better one comes back
const passing = [...VERSE, "", "export const recite = (s, k) => {", "  const out = [];", "  for (let i = 0; i < k; i++) out.push(verse(s - i).join(\"\\n\"));", "  return out.join(\"\\n\\n\");", "};", ""].join(NL);
wb("beer-song.js", passing);
out = String(await H.run(b, cmd));
t(ag.watch.best.score.good === 4 && ag.watch.best.files.get("beer-song.js") === passing, "a later state with 4 passing becomes the best state");
wb("beer-song.js", good); // a worse 'repair'
ag._bestGuardDone = false; ag._bestNote = "";
t((await ag._bestEverGuard(cmd, emit, "end")) === true && rb("beer-song.js") === passing, "end of run: the 4-passing state comes back over the 0-passing end state");
ag._bestGuardDone = false; ag._bestNote = "";
t((await ag._bestEverGuard(cmd, emit, "end")) === false && rb("beer-song.js") === passing, "end state as good as the best: nothing is restored");
H.taps.delete(H.tapKey(b));

// ---- Watchdog.capture rules on their own
{
  const c = fs.mkdtempSync(path.join(os.tmpdir(), "eta-gate1-cap-"));
  fs.writeFileSync(path.join(c, "a.py"), "x = 1" + NL);
  const start = await snapshotCode(c);
  const wd = new Watchdog();
  await wd.capture(c, { good: 0, fails: 2 }, { startSnap: start });
  fs.writeFileSync(path.join(c, "a.py"), "x = 2" + NL);
  t(await wd.capture(c, { good: 0, fails: 2 }, { startSnap: start }), "capture: a tie with the start state is replaced by the first draft");
  fs.writeFileSync(path.join(c, "a.py"), "x = 3" + NL);
  t(!(await wd.capture(c, { good: 0, fails: 2 }, { startSnap: start })) && wd.best.files.get("a.py") === "x = 2" + NL, "capture: a later tie does NOT replace the first draft");
  const old = new Watchdog(); await old.capture(c, { good: 1, fails: 0 });
  t(old.best && old.best.start === false, "capture: the old two-argument call still works");
  fs.rmSync(c, { recursive: true, force: true });
}

try { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); } catch {}
console.log(`gate1: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
