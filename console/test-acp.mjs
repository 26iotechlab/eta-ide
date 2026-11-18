// test-acp.mjs - tests for acp.mjs (ACP adapter). Uses only fakes: a tiny local HTTP server on a
// random port plays the Eta engine; in-memory streams play the ACP client (Zed / JetBrains).
// No GPU, no model, no real engine.   Run: node test-acp.mjs

import http from "node:http";
import { PassThrough } from "node:stream";
import { AcpAgent, PROTOCOL_VERSION } from "./acp.mjs";

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log("  ok   " + name); } else { failed++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : "")); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- fake engine ----------------
function fakeEngine() {
  const clients = new Set();
  const calls = { message: [], approve: [], cancel: [], plan: [], ask: [] };
  const waiters = new Map(); // approval id -> resolve(ok)
  let onMessage = null; // (body) => response object; may schedule events
  const send = (evt) => { const d = `data: ${JSON.stringify(evt)}\n\n`; for (const c of clients) c.write(d); };
  const body = (req) => new Promise((res) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { res(JSON.parse(s || "{}")); } catch { res({}); } }); });
  const json = (res, o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hello\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (req.method === "POST" && u.pathname === "/api/message") { const b = await body(req); calls.message.push(b); return json(res, onMessage ? onMessage(b) : { kind: "chat" }); }
    if (req.method === "POST" && u.pathname === "/api/approve") { const b = await body(req); calls.approve.push(b); waiters.get(b.id)?.(!!b.ok); waiters.delete(b.id); return json(res, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/plan-decision") { const b = await body(req); calls.plan.push(b); waiters.get(b.id)?.(b.action); waiters.delete(b.id); return json(res, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/ask-user-answer") { const b = await body(req); calls.ask.push(b); waiters.get(b.id)?.(b.answer); waiters.delete(b.id); return json(res, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/cancel") { const b = await body(req); calls.cancel.push(b); setTimeout(() => send({ type: "cancelled", runId: b.runId }), 20); return json(res, { ok: true }); }
    json(res, { error: "not found" }, 404);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, send, calls,
    set onMessage(f) { onMessage = f; },
    waitDecision: (id) => new Promise((r) => waiters.set(id, r)),
    close: () => { for (const c of clients) c.destroy(); server.close(); },
  })));
}

// ---------------- fake ACP client ----------------
function fakeClient(engineUrl, opts) {
  const input = new PassThrough(), output = new PassThrough();
  const agent = new AcpAgent(input, output, engineUrl, { log: () => {}, ...opts });
  const raw = [], msgs = [], pending = new Map();
  let permissionPolicy = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buf += chunk; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); raw.push(line);
      let m; try { m = JSON.parse(line); } catch { continue; }
      msgs.push(m);
      if (m.method === "session/request_permission" && m.id !== undefined) {
        Promise.resolve(permissionPolicy(m)).then((result) => input.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n"));
      } else if (!m.method && m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let nextId = 1;
  return {
    agent, raw, msgs, input,
    set permission(f) { permissionPolicy = f; },
    call(method, params, timeout = 4000) {
      const id = nextId++;
      return new Promise((resolve) => {
        const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, timeout);
        pending.set(id, (m) => { clearTimeout(t); resolve(m); });
        input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method, params) { input.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
    writeRaw(s) { input.write(s); },
    updates(sessionId) { return msgs.filter((m) => m.method === "session/update" && m.params.sessionId === sessionId).map((m) => m.params.update); },
    end() { input.end(); },
  };
}

async function newSession(c, cwd = "D:\\work\\proj") { const r = await c.call("session/new", { cwd, mcpServers: [] }); return r.result && r.result.sessionId; }
const text = (t) => [{ type: "text", text: t }];
const chunkText = (ups) => ups.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");

// ---------------- tests ----------------
const eng = await fakeEngine();
const allClients = [];
const mk = (o) => { const c = fakeClient(eng.url, o); allClients.push(c); return c; };

console.log("initialize / session/new");
{
  const c = mk();
  const r = await c.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "fake", version: "1" } });
  check("initialize returns protocolVersion 1", r.result && r.result.protocolVersion === PROTOCOL_VERSION && PROTOCOL_VERSION === 1, r);
  check("initialize has agentCapabilities", r.result && typeof r.result.agentCapabilities === "object" && r.result.agentCapabilities.loadSession === false, r);
  check("authMethods is empty", r.result && Array.isArray(r.result.authMethods) && r.result.authMethods.length === 0, r);
  const r2 = await c.call("initialize", { protocolVersion: 7, clientCapabilities: {} });
  check("newer client version answered with ours (1)", r2.result && r2.result.protocolVersion === 1, r2);
  const s = await c.call("session/new", { cwd: "D:\\work\\proj", mcpServers: [] });
  check("session/new returns a sessionId", s.result && typeof s.result.sessionId === "string" && s.result.sessionId.length > 4, s);
  const bad = await c.call("session/new", { mcpServers: [] });
  check("session/new without cwd -> -32602", bad.error && bad.error.code === -32602, bad);
  const sid = s.result.sessionId;
  check("session map keeps cwd", c.agent.sessions.get(sid)?.cwd === "D:\\work\\proj");
}

