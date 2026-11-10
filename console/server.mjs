// Eta IDE — a standalone, Antigravity-style agent surface with a real IDE shell:
// file explorer + live editor (you watch Eta create/edit files) + terminal you can
// use + a direct Chat-with-Eta panel + the multi-agent manager (Planner/Executor/
// Reviewer). Pure Node (http + SSE), no deps. Brain = ./agent.mjs (local Eta/Ollama).
import http from "http";
import crypto from "crypto";
import { readFileSync } from "fs";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { exec, spawn as cpSpawn } from "child_process";
import { queryWorkspace } from "./localsearch.mjs";
import { configureSearch, parseProviderLines, searchStatus, searchWeb, proxyLabel } from "./websearch.mjs";
import { Agent, Eta, chatStream, repoMap, provider, setProvider, detectProviderKind, listProviderModels, indexWorkspace, search as ripgrepSearch, retrieveForQuestion, completeCode, loadRules, loadWorkflows, loadAgents, editCode, ensureFimModel, fimReady, FIM_MODEL, detectHardware, ollamaUp, ollamaBase } from "./agent.mjs";
import { stopMoeTurbo, moeBackendRunning, findLlamaServer, recommendHF, startMainModelHF } from "./moe.mjs";
import { loadMcpConfig } from "./mcp.mjs";
import { listCatalog, addCatalogTool } from "./catalog.mjs";
import { Host, recommendFor, fitFor } from "./host.mjs";
import { listCustom, createItem, deleteItem, previewImport, commitImport, readItem, writeItem, testItem } from "./customize.mjs";
import { lspAvailable, diagnostics as lspDiagnostics } from "./lsp.mjs";
import { loadSkills, fileDeps, depGraph, ruleSkills } from "./agent.mjs";
import { onMeter, resetMeter } from "./meter.mjs";
import { gitSnapshot, revertRun, excludeEta, withGitLock, makeWorktree, mergeWorktree, discardWorktree } from "./snapshot.mjs";
import { CHAT_RULES } from "./chatrules.mjs";
import { encryptSecret, decryptSecret } from "./secrets.mjs";
import { fileURLToPath as _toPath } from "url";
const ENGINE_DIR_SELF = path.dirname(_toPath(import.meta.url));

const PORT = process.env.PORT || 8710;
const UI_PATH = new URL("./ui.html", import.meta.url);
const html = () => readFileSync(UI_PATH, "utf8"); // read fresh so UI edits show on reload
const MGR_PATH = new URL("./manager.html", import.meta.url);
// The standalone Manager app was dropped (Eta IDE only). "/" without ?embed=1 now serves the same panel page.
const managerHtml = () => { try { return readFileSync(MGR_PATH, "utf8"); } catch { return html(); } };

// ---- persistent provider config (~/.eta-ide/config.json) ----
// Profile isolation: the product app (port 8712) uses the unsuffixed files; any
// other port (dev/test/benchmark instances) gets its own config/state so parallel
// engines never race or corrupt the app's persisted state.
const PROFILE = String(PORT) === "8712" ? "" : "-" + PORT;
const CFG_PATH = path.join(os.homedir(), ".eta-ide", `config${PROFILE}.json`);
async function loadConfig() {
  try {
    const c = JSON.parse(await fsp.readFile(CFG_PATH, "utf8"));
    if (c.provider) {
      const prov = { ...c.provider };
      // Key lives encrypted at rest (keyEnc); legacy plaintext `key` still honored.
      if (c.provider.keyEnc) prov.key = await decryptSecret(c.provider.keyEnc);
      setProvider(prov);
    }
    await applySearchConfig(c.search);
    return c;
  } catch { return {}; }
}
// Web search sources (several providers, tried in turn). Brave API keys are stored encrypted.
async function applySearchConfig(sc) {
  if (!sc || !Array.isArray(sc.providers)) return;
  const providers = [];
  for (const p of sc.providers) providers.push(p.keyEnc ? { ...p, key: await decryptSecret(p.keyEnc) } : { ...p });
  const proxy = sc.proxy ? { url: sc.proxy.urlEnc ? await decryptSecret(sc.proxy.urlEnc) : "", noProxy: sc.proxy.noProxy || [] } : { url: "", noProxy: [] };
  try { configureSearch({ providers, minGapMs: sc.minGapMs, proxy }); } catch { configureSearch({ providers, minGapMs: sc.minGapMs }); }
}
function searchText(providers) {
  return providers.map((p) => p.type === "searxng" ? "searxng " + p.url : p.type === "brave" ? "brave " + ((p.key || p.keyEnc) ? "(key saved)" : "") : "ddg").join("\n");
}
async function saveConfig(patch) {
  let c = {}; try { c = JSON.parse(await fsp.readFile(CFG_PATH, "utf8")); } catch {}
  c = { ...c, ...patch };
  await fsp.mkdir(path.dirname(CFG_PATH), { recursive: true });
  await fsp.writeFile(CFG_PATH, JSON.stringify(c, null, 2), "utf8");
  return c;
}
async function loadConfigRaw() { try { return JSON.parse(await fsp.readFile(CFG_PATH, "utf8")); } catch { return {}; } }
await loadConfig();

// ---- model host: downloads and runs the local model (host.mjs) ----
let _hwFull = null;
const getHwFull = async () => { if (_hwFull) return _hwFull; try { _hwFull = await detectHardware(); } catch {} return _hwFull; };
const host = new Host({
  stateFile: path.join(os.homedir(), ".eta-ide", `host${PROFILE}.json`),
  getHw: getHwFull,
  isBusy: () => { for (const r of runs.values()) if (r.status === "running") return true; return false; },
  onState: (st) => {
    broadcast({ type: "host", state: st });
    // older panel code listens for these two
    if (st.status === "downloading" || st.status === "loading") broadcast({ type: "modelPull", status: (st.status === "downloading" ? st.percent + "% of " + st.totalGB + " GB" : st.message), model: st.label });
  },
});
await host.init();
// Pick a model: download if needed, start it, and point the engine at it.
async function useHosted(idOrSpec) {
  await host.use(idOrSpec);
  setProvider({ base: "http://127.0.0.1:8722", kind: "openai", model: host.apiModel || host.s.label, noGrammar: host.engine === "colibri" }); // Colibri only answers to its own model name and rejects response_format
  await saveConfig({ provider: { base: provider.base, model: provider.model, kind: provider.kind, keyEnc: await encryptSecret(provider.key || ""), completionModel: provider.completionModel, noGrammar: provider.noGrammar } });
  broadcast({ type: "modelReady", model: host.s.label, turbo: true });
}

// Cached hardware profile (the ONE model + context size + parallel-agent count sized
// to THIS machine). Warmed at startup so spawns can scale themselves without re-probing.
let _hw = null;
async function hwProfile() { if (_hw) return _hw; try { _hw = recommendHF(await detectHardware()); } catch {} return _hw; }
hwProfile();

// INBUILT FIM autocomplete: on launch (local Ollama), make sure the bundled
// completion model exists so "Tab" works with zero config. Idempotent + background —
// never blocks boot; first run streams a one-time ~1GB base pull.
function bootstrapFim() {
  // NOT gated on provider.kind: under MoE Turbo the main brain is llama-server ("openai")
  // while Tab-autocomplete still runs on Ollama. ensureFimModel self-checks Ollama is up.
  ensureFimModel((s) => broadcast({ type: "knowledge", text: "completion model: " + s }))
    .then((r) => { if (r.ok) console.log(`[fim] inbuilt completion model ${r.status} (${FIM_MODEL})`); else console.log(`[fim] setup skipped: ${r.reason}`); })
    .catch(() => {});
}
bootstrapFim();
const IGNORE = new Set(["node_modules", ".git", "dist", ".eta", "__pycache__", ".venv", "venv", ".next", "build", ".cache"]);

const runs = new Map();
let nextId = 1;
const clients = new Set();
const pending = new Map();
let planApprovalMode = false; // Topic 3: when ON, every run shows its plan and waits for approval before editing
const termState = { cwd: null };
const SYS_MSG = { role: "system", content: "You are Eta, a concise, correct local coding assistant running inside the Eta IDE. When asked about code, be direct and practical." };
let chatMsgs = [SYS_MSG];
// CHAT HISTORY: earlier chats are kept (per project) so "New chat" never destroys work.
let chatGen = 0; // bumped when the user switches chats, so a late reply never lands in the wrong chat
let archive = []; // [{id,title,ws,updated,chatMsgs,history}]
const MAX_ARCHIVE = 60;
function chatTitle(h) {
  const u = h.find((x) => x.kind === "user" && x.text);
  if (u) return String(u.text).replace(/\s+/g, " ").slice(0, 70);
  const r = h.find((x) => x.kind === "run" && runs.get(x.runId));
  return r ? String(runs.get(r.runId).task || "Agent run").replace(/\s+/g, " ").slice(0, 70) : "Chat";
}
function archiveCurrent(ws) {
  if (!history.some((x) => x.kind === "user" || x.kind === "run")) return null;
  const entry = { id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: chatTitle(history), ws: ws || "", updated: history[history.length - 1]?.ts || Date.now(), chatMsgs, history };
  archive.unshift(entry); if (archive.length > MAX_ARCHIVE) archive.length = MAX_ARCHIVE;
  return entry;
}
let history = []; // UI-renderable transcript: {kind:"user"|"eta"|"run", text?/runId?, ts}
// The open chat belongs to ONE folder (Gokul, 2026-11-10: "when I open a new folder, the previous folder's chat is still there").
// Opening another folder files the open chat under its own folder and shows that folder's last chat, or an empty one.
let currentWs = "";
const sameWs = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
function switchWs(ws) {
  if (!ws || sameWs(ws, currentWs)) return false;
  archiveCurrent(currentWs); // a chat from before this change has no folder: it stays visible in History for every folder
  const i = archive.findIndex((a) => sameWs(a.ws, ws));
  if (i >= 0) { const [p] = archive.splice(i, 1); chatMsgs = p.chatMsgs[0]?.role === "system" ? p.chatMsgs : [SYS_MSG, ...p.chatMsgs]; history = p.history; }
  else { chatMsgs = [SYS_MSG]; history = []; }
  currentWs = ws; chatGen++; scheduleSave(); return true;
}

