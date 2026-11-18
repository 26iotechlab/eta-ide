// Test: Prompt Keeper (2026-11-15). How much of each model call's text starts exactly like the text the engine
// already holds from the call before it (prompt re-use). NO model, NO GPU: a FAKE local server answers with
// scripted replies in the OpenAI shape, the REAL agent runs a 3-bug fix task against it, every request is recorded.
// The fake engine holds ONE conversation, like the Eta Engine: what it holds = the last prompt + its own reply.
// This measures how stable the start of the prompt is. It does NOT measure real speed (that needs a real model).
// Run: node test-prompt-keeper.mjs
import fs from "fs"; import os from "os"; import path from "path"; import http from "http";
import { Agent, setProvider, provider, promptKeeperOn, keptActionReply } from "./agent.mjs";

let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };

const CALC_BAD = `def average(xs):
    return sum(xs) / (len(xs) + 1)


def median(xs):
    s = sorted(xs)
    return s[len(s) // 2 + 1]


def clamp(x, lo, hi):
    return max(hi, min(lo, x))
`;
const CALC_GOOD = `def average(xs):
    return sum(xs) / len(xs)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def clamp(x, lo, hi):
    return max(lo, min(hi, x))
`;
const TESTS = `import unittest
from calc import average, median, clamp


class T(unittest.TestCase):
    def test_average(self):
        self.assertEqual(average([1, 2, 3]), 2)

    def test_median(self):
        self.assertEqual(median([3, 1, 2]), 2)
        self.assertEqual(median([1, 2, 3, 4]), 2.5)

    def test_clamp(self):
        self.assertEqual(clamp(5, 0, 3), 3)
        self.assertEqual(clamp(-1, 0, 3), 0)


if __name__ == "__main__":
    unittest.main()
`;
const EDIT_REPLY = [
  "<<<<<<< SEARCH\n    return sum(xs) / (len(xs) + 1)\n=======\n    return sum(xs) / len(xs)\n>>>>>>> REPLACE",
  "<<<<<<< SEARCH\n    return s[len(s) // 2 + 1]\n=======\n    n = len(s)\n    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2\n>>>>>>> REPLACE",
  "<<<<<<< SEARCH\n    return max(hi, min(lo, x))\n=======\n    return max(lo, min(hi, x))\n>>>>>>> REPLACE",
].join("\n");
// The same plan shape as the real run on 2026-11-14 (reports/coli-reuse-20261114.log).
const PLAN = "1. Fix the bugs in `calc.py`: average divides by the wrong count, median picks the wrong index, clamp swaps lo and hi.\n2. Run `python test_calc.py` and fix any test that still fails.";  // SPEED1: a step that ONLY runs the tests is now dropped from plans

// ---- the scripted fake model ----
const text = (m) => String(m?.content ?? "");
function reply(messages) {
  const sys = messages[0]?.role === "system" ? text(messages[0]) : "";
  const last = text(messages[messages.length - 1]);
  const all = messages.map(text).join("\n");
  if (/Output SEARCH\/REPLACE block/.test(last)) return EDIT_REPLY;
  if (/Now output the COMPLETE content of the file/.test(last)) return CALC_GOOD;
  if (/You are the Planner/.test(all)) return PLAN;
  if (/You are the Reviewer/.test(all)) return "APPROVED";
  if (/You fix ONE Python function|You fix MULTIPLE Python methods|You implement ONE Python method/.test(sys + last)) {
    const m = last.match(/def (\w+)/); const name = m ? m[1] : "average"; // give the buggy body back: the surgical lever must NOT land
    const src = CALC_BAD.split("\n\n\n").find((b) => b.includes(`def ${name}(`)) || CALC_BAD.split("\n\n\n")[0];
    return src.trim();
  }
  if (sys.startsWith("You are Eta's Executor")) {
    // which step, and how many actions this step has already taken
    let si = -1; for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && />>> STEP \d+/.test(text(messages[i]))) { si = i; break; }
    const stepTxt = si >= 0 ? text(messages[si]).match(/>>> STEP \d+: ([^\n]*)/)?.[1] || "" : "";
    const done = si >= 0 ? messages.slice(si + 1).filter((m) => m.role === "assistant").length : messages.filter((m) => m.role === "assistant").length;
    const script = /^Run /.test(stepTxt)
      ? [{ say: "Running the tests.", tool: "run_command", args: { command: "python test_calc.py" } }, { say: "Done.", tool: "finish", args: { summary: "tests run" } }]
      : /^Fix /.test(stepTxt)
        ? [{ say: "Reading calc.py.", tool: "read_file", args: { path: "calc.py" } }, { say: "Fixing the three bugs.", tool: "edit_file", args: { path: "calc.py" } }, { say: "Running the tests.", tool: "run_command", args: { command: "python test_calc.py" } }, { say: "Fixed.", tool: "finish", args: { summary: "fixed calc.py" } }]
        : [{ say: "Done.", tool: "finish", args: { summary: "nothing left" } }];
    return JSON.stringify(script[Math.min(done, script.length - 1)]);
  }
  return "OK";
}

