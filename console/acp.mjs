// acp.mjs - Agent Client Protocol (ACP) adapter for the Eta engine.
//
// Lets an ACP client (Zed, JetBrains, ...) use Eta as its agent. Implemented from the public
// ACP spec (https://agentclientprotocol.com, protocol version 1):
//   - transport: JSON-RPC 2.0 over stdio, one message per line, nothing else on stdout
//   - agent methods: initialize, session/new, session/prompt, notification session/cancel
//   - agent -> client: session/update notifications, session/request_permission requests
//
// The adapter does no AI work itself. It forwards each prompt to an Eta engine that is ALREADY
// RUNNING (console/server.mjs) over its local HTTP API and turns the engine's live events
// (GET /events, server-sent events) into ACP session updates.
//
//   node acp.mjs                      engine at http://127.0.0.1:8713 (the IDE's bundled engine)
//   ETA_ENGINE_URL=http://127.0.0.1:8710 node acp.mjs
//
// Logs go to stderr only.

import http from "node:http";
import https from "node:https";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_ENGINE_URL = "http://127.0.0.1:8713";
const VERSION = "0.1.0";

// JSON-RPC 2.0 error codes
const E_PARSE = -32700, E_INVALID = -32600, E_METHOD = -32601, E_PARAMS = -32602, E_INTERNAL = -32603;
const E_ENGINE = -32000; // engine not reachable / lost (server-defined range)

const TERMINAL_RUN = new Set(["done", "error", "cancelled"]);

// ---------- small HTTP helpers (node:http, no extra headers: the engine refuses foreign Origin) ----------
function client(u) { return u.protocol === "https:" ? https : http; }

export function httpJson(base, method, path, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(path, base); } catch (e) { return reject(e); }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = client(u).request(u, { method, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
        if (res.statusCode >= 400) return reject(Object.assign(new Error((j && j.error) || `HTTP ${res.statusCode}: ${text.slice(0, 200)}`), { status: res.statusCode }));
        resolve(j);
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Open the engine's event stream. Resolves once the stream is connected (so no event is missed).
export function openEvents(base, onEvent, onClose, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL("/events", base); } catch (e) { return reject(e); }
    let settled = false, closed = false;
    const req = client(u).get(u, { headers: { accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) { settled = true; res.resume(); req.destroy(); return reject(new Error(`event stream refused: HTTP ${res.statusCode}`)); }
      settled = true; req.setTimeout(0);
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
          const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue; // comment / heartbeat
          let evt; try { evt = JSON.parse(data); } catch { continue; }
          try { onEvent(evt); } catch {}
        }
      });
      const end = () => { if (!closed) { closed = true; onClose?.(); } };
      res.on("end", end); res.on("close", end); res.on("error", end);
      resolve({ close() { closed = true; req.destroy(); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", (e) => { if (!settled) { settled = true; reject(e); } else if (!closed) { closed = true; onClose?.(); } });
  });
}

// ---------- mapping helpers ----------
export function toolKind(name) {
  const n = String(name || "").toLowerCase();
  if (/delete|remove|unlink/.test(n)) return "delete";
  if (/move|rename/.test(n)) return "move";
  if (/write|edit|patch|replace|create|insert|append/.test(n)) return "edit";
  if (/read|open|view|cat|list|tree|ls\b/.test(n)) return "read";
  if (/search|grep|find|glob/.test(n)) return "search";
  if (/fetch|http|web|url|download|browse/.test(n)) return "fetch";
  if (/run|exec|shell|terminal|command|bash|test|build/.test(n)) return "execute";
  if (/think|plan|reason/.test(n)) return "think";
  return "other";
}
function argPath(args) { if (!args || typeof args !== "object") return null; const p = args.path || args.file || args.filePath || args.file_path; return typeof p === "string" ? p : null; }
function toolTitle(name, args) {
  const p = argPath(args);
  if (p) return `${name} ${p}`;
  const cmd = args && typeof args === "object" && (args.command || args.cmd || args.query || args.pattern || args.url);
  return typeof cmd === "string" ? `${name}: ${cmd.slice(0, 80)}` : String(name || "tool");
}
const textBlock = (text) => ({ type: "text", text: String(text) });

// Turn ACP prompt content blocks into the plain message the engine takes.
export function promptToText(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (b.type === "resource_link" && b.uri) out.push(`(file: ${b.title || b.name || ""} ${b.uri})`.replace(/\s+/g, " "));
    else if (b.type === "resource" && b.resource) {
      const r = b.resource;
      if (typeof r.text === "string") out.push(`[${r.uri || "attached"}]\n${r.text}`);
      else if (r.uri) out.push(`(file: ${r.uri})`);
    }
  }
  return out.join("\n\n").trim();
}

