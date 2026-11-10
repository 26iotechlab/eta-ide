// Tests for host.mjs: download with progress/pause/resume, crash restart, idle sleep + wake,
// speed verdict + smaller suggestion. Uses a fake Hugging Face and a fake llama-server (no internet, no GPU).
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-host-"));
process.env.ETA_MODELS_DIR = path.join(tmp, "models");
const FILE = Buffer.alloc(3_000_000, 7); // the fake model file
let slow = false;
const hf = http.createServer((req, res) => {
  if (req.url.startsWith("/api/models/")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ siblings: [
      { rfilename: "tiny-q4_k_m.gguf", size: FILE.length }, { rfilename: "tiny-q4_k_m-00001-of-00002.gguf", size: 10 }, { rfilename: "tiny-Q8_0.gguf", size: 99 }, { rfilename: "README.md", size: 5 },
    ] }));
  }
  const m = /range:\s*bytes=(\d+)-/i.exec(Object.entries(req.headers).map(([k, v]) => k + ": " + v).join("\n"));
  const from = m ? +m[1] : 0; const body = FILE.subarray(from);
  res.writeHead(m ? 206 : 200, { "content-length": body.length, "content-type": "application/octet-stream" });
  if (!slow) return res.end(body);
  let i = 0; const t = setInterval(() => { if (i >= body.length || res.destroyed) { clearInterval(t); return res.end(); } res.write(body.subarray(i, i + 200_000)); i += 200_000; }, 60);
  res.on("close", () => clearInterval(t));
});
await new Promise((r) => hf.listen(0, r));
process.env.ETA_HF_BASE = "http://127.0.0.1:" + hf.address().port;

// fake llama-server: /health + /completion; speed from env FAKE_TOKS
const fake = path.join(tmp, "fake-llama.mjs");
fs.writeFileSync(fake, `import http from "http"; const a=process.argv; const port=+a[a.indexOf("--port")+1];
http.createServer((q,r)=>{ if(q.url==="/health"){r.end("{}");return;} if(q.url==="/completion"){let b="";q.on("data",c=>b+=c);q.on("end",()=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({content:"ok",timings:{predicted_per_second:+process.env.FAKE_TOKS,prompt_per_second:50,prompt_ms:100,predicted_n:64}}));});return;} r.end("{}"); }).listen(port,"127.0.0.1");`);