function startFake() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake" }] })); }
      if (!req.url.endsWith("/chat/completions")) { res.statusCode = 404; return res.end("{}"); }
      let body = {}; try { body = JSON.parse(b); } catch {}
      const messages = body.messages || [];
      const out = reply(messages);
      calls.push({ messages, reply: out });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`); res.write("data: [DONE]\n\n"); return res.end();
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, calls, port: server.address().port })));
}

// ---- prefix measure: ChatML text like Qwen's template; held = last prompt + its reply ----
const render = (msgs) => msgs.map((m) => `<|im_start|>${m.role}\n${text(m)}<|im_end|>\n`).join("") + "<|im_start|>assistant\n";
function common(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; }
export function measure(calls) {
  let held = "", shared = 0, total = 0; const rows = [];
  for (const c of calls) {
    const p = render(c.messages); const s = common(held, p);
    shared += s; total += p.length; rows.push({ s, n: p.length, sys: text(c.messages[0]).slice(0, 40).replace(/\n/g, " ") });
    held = p + c.reply;
  }
  return { calls: calls.length, shared, total, pct: total ? (100 * shared) / total : 0, rows };
}

async function runOnce(keeper) {
  process.env.ETA_PROMPT_KEEPER = keeper ? "1" : "0";
  const fake = await startFake();
  setProvider({ base: `http://127.0.0.1:${fake.port}`, kind: "openai", model: "fake", key: "", noGrammar: true }); // like the Eta Engine
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-keeper-"));
  fs.writeFileSync(path.join(root, "calc.py"), CALC_BAD); fs.writeFileSync(path.join(root, "test_calc.py"), TESTS);
  const ag = new Agent(root, { autoApprove: true, timeBudgetMs: 240000, numCtx: 16384, model: "fake" });
  ag.resolveHelperModel = async function () { this._helperBase = null; this._helperKind = null; this._helperModel = this.memModel; return this.memModel; }; // never start or download a helper model
  const ev = [];
  const t0 = Date.now();
  await ag.run("Fix the 3 bugs in calc.py (average, median, clamp) so that python test_calc.py passes.", (e) => ev.push(e), async () => true);
  const ms = Date.now() - t0;
  fake.server.close();
  const finalCalc = fs.readFileSync(path.join(root, "calc.py"), "utf8");
  fs.rmSync(root, { recursive: true, force: true });
  return { m: measure(fake.calls), ev, ms, fixed: finalCalc.includes("return sum(xs) / len(xs)") && finalCalc.includes("max(lo, min(hi, x))"), calls: fake.calls };
}

const saved = { ...provider }; const savedEnv = process.env.ETA_PROMPT_KEEPER;
const show = (label, r) => {
  console.log(`  ${label}: ${r.m.calls} model calls, ${r.m.shared} of ${r.m.total} prompt characters re-used = ${r.m.pct.toFixed(1)}% (about ${Math.round(r.m.shared / 4)} of ${Math.round(r.m.total / 4)} tokens); read fresh: about ${Math.round((r.m.total - r.m.shared) / 4)} tokens; calc.py fixed: ${r.fixed}`);
  if (process.env.KEEPER_VERBOSE) for (const [i, x] of r.m.rows.entries()) console.log(`     #${i + 1} ${x.s}/${x.n} (${x.n ? Math.round((100 * x.s) / x.n) : 0}%)  ${x.sys}`);
};
const before = await runOnce(false);
show("BEFORE (keeper off)", before);
const after = await runOnce(true);
show("AFTER  (keeper on) ", after);

