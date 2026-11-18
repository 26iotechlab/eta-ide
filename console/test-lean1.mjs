// LEAN1 (2026-11-17): the lean path for small exercise-shaped tasks (draft -> tests -> bounded repair -> best state kept).
// Real files in temp folders, a fake local model server (scripted replies), real python / node test runs. No GPU, no network.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { Agent, setProvider, provider, leanRoute, leanTaskWording, parseLeanReply, leanDiffBlock, leanPrompt, leanGreen, leanExtraFiles, LEAN_SYSTEM } from "./agent.mjs";
import { snapshotCode } from "./watchdog.mjs";

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("PASS", m); } else { fail++; console.log("FAIL", m, extra === undefined ? "" : JSON.stringify(extra).slice(0, 900)); } };
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), "eta-lean1-" + n + "-"));
const w = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const rd = (d, f) => fs.readFileSync(path.join(d, f), "utf8");
const EX = (impl, test) => `Implement the exercise described below. Edit this file: ${impl} (it contains only a starting stub). The test file ${test} is already in this folder: do NOT change it; your code must make every test pass. Keep the names of the functions and classes that the stub and the tests use.\n\n# Instructions\n\nAdd two numbers and subtract two numbers.`;

const STUB = "def add(a, b):\n    raise NotImplementedError('Remove this statement and implement this function')\n\n\ndef sub(a, b):\n    raise NotImplementedError('Remove this statement and implement this function')\n";
const GOOD = "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n";
const HALF = "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a + b\n"; // add right, sub wrong: 2 of 3 pass
const WORSE = "def add(a, b):\n    return 0\n\n\ndef sub(a, b):\n    return 0\n"; // compiles, 0 of 3 pass
const BROKEN = "def add(a, b):\n    return a +\n\n\ndef sub(a, b):\n    return a - b\n";
const TESTS = "import unittest\nfrom calc import add, sub\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_add_neg(self):\n        self.assertEqual(add(-1, 1), 0)\n    def test_sub(self):\n        self.assertEqual(sub(5, 3), 2)\n\nif __name__ == '__main__':\n    unittest.main()\n";
const UCMD = 'python -B -m unittest discover -p "*_test.py"';
const file = (rel, body) => `=== FILE: ${rel} ===\n${body}=== END ===\n`;
function pyProject(name) { const d = tmp(name); w(d, "calc.py", STUB); w(d, "calc_test.py", TESTS); return d; }