// ---- session persistence (~/.eta-ide/state.json): chats + runs survive restarts ----
const STATE_PATH = path.join(os.homedir(), ".eta-ide", `state${PROFILE}.json`);
let _saveT = null;
function scheduleSave() { clearTimeout(_saveT); _saveT = setTimeout(() => saveState().catch(() => {}), 800); }
async function saveState() {
  const keepRunIds = new Set([...history, ...archive.flatMap((a) => a.history)].filter((h) => h.kind === "run").map((h) => h.runId));
  const data = {
    nextId, currentWs, chatMsgs: chatMsgs.slice(-25), history: history.slice(-40), archive: archive.map((a) => ({ ...a, chatMsgs: a.chatMsgs.slice(-25), history: a.history.slice(-60) })),
    runs: [...runs.values()].filter((r) => keepRunIds.has(r.id)).map((r) => ({
      id: r.id, task: r.task, workspace: r.workspace, status: r.status, started: r.started,
      files: [...r.files], warnings: r.warnings || [], snapshot: r.snapshot || null, events: r.events.slice(-400),
    })),
  };
  await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fsp.writeFile(STATE_PATH, JSON.stringify(data), "utf8");
}
async function loadState() {
  try {
    const d = JSON.parse(await fsp.readFile(STATE_PATH, "utf8"));
    nextId = d.nextId || 1;
    history = d.history || [];
    currentWs = d.currentWs || "";
    archive = Array.isArray(d.archive) ? d.archive : [];
    if (Array.isArray(d.chatMsgs) && d.chatMsgs.length) chatMsgs = d.chatMsgs[0]?.role === "system" ? d.chatMsgs : [SYS_MSG, ...d.chatMsgs];
    let recovered = false;
    for (const r of d.runs || []) {
      if (r.status === "running") {
        // The process died mid-run (crash/kill/reboot) before it could finish or revert a
        // partial write — same as any other "error" outcome, offer the snapshot-based undo
        // (see the `canRevert` convention in emit()) so a half-written file isn't silently
        // left worse than found with no way back.
        r.status = "error";
        r.events.push({ type: "error", text: "run interrupted by engine restart", runId: r.id, ...(r.snapshot ? { canRevert: true } : {}) });
        recovered = true;
      }
      runs.set(r.id, { ...r, files: new Set(r.files || []), agent: null });
    }
    if (runs.size || history.length) console.log(`[state] restored ${history.length} chat items, ${runs.size} runs`);
    // Persist the recovery immediately — otherwise the on-disk file still says "running" and
    // the NEXT restart re-discovers the same already-handled run as a fresh orphan, appending a
    // duplicate "run interrupted" event every single boot forever (found 2026-08-26: run 170's
    // in-memory status was "error" but its on-disk record still said "running" with zero
    // interrupted-events, days after it was actually recovered and reverted).
    if (recovered) scheduleSave();
  } catch (e) { console.log("[state] load failed:", String(e?.message || e).slice(0, 120)); }
}
await loadState(); // must run AFTER the declarations above (TDZ)

const meta = (r) => ({ id: r.id, task: r.task, workspace: r.workspace, status: r.status, started: r.started, files: [...r.files], warnings: r.warnings || [], isolated: !!r.isolated, branch: r.branch || null, merged: !!r.merged, discarded: !!r.discarded, conflicted: !!r.conflicted, canMerge: !!(r.isolated && r.branch && !r.merged && !r.discarded && !r.conflicted && ["done", "error"].includes(r.status)) });

// Compose a walkthrough artifact (Antigravity-style proof-of-work) from a run's
// events: plan, steps, files, gates, browser checks + screenshots, verdict.
function walkthrough(r) {
  const ev = r.events || [];
  const get = (t) => ev.filter((e) => e.type === t);
  const plan = get("plan")[0]?.text || "";
  const steps = ev.filter((e) => e.type === "tool").map((e) => {
    const a = e.args || {}; const k = a.path || a.command || a.query || a.question || "";
    return { name: e.name, arg: String(k).slice(0, 100) };
  });
  const gates = get("gate").map((e) => ({ file: e.file, ok: e.ok, msg: e.msg }));
  const browser = get("browser").map((e) => ({ file: e.file, ok: e.ok, errors: e.errors || [], shot: e.shot }));
  const reviews = get("review").map((e) => ({ approved: e.approved, feedback: e.feedback }));
  const answer = get("answer").slice(-1)[0]?.text || "";
  const done = get("done").slice(-1)[0];
  const durationMs = (ev.find((e) => e.type === "done" || e.type === "error")?.ts || Date.now()) - r.started;
  return {
    id: r.id, task: r.task, workspace: r.workspace, status: r.status, started: r.started,
    files: [...r.files], snapshot: r.snapshot || null, plan, steps, gates, browser, reviews, answer,
    warnings: done?.warnings || [], toolCount: steps.length, durationMs,
  };
}
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// Minimal markdown->HTML for published .md artifacts — headings/bold/italic/inline-code/fenced
// code/links/unordered-lists/paragraphs only. Deliberately NOT a full CommonMark implementation
// (no new dependency for one feature) — good enough for a report/notes page, not every markdown
// document; a doc leaning on tables/nested lists/etc. will render those parts as plain text.
function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = []; let inCode = false, codeBuf = [], inList = false;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
  for (const raw of lines) {
    const line = raw;
    if (/^\s*```/.test(line)) {
      if (inCode) { out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    closeList();
    if (!line.trim()) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`); // unterminated fence — show what we have
  return out.join("\n");
}
function mdArtifactPage(md, title) {
  return `<!doctype html><html><head><meta charset=utf-8><title>${esc(title || "Artifact")}</title>
<style>body{margin:0;background:#0d0d0d;color:#ddd;font:15px/1.7 "Segoe UI",system-ui,sans-serif;padding:36px 20px}
.wrap{max-width:760px;margin:0 auto}h1,h2,h3{color:#fff;line-height:1.3}code{background:#1a1a1a;padding:2px 5px;border-radius:4px;font:13px "Cascadia Code",Consolas,monospace}
pre{background:#131313;border:1px solid #2b2b2b;border-radius:8px;padding:14px;overflow-x:auto}pre code{background:none;padding:0}
a{color:#4c9aff}ul{padding-left:22px}</style></head>
<body><div class="wrap">${mdToHtml(md)}</div></body></html>`;
}
function walkthroughHtml(w) {
  const dur = w.durationMs > 0 ? Math.round(w.durationMs / 1000) + "s" : "";
  const badge = { done: "#2dd4bf", error: "#f87171", cancelled: "#fbbf24", running: "#22d3ee" }[w.status] || "#888";
  const shot = (b) => b.shot ? `<img src="/api/shot?ws=${encodeURIComponent(w.workspace)}&p=${encodeURIComponent(b.shot)}" style="max-width:100%;border-radius:8px;border:1px solid #2b2b2b;margin-top:8px">` : "";
  return `<!doctype html><html><head><meta charset=utf-8><title>Walkthrough — ${esc(w.task).slice(0, 50)}</title>
<style>body{margin:0;background:#0d0d0d;color:#ccc;font:14px/1.6 "Segoe UI",system-ui,sans-serif;padding:28px 20px}
.wrap{max-width:820px;margin:0 auto}h1{font-size:19px;color:#e8e8e8;margin:0 0 4px}
.sub{color:#888;font-size:12.5px;margin-bottom:22px}.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#052620;background:${badge}}
.sec{margin:22px 0}.sec h2{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#7a8;margin:0 0 10px}
.card{background:#161616;border:1px solid #2b2b2b;border-radius:10px;padding:12px 15px;margin:8px 0}
.plan{white-space:pre-wrap;color:#cdd}.step{font-family:"Cascadia Code",monospace;font-size:12.5px;color:#8cf;margin:3px 0}.step .a{color:#888}
.ok{color:#2dd4bf}.bad{color:#f87171}.mono{font-family:"Cascadia Code",monospace;font-size:12px}
.file{display:inline-block;background:#1e2a28;color:#2dd4bf;padding:2px 9px;border-radius:6px;margin:3px 6px 3px 0;font-family:monospace;font-size:12.5px}
.ans{background:#0f1c1b;border:1px solid #1d3b37;border-radius:8px;padding:11px 14px;white-space:pre-wrap}
.warn{background:#1c160c;border:1px solid #4a3a10;border-radius:8px;padding:11px 14px;color:#f2ddb0}</style></head>
<body><div class=wrap>
<h1>${esc(w.task)}</h1>
<div class=sub><span class=badge>${w.status}</span> &nbsp; ${esc((w.workspace || "").split(/[\\/]/).pop())} &nbsp;·&nbsp; ${w.toolCount} steps${dur ? " · " + dur : ""} · ${new Date(w.started).toLocaleString()}</div>
${w.plan ? `<div class=sec><h2>Plan</h2><div class="card plan">${esc(w.plan)}</div></div>` : ""}
${w.files.length ? `<div class=sec><h2>Files changed</h2><div>${w.files.map((f) => `<span class=file>${esc(f)}</span>`).join("")}</div></div>` : ""}
<div class=sec><h2>What Eta did</h2><div class=card>${w.steps.map((s) => `<div class=step>${esc(s.name)}${s.arg ? ` <span class=a>— ${esc(s.arg)}</span>` : ""}</div>`).join("") || "<i>no tool steps</i>"}</div></div>
${w.gates.length ? `<div class=sec><h2>Syntax gates</h2><div class=card>${w.gates.map((g) => `<div class=mono><span class="${g.ok ? "ok" : "bad"}">${g.ok ? "✓" : "✗"}</span> ${esc(g.file)} — ${esc(g.msg)}</div>`).join("")}</div></div>` : ""}
${w.browser.length ? `<div class=sec><h2>Browser verification</h2>${w.browser.map((b) => `<div class=card><div class="${b.ok ? "ok" : "bad"}">${b.ok ? "✓ page loads, console clean" : "✗ " + esc((b.errors || []).join("; ").slice(0, 200))}</div>${shot(b)}</div>`).join("")}</div>` : ""}
${w.reviews.length ? `<div class=sec><h2>Review</h2>${w.reviews.map((r) => `<div class=card><span class="${r.approved ? "ok" : "bad"}">${r.approved ? "✓ Approved" : "↻ Needs work"}</span>${r.feedback ? `<div style="margin-top:6px;white-space:pre-wrap">${esc(r.feedback)}</div>` : ""}</div>`).join("")}</div>` : ""}
${w.answer ? `<div class=sec><h2>Result</h2><div class=ans>${esc(w.answer)}</div></div>` : ""}
${w.warnings.length ? `<div class=sec><h2>Unresolved</h2><div class=warn>${w.warnings.map(esc).join("<br>")}</div></div>` : ""}
<div class=sub style="margin-top:28px">Generated by Eta IDE · 26io Techlab</div>
</div></body></html>`;
}
function broadcast(evt) { const d = `data: ${JSON.stringify(evt)}\n\n`; for (const c of clients) { try { c.write(d); } catch {} } }
// token meter (meter.mjs) -> the panel, at most twice a second
let _meterLast = 0, _meterT = null;
onMeter((s) => { const send = () => { _meterLast = Date.now(); _meterT = null; broadcast({ type: "meter", ...s }); };
  if (!s.busy || Date.now() - _meterLast > 500) { clearTimeout(_meterT); send(); } else if (!_meterT) _meterT = setTimeout(send, 500); });