ok(before.m.calls >= 6, "the task makes several model calls (a multi-call task)", before.m.calls);
ok(before.fixed && after.fixed, "the task gets done both ways (calc.py fixed)", { before: before.fixed, after: after.fixed });
ok(after.m.pct >= 80, "keeper on: at least 80% of prompt text re-used (roundtable pass bar)", after.m.pct.toFixed(1));
ok(after.m.pct > before.m.pct + 10, "keeper on re-uses clearly more than keeper off", { before: before.m.pct.toFixed(1), after: after.m.pct.toFixed(1) });
const fresh = (r) => r.m.total - r.m.shared;
ok(fresh(after) < fresh(before) * 0.8, "keeper on: at least 20% fewer prompt tokens read fresh (the part that costs time)", { before: Math.round(fresh(before) / 4), after: Math.round(fresh(after) / 4) });
// with the keeper on, the executor's system text is the same in every executor call of the run
const execSys = (r) => new Set(r.calls.filter((c) => text(c.messages[0]).startsWith("You are Eta's Executor")).map((c) => text(c.messages[0])));
ok(execSys(after).size === 1, "keeper on: one executor system text for the whole run", execSys(after).size);
ok(after.calls.some((c) => text(c.messages[c.messages.length - 1]).startsWith("ROLE CHANGE FOR THIS ONE REPLY")), "keeper on: side calls carry the role-change line");
ok(!before.calls.some((c) => c.messages.some((m) => text(m).includes("ROLE CHANGE FOR THIS ONE REPLY"))), "keeper off: no role-change line anywhere (old prompts)");
const doneEv = (r) => r.ev.find((e) => e.type === "done") || r.ev[r.ev.length - 1];
ok(doneEv(after)?.type === doneEv(before)?.type, "the run ends the same way both ways", { before: doneEv(before)?.type, after: doneEv(after)?.type });

// the switch: off for cloud, on for this PC, env wins
process.env.ETA_PROMPT_KEEPER = "";
setProvider({ base: "http://127.0.0.1:8722", kind: "openai", noGrammar: true }); ok(promptKeeperOn() === true, "default: ON for an engine on this PC");
setProvider({ base: "https://api.openai.com", kind: "openai", noGrammar: false }); ok(promptKeeperOn() === false, "default: OFF for a cloud API");
process.env.ETA_PROMPT_KEEPER = "1"; ok(promptKeeperOn() === true, "ETA_PROMPT_KEEPER=1 turns it on (even for cloud)");
process.env.ETA_PROMPT_KEEPER = "0"; setProvider({ base: "http://127.0.0.1:8722", kind: "openai", noGrammar: true }); ok(promptKeeperOn() === false, "ETA_PROMPT_KEEPER=0 turns it off");

// side-call messages: old shape when off, when no executor text exists yet, or when it would not fit the window
{
  process.env.ETA_PROMPT_KEEPER = "1";
  const a = new Agent(os.tmpdir(), { numCtx: 16384, model: "fake" });
  const old = a._sideMsgs("SYS", "USER", 100);
  ok(old.length === 2 && old[0].content === "SYS" && old[1].content === "USER", "no executor text yet: old two messages", old);
  a._keeperHead = "HEAD";
  const kept = a._sideMsgs("SYS", "USER", 100);
  ok(kept[0].content === "HEAD" && kept[1].content.startsWith("ROLE CHANGE") && kept[1].content.endsWith("SYS\n\nUSER"), "keeper on: executor head first, own job in the user message", kept);
  const small = new Agent(os.tmpdir(), { numCtx: 2048, model: "fake" }); small._keeperHead = "x".repeat(8000);
  ok(small._sideMsgs("SYS", "USER", 700)[0].content === "SYS", "head would not fit a small window: old two messages");
  process.env.ETA_PROMPT_KEEPER = "0";
  ok(a._sideMsgs("SYS", "USER", 100)[0].content === "SYS", "keeper off: old two messages");
}
// the model's own action reply is kept only when it is exactly the action that runs
ok(keptActionReply(' {"say":"hi","tool":"read_file","args":{"path":"a.py"}} ', { name: "read_file", args: { path: "a.py" } }) === '{"say":"hi","tool":"read_file","args":{"path":"a.py"}}', "clean reply is kept word for word");
ok(keptActionReply('{"tool":"read_file","args":{"path":"b.py"}}', { name: "read_file", args: { path: "a.py" } }) === null, "reply with other args is not kept");
ok(keptActionReply('sure! {"tool":"read_file","args":{}}', { name: "read_file", args: {} }) === null, "reply with extra words is not kept");

if (savedEnv === undefined) delete process.env.ETA_PROMPT_KEEPER; else process.env.ETA_PROMPT_KEEPER = savedEnv;
setProvider(saved);
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