console.log("prompt with tool calls and a final answer");
{
  const c = mk();
  const sid = await newSession(c);
  eng.onMessage = (b) => {
    setTimeout(() => {
      eng.send({ type: "narration", text: "Looking at the file.", runId: "41" });
      eng.send({ type: "narration", text: "OTHER RUN TEXT", runId: "99" }); // other run: must be ignored
      eng.send({ type: "tool", name: "read_file", args: { path: "src/a.js" }, runId: "41" });
      eng.send({ type: "tool", name: "read_file", args: { path: "OTHER.js" }, runId: "99" });
      eng.send({ type: "toolResult", name: "read_file", result: "line1\nline2", runId: "41" });
      eng.send({ type: "tool", name: "run_command", args: { command: "npm test" }, runId: "41" });
      eng.send({ type: "toolResult", name: "run_command", result: "ERROR: 1 failing", runId: "41" });
      eng.send({ type: "log", text: "noise", runId: "41" });
      eng.send({ type: "answer", text: "All fixed.", runId: "41" });
      eng.send({ type: "done", files: ["src/a.js"], runId: "99" }); // other run finishing must not end our turn
      setTimeout(() => eng.send({ type: "done", files: ["src/a.js"], runId: "41" }), 30);
    }, 20);
    return { kind: "task", runId: "41" };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("fix the bug in a.js") });
  check("prompt ends with end_turn", r.result && r.result.stopReason === "end_turn", r);
  const m = eng.calls.message.at(-1);
  check("engine got message, ws=cwd, autoApprove=false", m.message === "fix the bug in a.js" && m.ws === "D:\\work\\proj" && m.autoApprove === false, m);
  const ups = c.updates(sid);
  const txt = chunkText(ups);
  check("narration and answer sent as agent_message_chunk", txt.includes("Looking at the file.") && txt.includes("All fixed."), txt);
  check("event for another runId ignored (text)", !txt.includes("OTHER RUN TEXT"), txt);
  const calls = ups.filter((u) => u.sessionUpdate === "tool_call");
  check("two tool_call updates (other run's tool ignored)", calls.length === 2, calls);
  check("tool_call has id, title, kind read, location", calls[0] && calls[0].toolCallId && calls[0].title.includes("src/a.js") && calls[0].kind === "read" && calls[0].locations[0].path === "src/a.js", calls[0]);
  check("execute kind for run_command", calls[1] && calls[1].kind === "execute", calls[1]);
  const upd = ups.filter((u) => u.sessionUpdate === "tool_call_update");
  check("tool_call_update completed with content", upd[0] && upd[0].toolCallId === calls[0].toolCallId && upd[0].status === "completed" && upd[0].content[0].type === "content" && upd[0].content[0].content.text === "line1\nline2", upd[0]);
  check("failed tool result -> status failed", upd[1] && upd[1].toolCallId === calls[1].toolCallId && upd[1].status === "failed", upd[1]);
  check("session keeps runId", c.agent.sessions.get(sid).runId === "41");
}

