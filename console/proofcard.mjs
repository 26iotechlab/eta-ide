// Proof card (2026-11-13): a short, honest summary shown in the panel when a run ends.
// buildProofCard(runInfo) is pure: it reads only what the run recorded (its events, its changed files,
// the model servers it used) and never runs anything. The server gathers runInfo (see /api/proof).
//   runInfo = { id, status, events, files, changes, bases, cloudBase, canUndo, isolated }
//   changes = [{ file, status: "added"|"modified"|"deleted", added, removed, counted }] or null (no line counts)
import * as fs from "fs"; import * as fsp from "fs/promises"; import * as path from "path";
import { isLocalBase, envMissing } from "./agent.mjs";
import { runChanges } from "./review.mjs";
import { readSnapshotFile } from "./snapshot.mjs";

const cmdKey = (c) => String(c || "").replace(/\s+/g, " ").replace(/\.[\\/]/g, "").trim(); // same as agent.mjs
// a shell command that runs a test suite
const TEST_CMD = /\b(pytest|unittest|(npm|pnpm|yarn)( run)? test|jest|vitest|mocha|go test|cargo test|dotnet test|mvn test|gradle test|phpunit|rspec)\b|\bnode\s+\S*test\S*\.m?js\b/i;
// a shell command that may send or fetch data over the internet
const NET_CMD = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|ssh|ftp|git\s+(push|pull|fetch|clone)|npm\s+(install|i|publish|add)|pnpm\s+(install|add)|yarn\s+add|npx|pip3?\s+install|conda\s+install|winget|choco)\b/i;
const WEB_TOOLS = { web_search: "web search was used", deep_research: "deep research read web pages", visual_search: "visual search opened web pages" };
const URL_TOOLS = { open_url: "url", http_request: "url", screenshot: "target", check_page: "path" };
const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : "https://" + u).host || String(u); } catch { return String(u).slice(0, 60); } };
const isWebUrl = (u) => /^https?:\/\//i.test(String(u || "").trim()) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(String(u || "").trim());