// ---------- 1. routing (plain code) ----------
console.log("1. routing rule");
{
  const d = pyProject("route");
  const snap = await snapshotCode(d);
  const r = leanRoute({ task: EX("calc.py", "calc_test.py"), snap, testCmd: UCMD, env: {} });
  ok(r.ok && r.targets.join() === "calc.py" && r.tests.join() === "calc_test.py", "exercise task, 1 stub + 1 test file: lean path, target calc.py", r);
  ok(!leanRoute({ task: EX("calc.py", "calc_test.py"), snap, testCmd: null, env: {} }).ok, "no test command: not lean");
  ok(!leanRoute({ task: EX("calc.py", "calc_test.py"), snap, testCmd: UCMD, env: { ETA_LEAN: "0" } }).ok, "ETA_LEAN=0 turns it off");
  ok(!leanRoute({ task: EX("calc.py", "calc_test.py"), snap, testCmd: UCMD, optOut: true, env: {} }).ok, "leanPath:false turns it off");
  ok(!leanRoute({ task: EX("calc.py", "calc_test.py"), snap, testCmd: UCMD, planApproval: true, env: {} }).ok, "plan approval on: not lean (the user wants a plan)");
  const big = new Map(snap); for (const f of ["a.py", "b.py", "c.py"]) big.set(f, "x = 1\n");
  const rb = leanRoute({ task: EX("calc.py", "calc_test.py"), snap: big, testCmd: UCMD, env: {} });
  ok(!rb.ok && /4 source files/.test(rb.why), "4 source files: not lean (old path for bigger projects)", rb);
  const many = new Map(snap); for (const f of ["t1_test.py", "t2_test.py", "t3_test.py"]) many.set(f, "import unittest\n");
  ok(!leanRoute({ task: EX("calc.py", "calc_test.py"), snap: many, testCmd: UCMD, env: {} }).ok, "4 test files: not lean");
  const noTests = new Map([["calc.py", STUB]]);
  ok(!leanRoute({ task: EX("calc.py", "calc_test.py"), snap: noTests, testCmd: UCMD, env: {} }).ok, "no test file in the project: not lean");
  const cfg = new Map(snap); cfg.set("babel.config.js", "module.exports = {};\n"); cfg.set("setup.py", "x=1\n"); cfg.set("conftest.py", "x=1\n");
  ok(leanRoute({ task: EX("calc.py", "calc_test.py"), snap: cfg, testCmd: UCMD, env: {} }).ok, "config files (babel.config.js, setup.py, conftest.py) do not count as source files");
  ok(leanTaskWording("Implement add() in calc.py. The test file test_calc.py is already in this folder: do NOT change it; your code must make every test pass."), "wording: 'test file is already in this folder ... make every test pass'");
  ok(leanTaskWording("Fix the bug in calc.py so that the tests pass."), "wording: 'fix the bug so that the tests pass'");
  ok(!leanTaskWording("Write pytest tests for textutils.py. Put them in tests/test_textutils.py. The tests must pass."), "wording: a task that asks to WRITE tests is not lean");
  ok(!leanTaskWording("Find and fix the bug, and add a test for it."), "wording: 'add a test' is not lean");
  ok(!leanTaskWording("Update the tests in test_calc.py so they pass."), "wording: 'update the tests' is not lean");
  ok(!leanTaskWording("Add priorities to my todo app (todo.py)."), "wording: a feature request with no tests named is not lean");
  ok(!leanTaskWording("make me a little number guessing game"), "wording: a vague request is not lean");
  // the real benchmark tasks (all 10 of seed 3) route to the lean path; the real-use tasks do not
  const B = "D:/eta-ide/dev-scratch/bench/tasks-poly-3", R = "D:/eta-ide/dev-scratch/reality/tasks";
  if (fs.existsSync(B)) {
    let n = 0, yes = 0;
    for (const t of fs.readdirSync(B)) { const ws = path.join(B, t, "start"); n++; const rr = leanRoute({ task: rd(path.join(B, t), "task.txt"), snap: await snapshotCode(ws), testCmd: /^js-/.test(t) ? "npm test --silent" : UCMD, env: {} }); if (rr.ok && rr.targets.length === 1) yes++; }
    ok(n > 0 && yes === n, `benchmark seed 3: ${yes} of ${n} tasks take the lean path with one target file`);
  }
  if (fs.existsSync(R)) {
    let n = 0, yes = [];
    for (const t of fs.readdirSync(R)) { const ws = path.join(R, t, "start"); if (!fs.existsSync(ws)) continue; n++; const rr = leanRoute({ task: rd(path.join(R, t), "task.txt"), snap: await snapshotCode(ws), testCmd: "python -m pytest -q", env: {} }); if (rr.ok) yes.push(t); }
    ok(n > 0 && yes.length === 0, `real-use tasks: none of ${n} take the lean path (features, bug reports, write-tests, vague)`, yes);
  }
  fs.rmSync(d, { recursive: true, force: true });
}

