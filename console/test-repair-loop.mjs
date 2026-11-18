// Test: the repair loop fixes from build20 (2026-11-15, reports/build-weakness-analysis.md).
// NO real model, NO GPU: pure functions, a stub model object, and one FAKE local model server (like
// test-prompt-keeper.mjs) that drives the REAL agent through the test gate. Python runs the tests.
//  1. A traceback with a Python-library frame (json\decoder.py) must point at the PROJECT file.
//  2. The test gate's first fix round still gets time when the run clock is already spent.
//  3. Later fix attempts see the real error text and the debugger's answer; __init__ can be the surgical target.
// Run: node test-repair-loop.mjs
import fs from "fs"; import os from "os"; import path from "path"; import http from "http";
import { Agent, setProvider, provider, pickImplFile, parseFailure, falsifyingCase, frameInProject, firstFailureBlock, initInTraceback } from "./agent.mjs";

let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const WIN = process.platform === "win32";

// ---- 1. tracebacks: library frames are ignored ----
const winTb = (root, py) => `E.
======================================================================
ERROR: test_empty_file (test_expenses.T.test_empty_file)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "${root}\\test_expenses.py", line 9, in test_empty_file
    b = ExpenseBook(p)
        ^^^^^^^^^^^^^^
  File "${root}\\expenses.py", line 12, in __init__
    self.items = json.load(f)
                 ^^^^^^^^^^^^
  File "${py}\\Lib\\json\\__init__.py", line 293, in load
    return loads(fp.read(),
  File "${py}\\Lib\\json\\decoder.py", line 355, in raw_decode
    raise JSONDecodeError("Expecting value", s, err.value) from None
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)

----------------------------------------------------------------------
Ran 2 tests in 0.003s

FAILED (errors=1)
COMMAND FAILED (exit 1)`;
if (WIN) {
  const PY = "C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python311";
  const tb = winTb("D:\\proj", PY);
  ok(await pickImplFile(tb, "D:\\proj", new Set(), "") === "expenses.py", "pickImplFile, other drive (D: project, C: Python): picks expenses.py", await pickImplFile(tb, "D:\\proj", new Set(), ""));
  const pf = parseFailure(tb, "D:\\proj");
  ok(/expenses\.py at line 12/.test(pf) && !/decoder.py/.test(pf), "parseFailure, other drive: says expenses.py line 12, not decoder.py", pf);
  const fc = falsifyingCase(tb, "D:\\proj");
  ok(/culprit:\s+expenses\.py line 12/.test(fc) && !/decoder.py/.test(fc), "falsifyingCase, other drive: culprit is expenses.py line 12", fc);
  const tb2 = winTb("C:\\proj", "C:\\Python311");
  ok(await pickImplFile(tb2, "C:\\proj", new Set(), "") === "expenses.py", "pickImplFile, same drive: picks expenses.py", await pickImplFile(tb2, "C:\\proj", new Set(), ""));
  ok(/expenses\.py at line 12/.test(parseFailure(tb2, "C:\\proj")), "parseFailure, same drive: expenses.py line 12", parseFailure(tb2, "C:\\proj"));
  ok(/expenses\.py at line 12/.test(parseFailure(tb, "d:\\PROJ")), "parseFailure: drive letter and case differences still match the project folder", parseFailure(tb, "d:\\PROJ"));
  ok(frameInProject("D:\\proj", "C:\\Python311\\Lib\\json\\decoder.py") === false && frameInProject("D:\\proj", "D:\\proj\\a\\b.py") === true, "frameInProject: other drive is outside, sub folder is inside");
}
{ // Linux-style paths (run on every OS)
  const tb = `Traceback (most recent call last):
  File "/proj/test_expenses.py", line 9, in test_empty_file
    b = ExpenseBook(p)
  File "/proj/expenses.py", line 12, in __init__
    self.items = json.load(f)
  File "/usr/lib/python3.11/json/decoder.py", line 355, in raw_decode
    raise JSONDecodeError("Expecting value", s, err.value) from None
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)`;
  ok(await pickImplFile(tb, "/proj", new Set(), "") === "expenses.py", "pickImplFile, Linux paths: picks expenses.py", await pickImplFile(tb, "/proj", new Set(), ""));
  ok(/expenses\.py at line 12/.test(parseFailure(tb, "/proj")), "parseFailure, Linux paths: expenses.py line 12", parseFailure(tb, "/proj"));
  ok(/expenses\.py at line 12/.test(parseFailure(tb.replace(/\/proj\//g, ""), "/proj")), "parseFailure: relative frame paths are read against the project folder", parseFailure(tb.replace(/\/proj\//g, ""), "/proj"));
  // a project's OWN lib/ folder is not mistaken for Python's library
  const own = tb.replace("/proj/expenses.py", "/proj/lib/expenses.py");
  ok(await pickImplFile(own, "/proj", new Set(), "") === "lib/expenses.py", "a project sub folder named lib is still the project", await pickImplFile(own, "/proj", new Set(), ""));
  ok(initInTraceback(tb, "expenses.py") === true && initInTraceback(tb, "other.py") === false, "initInTraceback: finds 'expenses.py ... in __init__', not for another file");
  ok(initInTraceback("expenses.py:12: in __init__\n    self.items = json.load(f)", "pkg/expenses.py") === true, "initInTraceback: pytest format");
}
{ // pytest first-failure section
  const pt = `F.                                                                       [100%]
=================================== FAILURES ===================================
_______________________________ test_empty_file ________________________________

    def test_empty_file():
>       b = ExpenseBook(p)

expenses.py:12: in __init__
    self.items = json.load(f)
E   json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
=========================== short test summary info ============================
FAILED test_expenses.py::test_empty_file - json.decoder.JSONDecodeError
1 failed, 1 passed in 0.05s`;
  const b = firstFailureBlock(pt);
  ok(/test_empty_file/.test(b) && /JSONDecodeError/.test(b) && !/short test summary/.test(b), "firstFailureBlock: pytest section with the error, without the summary", b);
  const u = firstFailureBlock(winTb("D:\\proj", "C:\\Py"));
  ok(/^ERROR: test_empty_file/.test(u) && /JSONDecodeError/.test(u), "firstFailureBlock: unittest block with the traceback", u.slice(0, 80));
  ok(firstFailureBlock("x".repeat(5000), 1000).length <= 1010, "firstFailureBlock: bounded");
}

// ---- a real little project (Python runs its tests) ----
const EXP_BAD = `import json
import os


class ExpenseBook:
    def __init__(self, path):
        self.path = path
        self.items = []
        if os.path.exists(path):
            with open(path) as f:
                self.items = json.load(f)

    def add(self, name, amount):
        self.items.append({"name": name, "amount": amount})

    def total(self):
        return round(sum(i["amount"] for i in self.items), 2)
`;
const TESTS = `import os
import tempfile
import unittest
from expenses import ExpenseBook


class T(unittest.TestCase):
    def test_empty_file(self):
        fd, p = tempfile.mkstemp()
        os.close(fd)
        try:
            b = ExpenseBook(p)
            self.assertEqual(b.total(), 0)
        finally:
            os.remove(p)

    def test_add(self):
        b = ExpenseBook("missing_file_never_created.json")
        b.add("a", 2.5)
        self.assertEqual(b.total(), 2.5)


if __name__ == "__main__":
    unittest.main()
`;
const FIX_LINE = "        if os.path.exists(path) and os.path.getsize(path) > 0:";
const INIT_GOOD = `    def __init__(self, path):
        self.path = path
        self.items = []
${FIX_LINE}
            with open(path) as f:
                self.items = json.load(f)`;
const HYP = "__init__ fails when the file exists but is empty: json.load raises JSONDecodeError. Fix: only load when the file size is above 0.";
const mkProject = (tag) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), `eta-repair-${tag}-`)); fs.writeFileSync(path.join(r, "expenses.py"), EXP_BAD); fs.writeFileSync(path.join(r, "test_expenses.py"), TESTS); return r; };
const text = (m) => String(m?.content ?? "");