// ---------- the ACP agent ----------
export class AcpAgent {
  constructor(input, output, engineBaseUrl = DEFAULT_ENGINE_URL, opts = {}) {
    this.input = input; this.output = output;
    this.engine = String(engineBaseUrl || DEFAULT_ENGINE_URL).replace(/\/+$/, "");
    this.log = opts.log || ((...a) => { try { process.stderr.write("[eta-acp] " + a.join(" ") + "\n"); } catch {} });
    this.cancelWaitMs = opts.cancelWaitMs ?? 10000;
    this.messageTimeoutMs = opts.messageTimeoutMs ?? 120000;
    // after "done" the engine may still run its regression check (up to 120 s) and send a late warning;
    // an engine that announces this (done.settles) sends "runSettled" when it is over. Wait at most this long.
    this.settleWaitMs = opts.settleWaitMs ?? 150000;
    this.sessions = new Map(); // sessionId -> { cwd, runId, turn }
    this.outgoing = new Map(); // our request id -> { resolve, reject }
    this.nextOutId = 1;
    this.closed = false;
    this.rl = readline.createInterface({ input, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("close", () => this.shutdown());
  }

  // ----- wire -----
  send(msg) { if (this.closed && !this.output.writable) return; try { this.output.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); } catch (e) { this.log("write failed:", e.message); } }
  reply(id, result) { this.send({ id, result }); }
  fail(id, code, message, data) { this.send({ id, error: data === undefined ? { code, message } : { code, message, data } }); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params, turn) {
    const id = "eta-" + this.nextOutId++;
    if (turn && turn.outReqs) turn.outReqs.add(id); // answered as "cancelled" when the turn ends, so nothing waits forever
    return new Promise((resolve, reject) => { this.outgoing.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }
  update(sessionId, update) { this.notify("session/update", { sessionId, update }); }

  onLine(line) {
    const s = String(line).trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return this.fail(null, E_PARSE, "Parse error"); }
    if (Array.isArray(msg)) { if (!msg.length) return this.fail(null, E_INVALID, "Invalid Request"); for (const m of msg) this.dispatch(m); return; }
    this.dispatch(msg);
  }

  dispatch(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return this.fail(msg && msg.id !== undefined ? msg.id : null, E_INVALID, "Invalid Request");
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
    // a response to one of our requests (session/request_permission)
    if (!msg.method && hasId) {
      const p = this.outgoing.get(msg.id);
      if (p) { this.outgoing.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message || "client error"), { rpc: msg.error })) : p.resolve(msg.result); }
      return;
    }
    if (typeof msg.method !== "string") return this.fail(hasId ? msg.id : null, E_INVALID, "Invalid Request");
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    if (!hasId) { // notification: never answered
      if (msg.method === "session/cancel") this.onCancel(params).catch((e) => this.log("cancel failed:", e.message));
      return;
    }
    const handlers = { "initialize": (p) => this.onInitialize(p), "session/new": (p) => this.onNewSession(p), "session/prompt": (p) => this.onPrompt(p), "authenticate": () => ({}) };
    const h = handlers[msg.method];
    if (!h) return this.fail(msg.id, E_METHOD, `Method not found: ${msg.method}`);
    Promise.resolve().then(() => h(params)).then(
      (r) => this.reply(msg.id, r ?? null),
      (e) => this.fail(msg.id, e.code || E_INTERNAL, e.message || String(e), e.data));
  }

  // ----- methods -----
  onInitialize(p) {
    // spec: answer the client's version if we support it, else the latest we support (we only have 1)
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "eta", title: "Eta", version: VERSION },
      authMethods: [],
    };
  }

  onNewSession(p) {
    if (typeof p.cwd !== "string" || !p.cwd) throw Object.assign(new Error("cwd (absolute path) is required"), { code: E_PARAMS });
    const sessionId = "eta_" + randomUUID().replace(/-/g, "");
    this.sessions.set(sessionId, { cwd: p.cwd, runId: null, turn: null });
    return { sessionId };
  }

  async onCancel(p) {
    const s = this.sessions.get(p.sessionId);
    const t = s && s.turn;
    if (!t || t.finished) return;
    t.cancelRequested = true;
    // the run is already over; only the after-run check is left: nothing to stop in the engine
    if (t.settling) return t.finish({ stopReason: "cancelled" });
    if (t.runId) await this.engineCancel(t.runId);
    // LIMIT: the engine has no way to stop a chat reply (chatStream takes no abort signal), so the model
    // finishes it in the background; we stop forwarding it and end the turn at once.
    else if (t.mode === "chat") return t.finish({ stopReason: "cancelled" });
    if (t.finished) return;
    // a run that never confirms its stop must not hang the client
    t.cancelTimer = setTimeout(() => t.finish({ stopReason: "cancelled" }), this.cancelWaitMs);
  }

  async engineCancel(runId) {
    try { await httpJson(this.engine, "POST", "/api/cancel", { runId }); }
    catch (e) { this.log("engine cancel failed:", e.message); }
  }

  async onPrompt(p) {
    const s = this.sessions.get(p.sessionId);
    if (!s) throw Object.assign(new Error(`Unknown session: ${p.sessionId}`), { code: E_PARAMS });
    if (s.turn && !s.turn.finished) throw Object.assign(new Error("A prompt is already running in this session"), { code: E_INVALID });
    const message = promptToText(p.prompt);
    if (!message) throw Object.assign(new Error("prompt has no text"), { code: E_PARAMS });
    const sessionId = p.sessionId;

    let resolveTurn, rejectTurn;
    const done = new Promise((res, rej) => { resolveTurn = res; rejectTurn = rej; });
    const turn = {
      mode: null, runId: null, finished: false, cancelRequested: false, cancelTimer: null,
      buffer: [], openTools: new Map(), toolsById: new Map(), toolSeq: 0, chat: { state: "awaitUser", cid: null }, approvals: new Set(),
      outReqs: new Set(), sawDone: false, settling: false, settleTimer: null,
      finish: (result, err) => {
        if (turn.finished) return;
        turn.finished = true;
        clearTimeout(turn.cancelTimer); clearTimeout(turn.settleTimer);
        // a permission question still open in the client: treat it as cancelled (ACP outcome), so the engine gets a "no"
        for (const id of turn.outReqs) { const p = this.outgoing.get(id); if (p) { this.outgoing.delete(id); p.resolve({ outcome: { outcome: "cancelled" } }); } }
        turn.outReqs.clear();
        // close every tool call still open, so the client does not show it spinning
        const status = result && result.stopReason === "end_turn" && !err ? "completed" : "failed";
        for (const [, q] of turn.openTools) for (const id of q) this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status });
        for (const [, id] of turn.toolsById) this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status });
        turn.openTools.clear(); turn.toolsById.clear();
        try { turn.events?.close(); } catch {}
        if (err) rejectTurn(err); else resolveTurn(result);
      },
    };
    s.turn = turn;

    // 1. connect to the event stream FIRST, so no event of our run is missed
    try {
      turn.events = await openEvents(this.engine, (evt) => this.onEngineEvent(sessionId, turn, evt, message), () => {
        if (!turn.finished) turn.finish(null, Object.assign(new Error(`Lost the connection to the Eta engine at ${this.engine}.`), { code: E_ENGINE }));
      });
    } catch (e) {
      turn.finished = true;
      throw Object.assign(new Error(`Eta engine not reachable at ${this.engine} (${e.code || e.message}). Start Eta first, or set ETA_ENGINE_URL.`), { code: E_ENGINE });
    }

    // 2. hand the message to the engine
    let r;
    try { r = await httpJson(this.engine, "POST", "/api/message", { message, ws: s.cwd, autoApprove: false }, this.messageTimeoutMs); }
    catch (e) {
      turn.finish(null, Object.assign(new Error(`Eta engine refused the message: ${e.message}`), { code: E_ENGINE }));
      return done;
    }
    if (turn.finished) return done; // cancelled while posting a chat question
    if (r && r.kind === "task" && r.runId != null) {
      turn.mode = "task"; turn.runId = String(r.runId); s.runId = turn.runId;
      if (turn.cancelRequested) this.engineCancel(turn.runId);
    } else if (r && r.kind === "chat") {
      turn.mode = "chat";
      // a newer engine names its reply (cid): follow exactly that one. An older one does not: match our text.
      if (r.cid) { turn.chat.state = "streaming"; turn.chat.cid = String(r.cid); }
      if (turn.cancelRequested) { turn.finish({ stopReason: "cancelled" }); return done; }
      const hint = { skill_needs_task: `Tell me the task for the skill "${r.skill}", for example: /${r.skill} <what to do>.`, agent_needs_task: `Tell me the task for the agent "${r.agent}", for example: @${r.agent} <what to do>.` }[r.hint];
      if (hint) { this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(hint) }); turn.finish({ stopReason: "end_turn" }); return done; }
    } else {
      turn.finish(null, Object.assign(new Error("Unexpected answer from the Eta engine: " + JSON.stringify(r).slice(0, 200)), { code: E_ENGINE }));
      return done;
    }
    // 3. replay what arrived while the POST was in flight
    const early = turn.buffer; turn.buffer = null;
    for (const evt of early) this.onEngineEvent(sessionId, turn, evt, message);
    return done;
  }

  onEngineEvent(sessionId, turn, evt, message) {
    if (turn.finished || !evt || typeof evt !== "object") return;
    if (turn.buffer) { turn.buffer.push(evt); return; } // mode not known yet
    if (turn.mode === "chat") return this.onChatEvent(sessionId, turn, evt, message);
    // events are broadcast for ALL runs: keep only ours
    if (evt.type === "run") {
      // after a "done" event, that event decides when the turn ends (it may wait for runSettled)
      // STRONG1: a measured "not done" run has status "error" but still ended with a normal "done" event (outcome set): it ends like "done"
      if (evt.run && String(evt.run.id) === turn.runId && TERMINAL_RUN.has(evt.run.status) && !(turn.sawDone && (evt.run.status === "done" || evt.run.outcome))) this.endRun(turn, evt.run.status, null);
      return;
    }
    if (evt.type === "runSettled") { if (String(evt.id) === turn.runId && turn.sawDone) this.endRun(turn, "done", null); return; }
    if (evt.runId == null || String(evt.runId) !== turn.runId) return;
    const say = (text) => text && this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(text.endsWith("\n") ? text : text + "\n\n") });
    switch (evt.type) {
      case "narration": case "answer": say(String(evt.text || "")); break;
      case "regression": case "stuck": say("⚠ " + String(evt.text || "")); break;
      case "tool": {
        const id = `${turn.runId}-t${++turn.toolSeq}`;
        // pairing: by the engine's call id when it sends one; else first-in-first-out per tool name
        // (the engine runs one tool at a time per run, so its result is always for the oldest open call)
        const cid = evt.callId ?? evt.toolCallId;
        if (cid != null) turn.toolsById.set(String(cid), id);
        else { const q = turn.openTools.get(evt.name) || []; q.push(id); turn.openTools.set(evt.name, q); }
        const p = argPath(evt.args);
        this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: toolTitle(evt.name, evt.args), kind: toolKind(evt.name), status: "in_progress", rawInput: evt.args ?? {}, ...(p ? { locations: [{ path: p }] } : {}) });
        break;
      }
      case "toolResult": {
        const result = String(evt.result ?? "");
        const failed = /^(VETOED|BLOCKED|ERROR|Error)\b/.test(result);
        const cid = evt.callId ?? evt.toolCallId;
        let id = null;
        if (cid != null) { id = turn.toolsById.get(String(cid)) || null; turn.toolsById.delete(String(cid)); }
        // a VETOED / BLOCKED result never had a "tool" start (agent.mjs stops it before it runs):
        // it must not take the place of a real call of the same name that is still open
        else if (!/^(VETOED|BLOCKED)\b/.test(result)) {
          const q = turn.openTools.get(evt.name);
          id = (q && q.shift()) || null;
          if (q && !q.length) turn.openTools.delete(evt.name);
        }
        if (!id) { // a result with no start (vetoed before it ran): show it as one finished call
          id = `${turn.runId}-t${++turn.toolSeq}`;
          this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: toolTitle(evt.name, null), kind: toolKind(evt.name), status: "pending" });
        }
        this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: failed ? "failed" : "completed", content: [{ type: "content", content: textBlock(result) }], rawOutput: { result } });
        break;
      }
      case "approval": this.askPermission(sessionId, turn, evt, "approval"); break;
      case "plan_review": this.askPermission(sessionId, turn, evt, "plan"); break;
      case "ask_user": this.askUser(sessionId, turn, evt); break;
      case "error": say("⚠ Error: " + String(evt.text || "unknown error")); this.endRun(turn, "error", String(evt.text || "")); break;
      case "cancelled": this.endRun(turn, "cancelled", null); break;
      case "done": {
        turn.sawDone = true;
        const w = Array.isArray(evt.warnings) ? evt.warnings.map(String).filter(Boolean) : [];
        if (w.length) say("⚠ Not fully complete:\n" + w.map((x) => "• " + x).join("\n"));
        if (!evt.settles) { this.endRun(turn, "done", null); break; } // older engine: nothing more is announced
        // the regression check may still send a warning: end the turn on runSettled (or after settleWaitMs)
        turn.settling = true;
        if (turn.cancelRequested) { this.endRun(turn, "done", null); break; }
        turn.settleTimer = setTimeout(() => this.endRun(turn, "done", null), this.settleWaitMs);
        break;
      }
      case "log": this.log(`[run ${turn.runId}]`, String(evt.text || "").slice(0, 200)); break;
      default: break;
    }
  }

  endRun(turn, status, errText) {
    if (turn.cancelRequested || status === "cancelled") return turn.finish({ stopReason: "cancelled" });
    if (status === "error") return turn.finish(null, Object.assign(new Error("Eta run failed: " + (errText || "see the Eta window")), { code: E_INTERNAL }));
    turn.finish({ stopReason: "end_turn" });
  }

  // chat replies carry no runId: match the user echo of OUR message, then follow that reply's cid
  onChatEvent(sessionId, turn, evt, message) {
    const c = turn.chat;
    if (c.state === "awaitUser" && evt.type === "chat" && evt.role === "user" && evt.text === message) { c.state = "awaitStart"; return; }
    if (c.state === "awaitStart" && evt.type === "chatStart") { c.state = "streaming"; c.cid = evt.cid; return; }
    if (c.state !== "streaming" || evt.cid !== c.cid) return;
    if (evt.type === "chatDelta" && evt.delta) this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(evt.delta) });
    if (evt.type === "chatEnd") turn.finish({ stopReason: turn.cancelRequested ? "cancelled" : "end_turn" });
  }

  async askPermission(sessionId, turn, evt, what) {
    if (turn.approvals.has(evt.id)) return; turn.approvals.add(evt.id);
    const isPlan = what === "plan";
    const toolCall = {
      toolCallId: `${turn.runId}-${isPlan ? "plan" : "approval"}-${turn.approvals.size}`,
      title: isPlan ? "Approve Eta's plan" : String(evt.title || "Eta wants to run an action"),
      kind: isPlan ? "think" : toolKind(evt.title),
      status: "pending",
      content: [{ type: "content", content: textBlock(String((isPlan ? evt.plan : evt.detail) || evt.title || "")) }],
    };
    let ok = false;
    try {
      const res = await this.request("session/request_permission", {
        sessionId, toolCall,
        options: [
          { optionId: "allow-once", name: isPlan ? "Approve plan" : "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: isPlan ? "Reject plan" : "Reject", kind: "reject_once" },
        ],
      }, turn);
      const o = res && res.outcome;
      ok = !!(o && o.outcome === "selected" && o.optionId === "allow-once");
    } catch (e) { this.log("permission request failed:", e.message); }
    if (turn.cancelRequested) ok = false;
    try {
      if (isPlan) await httpJson(this.engine, "POST", "/api/plan-decision", { id: evt.id, action: ok ? "approve" : "reject" });
      else await httpJson(this.engine, "POST", "/api/approve", { id: evt.id, ok });
    } catch (e) { this.log("could not send the decision to the engine:", e.message); }
  }

  // ACP has no free-text question to the user; offer the engine's choices as options when it has them.
  async askUser(sessionId, turn, evt) {
    if (turn.approvals.has(evt.id)) return; turn.approvals.add(evt.id);
    const choices = Array.isArray(evt.options) ? evt.options.map(String).filter(Boolean).slice(0, 8) : [];
    let answer = null;
    if (choices.length) {
      try {
        const res = await this.request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: `${turn.runId}-ask-${turn.approvals.size}`, title: String(evt.question || "Eta has a question"), kind: "other", status: "pending" },
          options: [...choices.map((c, i) => ({ optionId: "choice-" + i, name: c, kind: "allow_once" })), { optionId: "skip", name: "Skip", kind: "reject_once" }],
        }, turn);
        const o = res && res.outcome;
        const m = o && o.outcome === "selected" && /^choice-(\d+)$/.exec(o.optionId || "");
        if (m) answer = choices[Number(m[1])] ?? null;
      } catch (e) { this.log("question failed:", e.message); }
    } else {
      // ACP has no free-text question: answer "no answer" (null) at once, so the run never waits,
      // and say so plainly. The engine then reads "User did not answer" and decides by itself.
      this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: textBlock(`Eta asked: ${evt.question || "(no question text)"}\nThis editor cannot answer free-text questions, so Eta will decide by itself. If its choice is wrong, tell it in your next message.\n\n`) });
    }
    try { await httpJson(this.engine, "POST", "/api/ask-user-answer", { id: evt.id, answer }); }
    catch (e) { this.log("could not send the answer to the engine:", e.message); }
  }

  shutdown() {
    if (this.closed) return; this.closed = true;
    for (const [, s] of this.sessions) if (s.turn && !s.turn.finished) { if (s.turn.runId) this.engineCancel(s.turn.runId); s.turn.finish({ stopReason: "cancelled" }); }
    for (const [, p] of this.outgoing) p.reject(new Error("connection closed"));
    this.outgoing.clear();
  }
}

export function startAcp(input, output, engineBaseUrl, opts) { return new AcpAgent(input, output, engineBaseUrl, opts); }

// ---------- run as a program ----------
const isMain = (() => { try { return !!process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase() === process.argv[1].replace(/\\/g, "/").replace(/(\.mjs)?$/i, ".mjs").toLowerCase(); } catch { return false; } })();
if (isMain) {
  // stdout is the protocol channel: any stray console output goes to stderr
  const toErr = (...a) => { try { process.stderr.write(a.map(String).join(" ") + "\n"); } catch {} };
  console.log = console.info = console.debug = console.warn = toErr;
  const url = process.env.ETA_ENGINE_URL || DEFAULT_ENGINE_URL;
  toErr(`[eta-acp] ACP agent on stdio, Eta engine at ${url}`);
  const agent = new AcpAgent(process.stdin, process.stdout, url);
  process.stdin.on("end", () => { agent.shutdown(); setTimeout(() => process.exit(0), 200); });
  process.on("uncaughtException", (e) => toErr("[eta-acp] error:", e && e.stack || e));
  process.on("unhandledRejection", (e) => toErr("[eta-acp] error:", e && e.stack || e));
}