// ---------- 2. reply parsing + prompt ----------
console.log("2. reply parsing and the repair prompt");
{
  let p = parseLeanReply(file("calc.py", GOOD) + file("calc_test.py", "x\n"));
  ok(p.length === 2 && p[0].rel === "calc.py" && p[0].body === GOOD, "two FILE blocks parsed, body exact", p);
  p = parseLeanReply("<think>let me think\n=== FILE: nope.py ===\nx\n</think>\n=== FILE: calc.py ===\n```python\n" + GOOD + "```\n");
  ok(p.length === 1 && p[0].rel === "calc.py" && p[0].body === GOOD, "think block dropped, missing END and a markdown fence tolerated", p);
  p = parseLeanReply("Here it is:\n```python\n" + GOOD + "```\nDone.", ["calc.py"]);
  ok(p.length === 1 && p[0].rel === "calc.py" && p[0].body === GOOD, "one target and no FILE header: the fenced block is used for it", p);
  ok(parseLeanReply("Here it is:\n```python\n" + GOOD + "```", ["a.py", "b.py"]).length === 0, "two targets and no header: nothing is guessed");
  ok(parseLeanReply(file("../evil.py", "x\n") + file("C:/x.py", "y\n")).length === 0, "paths outside the folder are dropped");
  ok(parseLeanReply(file("calc.py", HALF) + file("calc.py", GOOD))[0].body === GOOD && parseLeanReply(file("calc.py", HALF) + file("calc.py", GOOD)).length === 1, "the same file twice: the last one wins");
  const out = "FAIL: test_sub (calc_test.T.test_sub)\nTraceback (most recent call last):\n  File \"calc_test.py\", line 9, in test_sub\n    self.assertEqual(sub(5, 3), 2)\nAssertionError: 8 != 2\n\nRan 3 tests in 0.001s\n\nFAILED (failures=1)\n";
  const pr = leanPrompt({ task: "TASK X", files: [["calc.py", HALF]], testCmd: UCMD, testOut: out, rejects: [{ rel: "calc.py", why: "SyntaxError: invalid syntax" }] });
  ok(/TASK X/.test(pr) && /--- calc\.py ---/.test(pr) && /2 of 3 pass, 1 fail/.test(pr) && /8 != 2/.test(pr) && /NOT KEPT FOR: calc\.py \(SyntaxError/.test(pr), "repair prompt: task, files, real counts, the failing assertion, the write-gate refusal", pr.slice(0, 600));
  ok(!/THE TESTS WERE RUN/.test(leanPrompt({ task: "T", files: [] })), "first-draft prompt has no test section");
  {
    const d = tmp("extra");
    w(d, "grep.js", "x"); w(d, "grep.spec.js", "t"); w(d, "package.json", "{}"); w(d, "LICENSE", "MIT"); w(d, ".eslintrc", "{}"); w(d, "data/iliad.txt", "Achilles"); w(d, "node_modules/x/index.js", "y"); w(d, "big.txt", "z".repeat(25000));
    const ex = (await leanExtraFiles(d, new Set(["grep.js"]))).map(([f]) => f);
    ok(ex.join() === "data/iliad.txt,package.json", "extra prompt files: data and package.json; no test, LICENSE, dot, node_modules or big file", ex);
    fs.rmSync(d, { recursive: true, force: true });
  }
  ok(leanGreen("Ran 3 tests\n\nOK\n", { good: 3, fails: 0 }) && !leanGreen("⚠ COMMAND FAILED (exit 1)\n", { good: 3, fails: 0 }) && !leanGreen("", { good: 0, fails: 0 }), "green = no failure mark, passing > 0, failing 0");
}

// ---------- 3. end to end with a scripted fake model ----------
let SCRIPT = [], SEEN = [], DELAY = 0, DELAY_ONCE = false;
function startFake() {
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", async () => {
      if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake" }] })); }
      if (!req.url.endsWith("/chat/completions")) { res.statusCode = 404; return res.end("{}"); }
      let body = {}; try { body = JSON.parse(b); } catch {}
      SEEN.push(body);
      const isLean = (body.messages || []).some((m) => m.role === "system" && m.content === LEAN_SYSTEM);
      const out = isLean ? (SCRIPT.length ? SCRIPT.shift() : "") : "OK";
      if (DELAY) { const dl = DELAY; if (DELAY_ONCE) DELAY = 0; await new Promise((r) => setTimeout(r, dl)); }
      if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`); res.write("data: [DONE]\n\n"); return res.end(); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}
const saved = { ...provider }; const savedEnv = { k: process.env.ETA_PROMPT_KEEPER, b: process.env.ETA_LEAN_BUDGET_MS, f: process.env.ETA_LEAN_FALLBACK };
process.env.ETA_PROMPT_KEEPER = "0"; delete process.env.ETA_LEAN_FALLBACK;
const fake = await startFake();
setProvider({ base: `http://127.0.0.1:${fake.port}`, kind: "openai", model: "fake", key: "", noGrammar: true });
async function e2e(root, task, script, opts = {}) {
  SCRIPT = [...script]; SEEN = [];
  const ag = new Agent(root, { autoApprove: true, timeBudgetMs: 120000, numCtx: 16384, model: "fake", testCmd: UCMD, testBaselineOk: false, ...opts });
  ag.resolveHelperModel = async function () { this._helperBase = null; this._helperKind = null; this._helperModel = this.memModel; return this.memModel; };
  const ev = []; const t0 = Date.now(); await ag.run(task, (e) => ev.push(e), opts.approve || (async () => true));
  const leanCalls = SEEN.filter((b) => (b.messages || []).some((m) => m.content === LEAN_SYSTEM));
  return { ag, ev, ms: Date.now() - t0, calls: leanCalls.length, otherCalls: SEEN.length - leanCalls.length, prompts: leanCalls.map((b) => b.messages[1].content), done: ev.filter((e) => e.type === "done").pop(), logs: ev.filter((e) => e.type === "log").map((e) => e.text), answers: ev.filter((e) => e.type === "answer").map((e) => e.text) };
}
const lean = (r) => r.logs.filter((t) => /^lean path|best-state|write gate/.test(t));
try {
  console.log("3a. a good first draft: one model call, tests green, done");
  {
    const d = pyProject("good");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", GOOD)]);
    ok(rd(d, "calc.py") === GOOD, "calc.py holds the draft");
    ok(r.calls === 1 && r.otherCalls === 0, "exactly one model call, no planner/analyst/reviewer calls", { calls: r.calls, other: r.otherCalls });
    ok(r.done && r.done.status === "done" && r.done.outcome === "done" && r.done.files.includes("calc.py"), "done event: status done, calc.py changed", r.done);
    ok(r.answers.some((a) => /^Done: 3 of 3 tests pass/.test(a)), "answer states the measured result", r.answers);
    ok(rd(d, "calc_test.py") === TESTS, "test file untouched");
    ok(r.logs.some((t) => /^lean path: small task: calc\.py \+ 1 test file/.test(t)), "the log says why the lean path was taken", lean(r));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3b. draft half right, repair 1 worse (put back), repair 2 fixes it");
  {
    const d = pyProject("repair");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", HALF), file("calc.py", WORSE), file("calc.py", GOOD)]);
    ok(r.calls === 3, "three model calls (draft + 2 repairs)", r.calls);
    ok(rd(d, "calc.py") === GOOD && r.done?.status === "done", "ends green with the repaired file", { f: rd(d, "calc.py"), s: r.done?.status });
    ok(r.logs.some((t) => /repair round 1 was not better \(1 passing, 2 failing vs best 2 passing, 1 failing\) - put back the best state: calc\.py/.test(t)), "the worse repair was measured and undone", lean(r));
    ok(/THE TESTS WERE RUN/.test(r.prompts[1]) && /sub/.test(r.prompts[1]) && r.prompts[1].includes(HALF.trim()), "repair 1 got the real failures and the best draft", r.prompts[1]?.slice(-900));
    ok(r.prompts[2].includes(HALF.trim()) && !r.prompts[2].includes(WORSE.trim()), "repair 2 starts again from the best state, not from the worse one");
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3c. NEVER BELOW THE FIRST DRAFT: both repairs worse, the draft stays");
  {
    const d = pyProject("never-worse");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", HALF), file("calc.py", WORSE), file("calc.py", WORSE.replace("return 0", "return 1"))]);
    ok(rd(d, "calc.py") === HALF, "calc.py is the first draft (2 of 3), not a worse repair", rd(d, "calc.py"));
    ok(r.done && r.done.status === "not-done" && /tests still failing \(1 failing\)/.test(r.done.verdict || ""), "honest verdict: not done, 1 failing", r.done);
    ok(r.answers.some((a) => /Not fully complete - 2\/3 tests passing, 1 still failing/.test(a)), "honest answer with the real counts", r.answers);
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3d. a syntax-broken draft is refused by the write gate; the next round gets the reason");
  {
    const d = pyProject("syntax");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", BROKEN), file("calc.py", GOOD)]);
    ok(r.logs.some((t) => /write gate: rejected the new calc\.py \(syntax/.test(t)), "write gate rejected the broken draft", lean(r));
    ok(/NOT KEPT FOR: calc\.py/.test(r.prompts[1] || ""), "round 1 was told why the draft was not kept");
    ok(rd(d, "calc.py") === GOOD && r.done?.status === "done", "ends green", r.done);
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3e. the reply also rewrites the test file: refused, the tests stay");
  {
    const d = pyProject("testedit");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", HALF) + file("calc_test.py", "import unittest\n"), file("calc.py", GOOD)]);
    ok(rd(d, "calc_test.py") === TESTS, "calc_test.py unchanged");
    ok(r.logs.some((t) => /refused to write the test file calc_test\.py/.test(t)), "the refusal is logged");
    ok(r.done?.status === "done", "the code part was still used and repaired", r.done);
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3f. a lazy model (no files ever): stub unchanged, honest not-done");
  {
    const d = pyProject("lazy");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), ["All tests pass, done.", "Done.", "Done."]);
    ok(rd(d, "calc.py") === STUB, "calc.py is still the stub");
    ok(r.done && r.done.status === "not-done", "status not-done", r.done);
    ok(r.answers.some((a) => /Not fully complete/.test(a)), "honest answer, the model's claim is not repeated as truth");
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3g. strict time budget: no repair round starts without time for it");
  {
    process.env.ETA_LEAN_BUDGET_MS = "8000";
    const d = pyProject("budget");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", HALF), file("calc.py", GOOD)]);
    ok(r.calls === 1, "only the draft call ran", r.calls);
    ok(r.logs.some((t) => /stopping before repair round 1/.test(t)), "the stop is logged with the time left", lean(r));
    ok(rd(d, "calc.py") === HALF && r.done?.status === "not-done", "the best state (the draft) stays, honest not-done");
    delete process.env.ETA_LEAN_BUDGET_MS;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3h. the outer deadline also stops it");
  {
    const d = pyProject("deadline");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", HALF), file("calc.py", GOOD)], { deadlineAt: Date.now() + 65000 });
    ok(r.calls === 1 && r.logs.some((t) => /stopping before repair round 1/.test(t)), "deadline 65 s (minus the 45 s wrap-up): no repair round", { calls: r.calls, l: lean(r) });
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3i. without auto-approve every write is asked; a 'no' writes nothing");
  {
    const d = pyProject("approve");
    const asked = [];
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", GOOD), file("calc.py", GOOD), file("calc.py", GOOD)], { autoApprove: false, approve: async (title) => { asked.push(title); return false; } });
    ok(asked.length >= 1 && asked.every((t) => t === "Rewrite calc.py"), "the user was asked before each write", asked);
    ok(rd(d, "calc.py") === STUB && r.done?.status === "not-done", "nothing written after 'no'");
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3j. JavaScript (node --test) exercise");
  {
    const d = tmp("js");
    w(d, "package.json", JSON.stringify({ name: "x", type: "module", private: true }));
    w(d, "calc.js", "export const add = (a, b) => {\n  throw new Error('Remove this line and implement the function');\n};\n");
    w(d, "calc.test.js", "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './calc.js';\ntest('add', () => { assert.strictEqual(add(2, 3), 5); });\ntest('neg', () => { assert.strictEqual(add(-1, 1), 0); });\n");
    const r = await e2e(d, EX("calc.js", "calc.test.js"), ["=== FILE: calc.js ===\nexport const add = (a, b) => a + b;\n"], { testCmd: "node --test" });
    ok(/a \+ b/.test(rd(d, "calc.js")) && r.done?.status === "done" && r.calls === 1, "one call, node --test green, done", { s: r.done, calls: r.calls, l: lean(r) });
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3l. a hung first call is dropped at the call cap and the first draft is tried once more");
  {
    const d = pyProject("hang");
    const savedCap = process.env.ETA_LEAN_CALL_CAP_MS; process.env.ETA_LEAN_CALL_CAP_MS = "800";
    DELAY = 6000; DELAY_ONCE = true;
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [file("calc.py", GOOD), file("calc.py", GOOD)]);
    DELAY = 0; DELAY_ONCE = false; if (savedCap === undefined) delete process.env.ETA_LEAN_CALL_CAP_MS; else process.env.ETA_LEAN_CALL_CAP_MS = savedCap;
    ok(r.logs.some((t) => /the model call failed \(no answer within/.test(t)), "the hung call was dropped", lean(r));
    ok(r.logs.some((t) => /trying the first draft once more/.test(t)), "one retry of the first draft", lean(r));
    ok(rd(d, "calc.py") === GOOD && r.done?.status === "done", "the retry wrote the draft and the tests are green", { s: r.done, l: lean(r) });
    ok(r.ms < 30000, "the run did not wait for the hung call", { ms: r.ms });
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log("3k. not routed: leanPath:false keeps the old path");
  {
    const d = pyProject("optout");
    const r = await e2e(d, EX("calc.py", "calc_test.py"), [], { leanPath: false, timeBudgetMs: 20000 });
    ok(r.calls === 0 && r.logs.some((t) => /^lean path: not used \(turned off\)/.test(t)), "lean path not used; the old path ran", { calls: r.calls, l: lean(r) });
    fs.rmSync(d, { recursive: true, force: true });
  }
} finally {
  fake.server.close(); setProvider(saved);
  for (const [k, v] of [["ETA_PROMPT_KEEPER", savedEnv.k], ["ETA_LEAN_BUDGET_MS", savedEnv.b], ["ETA_LEAN_FALLBACK", savedEnv.f]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
// leanDiffBlock: shows how the result differs from what the test expected
{ const out = ["  - Expected  - 2", "  + Received  + 3", "", "  - line a", "  + line a", "  +", "    line b", "", "    12 |   expect(x).toBe(y);", "    at Object.<anonymous> (a.test.js:12:3)"].join(String.fromCharCode(10));
  const b = leanDiffBlock(out);
  ok(/HOW THE RESULT DIFFERS/.test(b) && /EMPTY LINE/.test(b), "leanDiffBlock: shows the extra empty line", b);
  ok(!/expect\(x\)/.test(b), "leanDiffBlock: stops before the code frame");
  ok(leanDiffBlock("all fine") === "" && leanDiffBlock(null) === "", "leanDiffBlock: no diff in the output gives an empty string"); }
console.log(`\nlean1: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
