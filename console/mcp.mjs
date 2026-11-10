// Minimal MCP (Model Context Protocol) client — stdio transport, JSON-RPC 2.0.
// Spawns the servers declared in .eta/mcp.json and exposes their tools to the
// agent, so users can plug in external tools (filesystem, GitHub, Postgres, …)
// the same way Cursor/Antigravity/Claude Desktop do. Pure Node, no deps.
// Per the MCP stdio spec, messages are newline-delimited JSON with no embedded
// newlines — so we split stdout on "\n".
import { spawn } from "child_process";
import { existsSync } from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

const PROTOCOL_VERSION = "2024-11-05";

// Windows launch resolution: a bare command name (npx, uvx, docker) must be
// resolved via PATHEXT — and .cmd/.bat shims can only run through a shell (Node
// refuses to spawn them directly). Explicit paths / .exe run without a shell, so
// spaces in the path are safe. Returns the concrete command + whether a shell is needed.
function winResolve(command) {
  if (/[\\/]/.test(command) || /\.[a-z0-9]+$/i.test(command)) return { cmd: command, shell: /\.(cmd|bat)$/i.test(command) };
  for (const dir of (process.env.PATH || "").split(";")) {
    for (const ext of (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")) {
      const full = path.join(dir, command + ext);
      if (existsSync(full)) return { cmd: full, shell: /\.(cmd|bat)$/i.test(ext) };
    }
  }
  return { cmd: command, shell: true }; // last resort — let the shell find it
}
const winQuote = (a) => (/[\s"^&|<>()]/.test(String(a)) ? `"${String(a).replace(/"/g, '""')}"` : String(a));

class McpServer {
  constructor(name, cfg) {
    this.name = name; this.cfg = cfg; this.proc = null;
    this.nextId = 1; this.pending = new Map(); this.buf = "";
    this.tools = []; this.ready = false;
  }
  async start(cwd) {
    const { command, args = [], env = {} } = this.cfg || {};
    if (!command) throw new Error(`server '${this.name}' has no command`);
    const base = { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
    if (process.platform === "win32") {
      const { cmd, shell } = winResolve(command);
      if (shell) this.proc = spawn([cmd, ...args].map(winQuote).join(" "), [], { ...base, shell: true });
      else this.proc = spawn(cmd, args, { ...base, shell: false });
    } else {
      this.proc = spawn(command, args, { ...base, shell: false });
    }
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", () => {}); // servers log diagnostics to stderr — ignore
    this.proc.on("error", () => { this.ready = false; });
    this.proc.on("exit", () => {
      this.ready = false;
      for (const [, p] of this.pending) p.reject(new Error("server exited"));
      this.pending.clear();
    });
    await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "Eta IDE", version: "0.1.0" },
    }, 20000);
    this._notify("notifications/initialized", {});
    const list = await this._request("tools/list", {}, 15000);
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    this.ready = true;
    return this.tools;
  }
  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim(); this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || "mcp error")); else p.resolve(msg.result);
      }
    }
  }
  _send(obj) { try { this.proc.stdin.write(JSON.stringify(obj) + "\n"); } catch {} }
  _notify(method, params) { this._send({ jsonrpc: "2.0", method, params }); }
  _request(method, params, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async call(toolName, args, timeout = 60000) {
    const res = await this._request("tools/call", { name: toolName, arguments: args || {} }, timeout);
    const parts = Array.isArray(res?.content) ? res.content : [];
    const text = parts.map((c) =>
      c?.type === "text" ? c.text :
      c?.type === "resource" ? JSON.stringify(c.resource) : JSON.stringify(c)
    ).join("\n");
    return { text: text || (res?.isError ? "(tool reported an error)" : "(no output)"), isError: !!res?.isError };
  }
  stop() { try { this.proc?.kill(); } catch {} }
}

// .eta/mcp.json (or .mcp.json) — same shape Claude Desktop / Cursor use:
//   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
// Tools can be GLOBAL (~/.eta/mcp.json, every project) or per project; a project entry with the
// same name wins over the global one.
export async function loadMcpFile(p) {
  try { const c = JSON.parse(await fsp.readFile(p, "utf8")); return c.mcpServers || c.servers || {}; } catch { return {}; }
}
export const globalMcpPath = () => path.join(os.homedir(), ".eta", "mcp.json");
export async function loadMcpConfig(root) {
  const global = await loadMcpFile(globalMcpPath());
  let project = {};
  if (root) for (const p of [path.join(root, ".eta", "mcp.json"), path.join(root, ".mcp.json")]) {
    project = await loadMcpFile(p); if (Object.keys(project).length) break;
  }
  return { ...global, ...project };
}

// A compact args hint for the tool prompt: {name: "type", optional: "?type"}.
export function mcpArgsHint(schema) {
  const props = schema?.properties || {}; const req = new Set(schema?.required || []);
  const o = {};
  for (const k of Object.keys(props).slice(0, 8)) o[k] = (req.has(k) ? "" : "?") + (props[k]?.type || "any");
  return o;
}

// Tools reached by WEB ADDRESS (MCP "Streamable HTTP"): a { "url": "https://...", "headers": {...} } entry.
// Same shape as McpServer above, so the rest of the engine does not care which kind it is.
class HttpMcpServer {
  constructor(name, cfg) { this.name = name; this.cfg = cfg; this.nextId = 1; this.tools = []; this.ready = false; this.session = null; this.controller = null; }
  _headers() {
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION, ...(this.cfg.headers || {}) };
    if (this.session) h["mcp-session-id"] = this.session;
    return h;
  }
  async _post(msg, timeout) {
    let res;
    try { res = await fetch(this.cfg.url, { method: "POST", headers: this._headers(), body: JSON.stringify(msg), signal: AbortSignal.timeout(timeout) }); }
    catch (e) { throw new Error(e && e.name === "TimeoutError" ? "The service did not answer in time." : "I could not reach " + this.cfg.url + ". Check the address and your internet."); }
    const sid = res.headers.get("mcp-session-id"); if (sid) this.session = sid;
    if (res.status === 401 || res.status === 403) throw new Error("The service refused the key (" + res.status + "). Check the headers, for example Authorization.");
    if (!res.ok && res.status !== 202) throw new Error("The service answered " + res.status + " " + (await res.text()).slice(0, 120));
    if (msg.id == null) return null; // a notification has no answer
    const ct = res.headers.get("content-type") || ""; const text = await res.text();
    let found = null;
    if (ct.includes("text/event-stream")) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue; try { const m = JSON.parse(data); if (m.id === msg.id) found = m; } catch {}
      }
    } else { try { const m = JSON.parse(text); found = Array.isArray(m) ? m.find((x) => x.id === msg.id) : m; } catch {} }
    if (!found) throw new Error("The service sent no usable answer to " + msg.method);
    if (found.error) throw new Error(found.error.message || "mcp error");
    return found.result;
  }
  _request(method, params, timeout = 30000) { return this._post({ jsonrpc: "2.0", id: this.nextId++, method, params }, timeout); }
  async start() {
    if (!/^https?:\/\//i.test(String(this.cfg.url || ""))) throw new Error("server '" + this.name + "' needs an http(s) address");
    await this._request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Eta IDE", version: "0.1.0" } }, 20000);
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, 15000).catch(() => {});
    const list = await this._request("tools/list", {}, 15000);
    this.tools = Array.isArray(list?.tools) ? list.tools : []; this.ready = true; return this.tools;
  }
  async call(toolName, args, timeout = 60000) {
    const res = await this._request("tools/call", { name: toolName, arguments: args || {} }, timeout);
    const parts = Array.isArray(res?.content) ? res.content : [];
    const text = parts.map((c) => c?.type === "text" ? c.text : c?.type === "resource" ? JSON.stringify(c.resource) : JSON.stringify(c)).join("\n");
    return { text: text || (res?.isError ? "(tool reported an error)" : "(no output)"), isError: !!res?.isError };
  }
  stop() { if (this.session) fetch(this.cfg.url, { method: "DELETE", headers: this._headers(), signal: AbortSignal.timeout(3000) }).catch(() => {}); this.ready = false; }
}
const makeServer = (name, cfg) => (cfg && cfg.url && !cfg.command ? new HttpMcpServer(name, cfg) : new McpServer(name, cfg));

// Connect once and report how many tools the entry offers (used by the "Test" button).
export async function testMcpServer(name, cfg, root) {
  const srv = makeServer(name, cfg);
  try { const t = await srv.start(root); return { ok: true, tools: t.map((x) => x.name) }; }
  catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 300) }; }
  finally { srv.stop(); }
}

// Start every configured server; return a hub the agent lists/calls tools through.
// Tools are namespaced mcp__<server>__<tool> so they never collide with built-ins.
export async function startMcp(root, log = () => {}) {
  const cfg = await loadMcpConfig(root);
  const servers = [];
  const tools = [];
  for (const name of Object.keys(cfg)) {
    if (cfg[name]?.disabled) continue;
    const srv = makeServer(name, cfg[name]);
    try {
      const list = await srv.start(root);
      servers.push(srv);
      for (const td of list) tools.push({
        server: name, name: td.name, fullName: `mcp__${name}__${td.name}`,
        description: td.description || "", schema: td.inputSchema || { type: "object", properties: {} },
      });
      log(`MCP '${name}': ${list.length} tool(s) ready`);
    } catch (e) { log(`MCP '${name}' failed: ${String(e?.message || e).slice(0, 120)}`); srv.stop(); }
  }
  return {
    tools, servers,
    async call(fullName, args) {
      const t = tools.find((x) => x.fullName === fullName);
      if (!t) return { text: `unknown MCP tool ${fullName}`, isError: true };
      const srv = servers.find((s) => s.name === t.server);
      if (!srv?.ready) return { text: `MCP server ${t?.server} not running`, isError: true };
      try { return await srv.call(t.name, args); } catch (e) { return { text: String(e?.message || e).slice(0, 400), isError: true }; }
    },
    stop() { for (const s of servers) s.stop(); },
  };
}
