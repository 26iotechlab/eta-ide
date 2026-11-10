// End-to-end (slow, needs the 35B file): the IDE engine links the GGUF, starts Colibri through the Host, measures speed, then fixes a 3-bug task.
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
  const ws = "D:/tmp/e2e-proj"; fs.rmSync(ws, { recursive: true, force: true }); fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "calc.py"), `def average(nums):\n    if not nums:\n        return 0\n    return sum(nums) / (len(nums) + 1)\n\ndef is_even(n):\n    return n % 2 == 1\n\ndef clamp(x, lo, hi):\n    return max(hi, min(x, lo))\n`);
  fs.writeFileSync(path.join(ws, "test_calc.py"), `from calc import average, is_even, clamp\nassert average([2, 4, 6]) == 4, 'average'\nassert average([]) == 0, 'average empty'\nassert is_even(4) and not is_even(7), 'is_even'\nassert clamp(15, 0, 10) == 10 and clamp(-3, 0, 10) == 0 and clamp(5, 0, 10) == 5, 'clamp'\nprint('ALL OK')\n`);
  const cap = captureEvents(BASE); await sleep(500);
  const r = await post("/api/message", { message: "Run python test_calc.py. The tests fail. Find and fix the bugs in calc.py.", ws, autoApprove: true });
  const t1 = Date.now(); let status = "?";
  for (let i = 0; i < 360; i++) { await sleep(3000); const s = await (await fetch(BASE + "/api/run?id=" + r.runId)).json(); status = s.status; if (status !== "running") break; }
  cap.stop(); console.log(cap.lines.filter((l) => !/^(snapshot|start|run):/.test(l)).slice(0, 45).join("\n"));
  const fixed = spawnSync("python", ["test_calc.py"], { cwd: ws, encoding: "utf8" }).stdout.includes("ALL OK");
  console.log("agent task:", status, "| fixed:", fixed, "|", Math.round((Date.now() - t1) / 1000) + " s");
}
eng.kill(); spawnSync("taskkill", ["/F", "/T", "/PID", String(eng.pid)], { stdio: "ignore" });
spawnSync("taskkill", ["/F", "/IM", "qwen36.exe"], { stdio: "ignore" });
console.log("DONE"); process.exit(0);