function emit(run, e) {
  const evt = { ...e, runId: run.id, ts: Date.now() };
  if (e.type === "done" && run.snapshot) evt.canRevert = true;
  // live code-generation deltas are broadcast-only (ephemeral): storing every
  // keystroke-sized chunk would bloat run history; the final diff/filewrite
  // event carries the durable record.
  if (e.type !== "gen" && e.type !== "genEnd") run.events.push(evt);
  if (["start", "agent", "plan", "tool", "toolResult", "answer", "gate", "review", "error", "cancelled", "done", "stuck"].includes(e.type))
    console.log(`[run ${run.id}] ${e.type}${e.role ? ":" + e.role : ""}${e.name ? " " + e.name : ""}${e.file ? " " + e.file + (e.ok ? " OK" : " FAIL") : ""} ${String(e.text || e.result || e.feedback || "").slice(0, 90).replace(/\s+/g, " ")}`);
  if (e.type === "log" && /^✎ (created|edited) /.test(e.text || "")) run.files.add(e.text.replace(/^✎ (created|edited) /, "").split(" ")[0]);
  // The agent's own `done` event carries the authoritative post-processing file list
  // (e.g. empty after restoreBaselineIfWorse reverts a regression) — it must WIN over the
  // log-scan Set above, which only ever accumulates and never learns about a later revert.
  if (e.type === "done" && Array.isArray(e.files)) run.files = new Set(e.files);
  // Same reasoning as the files line above: the agent's own `done` event already computed
  // the authoritative honest-outcome warnings (outcome-not-met, still-failing test command,
  // placeholders left, etc.) via all the deterministic checks in agent.mjs's run() finish path.
  // Before this, that signal only ever reached the SSE broadcast (evt keeps e.warnings verbatim)
  // and the HTML report (which re-scans events for the last `done`) -- polling consumers of
  // meta()/`GET /api/run?id=N`, including this project's own standing unattended-run polling
  // method in TASKS.md, saw only `status`/`files` and had no top-level way to tell an honestly
  // "not fully complete" run apart from a genuinely successful one without replaying every event.
  if (e.type === "done") { run.status = "done"; run.warnings = Array.isArray(e.warnings) ? e.warnings : []; }
  if (e.type === "error") run.status = "error";
  if (e.type === "cancelled") run.status = "cancelled";
  broadcast(evt);
  if (["done", "error", "cancelled"].includes(e.type)) broadcast({ type: "run", run: meta(run) });
  scheduleSave();
}