console.log("permission: allow and reject");
for (const allow of [true, false]) {
  const c = mk();
  const sid = await newSession(c);
  c.permission = () => ({ outcome: { outcome: "selected", optionId: allow ? "allow-once" : "reject-once" } });
  const runId = allow ? "50" : "51", aid = runId + ":xyz";
  eng.onMessage = () => {
    setTimeout(async () => {
      eng.send({ type: "approval", id: "99:other", title: "other run", detail: "x", runId: "99" }); // must not be asked
      const decided = eng.waitDecision(aid);
      eng.send({ type: "approval", id: aid, title: "Run shell: rm -rf build", detail: "rm -rf build", runId });
      const ok = await decided;
      eng.send({ type: "answer", text: ok ? "ran it" : "skipped it", runId });
      eng.send({ type: "done", runId });
    }, 20);
    return { kind: "task", runId };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("clean the build folder") });
  const reqs = c.msgs.filter((m) => m.method === "session/request_permission");
  check(`permission ${allow ? "allow" : "reject"}: one request_permission (other run ignored)`, reqs.length === 1, reqs);
  const p = reqs[0] && reqs[0].params;
  check(`permission ${allow ? "allow" : "reject"}: has sessionId, toolCall, allow_once and reject_once options`, p && p.sessionId === sid && p.toolCall.toolCallId && p.toolCall.title.includes("rm -rf") && p.options.some((o) => o.kind === "allow_once") && p.options.some((o) => o.kind === "reject_once"), p);
  const a = eng.calls.approve.filter((x) => x.id === aid);
  check(`permission ${allow ? "allow" : "reject"}: engine /api/approve ok=${allow}`, a.length === 1 && a[0].ok === allow, eng.calls.approve);
  check(`permission ${allow ? "allow" : "reject"}: other run's approval not answered`, !eng.calls.approve.some((x) => x.id === "99:other"));
  check(`permission ${allow ? "allow" : "reject"}: turn ends end_turn`, r.result && r.result.stopReason === "end_turn" && chunkText(c.updates(sid)).includes(allow ? "ran it" : "skipped it"), r);
}

console.log("plan review via permission");
{
  const c = mk(); const sid = await newSession(c);
  c.permission = () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
  eng.onMessage = () => { setTimeout(async () => { const d = eng.waitDecision("60:plan"); eng.send({ type: "plan_review", id: "60:plan", plan: "1. do it", runId: "60" }); await d; eng.send({ type: "done", runId: "60" }); }, 20); return { kind: "task", runId: "60" }; };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("refactor") });
  check("plan_review -> /api/plan-decision approve", eng.calls.plan.at(-1)?.action === "approve" && r.result?.stopReason === "end_turn", eng.calls.plan);
}

console.log("cancel");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = () => { setTimeout(() => eng.send({ type: "tool", name: "write_file", args: { path: "x.js" }, runId: "70" }), 10); return { kind: "task", runId: "70" }; };
  const pr = c.call("session/prompt", { sessionId: sid, prompt: text("write lots of code") });
  await sleep(120);
  c.notify("session/cancel", { sessionId: sid });
  const r = await pr;
  check("cancel -> POST /api/cancel with runId", eng.calls.cancel.some((x) => x.runId === "70"), eng.calls.cancel);
  check("prompt returns stopReason cancelled", r.result && r.result.stopReason === "cancelled", r);
  const ups = c.updates(sid).filter((u) => u.sessionUpdate === "tool_call_update");
  check("open tool call closed on cancel", ups.some((u) => u.status === "failed"), ups);
  check("notification got no response", !c.msgs.some((m) => m.id === undefined && (m.result || m.error)));
}

console.log("cancel when the engine never confirms (timeout)");
{
  const c = mk({ cancelWaitMs: 150 }); const sid = await newSession(c);
  eng.onMessage = () => ({ kind: "task", runId: "71" });
  const pr = c.call("session/prompt", { sessionId: sid, prompt: text("hang") });
  await sleep(80);
  c.agent.engineCancel = async () => {}; // the engine never sends "cancelled" for this run
  c.notify("session/cancel", { sessionId: sid });
  const r = await pr;
  check("unconfirmed cancel still returns cancelled", r.result && r.result.stopReason === "cancelled", r);
}