function testRecord(events) {
  const runs = []; let lastTool = null;
  for (const e of events) {
    if (e.type === "tool") { lastTool = e; continue; }
    if (e.type === "toolResult" && lastTool && lastTool.name === e.name) {
      const cmd = e.name === "run_tests" ? String(lastTool.args?.command || "run_tests") : e.name === "run_command" ? String(lastTool.args?.command || "") : null;
      lastTool = null;
      if (cmd === null || (e.name === "run_command" && !TEST_CMD.test(cmd))) continue;
      const out = String(e.result || "");
      if (/^(VETOED|BLOCKED|User rejected)/.test(out)) continue; // it never ran
      runs.push({ cmd, ok: envMissing(out) ? null : !/COMMAND FAILED/.test(out), by: "agent" });
      continue;
    }
    if (e.type === "log") {
      const m = /^test gate: (.+) → (PASS|FAIL)$/.exec(String(e.text || ""));
      if (m) runs.push({ cmd: m[1], ok: m[2] === "PASS", by: "test check" });
      continue;
    }
    if (e.type === "regression") runs.push({ cmd: (/'([^']+)'/.exec(String(e.text || "")) || [])[1] || "project tests", ok: false, by: "check after the run" });
  }
  return runs;
}

export function buildProofCard(info = {}) {
  const events = Array.isArray(info.events) ? info.events : [];
  const done = events.filter((e) => e.type === "done").slice(-1)[0];

  // (1) tests: only what the run recorded
  const runs = testRecord(events);
  const known = new Set(runs.map((r) => cmdKey(r.cmd)));
  const stillFailing = ((done && done.warnings) || []).map((w) => (/^command still failing: (.+)$/.exec(String(w)) || [])[1]).filter((c) => c && (known.has(cmdKey(c)) || TEST_CMD.test(c)));
  const last = runs[runs.length - 1];
  let tests;
  if (!runs.length && !stillFailing.length) tests = { status: "none", text: "No tests were run.", runs };
  else if (stillFailing.length || runs.some((r) => r.by === "check after the run") || (last && last.ok === false)) {
    const cmd = stillFailing[0] || (runs.filter((r) => r.ok === false).slice(-1)[0] || {}).cmd || "";
    tests = { status: "failed", text: "Tests failed" + (cmd ? ": " + cmd : "") + ".", runs };
  } else if (last && last.ok === true) tests = { status: "passed", text: "Tests passed" + (runs.length > 1 ? ` (${runs.length} test runs, last: ${last.cmd})` : ": " + last.cmd) + ".", runs };
  else tests = { status: "not-run", text: "Tests could not run: the test program is missing on this PC" + (last ? " (" + last.cmd + ")" : "") + ".", runs };

  // (2) files changed: the run's undo point compared with the files now
  let list;
  if (Array.isArray(info.changes)) list = info.changes.map((c) => ({ file: c.file, status: c.status || "modified", added: c.added || 0, removed: c.removed || 0, counted: c.counted !== false }));
  else list = (info.files || []).map((f) => ({ file: f, status: "changed", added: 0, removed: 0, counted: false }));
  const add = list.reduce((s, f) => s + f.added, 0), rem = list.reduce((s, f) => s + f.removed, 0);
  const files = { list, added: add, removed: rem,
    text: !list.length ? "No files changed." : `${list.length} file${list.length > 1 ? "s" : ""} changed` + (list.some((f) => f.counted) ? ` (+${add} −${rem} lines)` : "") + "." };

  // (3) undo: the existing whole-run revert and go-back-to-a-step buttons
  const undo = info.isolated ? { available: false, text: "This run worked on its own branch. Use Discard to drop it." }
    : info.canUndo ? { available: true, text: "One click restores the files as they were before this run." }
    : { available: false, text: "This run has no undo point." };

  // (4) did anything leave this PC?
  const left = [];
  const bases = [...new Set((info.bases || []).filter(Boolean).map(String))];
  if (info.cloudBase && events.some((e) => e.type === "agent" && e.role === "cloud-fallback")) bases.push(String(info.cloudBase));
  for (const b of bases) if (!isLocalBase(b)) left.push(`a model outside this PC was used (${hostOf(b)})`);
  for (const e of events) {
    if (e.type !== "tool") continue;
    const a = e.args || {};
    if (WEB_TOOLS[e.name]) left.push(WEB_TOOLS[e.name]);
    else if (URL_TOOLS[e.name]) {
      const u = String(a[URL_TOOLS[e.name]] || "");
      const web = e.name === "open_url" || e.name === "http_request" ? u && isWebUrl(u) : /^https?:\/\//i.test(u);
      if (web && !isLocalBase(/^[a-z]+:\/\//i.test(u) ? u : "http://" + u)) left.push(`a web page was opened (${hostOf(u)})`);
    }
    else if (/^mcp__/.test(e.name)) left.push(`an outside tool was used (${e.name.split("__")[1] || e.name}); Eta cannot check where it sends data`);
    else if ((e.name === "run_command" || e.name === "start_process") && NET_CMD.test(String(a.command || ""))) left.push(`a command that can use the internet was run (${String(a.command).slice(0, 60)})`);
    else if (e.name === "git" && /^(git\s+)?(push|pull|fetch|clone)\b/i.test(String(a.command || "").trim())) left.push(`git talked to another computer (${String(a.command).slice(0, 60)})`);
  }
  const uniq = [...new Set(left)];
  const privacy = !bases.length && !uniq.length
    ? { local: null, left: [], text: "Not known: this run did not record which model server it used." }
    : uniq.length ? { local: false, left: uniq, text: "Something left this PC: " + uniq.join("; ") + "." }
    : { local: true, left: [], text: "Nothing left this PC." };

  return { runId: info.id ?? null, status: info.status || null, tests, files, undo, privacy };
}

// proofCard(run): gather what a server run recorded, then build the card (used by GET /api/proof). Line counts come
// from the same snapshot-vs-now compare as "Review changes" (review.mjs); files the run deleted are added here.
const lineCount = (b) => { const t = b.toString("utf8"); return b.subarray(0, 8000).includes(0) || !t ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0); };
export async function proofCard(r) {
  let changes = null;
  const ch = r.wtPath ? { ok: false } : await runChanges(r);
  if (ch.ok) {
    changes = [];
    for (const f of ch.files) {
      let added = 0, removed = 0;
      for (const h of f.hunks || []) { added += h.addedTotal || 0; removed += h.removedTotal || 0; }
      const counted = !!(f.hunks || []).length || f.status === "added";
      if (f.status === "added") { try { added = lineCount(await fsp.readFile(path.join(r.workspace, f.file))); } catch {} }
      changes.push({ file: f.file, status: f.status, added, removed, counted });
    }
    const k = (p) => String(p).replace(/\\/g, "/").replace(/^(\.\/)+/, "").toLowerCase();
    const seen = new Set(changes.map((c) => k(c.file)));
    for (const f of r.files || []) {
      const rel = String(f).replace(/\\/g, "/").replace(/^(\.\/)+/, "");
      if (!rel || seen.has(k(rel)) || rel.split("/").includes("..") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || fs.existsSync(path.join(r.workspace, rel))) continue;
      let old; try { old = await readSnapshotFile(r, rel, { raw: true }); } catch { continue; }
      if (Buffer.isBuffer(old)) { seen.add(k(rel)); changes.push({ file: rel, status: "deleted", added: 0, removed: lineCount(old), counted: true }); }
    }
  }
  const bases = [...(r.bases || []), r.agent?._helperBase].filter(Boolean);
  return buildProofCard({ id: r.id, status: r.status, events: r.events || [], files: [...(r.files || [])], changes, bases, cloudBase: r.cloudBase || null, canUndo: !!r.snapshot && !r.wtPath, isolated: !!(r.wtPath || r.isolated) });
}