// ---- git safety net + behavioral baseline ----
function sh(cwd, cmd, timeout = 90000) {
  return new Promise((res) => exec(cmd, { cwd, timeout, maxBuffer: 4 << 20, windowsHide: true },
    (err, so, se) => res({ ok: !err, out: ((so || "") + (se || "")).slice(-3000) })));
}
const GIT = `git -c user.name="Eta IDE" -c user.email="eta@26io.local"`;
// Generate a PR title + body from a diff, using the connected model.
async function generatePRText(diff) {
  try {
    const prompt = `Summarize these code changes as a GitHub pull request. Reply in EXACTLY this format, nothing else:\nTITLE: <one concise conventional-commit-style line>\nBODY:\n- <what changed>\n- <why / how it was tested>\n\nDiff:\n${String(diff || "").slice(0, 6000)}`;
    const out = await new Eta(provider.model).ask(prompt, provider.model, 400);
    const title = ((out.match(/TITLE:\s*(.+)/i) || [])[1] || "").trim() || "Update from Eta";
    const bodyText = (out.split(/BODY:\s*/i)[1] || "").trim() || "Changes made with Eta IDE.";
    return { title, body: bodyText };
  } catch { return { title: "Update from Eta", body: "Changes made with Eta IDE." }; }
}
// Keep engine metadata + build junk OUT of git (local-only .git/info/exclude, so
// we don't touch the user's .gitignore). Prevents spurious merge conflicts on
// .eta/brain when parallel agents each write memory.
// Detect a runnable baseline check (project tests). Recorded before the run;
// if it PASSED before and FAILS after, the agent introduced a regression.
async function detectBaseline(ws) {
  try { const pkg = JSON.parse(await fsp.readFile(path.join(ws, "package.json"), "utf8")); const t = pkg.scripts?.test; if (t && !/no test specified/i.test(t)) return "npm test --silent"; } catch {}
  try {
    const files = await fsp.readdir(ws);
    if (files.some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return 'python -m unittest discover -p "test*.py"';
    // LIVE-CAUGHT (boltons, 2026-07-23): this is the copy that actually matters for every live
    // spawned run (agent.mjs's own testCmd===undefined branch never fires, since the server
    // always passes an explicit testCmd — null included — to the Agent constructor below). Real
    // Python projects overwhelmingly keep tests in a tests/ subdirectory, not the repo root — this
    // never matched boltons (445 tests under tests/), so every run against it silently skipped the
    // real full-suite baseline for the whole history of that test workspace. See the matching fix
    // + comment in agent.mjs's detectTestCmd (the standalone-mode counterpart of this function).
    for (const dir of ["tests", "test"]) {
      if (!files.includes(dir)) continue;
      try {
        const sub = await fsp.readdir(path.join(ws, dir));
        if (sub.some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return "python -m pytest -q";
      } catch {}
    }
  } catch {}
  return null;
}

function spawn({ task, workspace, autoApprove, model, memoryModel, maxSteps, isolate, planApproval, forceSkill, persona }) {
  const id = String(nextId++); resetMeter();
  const run = { id, task, workspace, status: "running", events: [], files: new Set(), warnings: [], started: Date.now(), isolated: !!isolate };
  runs.set(id, run);
  history.push({ kind: "run", runId: id, ts: Date.now() });
  broadcast({ type: "run", run: meta(run) });
  const approve = (title, detail) => new Promise((res) => { const aid = id + ":" + Math.random().toString(36).slice(2); pending.set(aid, res); emit(run, { type: "approval", id: aid, title, detail }); });
  // Topic 3 — PLAN REVIEW: emit the plan and await the user's decision (approve / edit / reject).
  const planReview = (planText) => new Promise((res) => { const aid = id + ":plan"; pending.set(aid, res); emit(run, { type: "plan_review", id: aid, plan: planText }); });
  // ask_user tool channel — same pending/promise pattern, but for an in-loop clarifying question.
  const askUser = (question, options) => new Promise((res) => { const aid = id + ":ask:" + Math.random().toString(36).slice(2); pending.set(aid, res); emit(run, { type: "ask_user", id: aid, question, options }); });
  (async () => {
    // isolated (parallel) runs work in their own git worktree+branch
    let root = workspace;
    if (isolate) {
      emit(run, { type: "log", text: "creating isolated git worktree…" });
      const wt = await makeWorktree(workspace, id);
      if (wt) { root = wt.path; run.wtPath = wt.path; run.branch = wt.branch; run.base = wt.base; emit(run, { type: "worktree", branch: wt.branch }); }
      else emit(run, { type: "log", text: "git worktree unavailable — running directly" });
    }
    run.root = root;
    // safety snapshot (revert point) — only for direct runs; isolated ones use the branch
    if (!run.wtPath) { run.snapshot = await gitSnapshot(root); if (run.snapshot) emit(run, { type: "snapshot", hash: run.snapshot.slice(0, 10) }); }
    // behavioral baseline (regression reference) — handed to the engine so its
    // pre-review test gate knows what already passed without re-running the suite
    const bcmd = await detectBaseline(root);
    let base = null;
    if (bcmd) { base = await sh(root, bcmd, 120000); emit(run, { type: "log", text: `baseline check: ${bcmd} → ${base.ok ? "PASS" : "FAIL (pre-existing)"}` }); }
    // hardware-scaled context window: size numCtx to the machine (small on CPU/low-VRAM,
    // large on a strong GPU) unless the user pinned ETA_NUM_CTX.
    const prof = await hwProfile();
    const numCtx = process.env.ETA_NUM_CTX ? Number(process.env.ETA_NUM_CTX) : (prof?.numCtx || undefined);
    const agent = new Agent(root, { model: model || provider.model, memoryModel: memoryModel || model || provider.model, maxSteps: maxSteps || 24, autoApprove: autoApprove ?? true, testCmd: bcmd, testBaselineOk: base ? base.ok : null, numCtx, planApproval: planApproval ?? planApprovalMode, forceSkill, persona, enginePort: PORT });
    agent.planReview = planReview; // Topic 3: plan gate channel
    agent.askUser = askUser; // ask_user tool channel
    run.agent = agent;
    // the agent team
    try { await agent.run(task, (e) => emit(run, e), approve); }
    catch (err) { emit(run, { type: "error", text: String(err?.message || err) }); }
    finally { try { agent.mcp?.stop(); } catch {} } // release external MCP servers
    // regression gate
    if (bcmd && base?.ok) {
      const after = await sh(root, bcmd, 120000);
      if (!after.ok) emit(run, { type: "regression", text: `'${bcmd}' PASSED before this run but FAILS now — the agent likely broke existing behaviour. Consider Revert.`, detail: after.out.slice(-800) });
    }
  })();
  return id;
}

// ---- workspace knowledge ingestion (debounced per workspace) ----
const _ingestLast = new Map();
let lastWs = null;
function maybeIngest(ws) {
  if (!ws) return;
  lastWs = ws;
  const now = Date.now();
  if ((_ingestLast.get(ws) || 0) + 60000 > now) return;
  _ingestLast.set(ws, now);
  indexWorkspace(ws, (t) => broadcast({ type: "knowledge", text: t })).catch(() => {});
}

// ---- workspace helpers (explorer + editor) ----
async function tree(root, rel = "", depth = 0) {
  if (depth > 7) return [];
  let ents; try { ents = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return []; }
  ents.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
  const items = [];
  for (const e of ents) {
    if (IGNORE.has(e.name)) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) items.push({ name: e.name, path: r, type: "dir", children: await tree(root, r, depth + 1) });
    else items.push({ name: e.name, path: r, type: "file" });
    if (items.length > 500) break;
  }
  return items;
}
function safe(root, rel) { const r = path.resolve(root, rel || "."); if (!r.startsWith(path.resolve(root))) throw new Error("path escapes workspace"); return r; }

// ---- terminal (tracks cwd, basic cd support) ----
function runCmd(cwd, command) {
  return new Promise((res) => exec(command, { cwd, timeout: 120000, maxBuffer: 4 << 20, windowsHide: true },
    (err, so, se) => res(((so || "") + (se || "")).slice(-8000) + (err && !so && !se ? `\n[exit ${err.code ?? 1}]` : ""))));
}
async function terminal(ws, command) {
  const base = ws || os.homedir();
  let cwd = termState.cwd || base;
  try { await fsp.access(cwd); } catch { cwd = base; }
  const cd = command.match(/^\s*cd\s*(.*?)\s*$/i);
  if (cd) {
    let dest = (cd[1] || "").replace(/^["']|["']$/g, "");
    const next = dest ? path.resolve(cwd, dest) : os.homedir();
    try { const st = await fsp.stat(next); if (!st.isDirectory()) throw 0; termState.cwd = next; return { output: "", cwd: next }; }
    catch { return { output: `cd: no such directory: ${dest}`, cwd }; }
  }
  const output = await runCmd(cwd, command);
  termState.cwd = cwd;
  return { output, cwd };
}

// ---- persistent terminal sessions (streaming pipe shell + xterm.js frontend) ----
const shells = new Map(); let shellSeq = 0;
function startShell(ws) {
  const id = String(++shellSeq);
  const cwd = ws || os.homedir();
  const proc = process.platform === "win32"
    ? cpSpawn("powershell.exe", ["-NoLogo"], { cwd, env: process.env, windowsHide: true })
    : cpSpawn("bash", [], { cwd, env: process.env });
  const tail = { buf: "" };
  const push = (d) => { const s = d.toString(); tail.buf = (tail.buf + s).slice(-4000); broadcast({ type: "term", id, data: s }); };
  proc.stdout.on("data", push);
  proc.stderr.on("data", push);
  proc.on("exit", (c) => { broadcast({ type: "termExit", id, code: c }); shells.delete(id); });
  shells.set(id, { proc, ws, tail });
  return id;
}
// interrupt = kill the shell's CHILDREN (the running command), keep the shell
function interruptShell(id) {
  const s = shells.get(id); if (!s) return;
  const pid = s.proc.pid;
  exec(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }"`, { windowsHide: true }, () => {});
}

// ---- direct chat with Eta (streams over SSE) ----
const mapCache = new Map(); // ws -> {map, ts}
async function wsMap(ws) {
  if (!ws) return "";
  const c = mapCache.get(ws);
  if (c && Date.now() - c.ts < 60000) return c.map;
  let map = ""; try { map = await repoMap(ws, 4000); } catch {}
  mapCache.set(ws, { map, ts: Date.now() });
  return map;
}
async function doChat(message, ctxFile, ws, image) {
  resetMeter();
  if (chatMsgs.length > 24) chatMsgs = [chatMsgs[0], ...chatMsgs.slice(-18)];
  const map = await wsMap(ws);
  // project rules (.eta/rules | AGENTS.md | .cursorrules) steer chat too — the
  // SAME file the agents read, so chat and agent behave consistently per project.
  // Honesty rules + date (measured with test-hallucination.mjs on the 35B: invented-function explanations 4-5 of 8 without, 0 of 8 with),
  // and true product facts when the user asks about the IDE itself (same rule-based skills the agent uses).
  let facts = ""; try { const rs = ruleSkills(message, await loadSkills(ws)); if (rs.length) facts = "\n\nFACTS YOU MUST FOLLOW (never contradict, never invent other features):\n" + rs.map((x) => x.body.slice(0, 1200)).join("\n\n"); } catch {}
  const sysText = SYS_MSG.content + "\n\n" + CHAT_RULES() + facts;
  try { const rules = await loadRules(ws); chatMsgs[0] = { role: "system", content: sysText + (rules ? "\n\nPROJECT RULES (follow these for this project):\n" + rules : "") }; } catch { chatMsgs[0] = { role: "system", content: sysText }; }
  // pasted image -> deterministic analysis (OCR + pixel stats) -> text for Eta
  let imgReport = "";
  if (image) {
    try {
      const b64 = String(image).replace(/^data:image\/\w+;base64,/, "");
      const { analyzeImage } = await import("./imagelab.mjs");
      const a = await analyzeImage(Buffer.from(b64, "base64"));
      imgReport = `[the user pasted an image — analyzed without a vision model]\n${a.report}\n\n`;
      console.log(`[image] analyzed: ${a.width}x${a.height}, ocr ${a.text ? a.text.length + " chars" : "none"}`);
    } catch (e) { imgReport = `[an image was pasted but analysis failed: ${String(e?.message || e).slice(0, 100)}]\n\n`; }
  }
  // RETRIEVAL: grep the repo for the question's real symbols so the answer is grounded in actual
  // code, not the truncated static map (which hallucinated on modules it couldn't fit).
  let retrieved = ""; try { if (ws) retrieved = await retrieveForQuestion(ws, message); } catch {}
  const userText = (map ? `[project map]\n${map}\n` : "") + (retrieved ? retrieved + "\n" : "") + imgReport +
    (ctxFile ? `[open file: ${ctxFile.path}]\n\`\`\`\n${(ctxFile.content || "").slice(0, 6000)}\n\`\`\`\n\n` : "") + message;
  const myMsgs = chatMsgs, myHist = history, gen = chatGen; // stay bound to THIS chat even if the user switches meanwhile
  myMsgs.push({ role: "user", content: userText });
  myHist.push({ kind: "user", text: message + (image ? " (image attached)" : ""), ts: Date.now() });
  broadcast({ type: "chat", role: "user", text: message });
  const cid = Math.random().toString(36).slice(2);
  broadcast({ type: "chatStart", cid });
  let full = "";
  try { await chatStream(myMsgs, (d) => { full += d; if (gen === chatGen) broadcast({ type: "chatDelta", cid, delta: d }); }); }
  catch (e) { full = "[error: " + (e?.message || e) + "]"; if (gen === chatGen) broadcast({ type: "chatDelta", cid, delta: full }); }
  myMsgs.push({ role: "assistant", content: full });
  myHist.push({ kind: "eta", text: full, ts: Date.now() });
  console.log(`[chat] reply ${full.length} chars: ${full.slice(0, 80).replace(/\s+/g, " ")}`);
  broadcast({ type: "chatEnd", cid, text: full });
  scheduleSave();
}

// Decide whether a chat message is a "task" (act on the workspace with the agent team)
// or plain "chat" (just answer). Invisible to the user — one input, right behavior.
function classify(message, ws) {
  if (!ws) return "chat";
  const m = message.toLowerCase();
  const strong = /\b(build|create|make|add|write|implement|generate|scaffold|fix|edit|refactor|rename|delete|remove|install|set ?up|convert|replace|wire|integrate)\b/;
  if (strong.test(m)) return "task";
  const q = /^\s*(what|why|how|when|where|who|which|is|are|do|does|did|can|could|should|would|will|explain|describe|tell me|show me|list)\b/;
  if (q.test(m)) return "chat";
  if (/\b(update|change|modif|append|insert|move|run the|execute)\b/.test(m)) return "task";
  // LIVE-CAUGHT 2026-11-10: "Run greet.py and tell me…" and "Commit all files and push…" went to chat, where nothing can
  // run. A message that STARTS with a doing-word, or runs a named file, is work for the agent.
  if (/^\s*(please\s+)?(run|start|launch|stop|test|commit|push|pull|clone|deploy|serve|compile|debug|lint|format|migrate|clean|free|upgrade|uninstall|download|init|check)\b/.test(m)) return "task";
  if (/\b(run|execute|start|launch)\b[^.?!]{0,40}\b[\w-]+\.(py|js|mjs|cjs|ts|sh|bat|cmd|ps1|rb|go|java|php)\b/.test(m) || /\b(git\s+)?(commit|push)\b.*\b(origin|main|master|branch|repo|remote)\b/.test(m)) return "task";
  return "chat";
}

function body(req) { return new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); }); }
function json(res, o, code = 200) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); }

