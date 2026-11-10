// End-to-end (slow, needs the 35B file): questions through the real IDE chat (/api/message -> chat) with the honesty rules and product facts.
import fs from "fs"; import path from "path"; import { spawn, spawnSync } from "child_process";
const GGUF = process.argv[2] || "D:/tmp/models-35b/Qwen3.8-35B-A3B-IQ3_M.gguf";
const PORT = 8797, BASE = "http://127.0.0.1:" + PORT, home = fs.mkdtempSync("D:/tmp/e2e-home-"), MD = "D:/tmp/e2e-models";
fs.rmSync(MD, { recursive: true, force: true }); fs.mkdirSync(path.join(MD, "moe35"), { recursive: true });
fs.linkSync(GGUF, path.join(MD, "moe35", path.basename(GGUF)));
fs.writeFileSync(path.join(MD, "moe35", "manifest.json"), JSON.stringify({ files: [{ name: path.basename(GGUF), size: fs.statSync(GGUF).size }] }));
const eng = spawn(process.execPath, ["server.mjs"], { cwd: "D:/eta-ide-release/console", env: { ...process.env, PORT: String(PORT), USERPROFILE: home, HOME: home, ETA_MODELS_DIR: MD }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {} await sleep(1000); }
const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json();
await post("/api/host/use", { id: "moe35" }); let st;
for (let i = 0; i < 200; i++) { await sleep(3000); st = (await (await fetch(BASE + "/api/host")).json()).state; if (st.status === "ready" && st.tokPerSec) break; if (st.status === "error") break; }
console.log("host:", st.status, st.tokPerSec, "words/s");
const ws = "D:/tmp/chat-proj"; fs.mkdirSync(ws, { recursive: true });
const qs = ["How do I use Array.prototype.last() in JavaScript?", "How do I change the colour theme in Eta IDE?", "What does the Python function itertools.chunked() do?"];
for (const q of qs) {
  const ctl = new AbortController(); let text = "";
  const done = new Promise((resolve) => { fetch(BASE + "/events", { signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = ev.match(/data: (.*)/); if (m) try { const j = JSON.parse(m[1]); if (j.type === "chatEnd") { text = j.text; resolve(); } } catch {} } } }).catch(() => resolve()); });
  await sleep(300); const r = await post("/api/message", { message: q, ws });
  if (r.kind === "task") { console.log(`Q: ${q}\n  routed to a TASK (not chat)`); ctl.abort(); continue; }
  await Promise.race([done, sleep(240000)]); ctl.abort();
  console.log(`Q: ${q}\nA: ${text.replace(/\s+/g, " ").slice(0, 420)}\n`);
}
eng.kill(); spawnSync("taskkill", ["/F", "/T", "/PID", String(eng.pid)], { stdio: "ignore" }); spawnSync("taskkill", ["/F", "/IM", "qwen36.exe"], { stdio: "ignore" });
process.exit(0);
