// Colibri engine adapter (https://github.com/JustVugg/colibri, Apache-2.0, v2.1.0). It runs big Mixture-of-Experts
// models on small PCs by keeping the always-used part in memory and streaming the experts from disk with a cache.
// Eta runs it as a local server (127.0.0.1 only) and talks to it like any OpenAI-style server.
// Measured on the dev PC (8.3 GB memory, RTX 3060 12 GB, Qwen3.8-35B-A3B IQ3_M 16.3 GB file, 2026-11-09):
//   processor only 2.4 to 3.4 words/s, with the card through Vulkan 15 words/s. llama.cpp (mmap) gave 1.7 on the same model.
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Python 3 is needed only for Colibri's launcher/gateway script (the engines are plain programs).
export function findPython() {
  const tries = process.env.ETA_PYTHON ? [[process.env.ETA_PYTHON, []]] : [["python", []], ["python3", []], ["py", ["-3"]]];
  for (const [cmd, pre] of tries) {
    try { const r = spawnSync(cmd, [...pre, "-I", "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 8000, windowsHide: true }); if (r.status === 0 && String(r.stdout).trim() === "3") return { cmd, pre }; } catch {}
  }
  return null;
}

export function findColibri() {
  const dir = process.env.ETA_ENGINE_DIR || process.env.ETA_COLIBRI_DIR || [path.join(HERE, "engine"), path.join(HERE, "colibri")].find((d) => fs.existsSync(path.join(d, "coli"))) || path.join(HERE, "engine");
  if (!fs.existsSync(path.join(dir, "coli")) || !fs.existsSync(path.join(dir, "qwen36.exe")) && !fs.existsSync(path.join(dir, "qwen36"))) return null;
  const py = findPython(); if (!py) return { dir, python: null };
  return { dir, python: py };
}

// Memory plan from the PC. ram = what Colibri may use; cap = expert slots per layer (256 experts per layer in the Qwen 35B model).
// Measured on 8.3 GB: cap 32 and 48 gave 2.4 words/s, cap 64 ran out of memory and fell to 0.6. So stay low on small PCs.
export function colibriPlan(hw) {
  const ramGB = hw?.ramGB || 8;
  const vram = hw?.gpu && ["nvidia", "amd"].includes(hw.gpu.vendor) ? (hw.gpu.vramGB || 0) : 0;
  // kvSlots: each conversation (hashed from its system + first user message) keeps its own saved prompt state, so the agent's
  //   growing work loop re-reads only the new part. With one slot, the agent's other calls overwrote it (measured: no reuse).
  //   This model can only resume a prompt that CONTINUES the saved one (875 words: 32 s fresh, 4-5 s continued).
  // route: prefer experts already in memory when the router's choice is close (CACHE_ROUTE=1). Measured without a card:
  //   edit task 121-126 s down to 94 s, same answer. It can change answers a little, so only where the disk is the slow part.
  // gpuAny: any graphics chip Vulkan may use, also a built-in one (Intel, AMD iGPU). Colibri's own numbers: Radeon 780M
  //   iGPU 10-11 words/s with Vulkan against 6 on the processor. Not measured by us, so the Host measures both once and keeps the faster.
  // route is on everywhere: on this PC the card never held the experts (they ran on the processor), so the disk is the slow part there too.
  const gpuAny = !!(hw?.gpu && ["nvidia", "amd", "intel"].includes(hw.gpu.vendor));
  return { ram: Math.max(3, Math.floor(ramGB - 1.5)), cap: ramGB <= 9 ? 32 : ramGB <= 16 ? 64 : 128, vulkan: vram >= 6, ctx: 16384,
    kvSlots: 1, route: true, gpuAny };
  // kvSlots stays 1 for now: with 3 slots the card could not hold the experts ("expert batch: scratch failed", 2.6 words/s
  // instead of 15), and the agent still got no reuse because its calls are different prompts, not one growing conversation.
}

// Make a Colibri model folder from a GGUF file. Nothing is copied: Colibri reads the GGUF in place.
export function colibriImport(c, gguf, outDir) {
  if (fs.existsSync(path.join(outDir, "config.json"))) return { ok: true, already: true };
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const r = spawnSync(c.python.cmd, [...c.python.pre, "-I", "coli", "import", "--out", outDir, "--mode", "link", gguf], { cwd: c.dir, encoding: "utf8", timeout: 180000, windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(path.join(outDir, "config.json"))) throw new Error("Eta Engine could not read this model file. " + String(r.stderr || r.stdout || "").trim().slice(-200));
  return { ok: true };
}

export function colibriArgs(modelDir, port, plan) {
  return ["-I", "coli", "serve", "--model", modelDir, "--ram", String(plan.ram), "--cap", String(plan.cap), "--ctx", String(plan.ctx || 16384),
    "--gpu", "none", "--host", "127.0.0.1", "--port", String(port), "--no-think", "--model-id", "eta-engine",
    // security audit: the engine's default browser allow-list includes common dev ports (5173, 8000), so any dev web page
    // could use the model. Eta calls it from Node (no browser), so allow no browser origin at all.
    "--cors-origin", "http://127.0.0.1:1", "--kv-slots", String(plan.kvSlots || 1)];
}

export async function launchColibri(c, modelDir, port, plan, emit = () => {}, readyMs = 240000) {
  const env = { ...process.env, COLI_VULKAN: plan.vulkan ? "1" : "0" };
  if (plan.route) env.CACHE_ROUTE = "1";
  // Cards without Resizable BAR: Colibri's window probe used up the small mapped window, so the expert tier failed
  // ("expert batch: scratch of 4.2 MiB failed") and all experts ran on the processor. Skipping the probe fixed it on the
  // RTX 3060: 57 of 64 expert slots on the card, edit task 22 s instead of 85-110 s (2026-11-09).
  if (plan.vulkan && !process.env.COLI_VK_WINDOW_PROBE_MB) env.COLI_VK_WINDOW_PROBE_MB = "0";
  if (process.env.ETA_COLI_LOG) { env.COLI_PREFIX_LOG = "1"; }
  delete env.ELECTRON_RUN_AS_NODE;
  emit(`starting Eta Engine on :${port} (ram ${plan.ram} GB, ${plan.cap} experts per layer, graphics card ${plan.vulkan ? "on" : "off"})…`);
  const proc = spawn(c.python.cmd, [...c.python.pre, ...colibriArgs(modelDir, port, plan)], { cwd: c.dir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = ""; const keep = (d) => { tail = (tail + String(d)).slice(-1500); if (process.env.ETA_COLI_LOG) try { fs.appendFileSync(process.env.ETA_COLI_LOG, d); } catch {} };
  proc.stdout?.on("data", keep); proc.stderr?.on("data", keep);
  const stop = () => { try { if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true }); else proc.kill(); } catch {} };
  const t0 = Date.now();
  while (Date.now() - t0 < readyMs) {
    if (proc.exitCode != null || proc.signalCode != null) throw new Error("Eta Engine exited early. " + tail.trim().slice(-200));
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (h.ok) {
        let apiModel = "";
        try { const j = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(4000) })).json(); apiModel = j.data?.[0]?.id || ""; } catch {}
        emit(`Eta Engine ready on :${port}`); return { proc, port, apiModel, stop };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  stop(); throw new Error("Eta Engine did not become ready in time. " + tail.trim().slice(-200));
}

// Speed test: two short answers; the first one warms the cache, so the second one is the honest number.
export async function measureColibriTokPerSec(port, model, opts = {}) {
  let last = { tokPerSec: 0, tokens: 0 };
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs || 240000),
      body: JSON.stringify({ model, max_tokens: opts.maxTokens || 48, temperature: 0, messages: [{ role: "user", content: "Write a Python function is_prime(n). Only the code." }] }) });
    const j = await r.json(); const n = j.usage?.completion_tokens || 0; const dt = (Date.now() - t0) / 1000;
    last = { tokPerSec: +(n / Math.max(dt, 0.001)).toFixed(2), tokens: n, seconds: +dt.toFixed(1) };
  }
  return last;
}