console.log("chat reply (no runId)");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = (b) => {
    // like server.mjs: events go out before/after the HTTP answer
    eng.send({ type: "chat", role: "user", text: "someone else's question" });
    eng.send({ type: "chatStart", cid: "zzz" });
    eng.send({ type: "chatDelta", cid: "zzz", delta: "NOT MINE" });
    eng.send({ type: "chat", role: "user", text: b.message });
    eng.send({ type: "chatStart", cid: "c1" });
    setTimeout(() => { eng.send({ type: "chatDelta", cid: "c1", delta: "Hello " }); eng.send({ type: "chatDelta", cid: "zzz", delta: "NOT MINE 2" }); eng.send({ type: "chatDelta", cid: "c1", delta: "there." }); eng.send({ type: "chatEnd", cid: "c1", text: "Hello there." }); }, 20);
    return { kind: "chat" };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "what does this repo do?" }, { type: "resource_link", uri: "file:///D:/work/proj/README.md", name: "README.md" }] });
  check("chat ends with end_turn", r.result && r.result.stopReason === "end_turn", r);
  const t = chunkText(c.updates(sid));
  check("chat deltas forwarded, other chat ignored", t === "Hello there.", t);
  check("resource_link passed to engine", eng.calls.message.at(-1).message.includes("README.md"), eng.calls.message.at(-1));
}

console.log("errors");
{
  const c = mk();
  const r = await c.call("session/load", { sessionId: "x" });
  check("unknown method -> -32601", r.error && r.error.code === -32601, r);
  const before = c.msgs.length;
  c.writeRaw("{not json\n");
  await sleep(50);
  const e = c.msgs.slice(before).find((m) => m.error);
  check("bad JSON -> -32700, id null", e && e.error.code === -32700 && e.id === null, e);
  const still = await c.call("initialize", { protocolVersion: 1 });
  check("still works after bad JSON", still.result && still.result.protocolVersion === 1, still);
  const unk = await c.call("session/prompt", { sessionId: "nope", prompt: text("hi") });
  check("prompt on unknown session -> error", unk.error && unk.error.code === -32602, unk);
  c.notify("some/unknown_notification", {});
  await sleep(30);
  check("unknown notification ignored silently", !c.msgs.slice(before).some((m) => m.error && m.error.code === -32601 && m.id == null));
}

console.log("engine down");
{
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port; await new Promise((r) => dead.close(r)); // a port with nothing listening
  const c = fakeClient(`http://127.0.0.1:${port}`, { log: () => {} }); allClients.push(c);
  const sid = await newSession(c);
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("hello") });
  check("engine down -> JSON-RPC error with clear message", r.error && r.error.code === -32000 && /not reachable/.test(r.error.message) && r.error.message.includes(String(port)), r);
  const again = await c.call("session/prompt", { sessionId: sid, prompt: text("hello again") });
  check("engine down -> no crash, next prompt also answered", again.error && again.error.code === -32000, again);
}

console.log("engine run error");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = () => { setTimeout(() => eng.send({ type: "error", text: "model crashed", runId: "80" }), 20); return { kind: "task", runId: "80" }; };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("do x") });
  check("engine error event -> JSON-RPC error, message kept", r.error && /model crashed/.test(r.error.message), r);
}

