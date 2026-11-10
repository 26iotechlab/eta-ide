// End-to-end (slow, needs the 35B file): a beginner asks for a website and how to use Eta IDE. Check by hand: CHANGE ME marks, no fixed year, true Eta facts.
// Uses port 8722 (the model host port): do not run test-host.mjs at the same time.
import fs from "fs"; import path from "path"; import { spawn, spawnSync } from "child_process";
import { captureEvents } from "./test-sse.mjs";
const GGUF = process.argv[2] || "D:/tmp/models-35b/Qwen3.8-35B-A3B-IQ3_M.gguf";
const PORT = 8796, BASE = "http://127.0.0.1:" + PORT, home = fs.mkdtempSync("D:/tmp/e2e-home-"), MD = "D:/tmp/e2e-models";
fs.rmSync(MD, { recursive: true, force: true }); fs.mkdirSync(path.join(MD, "moe35"), { recursive: true });
fs.linkSync(GGUF, path.join(MD, "moe35", path.basename(GGUF)));
fs.writeFileSync(path.join(MD, "moe35", "manifest.json"), JSON.stringify({ files: [{ name: path.basename(GGUF), size: fs.statSync(GGUF).size }] }));
const eng = spawn(process.execPath, ["server.mjs"], { cwd: "D:/eta-ide-release/console", env: { ...process.env, PORT: String(PORT), USERPROFILE: home, HOME: home, ETA_MODELS_DIR: MD }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {} await sleep(1000); }
const post = async (p, b) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json();
const hwr = await (await fetch(BASE + "/api/hardware")).json(); console.log("recommendation on this PC:", hwr.recommendation ? hwr.recommendation.model : "none");
await post("/api/host/use", { id: "moe35" }); const t0 = Date.now(); let st;
for (let i = 0; i < 200; i++) { await sleep(3000); st = (await (await fetch(BASE + "/api/host")).json()).state; if (st.status === "ready" && st.tokPerSec) break; if (st.status === "error") break; }
console.log("host:", st.status, "| speed", st.tokPerSec, "words/s |", st.verdict, "|", st.message, "|", st.error || "", "|", Math.round((Date.now() - t0) / 1000) + " s");
if (st.status === "ready") {
  const ws = "D:/tmp/student-proj"; fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true });
  const cap = captureEvents(BASE); await sleep(500);
  const r = await post("/api/message", { message: "I am a student. I want to create a website for myself, but I do not know HTML or any coding. Can you make it for me, and tell me how to use Eta IDE?", ws, autoApprove: true });
  const t1 = Date.now(); let status = "?";
  for (let i = 0; i < 600; i++) { await sleep(3000); const s = await (await fetch(BASE + "/api/run?id=" + r.runId)).json(); status = s.status; if (status !== "running") break; }
  cap.stop(); console.log(cap.lines.filter((l) => !/^(snapshot|start|run):/.test(l)).slice(0, 80).join("\n"));
    console.log("files:", fs.readdirSync(ws, { recursive: true }).join(", ")); console.log("agent task:", status, "|", Math.round((Date.now() - t1) / 1000) + " s");
}
eng.kill(); spawnSync("taskkill", ["/F", "/T", "/PID", String(eng.pid)], { stdio: "ignore" });
spawnSync("taskkill", ["/F", "/IM", "qwen36.exe"], { stdio: "ignore" });
console.log("DONE"); process.exit(0);