const { Host, pickFiles, fitFor, recommendFor, CATALOG } = await import("./host.mjs");
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name); } };
const wait = async (f, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

console.log("== file picking ==");
ok(pickFiles([{ rfilename: "a-Q4_K_M.gguf", size: 1 }, { rfilename: "a-Q4_K_M-00001-of-00002.gguf", size: 1 }, { rfilename: "a-Q4_K_S.gguf", size: 1 }], "Q4_K_M").length === 1, "single file preferred over shards");
ok(pickFiles([{ rfilename: "a-Q6_K_L-00001-of-00002.gguf", size: 1 }, { rfilename: "a-Q6_K_L-00002-of-00002.gguf", size: 1 }, { rfilename: "a-Q6_K.gguf", size: 1 }], "Q6_K_L").length === 2, "shards kept together");
ok(pickFiles([{ rfilename: "a-Q4_K_M.gguf", size: 1 }], "Q4_K").length === 0, "Q4_K does not match Q4_K_M");
console.log("== fit ==");
ok(fitFor({ gpu: { vendor: "nvidia", vramGB: 12 }, ramGB: 16 }, { sizeGB: 4.7 }).level === "fast", "4.7 GB fits a 12 GB card");
ok(fitFor({ ramGB: 8 }, { sizeGB: 48 }).level === "no", "48 GB too big for 8 GB PC");

console.log("== recommendation ==");
ok(recommendFor({ gpu: { vendor: "nvidia", vramGB: 12 }, ramGB: 9 }).id === "q27", "12 GB card + 9 GB memory gets Qwen3.8 27B (3-bit), not the 80B");
ok(recommendFor({ gpu: { vendor: "nvidia", vramGB: 24 }, ramGB: 32 }).id === "q27hi", "24 GB card gets the higher quality 27B file");
ok(recommendFor({ ramGB: 16, diskFreeGB: 200 }).id === "moe35", "no graphics card, 16 GB memory: the 35B streaming model (Colibri), not a small one");
ok(recommendFor({ ramGB: 8, diskFreeGB: 200 }).id === "moe35", "8 GB memory, no card: the 35B streaming model on the processor");
ok(fitFor({ ramGB: 8, diskFreeGB: 200 }, CATALOG.find((m) => m.id === "moe35")).level === "ok", "processor-only is called ok (slow), not fast");
ok(recommendFor({ gpu: { vendor: "nvidia", vramGB: 8 }, ramGB: 16, diskFreeGB: 200 }).id === "moe35", "8 GB card: the streaming model through the card (fast)");
ok(recommendFor({ ramGB: 8, diskFreeGB: 10 }) === null, "not enough free disk for the 35B file: nothing offered");
ok(recommendFor({ ramGB: 4, diskFreeGB: 200 }) === null, "4 GB memory: null (Colibri needs at least 6 GB)");
ok(["tiny", "small", "code7", "code14", "floor"].every((id) => !CATALOG.some((m) => m.id === id)), "the list has no 3B, 4B, 7B, 14B or slow 16B model");
ok(CATALOG.every((m) => m.totalB >= 20), "every listed model has 20B or more parameters");
const states = [];
const host = new Host({ stateFile: path.join(tmp, "host.json"), getHw: async () => ({ ramGB: 32, cpus: 8, gpu: { vendor: "nvidia", vramGB: 12, name: "Test GPU" } }), isBusy: () => false, onState: (s) => states.push(s) });
host.exe = { cmd: process.execPath, pre: [fake] };
host.catalogCache = null;
const model = { id: "t1", label: "Tiny Test", repo: "x/tiny-GGUF", quant: "Q4_K_M", sizeGB: 0.003, totalB: 1, activeB: 1 };
await host.init();
host.s.customs.push(model);

console.log("== download: progress, pause, resume ==");
slow = true;
const p1 = host.use("t1").catch((e) => e);
ok(await wait(() => host.s.status === "downloading" && host.s.percent > 0 && host.s.percent < 99), "progress percent shown while downloading");
host.pause(); const r1 = await p1;
ok(r1 && r1.paused && host.s.status === "paused", "pause keeps a partial file");
const part = fs.readdirSync(path.join(process.env.ETA_MODELS_DIR, "t1")).find((f) => f.endsWith(".part"));
const partSize = part ? fs.statSync(path.join(process.env.ETA_MODELS_DIR, "t1", part)).size : 0;
ok(partSize > 0 && partSize < FILE.length, "partial file is on disk (" + partSize + " bytes)");
slow = false; process.env.FAKE_TOKS = "20";
await host.use("t1");
ok(fs.statSync(path.join(process.env.ETA_MODELS_DIR, "t1", "tiny-q4_k_m.gguf")).size === FILE.length, "resume finished the full file");
ok(host.s.status === "ready", "model is ready after download");
ok(await wait(() => host.s.tokPerSec === 20), "speed test recorded 20 tok/s");
ok(host.s.verdict === "good", "verdict is good");

console.log("== B: crash restart ==");
const pid1 = host.handle.proc.pid; host.handle.proc.kill();
ok(await wait(() => host.s.restarts === 1 && host.s.status === "ready" && host.handle && host.handle.proc.pid !== pid1, 20000), "restarted by itself after a crash");

console.log("== E: idle sleep and wake ==");
host.s.idleMin = 1; host.lastUsed = Date.now() - 5 * 60000;
ok(await wait(() => host.s.status === "sleeping", 10000), "went to sleep when idle");
ok(!host.handle, "memory freed (no process)");
await host.wake();
ok(host.s.status === "ready" && host.handle, "woke up on demand");

console.log("== C: slow model gets a smaller suggestion ==");
host.s.customs.push({ id: "t0", label: "Smaller Test", repo: "x/small", quant: "Q4_K_M", sizeGB: 0.001, totalB: 1, activeB: 1 });
host._kill("stop"); process.env.FAKE_TOKS = "2"; delete host.speed.t1;
await host.wake(true);
ok(await wait(() => host.s.verdict === "tooslow"), "2 tok/s is called too slow");
ok(host.s.suggest && host.s.suggest.id === "t0", "suggests the next smaller model that fits");

console.log("== stop / remove ==");
host.stop(); ok(host.s.status === "stopped" && !host.handle, "stop works");
await host.remove("t1"); ok(!fs.existsSync(path.join(process.env.ETA_MODELS_DIR, "t1")), "remove deletes the files");
host.shutdown(); hf.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