// ---- 3a. best-of-N fresh attempts see the error and the debugger's answer (stub model) ----
{
  const root = mkProject("fresh");
  const ag = new Agent(root, { numCtx: 16384, model: "fake" });
  ag.task = "Make ExpenseBook load the JSON file if it exists.";
  ag.authoritativeTests = { "test_expenses.py": TESTS }; ag.files.add("expenses.py");
  ag._lastHyp = HYP;
  const seen = []; ag.eta = { chat: async (m) => { seen.push(m); return { content: EXP_BAD }; } };
  const out = winTb(root, "C:\\Python311");
  await ag._genFreshImpl("expenses.py", "Write the cleanest implementation.", 0.5, out);
  const p = seen.length ? seen[0].map(text).join("\n") : "";
  ok(/WHAT FAILED LAST TIME/.test(p) && /JSONDecodeError: Expecting value/.test(p) && /ERROR: test_empty_file/.test(p), "best-of-N fresh prompt holds the real traceback", p.slice(0, 200));
  ok(p.includes(HYP), "best-of-N fresh prompt holds the debugger's answer");
  const ag0 = new Agent(root, { numCtx: 16384, model: "fake" }); ag0.task = "t"; ag0.authoritativeTests = { "test_expenses.py": TESTS };
  const seen0 = []; ag0.eta = { chat: async (m) => { seen0.push(m); return { content: EXP_BAD }; } };
  await ag0._genFreshImpl("expenses.py", "", 0.5);
  ok(seen0.length && !/WHAT FAILED LAST TIME/.test(seen0[0].map(text).join("\n")), "nothing known: no evidence block (old prompt)");
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 3b. surgical fix can pick __init__ when the traceback says so, and its prompt holds the evidence ----
{
  const root = mkProject("surg");
  const ag = new Agent(root, { numCtx: 16384, model: "fake", timeBudgetMs: 240000 });
  ag.task = "Make ExpenseBook load the JSON file if it exists."; ag.startTime = Date.now();
  ag.authoritativeTests = { "test_expenses.py": TESTS }; ag.files.add("expenses.py");
  ag._lastHyp = HYP;
  const seen = []; ag.eta = { chat: async (m) => { const t = m.map(text).join("\n"); seen.push(t); return { content: /`__init__`/.test(t) ? INIT_GOOD : "def add(self, name, amount):\n    pass" }; } };
  const logs = []; const won = await ag.surgicalEditFix("python test_expenses.py", (e) => { if (e.type === "log") logs.push(e.text); });
  const first = seen[0] || "";
  ok(/The function `__init__`/.test(first), "surgical fix: the FIRST target is __init__ (the traceback names it)", first.slice(0, 160));
  ok(/WHAT FAILED LAST TIME/.test(first) && /JSONDecodeError/.test(first) && first.includes(HYP), "surgical prompt holds the real error and the debugger's answer");
  ok(won === true && fs.readFileSync(path.join(root, "expenses.py"), "utf8").includes(FIX_LINE), "surgical fix lands: tests pass and expenses.py is fixed", { won, logs: logs.slice(-2) });
  fs.rmSync(root, { recursive: true, force: true });
}
{ // __init__ stays excluded when no traceback frame names it
  const root = mkProject("noinit");
  fs.writeFileSync(path.join(root, "expenses.py"), EXP_BAD.replace("if os.path.exists(path):", "if os.path.exists(path) and os.path.getsize(path) > 0:").replace("round(sum(", "round(1 + sum("));
  const ag = new Agent(root, { numCtx: 16384, model: "fake", timeBudgetMs: 240000 });
  ag.task = "t"; ag.startTime = Date.now(); ag.authoritativeTests = { "test_expenses.py": TESTS }; ag.files.add("expenses.py");
  const seen = []; ag.eta = { chat: async (m) => { seen.push(m.map(text).join("\n")); return { content: "def total(self):\n    return round(sum(i['amount'] for i in self.items), 2)" }; } };
  await ag.surgicalEditFix("python test_expenses.py", () => {});
  ok(seen.length > 0 && !seen.some((t) => /The function `__init__`/.test(t)), "no 'in __init__' frame: __init__ is not a target (old rule kept)", seen.map((t) => t.match(/The function `(\w+)`/)?.[1]));
  fs.rmSync(root, { recursive: true, force: true });
}

// ---- 2. the gate's first fix round gets time although the run clock is spent (REAL agent, fake model server) ----
const PLAN = "1. Fix the empty-file problem in `expenses.py`: ExpenseBook must load an empty file as an empty list.";
let AG = null; const st = { phase: "exec", debuggerSeen: 0, gateMsgs: null, n: { exec: 0, gate: 0 } };
function reply(messages) {
  const sys = messages[0]?.role === "system" ? text(messages[0]) : "";
  const last = text(messages[messages.length - 1]);
  const all = messages.map(text).join("\n");
  if (/A test is FAILING\. Find the ROOT CAUSE/.test(all)) {
    st.debuggerSeen++;
    if (st.phase === "exec") { st.phase = "gate"; AG.startTime = Date.now() - AG.timeBudgetMs - 60000; } // the executor "used up" the whole run clock
    return HYP;
  }
  if (/Output SEARCH\/REPLACE block/.test(last)) {
    return st.phase === "gate"
      ? `<<<<<<< SEARCH\n        if os.path.exists(path):\n=======\n${FIX_LINE}\n>>>>>>> REPLACE`
      : "<<<<<<< SEARCH\n        self.items = []\n=======\n        self.items = []  # loaded below\n>>>>>>> REPLACE"; // a harmless change before the gate: the bug stays
  }
  if (/Now output the COMPLETE content of the file/.test(last)) return EXP_BAD;
  if (/You are the Planner/.test(all)) return PLAN;
  if (/You are the Reviewer/.test(all)) return "APPROVED";
  if (/You fix ONE Python function|You fix MULTIPLE Python methods|You implement ONE Python method/.test(sys + last)) return "def add(self, name, amount):\n    self.items.append({'name': name, 'amount': amount})";
  if (sys.startsWith("You are Eta's Executor")) {
    let si = -1;
    if (st.phase === "gate") { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && /The project's test suite FAILED/.test(text(messages[i]))) { si = i; break; } if (si >= 0 && !st.gateMsgs) st.gateMsgs = text(messages[si]); }
    else for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && />>> STEP \d+/.test(text(messages[i]))) { si = i; break; }
    const done = st.n[st.phase]++; // one scripted action per executor call, per phase
    const script = st.phase === "gate"
      ? [{ say: "Fixing __init__.", tool: "edit_file", args: { path: "expenses.py" } }, { say: "Running the tests.", tool: "run_command", args: { command: "python test_expenses.py" } }, { say: "Fixed.", tool: "finish", args: { summary: "empty file loads as empty" } }]
      : [{ say: "Reading expenses.py.", tool: "read_file", args: { path: "expenses.py" } }, { say: "Editing.", tool: "edit_file", args: { path: "expenses.py" } }, { say: "Done.", tool: "finish", args: { summary: "edited expenses.py" } }];
    return JSON.stringify(script[Math.min(done, script.length - 1)]);
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
{
  process.env.ETA_PROMPT_KEEPER = "0";
  const fake = await startFake();
  setProvider({ base: `http://127.0.0.1:${fake.port}`, kind: "openai", model: "fake", key: "", noGrammar: true });
  const root = mkProject("gate");
  // as the server does: the test command and "the suite counts" are passed in
  AG = new Agent(root, { autoApprove: true, timeBudgetMs: 240000, numCtx: 16384, model: "fake", testCmd: "python test_expenses.py", testBaselineOk: true });
  AG.resolveHelperModel = async function () { this._helperBase = null; this._helperKind = null; this._helperModel = this.memModel; return this.memModel; }; // never start a helper model
  const ev = []; const logs = () => ev.filter((e) => e.type === "log").map((e) => e.text);
  await AG.run("Fix expenses.py so that python test_expenses.py passes: an empty expenses file must load as an empty book.", (e) => ev.push(e), async () => true);
  fake.server.close();
  if (process.env.REPAIR_VERBOSE) for (const e of ev) if (e.type === "log" || e.type === "error" || e.type === "done") console.log("   ev:", e.type, String(e.text || e.summary || "").slice(0, 200));
  const L = logs(); const gi = L.findIndex((t) => /^test gate: .* → FAIL/.test(t));
  const ri = L.findIndex((t) => /^repair window:/.test(t));
  const pi = L.findIndex((t, i) => i > gi && /^test gate: .* → PASS/.test(t));
  const tb = L.findIndex((t, i) => i > gi && /^time budget \(\d+m\) reached/.test(t));
  ok(st.debuggerSeen > 0 && gi >= 0, "PRECONDITION: the gate failed and the debugger ran (then the run clock was spent)", { debuggerSeen: st.debuggerSeen, gi });
  ok(ri > gi, "the repair window starts right after the gate failure", { gi, ri });
  ok(pi > gi && (tb < 0 || tb > pi), "the gate's first fix round got time: the next gate run PASSES (no 'time budget reached' before it)", L.filter((t) => /test gate|time budget|repair window/.test(t)));
  ok(fs.readFileSync(path.join(root, "expenses.py"), "utf8").includes(FIX_LINE), "expenses.py holds the real fix");
  ok(/expenses\.py/.test(st.gateMsgs || "") && !/decoder\.py at line|culprit:\s+\S*decoder/.test(st.gateMsgs || ""), "the gate's fix message points at expenses.py, not decoder.py", (st.gateMsgs || "").slice(0, 400));
  ok((st.gateMsgs || "").includes(HYP), "the gate's fix message holds the debugger's answer");
  fs.rmSync(root, { recursive: true, force: true });
}
// the window never SHORTENS a run that still has time left
{
  const a = new Agent(os.tmpdir(), { timeBudgetMs: 12 * 60000 }); a.startTime = Date.now() - 60000; a._repairUntil = 0;
  a.enterRepairPhase(() => {});
  ok(a._repairUntil >= a.startTime + a.timeBudgetMs - 5, "repair window early in a run: the run keeps its own remaining time (11 minutes, not 150 s)", Math.round((a._repairUntil - Date.now()) / 1000));
}
if (savedEnv === undefined) delete process.env.ETA_PROMPT_KEEPER; else process.env.ETA_PROMPT_KEEPER = savedEnv;
setProvider(saved);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