console.log("fix 1: tool pairing");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = () => {
    setTimeout(() => {
      // two same-name calls open at once: results come back first-in-first-out
      eng.send({ type: "tool", name: "read_file", args: { path: "a.js" }, runId: "90" });
      eng.send({ type: "tool", name: "read_file", args: { path: "b.js" }, runId: "90" });
      eng.send({ type: "toolResult", name: "read_file", result: "AAA", runId: "90" });
      eng.send({ type: "toolResult", name: "read_file", result: "BBB", runId: "90" });
      // a vetoed call (no start) while a real call of the same name is open must not take its place
      eng.send({ type: "tool", name: "write_file", args: { path: "x.js" }, runId: "90" });
      eng.send({ type: "toolResult", name: "write_file", result: "VETOED by verifier: wrong file", runId: "90" });
      eng.send({ type: "toolResult", name: "write_file", result: "wrote x.js", runId: "90" });
      // with engine call ids, results that come back out of order still pair right
      eng.send({ type: "tool", name: "grep", args: { pattern: "one" }, callId: "k1", runId: "90" });
      eng.send({ type: "tool", name: "grep", args: { pattern: "two" }, callId: "k2", runId: "90" });
      eng.send({ type: "toolResult", name: "grep", result: "TWO", callId: "k2", runId: "90" });
      eng.send({ type: "toolResult", name: "grep", result: "ONE", callId: "k1", runId: "90" });
      eng.send({ type: "done", runId: "90" });
    }, 20);
    return { kind: "task", runId: "90" };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("pair tools") });
  const ups = c.updates(sid);
  const starts = ups.filter((u) => u.sessionUpdate === "tool_call");
  const res = ups.filter((u) => u.sessionUpdate === "tool_call_update" && u.rawOutput);
  const idOf = (title) => starts.find((s) => s.title.includes(title))?.toolCallId;
  const out = (id) => res.find((u) => u.toolCallId === id)?.rawOutput.result;
  check("pairing: turn ends end_turn", r.result && r.result.stopReason === "end_turn", r);
  check("pairing: same-name calls in a row get their own results (FIFO)", out(idOf("a.js")) === "AAA" && out(idOf("b.js")) === "BBB", res);
  const veto = res.find((u) => u.rawOutput.result.startsWith("VETOED"));
  check("pairing: vetoed result is its own call, not the open write_file", veto && veto.toolCallId !== idOf("x.js") && veto.status === "failed", veto);
  check("pairing: open write_file gets the real result", out(idOf("x.js")) === "wrote x.js", res);
  check("pairing: engine call ids pair out-of-order results", out(idOf("one")) === "ONE" && out(idOf("two")) === "TWO", res);
  check("pairing: every started call got exactly one result", starts.every((s) => res.filter((u) => u.toolCallId === s.toolCallId).length === 1), { starts, res });
}

console.log("fix 2: chat followed by its id, and chat cancel");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = (b) => {
    // another window sent the SAME text just before: text matching would follow the wrong reply
    eng.send({ type: "chat", role: "user", text: b.message });
    eng.send({ type: "chatStart", cid: "other" });
    eng.send({ type: "chat", role: "user", text: b.message });
    eng.send({ type: "chatStart", cid: "mine7" });
    setTimeout(() => {
      eng.send({ type: "chatDelta", cid: "other", delta: "WRONG " });
      eng.send({ type: "chatDelta", cid: "mine7", delta: "Right." });
      eng.send({ type: "chatEnd", cid: "other", text: "WRONG" });
      setTimeout(() => eng.send({ type: "chatEnd", cid: "mine7", text: "Right." }), 30);
    }, 20);
    return { kind: "chat", cid: "mine7" };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("hi") });
  check("chat cid: ends end_turn on its own chatEnd", r.result && r.result.stopReason === "end_turn", r);
  check("chat cid: only our reply forwarded", chunkText(c.updates(sid)) === "Right.", chunkText(c.updates(sid)));

  const c2 = mk(); const sid2 = await newSession(c2);
  eng.onMessage = () => { setTimeout(() => eng.send({ type: "chatDelta", cid: "slow1", delta: "part one " }), 20); setTimeout(() => eng.send({ type: "chatDelta", cid: "slow1", delta: "LATE" }), 300); return { kind: "chat", cid: "slow1" }; };
  const t0 = Date.now();
  const pr = c2.call("session/prompt", { sessionId: sid2, prompt: text("long answer please") });
  await sleep(120);
  c2.notify("session/cancel", { sessionId: sid2 });
  const r2 = await pr;
  check("chat cancel: prompt returns cancelled at once", r2.result && r2.result.stopReason === "cancelled" && Date.now() - t0 < 1000, { r2, ms: Date.now() - t0 });
  await sleep(250);
  const t2 = chunkText(c2.updates(sid2));
  check("chat cancel: text after cancel is not forwarded", t2.includes("part one") && !t2.includes("LATE"), t2);
}