// ACCESS GUARD (security audit 2026-11-10): this server can run shell commands through the agent, so only this PC's own
// pages may call it. Before: it listened on every network card and accepted any request, so another PC on the same Wi-Fi,
// or ANY website the user visited (a "text/plain" POST needs no CORS check), could start an agent task with autoApprove.
//  - Host must be 127.0.0.1/localhost on our port (blocks DNS rebinding);
//  - a browser Origin, when sent, must be our own page (blocks cross-site requests; the panel iframe is same-origin);
//  - Sec-Fetch-Site cross-site/same-site is refused too (covers GETs and other localhost ports).
// The IDE extension and tests call from Node: no Origin header, allowed.
const OWN_ORIGINS = () => new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
function accessDenied(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (host && !OWN_ORIGINS().has("http://" + host)) return "host";
  const origin = req.headers.origin;
  if (origin !== undefined && !OWN_ORIGINS().has(String(origin).toLowerCase())) return "origin";
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site === "cross-site" || site === "same-site") {
    // The IDE shows the panel in an iframe: that first page load comes from the webview, so it is "cross-site".
    // Allow plain page loads (GET navigations of the UI, never /api or /events): a foreign page cannot read them anyway.
    const p = String(req.url || "/");
    if (req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && !/^\/(api|events)\b/.test(p)) return "";
    return "site";
  }
  return "";
}
const server = http.createServer(async (req, res) => {
  try {
    const denied = accessDenied(req);
    if (denied) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("Forbidden: Eta only accepts requests from its own window (" + denied + ")."); }
    const u = new URL(req.url, "http://x");
    // the model may be asleep (idle) or restarting: wake it before work that needs it
    if (req.method === "POST" && /^\/api\/(chat|message|spawn|spawn-many)$/.test(u.pathname) && host.isHostedProvider(provider)) { try { await host.wake(); } catch {} }
    if (req.method === "GET" && u.pathname === "/") {
      // standalone app = the Agent Manager; the VS Code fork embeds the agent panel with ?embed=1
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(u.searchParams.get("embed") ? html() : managerHtml());
    }
    if (req.method === "GET" && u.pathname.startsWith("/vendor/")) {
      const rel = u.pathname.slice(8).replace(/\.\./g, "");
      const fp = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, "$1")), "vendor", rel);
      try { const data = await fsp.readFile(fp);
        const ct = fp.endsWith(".js") ? "text/javascript" : fp.endsWith(".css") ? "text/css" : "application/octet-stream";
        res.writeHead(200, { "content-type": ct, "cache-control": "max-age=3600" }); return res.end(data);
      } catch { res.writeHead(404); return res.end("not found"); }
    }
    if (u.pathname === "/events") {
      // live-only stream — initial state comes from GET /api/history (persistence)
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      // "still here" every 30 s: a quiet stream (the agent waiting for the user) must not be closed by a client or proxy timeout
      const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 30000); req.on("close", () => clearInterval(hb));
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/history") {
      switchWs(u.searchParams.get("ws") || "");
      return json(res, {
        history: history.slice(-40),
        runs: Object.fromEntries([...runs].map(([id, r]) => [id, { meta: meta(r), events: r.events.slice(-400) }])),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/clear-chat") {
      const b = await body(req).catch(() => ({}));
      archiveCurrent((b && b.ws) || currentWs); // "new chat" keeps the old one in History
      if (b && b.ws) currentWs = b.ws;
      chatGen++; chatMsgs = [SYS_MSG]; history = []; scheduleSave();
      return json(res, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/chats") {
      const ws = u.searchParams.get("ws") || "";
      const list = archive.filter((a) => !ws || !a.ws || a.ws.toLowerCase() === ws.toLowerCase())
        .map((a) => ({ id: a.id, title: a.title, updated: a.updated, items: a.history.length }));
      return json(res, { chats: list, currentHasContent: history.some((x) => x.kind === "user" || x.kind === "run") });
    }
    if (req.method === "POST" && u.pathname === "/api/chats/open") {
      const b = await body(req); const i = archive.findIndex((a) => a.id === b.id);
      if (i < 0) return json(res, { error: "chat not found" }, 404);
      const [picked] = archive.splice(i, 1);
      archiveCurrent(currentWs || b.ws || picked.ws);
      currentWs = b.ws || picked.ws || currentWs;
      chatMsgs = picked.chatMsgs[0]?.role === "system" ? picked.chatMsgs : [SYS_MSG, ...picked.chatMsgs]; history = picked.history; chatGen++;
      scheduleSave(); return json(res, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/chats/delete") {
      const b = await body(req); archive = archive.filter((a) => a.id !== b.id); scheduleSave(); return json(res, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/update") return json(res, updateInfo || { available: false });
    if (req.method === "GET" && u.pathname === "/api/health") {
      const configured = !!(provider.base && provider.model);
      let ok = configured ? await new Eta(u.searchParams.get("model") || provider.model).health() : false;
      if (configured && host.isHostedProvider(provider)) ok = ["ready", "sleeping", "loading", "restarting", "downloading"].includes(host.s.status); // llama-server names its model by file path, so the name check cannot be trusted
      return json(res, { eta: ok, configured, hostStatus: host.isHostedProvider(provider) ? host.s.status : "", kind: provider.kind, model: provider.model, base: provider.base, local: /localhost|127\.0\.0\.1/.test(provider.base) });
    }
    if (req.method === "GET" && u.pathname === "/api/config") { return json(res, { provider: { base: provider.base, model: provider.model, key: provider.key, kind: provider.kind, completionModel: provider.completionModel } }); }
    if (req.method === "POST" && u.pathname === "/api/config") {
      const b = await body(req);
      if (b.provider) {
        setProvider(b.provider);
        if (host.s.status !== "none" && !host.isHostedProvider(provider)) host.stop();
        // BYOM: auto-detect which protocol this endpoint speaks unless told.
        if (!b.provider.kind) { const k = await detectProviderKind(provider.base, provider.key); if (k) setProvider({ kind: k }); }
        // Persist the key ENCRYPTED (keyEnc), never plaintext.
        await saveConfig({ provider: { base: provider.base, model: provider.model, keyEnc: await encryptSecret(provider.key), kind: provider.kind, completionModel: provider.completionModel, escalationModel: provider.escalationModel } });
      }
      const ok = provider.model ? await new Eta(provider.model).health() : false;
      return json(res, { ok: true, eta: ok, provider: { base: provider.base, model: provider.model, kind: provider.kind } });
    }
    // Onboarding helper: probe a base URL (before saving) — detects protocol and
    // lists the models it offers so the user can pick one.
    if (req.method === "POST" && u.pathname === "/api/provider/test") {
      const b = await body(req);
      const out = await listProviderModels(b.base || "", b.key || "", b.kind || null);
      return json(res, { reachable: !!out.kind, ...out });
    }
    if (req.method === "GET" && u.pathname === "/api/run") { const r = runs.get(u.searchParams.get("id")); return json(res, r ? { status: r.status, files: [...r.files], warnings: r.warnings || [], events: r.events } : { error: "not found" }, r ? 200 : 404); }
    if (req.method === "GET" && u.pathname === "/api/walkthrough") {
      const r = runs.get(u.searchParams.get("id")); if (!r) return json(res, { error: "not found" }, 404);
      if (u.searchParams.get("format") === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(walkthroughHtml(walkthrough(r))); }
      return json(res, walkthrough(r));
    }
    if (req.method === "GET" && u.pathname === "/api/tree") {
      const ws = u.searchParams.get("ws"); if (!ws) return json(res, { error: "ws required" }, 400);
      try { await fsp.access(ws); } catch { return json(res, { error: "folder not found" }, 404); }
      maybeIngest(ws); // knowledge-native: opening a workspace indexes it (debounced)
      return json(res, { root: ws, tree: await tree(ws) });
    }
    // ---- project-wide search (ripgrep, same engine the agents use) ----
    if (req.method === "GET" && u.pathname === "/api/search") {
      const ws = u.searchParams.get("ws"), q = u.searchParams.get("q");
      if (!ws || !q) return json(res, { error: "ws and q required" }, 400);
      const out = await ripgrepSearch(ws, q);
      const hits = out === "no matches" ? [] : out.split("\n").map((l) => {
        const m = l.match(/^(.{1,300}?):(\d+):\s?(.*)$/);
        return m ? { path: m[1].replace(/^\.[\\/]/, "").replace(/\\/g, "/"), line: +m[2], text: m[3].slice(0, 200) } : null;
      }).filter(Boolean);
      return json(res, { hits });
    }
    // ---- git diff view (wraps the git already used for snapshots/worktrees) ----
    if (req.method === "GET" && u.pathname === "/api/git/diff") {
      const ws = u.searchParams.get("ws"); if (!ws) return json(res, { error: "ws required" }, 400);
      if (!(await sh(ws, "git rev-parse --is-inside-work-tree")).ok) return json(res, { git: false, diff: "", staged: "", status: "", branch: "" });
      const [d1, d2, st, br] = await Promise.all([sh(ws, "git diff"), sh(ws, "git diff --staged"), sh(ws, "git status --short"), sh(ws, "git rev-parse --abbrev-ref HEAD")]);
      return json(res, { git: true, diff: d1.out || "", staged: d2.out || "", status: st.out || "", branch: (br.out || "").trim() });
    }
    // ---- dependency graph: a file's imports + importedBy (blast radius), or the whole graph ----
    if (req.method === "GET" && u.pathname === "/api/deps") {
      const ws = u.searchParams.get("ws"), p = u.searchParams.get("path");
      if (!ws) return json(res, { error: "ws required" }, 400);
      if (p) return json(res, await fileDeps(ws, p));
      return json(res, { graph: await depGraph(ws) });
    }
    // ---- Pull Request assistant: branch + commit + push + open a PR (GitHub CLI) ----
    if (req.method === "POST" && u.pathname === "/api/pr") {
      const b = await body(req); const ws = b.ws;
      if (!ws) return json(res, { error: "ws required" }, 400);
      if (!(await sh(ws, "git rev-parse --is-inside-work-tree")).ok) return json(res, { error: "This folder is not a git repository." }, 400);
      if (!(await sh(ws, "gh --version")).ok) return json(res, { error: "GitHub CLI (gh) isn't installed. Get it at cli.github.com, run `gh auth login`, then try again." }, 400);
      if (!(await sh(ws, "gh auth status")).ok) return json(res, { error: "Not signed in to GitHub. Open a terminal, run `gh auth login`, then try again." }, 400);
      // base branch (origin's default), then ensure we're on a feature branch
      const base = (b.base || "").trim() || ((await sh(ws, "git symbolic-ref refs/remotes/origin/HEAD")).out.trim().split("/").pop()) || "main";
      let branch = (await sh(ws, "git rev-parse --abbrev-ref HEAD")).out.trim();
      if (!branch || /^(main|master|HEAD)$/.test(branch)) {
        branch = "eta/pr-" + Date.now().toString(36);
        const co = await sh(ws, `${GIT} checkout -b ${branch}`);
        if (!co.ok) return json(res, { error: "Couldn't create a branch: " + co.out.slice(-200) }, 400);
      }
      await sh(ws, `${GIT} add -A`);
      if ((await sh(ws, "git status --short")).out.trim()) await sh(ws, `${GIT} commit --no-verify -m "eta: changes for pull request"`);
      const push = await sh(ws, `git push -u origin ${branch}`);
      if (!push.ok) return json(res, { error: "git push failed — check your remote and access:\n" + push.out.slice(-300) }, 400);
      let title = b.title, bodyText = b.body;
      if (!title) {
        const diff = (await sh(ws, `git diff origin/${base}...${branch}`)).out || (await sh(ws, "git log -3 --stat")).out;
        const g = await generatePRText(diff); title = g.title; bodyText = bodyText || g.body;
      }
      const bf = path.join(os.tmpdir(), `eta-pr-${Date.now()}.md`);
      await fsp.writeFile(bf, bodyText || "Changes made with Eta IDE.", "utf8");
      const safeTitle = String(title).replace(/["\r\n]/g, "").slice(0, 120) || "Update from Eta";
      const pr = await sh(ws, `gh pr create --base ${base} --head ${branch} --title "${safeTitle}" --body-file "${bf}"`);
      try { await fsp.unlink(bf); } catch {}
      const url = (pr.out.match(/https:\/\/github\.com\/\S+/) || [])[0] || null;
      return json(res, { ok: pr.ok && !!url, url, title: safeTitle, branch, base, detail: pr.out.slice(-400) });
    }
    // ---- web search sources: several providers, automatic fallback ----
    if (req.method === "GET" && u.pathname === "/api/search/config") {
      const c = await loadConfigRaw();
      const providers = (c.search && c.search.providers) || [{ type: "ddg" }];
      return json(res, { text: searchText(providers), status: searchStatus(), proxy: proxyLabel() });
    }
    if (req.method === "POST" && u.pathname === "/api/search/config") {
      const b = await body(req);
      let parsed; try { parsed = parseProviderLines(b.text || ""); } catch (e) { return json(res, { error: String(e.message || e) }, 400); }
      if (!parsed.length) parsed = [{ type: "ddg" }];
      const old = ((await loadConfigRaw()).search || {}).providers || [];
      const oldBrave = old.find((p) => p.type === "brave" && p.keyEnc);
      const stored = [];
      for (const p of parsed) {
        if (p.type !== "brave") { stored.push(p); continue; }
        const raw = (p.key || "").trim();
        if (!raw || /^\(key saved\)$/i.test(raw)) { if (oldBrave) stored.push({ type: "brave", keyEnc: oldBrave.keyEnc }); else stored.push({ type: "brave", key: "" }); }
        else stored.push({ type: "brave", keyEnc: await encryptSecret(raw) });
      }
      // proxy: undefined = keep what is saved; "" = remove; text = set (credentials are encrypted at rest)
      const oldSearch = (await loadConfigRaw()).search || {};
      let proxy = oldSearch.proxy;
      if (typeof b.proxyUrl === "string") {
        const pu = b.proxyUrl.trim();
        const noProxy = String(b.noProxy || "").split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (!pu) proxy = undefined;
        else {
          if (!/^https?:\/\/[^\s/]+/i.test(pu)) return json(res, { error: "Proxy address must look like http://host:port" }, 400);
          let keepOld = false;
          try { const lab = proxyLabel(); keepOld = !!(proxy && proxy.urlEnc && lab.hasAuth && pu === lab.url); } catch {}
          proxy = { urlEnc: keepOld ? proxy.urlEnc : await encryptSecret(pu), noProxy };
        }
      }
      const c = await saveConfig({ search: { providers: stored, minGapMs: Number.isFinite(b.minGapMs) ? b.minGapMs : undefined, proxy } });
      await applySearchConfig(c.search);
      return json(res, { ok: true, text: searchText(stored), status: searchStatus(), proxy: proxyLabel() });
    }
    if (req.method === "POST" && u.pathname === "/api/search/test") {
      const b = await body(req);
      const r = await searchWeb(String(b.query || "node.js fs readFile"), 3);
      return json(res, { provider: r.provider, results: r.results, tried: r.tried, error: r.error || null, status: searchStatus() });
    }
    // ---- built-in local code search (no outside service) ----
    if (req.method === "POST" && u.pathname === "/api/knowledge/ask") {
      const b = await body(req); if (!b.query) return json(res, { error: "query required" }, 400);
      const ws = b.ws || lastWs; if (!ws) return json(res, { error: "open a workspace first" }, 400);
      try {
        const hits = await queryWorkspace(ws, String(b.query), 6);
        const answer = hits.length ? hits.map((h, i) => "[" + (i + 1) + "] " + h.file + ":" + h.start + "-" + h.end).join("\n") : "";
        return json(res, { answer, source: "local workspace index", chunks: hits.map((h) => ({ text: "FILE: " + h.file + "\n" + h.text, source_title: h.file + ":" + h.start + "-" + h.end, doc_id: "ws:" + h.file })) });
      } catch (e) { return json(res, { error: "search failed: " + String(e?.message || e).slice(0, 120) }, 500); }
    }
    if (req.method === "GET" && u.pathname === "/api/knowledge/stats") {
      const ws = u.searchParams.get("ws") || lastWs; if (!ws) return json(res, { error: "open a workspace first" });
      const st = await indexWorkspace(ws).catch(() => null);
      return json(res, st ? { local: true, files: st.files, chunks: st.chunks } : { error: "index failed" });
    }
    // ---- inline completion (advisory; NEVER touches the verification pipeline) ----
    if (req.method === "POST" && u.pathname === "/api/complete") {
      const b = await body(req);
      if (!provider.model) return json(res, { completion: "", error: "no model configured" });
      try { return json(res, { completion: await completeCode(b.prefix || "", b.suffix || "", b.lang || "") }); }
      catch (e) { return json(res, { completion: "", error: String(e?.message || e).slice(0, 120) }); }
    }
    // ---- language intelligence: real diagnostics via the extension's LSP bridge ----
    if (req.method === "GET" && u.pathname === "/api/lsp/status") { return json(res, { available: lspAvailable() }); }
    if (req.method === "GET" && u.pathname === "/api/lsp/diagnostics") {
      const p = u.searchParams.get("path"); if (!p) return json(res, { error: "path required" }, 400);
      if (!lspAvailable()) return json(res, { available: false, diagnostics: [] });
      const d = await lspDiagnostics(p);
      return json(res, { available: true, diagnostics: d || [] });
    }
    // ---- inline edit (Cmd-K): rewrite a selection per an instruction ----
    if (req.method === "POST" && u.pathname === "/api/edit") {
      const b = await body(req);
      if (!provider.model) return json(res, { error: "no model configured" }, 400);
      if (typeof b.code !== "string" || !b.instruction) return json(res, { error: "code and instruction required" }, 400);
      try { return json(res, { edit: await editCode(b.code, b.instruction, b.lang || "", b.path || "") }); }
      catch (e) { return json(res, { error: String(e?.message || e).slice(0, 160) }, 500); }
    }
    // ---- adaptive hardware → the one right local model (first-run onboarding) ----
    // 2026-07-22: Ollama-free — recommendHF() picks a clean binary tier (flagship 80B on a
    // qualifying dGPU, else the 16B floor) straight from HF_MODELS, no Ollama tag involved.
    if (req.method === "GET" && u.pathname === "/api/hardware") {
      const hw = await detectHardware();
      const base = recommendHF(hw), pick = recommendFor(hw);
      // null = no model on the list is good enough AND fast enough here. Say so; do not hand out a weak model.
      if (!pick) return json(res, { hardware: hw, recommendation: null, tooSmall: true, llamaServerBundled: !!findLlamaServer(hw) });
      const recommendation ={ ...base, model: pick.label, tier: pick.id, sizeGB: pick.sizeGB, mode: "standard", reason: "The biggest model that runs fast on this PC. " + fitFor(hw, pick).text + "." };
      return json(res, { hardware: hw, recommendation, llamaServerBundled: !!findLlamaServer(hw) });
    }
    // MoE Turbo backend status (is the bundled llama-server serving the model?)
    if (u.pathname.startsWith("/api/host")) {
      try {
        if (req.method === "GET" && u.pathname === "/api/host") return json(res, await host.describe());
        const b = await body(req);
        if (u.pathname === "/api/host/use") { useHosted(b.id || b.spec).catch((e) => { if (!e.paused) broadcast({ type: "host", state: { ...host.publicState(), status: "error", error: String(e.message || e), message: String(e.message || e) } }); }); return json(res, { started: true }); }
        if (u.pathname === "/api/host/pause") { host.pause(); return json(res, { ok: true }); }
        if (u.pathname === "/api/host/cancel") { await host.cancel(); return json(res, { ok: true }); }
        if (u.pathname === "/api/host/stop") { host.stop(); return json(res, { ok: true }); }
        if (u.pathname === "/api/host/restart") { host.restart().catch(() => {}); return json(res, { started: true }); }
        if (u.pathname === "/api/host/idle") { host.setIdle(b.min); return json(res, { ok: true }); }
        if (u.pathname === "/api/host/remove") { await host.remove(b.id); return json(res, { ok: true }); }
      } catch (e) { return json(res, { error: String(e.message || e) }, 400); }
    }
    if (req.method === "GET" && u.pathname === "/api/moe/status") {
      const h = moeBackendRunning();
      return json(res, h ? { active: true, base: h.base, model: h.model || h.rec?.label, flags: h.flags } : { active: false });
    }
    if (req.method === "POST" && u.pathname === "/api/moe/stop") {
      stopMoeTurbo();
      // Only revert to Ollama if it's ACTUALLY reachable — after an Ollama-free setup there may
      // be no Ollama running at all, and silently claiming kind:"ollama" would just leave the
      // provider pointed at a dead endpoint instead of honestly reporting "not connected".
      if (await ollamaUp()) setProvider({ base: ollamaBase(), kind: "ollama" });
      else setProvider({ base: "", model: "", kind: "ollama" });
      return json(res, { stopped: true });
    }
    if (req.method === "POST" && u.pathname === "/api/hardware/setup") {
      // background launch (first run downloads GBs via -hf) — stream progress over SSE; UI
      // reacts to modelReady. No Ollama pull, no GGUF lookup in Ollama's blob store — the
      // bundled llama-server resolves the download/cache itself (see moe.mjs startMainModelHF).
      (async () => {
        const hw = await detectHardware(); const pick = recommendFor(hw);
        if (!pick) { broadcast({ type: "modelPull", status: "error: this PC is too small for a good model", model: "" }); return; }
        const rec = { model: pick.label };
        try { await useHosted(pick.id); } catch (e) { if (!e.paused) broadcast({ type: "modelPull", status: "error: " + String(e?.message || e).slice(0, 160), model: rec.model }); }
      })();
      return json(res, { started: true });
    }
    // ---- inbuilt FIM completion model: status + on-demand setup ----
    if (req.method === "GET" && u.pathname === "/api/fim/status") { return json(res, { ready: fimReady(), model: FIM_MODEL, kind: provider.kind }); }
    if (req.method === "POST" && u.pathname === "/api/fim/setup") {
      const r = await ensureFimModel((s) => broadcast({ type: "knowledge", text: "completion model: " + s }));
      return json(res, r);
    }
    if (req.method === "POST" && u.pathname === "/api/ingest-workspace") {
      const b = await body(req); if (!b.ws) return json(res, { error: "ws required" }, 400);
      indexWorkspace(b.ws, (t) => broadcast({ type: "knowledge", text: t })).catch(() => {});
      return json(res, { ok: true, started: true });
    }
    if (req.method === "GET" && u.pathname === "/api/file") {
      const ws = u.searchParams.get("ws"), p = u.searchParams.get("path"); if (!ws || !p) return json(res, { error: "ws and path required" }, 400);
      try { const c = await fsp.readFile(safe(ws, p), "utf8"); return json(res, { path: p, content: c.length > 400000 ? c.slice(0, 400000) + "\n…(truncated)" : c }); }
      catch (e) { return json(res, { error: String(e?.message || e) }, 404); }
    }
    if (req.method === "POST" && u.pathname === "/api/terminal") { const b = await body(req); if (!b.command) return json(res, { error: "command required" }, 400); return json(res, await terminal(b.ws, b.command)); }
    if (req.method === "PUT" && u.pathname === "/api/file") {
      const b = await body(req); if (!b.ws || !b.path || typeof b.content !== "string") return json(res, { error: "ws, path, content required" }, 400);
      try {
        const fp = safe(b.ws, b.path); await fsp.mkdir(path.dirname(fp), { recursive: true }); await fsp.writeFile(fp, b.content, "utf8");
        // keep the knowledge index in sync with edits (ledger sends only this change)
        indexWorkspace(b.ws, (t) => broadcast({ type: "knowledge", text: t })).catch(() => {});
        return json(res, { ok: true });
      }
      catch (e) { return json(res, { error: String(e?.message || e) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/term/start") { const b = await body(req); return json(res, { id: startShell(b.ws) }); }
    if (req.method === "POST" && u.pathname === "/api/term/input") { const b = await body(req); const s = shells.get(b.id); if (!s) return json(res, { error: "no session" }, 404); try { s.proc.stdin.write(b.data); } catch {} return json(res, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/term/interrupt") { const b = await body(req); interruptShell(b.id); return json(res, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/term/kill") { const b = await body(req); const s = shells.get(b.id); if (s) { try { exec(`taskkill /pid ${s.proc.pid} /T /F`, { windowsHide: true }, () => {}); } catch {} shells.delete(b.id); } return json(res, { ok: true }); }
    if (req.method === "GET" && u.pathname === "/api/term/tail") { const s = shells.get(u.searchParams.get("id")); return json(res, s ? { tail: s.tail.buf } : { error: "no session" }, s ? 200 : 404); }
    if (req.method === "GET" && u.pathname === "/api/shot") {
      const ws = u.searchParams.get("ws"), p = u.searchParams.get("p");
      if (!ws || !p || !/\.png$/i.test(p)) return json(res, { error: "ws and p (.png) required" }, 400);
      try { const data = await fsp.readFile(safe(ws, p)); res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" }); return res.end(data); }
      catch { res.writeHead(404); return res.end("not found"); }
    }
    // publish_artifact's serving side (2026-07-22): resolves slug -> source file via the
    // workspace's .eta/artifacts.json (written by the tool in agent.mjs), re-reads the file FRESH
    // on every request (so an edit + re-publish is visible without restarting anything), and wraps
    // .md files in a minimal readable page since raw markdown text isn't a page on its own.
    if (req.method === "GET" && u.pathname.startsWith("/artifacts/")) {
      const ws = u.searchParams.get("ws");
      const slug = decodeURIComponent(u.pathname.slice("/artifacts/".length));
      if (!ws || !slug) { res.writeHead(400, { "content-type": "text/plain" }); return res.end("ws and a slug are required"); }
      let reg; try { reg = JSON.parse(await fsp.readFile(path.join(ws, ".eta", "artifacts.json"), "utf8")); } catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("no artifacts published in this workspace"); }
      const entry = reg[slug];
      if (!entry) { res.writeHead(404, { "content-type": "text/plain" }); return res.end(`no artifact named "${slug}"`); }
      let content; try { content = await fsp.readFile(safe(ws, entry.path), "utf8"); }
      catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("the published source file is missing"); }
      const html = /\.md$/i.test(entry.path) ? mdArtifactPage(content, entry.title) : content;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "POST" && u.pathname === "/api/chat") { const b = await body(req); if (!b.message) return json(res, { error: "message required" }, 400); doChat(b.message, b.ctxFile, b.ws, b.image); return json(res, { ok: true }); }
    if (req.method === "GET" && u.pathname === "/api/skills") {
      const ws = u.searchParams.get("ws");
      const skills = await loadSkills(ws || null);
      return json(res, { skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.scope === "bundled" ? "bundled" : "workspace" })) });
    }
    // Customizations: project rules (.eta/rules.md) and MCP servers (.eta/mcp.json), per project.
    // Skills, agents and tools the user adds: list / create / delete / import (preview, then add).
    if (u.pathname.startsWith("/api/custom")) {
      try {
        if (req.method === "GET" && u.pathname === "/api/custom") return json(res, await listCustom(u.searchParams.get("ws") || null));
        if (req.method === "GET" && u.pathname === "/api/custom/catalog") return json(res, { tools: await listCatalog(u.searchParams.get("ws") || null) });
        const b = await body(req);
        if (u.pathname === "/api/custom/catalog/add") return json(res, await addCatalogTool(b));
        if (u.pathname === "/api/custom/create") return json(res, await createItem(b));
        if (u.pathname === "/api/custom/delete") return json(res, await deleteItem(b));
        if (u.pathname === "/api/custom/preview") return json(res, await previewImport(b));
        if (u.pathname === "/api/custom/test") return json(res, await testItem(b));
        if (u.pathname === "/api/custom/read") return json(res, await readItem(b));
        if (u.pathname === "/api/custom/write") return json(res, await writeItem(b));
        if (u.pathname === "/api/custom/commit") return json(res, await commitImport(b));
      } catch (e) { return json(res, { error: String(e.message || e) }, 400); }
    }
    if (req.method === "GET" && u.pathname === "/api/rules") {
      const ws = u.searchParams.get("ws"); if (!ws) return json(res, { error: "ws required" }, 400);
      return json(res, { text: await loadRules(ws, 20000) });
    }
    if (req.method === "POST" && u.pathname === "/api/rules") {
      const b = await body(req); if (!b.ws || typeof b.text !== "string") return json(res, { error: "ws and text required" }, 400);
      await fsp.mkdir(path.join(b.ws, ".eta"), { recursive: true });
      await fsp.writeFile(path.join(b.ws, ".eta", "rules.md"), b.text, "utf8");
      return json(res, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/mcp") {
      const ws = u.searchParams.get("ws"); if (!ws) return json(res, { servers: [] });
      const cfg = await loadMcpConfig(ws);
      return json(res, { servers: Object.entries(cfg).map(([name, c]) => ({ name, command: [c.command, ...(c.args || [])].filter(Boolean).join(" ") })) });
    }
    if (req.method === "POST" && u.pathname === "/api/open-ide") {
      const b = await body(req);
      const cands = [process.env.ETA_IDE_EXE, path.join(os.homedir(), "AppData", "Local", "Programs", "Eta IDE", "Eta IDE.exe"),
        path.resolve(ENGINE_DIR_SELF, "..", "dist", "Eta-IDE", "Eta IDE.exe")].filter(Boolean); // dev layout: <release>/console + <release>/dist (no personal paths)
      let exe = null; for (const c of cands) { try { await fsp.access(c); exe = c; break; } catch {} }
      if (!exe) return json(res, { ok: false, error: "Eta IDE.exe not found. Set ETA_IDE_EXE to its path." });
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = cpSpawn(exe, b.ws ? [b.ws] : [], { detached: true, stdio: "ignore", env }); child.unref();
      return json(res, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/workflows") {
      const ws = u.searchParams.get("ws");
      const list = ws ? await loadWorkflows(ws) : [];
      return json(res, { workflows: list.map((w) => ({ name: w.name, description: w.description })) });
    }
    if (req.method === "POST" && u.pathname === "/api/message") {
      const b = await body(req); if (!b.message) return json(res, { error: "message required" }, 400);
      // Workflow invocation: "/name [extra]" runs a saved .eta/workflows/<name>.md
      // recipe as an agent task, with any trailing text appended as user context.
      const wf = b.ws && b.message.match(/^\/([a-z0-9][\w-]*)\s*([\s\S]*)$/i);
      if (wf) {
        const found = (await loadWorkflows(b.ws)).find((w) => w.name.toLowerCase() === wf[1].toLowerCase());
        if (found) {
          const task = found.body + (wf[2].trim() ? `\n\nAdditional context from the user: ${wf[2].trim()}` : "");
          return json(res, { kind: "task", runId: spawn({ task, workspace: b.ws, autoApprove: b.autoApprove ?? true }), workflow: found.name });
        }
        // Not a workflow name — try a skill instead: "/skill-name <task>" FORCES that skill into
        // the run regardless of keyword match (skills are normally 100% automatic/invisible).
        const skillHit = (await loadSkills(b.ws)).find((s) => s.name.toLowerCase() === wf[1].toLowerCase());
        if (skillHit) {
          const task = wf[2].trim();
          if (!task) return json(res, { kind: "chat", hint: "skill_needs_task", skill: skillHit.name }); // named a skill but no task yet
          return json(res, { kind: "task", runId: spawn({ task, workspace: b.ws, autoApprove: b.autoApprove ?? true, forceSkill: skillHit.name }), skill: skillHit.name });
        }
      }
      // "@agent-name <task>": run the task as that agent (its instructions become the role).
      const at = b.ws !== undefined && b.message.match(/^@([a-z0-9][\w-]*)\s*([\s\S]*)$/i);
      if (at) {
        const ag = (await loadAgents(b.ws || null)).find((a) => a.name === at[1].toLowerCase());
        if (ag) {
          const task = at[2].trim();
          if (!task) return json(res, { kind: "chat", hint: "agent_needs_task", agent: ag.name });
          if (!b.ws) return json(res, { kind: "chat", hint: "open_folder" });
          return json(res, { kind: "task", runId: spawn({ task, workspace: b.ws, autoApprove: b.autoApprove ?? true, persona: { name: ag.name, body: ag.body } }), agent: ag.name });
        }
      }
      const kind = b.image ? "chat" : classify(b.message, b.ws); // image questions always go to chat
      if (kind === "task") { const runId = spawn({ task: b.message, workspace: b.ws, autoApprove: b.autoApprove ?? true }); return json(res, { kind: "task", runId }); }
      doChat(b.message, b.ctxFile, b.ws, b.image);
      const wantsBuild = !b.ws && /\b(build|create|make|add|fix|implement|write)\b/i.test(b.message);
      return json(res, { kind: "chat", hint: wantsBuild ? "open_folder" : undefined });
    }
    if (req.method === "POST" && u.pathname === "/api/spawn") { const b = await body(req); if (!b.task || !b.workspace) return json(res, { error: "task and workspace required" }, 400); return json(res, { runId: spawn(b) }); }
    if (req.method === "POST" && u.pathname === "/api/spawn-many") {
      const b = await body(req);
      if (!b.workspace || !Array.isArray(b.tasks) || !b.tasks.length) return json(res, { error: "workspace and tasks[] required" }, 400);
      // hardware-scaled parallelism: don't run more agents at once than the machine can sustain.
      const cap = Math.max(1, (await hwProfile())?.maxParallel || 3);
      const ids = b.tasks.filter((t) => t && t.trim()).slice(0, cap).map((task) => spawn({ task: task.trim(), workspace: b.workspace, autoApprove: b.autoApprove ?? true, isolate: true }));
      return json(res, { runIds: ids });
    }
    if (req.method === "POST" && u.pathname === "/api/merge") {
      const b = await body(req); const r = runs.get(b.runId);
      if (!r?.branch) return json(res, { error: "not an isolated run" }, 400);
      const m = await mergeWorktree(r, b.strategy);
      broadcast({ type: "run", run: meta(r) });
      broadcast({ type: "merge", runId: r.id, ok: m.ok, conflict: m.conflict, files: m.files });
      scheduleSave();
      return json(res, m);
    }
    if (req.method === "POST" && u.pathname === "/api/discard") {
      const b = await body(req); const r = runs.get(b.runId);
      if (!r?.branch) return json(res, { error: "not an isolated run" }, 400);
      await discardWorktree(r);
      broadcast({ type: "run", run: meta(r) });
      broadcast({ type: "discard", runId: r.id });
      scheduleSave();
      return json(res, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/approve") { const b = await body(req); pending.get(b.id)?.(!!b.ok); pending.delete(b.id); return json(res, { ok: true }); }
    // Topic 3 — the user's plan decision (approve / edit / reject) resolves the plan gate.
    if (req.method === "POST" && u.pathname === "/api/plan-decision") { const b = await body(req); pending.get(b.id)?.({ action: b.action || "approve", note: b.note || "" }); pending.delete(b.id); return json(res, { ok: true }); }
    // ask_user tool — the user's picked option resolves the clarifying-question gate.
    if (req.method === "POST" && u.pathname === "/api/ask-user-answer") { const b = await body(req); pending.get(b.id)?.(b.answer || null); pending.delete(b.id); return json(res, { ok: true }); }
    // Topic 3 — mid-run steering: hand a note to the running agent (applied between steps).
    if (req.method === "POST" && u.pathname === "/api/steer") { const b = await body(req); const a = runs.get(b.runId)?.agent; if (!a) return json(res, { error: "no such run" }, 404); a.steer(b.message || ""); return json(res, { ok: true }); }
    // Topic 3 — read/set the plan-gate toggle (off by default).
    if (req.method === "GET" && u.pathname === "/api/plan-mode") { return json(res, { planApproval: planApprovalMode }); }
    if (req.method === "POST" && u.pathname === "/api/plan-mode") { const b = await body(req); planApprovalMode = !!b.planApproval; return json(res, { ok: true, planApproval: planApprovalMode }); }
    if (req.method === "POST" && u.pathname === "/api/cancel") { const b = await body(req); runs.get(b.runId)?.agent?.cancel(); return json(res, { ok: true }); }
    if (req.method === "POST" && u.pathname === "/api/revert") {
      const b = await body(req); const r = runs.get(b.runId);
      if (!r?.snapshot) return json(res, { error: "no snapshot for this run" }, 400);
      const a = await revertRun(r);
      broadcast({ type: "reverted", runId: r.id, ok: a.ok });
      return json(res, a);
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { try { json(res, { error: String(e?.message || e) }, 500); } catch {} }
});
// Kill the bundled llama-server child when the IDE exits (no orphaned model in RAM).
for (const sig of ["SIGINT", "SIGTERM", "exit"]) process.on(sig, () => { try { stopMoeTurbo(); host.shutdown(); } catch {} if (sig !== "exit") process.exit(0); });

server.listen(PORT, "127.0.0.1", () => console.log(`\n  Eta IDE -> http://127.0.0.1:${PORT}\n`)); // this PC only, never the network
// update check: newest public release on GitHub; the panel shows a notice with a link (see update.mjs)
let updateInfo = null;
import("./update.mjs").then(({ startUpdateChecks }) => startUpdateChecks({
  current: JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version,
  enabled: async () => { try { return JSON.parse(await fsp.readFile(CFG_PATH, "utf8")).updateCheck !== false; } catch { return true; } },
  onResult: (r) => { updateInfo = r; if (r.available) broadcast({ type: "update", ...r }); },
})).catch(() => {});
// servers and watchers a crashed or hard-killed engine left running are stopped (only those of engines that are gone)
import("./terminal.mjs").then((t) => t.cleanupLeftovers()).then((n) => { if (n) console.log(`  stopped ${n} program(s) an earlier Eta left running`); }).catch(() => {});