console.log("fix 3: question without choices, and an unanswered question");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = () => {
    setTimeout(async () => {
      const d = eng.waitDecision("91:ask:a");
      eng.send({ type: "ask_user", id: "91:ask:a", question: "Which port?", runId: "91" });
      await d;
      eng.send({ type: "done", runId: "91" });
    }, 20);
    return { kind: "task", runId: "91" };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("set up the server") });
  const a = eng.calls.ask.find((x) => x.id === "91:ask:a");
  check("no choices: engine gets a 'no answer' (null) at once, run goes on", a && a.answer === null && r.result && r.result.stopReason === "end_turn", { a, r });
  check("no choices: no permission request sent", !c.msgs.some((m) => m.method === "session/request_permission"));
  const t = chunkText(c.updates(sid));
  check("no choices: user told the question and that Eta decides by itself", t.includes("Which port?") && t.includes("decide by itself"), t);

  const c2 = mk(); const sid2 = await newSession(c2);
  c2.permission = () => new Promise(() => {}); // the client never answers
  eng.onMessage = () => { setTimeout(() => eng.send({ type: "ask_user", id: "92:ask:b", question: "Pick one", options: ["red", "blue"], runId: "92" }), 20); return { kind: "task", runId: "92" }; };
  const pr = c2.call("session/prompt", { sessionId: sid2, prompt: text("paint it") });
  await sleep(150);
  check("unanswered question: a permission request with the choices was sent", c2.msgs.some((m) => m.method === "session/request_permission" && m.params.options.some((o) => o.name === "blue")));
  c2.notify("session/cancel", { sessionId: sid2 });
  const r2 = await pr;
  await sleep(80);
  check("unanswered question: cancel ends the turn (no hang)", r2.result && r2.result.stopReason === "cancelled", r2);
  const b2 = eng.calls.ask.find((x) => x.id === "92:ask:b");
  check("unanswered question: engine still gets a 'no answer' (null)", b2 && b2.answer === null, eng.calls.ask);
  check("unanswered question: no request left open", c2.agent.outgoing.size === 0, c2.agent.outgoing.size);
}

console.log("fix 4: warnings at done and late warnings after done");
{
  const c = mk(); const sid = await newSession(c);
  eng.onMessage = () => {
    setTimeout(() => {
      eng.send({ type: "answer", text: "Finished.", runId: "93" });
      eng.send({ type: "done", warnings: ["test command still fails"], settles: true, runId: "93" });
      eng.send({ type: "run", run: { id: "93", status: "done" } }); // must not end the turn yet
      eng.send({ type: "runSettled", id: "99" }); // another run: ignored
      setTimeout(() => {
        eng.send({ type: "regression", text: "'npm test' PASSED before this run but FAILS now", runId: "93" });
        eng.send({ type: "runSettled", id: "93" });
      }, 150);
    }, 20);
    return { kind: "task", runId: "93" };
  };
  const r = await c.call("session/prompt", { sessionId: sid, prompt: text("do it") });
  const t = chunkText(c.updates(sid));
  check("warnings: turn ends end_turn after runSettled", r.result && r.result.stopReason === "end_turn", r);
  check("warnings: done warnings delivered", t.includes("test command still fails"), t);
  check("warnings: late regression warning delivered before the response", t.includes("FAILS now"), t);

  const c2 = mk({ settleWaitMs: 150 }); const sid2 = await newSession(c2);
  eng.onMessage = () => { setTimeout(() => eng.send({ type: "done", settles: true, runId: "94" }), 20); return { kind: "task", runId: "94" }; };
  const t0 = Date.now();
  const r2 = await c2.call("session/prompt", { sessionId: sid2, prompt: text("x") });
  check("warnings: no runSettled -> turn still ends after the wait limit", r2.result && r2.result.stopReason === "end_turn" && Date.now() - t0 >= 140, { r2, ms: Date.now() - t0 });

  const c3 = mk(); const sid3 = await newSession(c3);
  eng.onMessage = () => { setTimeout(() => eng.send({ type: "done", settles: true, runId: "96" }), 20); return { kind: "task", runId: "96" }; };
  const pr3 = c3.call("session/prompt", { sessionId: sid3, prompt: text("y") });
  await sleep(120);
  const t3 = Date.now();
  c3.notify("session/cancel", { sessionId: sid3 });
  const r3 = await pr3;
  check("warnings: cancel while waiting for the check ends at once", r3.result && r3.result.stopReason === "cancelled" && Date.now() - t3 < 500, { r3, ms: Date.now() - t3 });
}

console.log("stdout hygiene");
{
  let all = 0, bad = 0;
  for (const c of allClients) for (const line of c.raw) { all++; try { const m = JSON.parse(line); if (m.jsonrpc !== "2.0") bad++; } catch { bad++; } }
  check(`every output line is valid JSON-RPC (${all} lines)`, all > 20 && bad === 0, { all, bad });
}

for (const c of allClients) c.end();
eng.close();
console.log(`========== ${passed} passed, ${failed} failed ==========`);
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 300);
