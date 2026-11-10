// MODEL HOST: downloads and runs the local model (llama-server, or Colibri for big streaming models) for Eta IDE.
//  A. real download progress (percent, speed, time left), stop and resume, auto-retry
//  B. a watcher that restarts the model if it crashes, and shows the real state
//  C. a speed test after the first load, with a smaller-model suggestion when it is too slow
//  D. a catalog of model sizes, plus any Hugging Face model by name
//  E. frees the memory when idle, and loads the model again when you type
import * as fs from "fs/promises";
import { createWriteStream, existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { findColibri, colibriPlan, colibriImport, launchColibri, measureColibriTokPerSec } from "./colibri.mjs";
import { HF_MODELS, computeLlamaFlags, llamaArgsHF, launchLlamaServer, measureLlamaTokPerSec, speedVerdict, findLlamaServer, findLocalModelFile } from "./moe.mjs";

const HF = () => process.env.ETA_HF_BASE || "https://huggingface.co";
export const MODELS_DIR = () => process.env.ETA_MODELS_DIR || path.join(os.homedir(), ".eta", "models");
const PORT = 8722;
const GB = 1e9;

// Real repos, checked on Hugging Face (file names and sizes) on 2026-11-09.
export const CATALOG = [
  { id: "q27", label: "Qwen3.8 27B", repo: "unsloth/Qwen3.8-27B-GGUF", quant: "UD-IQ3_XXS", sizeGB: 10.9, totalB: 27, activeB: 27, note: "Our first choice for a 12 GB graphics card. Fixed a 3-bug test task in Eta and ran at 13.5 words per second on an RTX 3060. Small 3-bit file: some quality loss. Long chats not tested yet." },
  { id: "q27hi", label: "Qwen3.8 27B (higher quality)", repo: "unsloth/Qwen3.8-27B-GGUF", quant: "UD-Q4_K_M", sizeGB: 16.5, totalB: 27, activeB: 27, note: "Same model, better quality file. Needs a graphics card with about 20 GB or more. Not tested in Eta yet." },
  { id: "moe35", engine: "colibri", label: "Qwen3.8 35B-A3B (streams from disk)", repo: "empero-ai/Qwen3.8-35B-A3B-Distill-GGUF", quant: "IQ3_M", sizeGB: 16.3, totalB: 35, activeB: 3, moe: true, layers: 40, note: "Runs on Eta Engine: only the parts in use stay in memory, the rest is read from disk. Measured here with 8 GB memory: 24 to 30 words per second with a 12 GB graphics card, 2.5 to 3 on the processor alone. A community fine-tune of a Qwen model. Needs a fast SSD." },
  { id: "devstral", label: "Devstral Small 24B", repo: "unsloth/Devstral-Small-2507-GGUF", quant: "Q4_K_M", sizeGB: 14.3, totalB: 24, activeB: 24, note: "Made by Mistral for coding agents (editing many files). Not tested in Eta yet." },
  { id: "gptoss", label: "gpt-oss 20B", repo: "unsloth/gpt-oss-20b-GGUF", quant: "Q4_K_M", sizeGB: 11.6, totalB: 21, activeB: 3.6, moe: true, layers: 24, note: "OpenAI open model, good with tools. Not tested in Eta yet." },
  { id: "moe30", engine: "colibri", label: "Qwen3-Coder 30B (A3B)", repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", quant: "Q4_K_M", sizeGB: 18.6, totalB: 30, activeB: 3, moe: true, layers: 48, note: "Official Qwen coding model, only 3B parts work at once. Runs on Eta Engine. Not tested in Eta yet." },
  { id: "flagship", tier: "flagship", label: HF_MODELS.flagship.label, repo: HF_MODELS.flagship.repo, quant: HF_MODELS.flagship.quant, sizeGB: HF_MODELS.flagship.sizeGB, totalB: HF_MODELS.flagship.totalB, activeB: HF_MODELS.flagship.activeB, moe: true, layers: 48, note: "The biggest. Needs a graphics card, fast disk and lots of memory." },
];

// How well a model fits this PC. Honest: real speed is measured after the first load.
// Colibri models (Mixture of Experts streamed from disk). Measured on the dev PC (2026-11-09): 15 words/s with the card through Vulkan, 2.4 to 3.4 on the processor.
function colibriFit(hw, m) {
  const ram = hw?.ramGB || 8; const vram = hw?.gpu && ["nvidia", "amd"].includes(hw.gpu.vendor) ? (hw.gpu.vramGB || 0) : 0; const disk = hw?.diskFreeGB || 0;
  if (ram < 6) return { level: "no", text: "Needs at least 6 GB of memory." };
  if (disk && disk < m.sizeGB + 3) return { level: "no", text: "Needs " + Math.ceil(m.sizeGB + 3) + " GB of free disk space." };
  if (vram >= 6) return { level: "fast", text: "Streams through your graphics card. Measured 15 words per second on a 12 GB card; other cards not measured." };
  return { level: "ok", text: "Runs on the processor and reads from disk. About 2 to 3 words per second on a 6-core PC (measured). Needs a fast SSD." };
}
export function fitFor(hw, m) {
  if (m.engine === "colibri") return colibriFit(hw, m);
  const vram = hw?.gpu && ["nvidia", "amd"].includes(hw.gpu.vendor) ? (hw.gpu.vramGB || 0) : 0;
  const ram = hw?.ramGB || 8; const size = m.sizeGB;
  if (vram && size <= vram * 0.92) return { level: "fast", text: "Fits your graphics card" };
  // Memory left for the model = card (90%) + memory minus about 5 GB for Windows and apps. Measured 2026-11-09: a 16.3 GB MoE file on a 12 GB card with 9 GB memory did not fit and gave only 1.7 words per second.
  if (m.moe && vram >= 4 && size * 1.1 <= vram * 0.9 + Math.max(0, ram - 5)) return { level: "ok", text: "Works. Parts stream from memory" };
  if (!m.moe && !vram && size <= ram * 0.8) return { level: "slow", text: "No graphics card: runs on the processor. Slow (measured 0.16 words per second when the file did not fit memory)." };
  if (!m.moe && vram && size <= ram * 0.6) return { level: "ok", text: "Works. Partly on the card, so slower" };
  if (size <= (ram + vram) * 0.8) return { level: "slow", text: "Will be slow on this PC" };
  if (m.moe && vram >= 4 && ram >= 8) return { level: "slow", text: "Streams from disk. Slow, but it works" };
  return { level: "no", text: "Too big for this PC" };
}

const dead = (p) => !p || p.exitCode != null || p.signalCode != null;
// The model to offer on first start: the biggest one that fits the graphics card ("fast").
// Without a card, the biggest that fits normal memory ("ok"). Streaming giants are never the default:
// the 80B file measured 0.6 tokens per second on a 12 GB card with 9 GB memory (2026-11-09).
export function recommendFor(hw, models = CATALOG) {
  // Only tested, working models. Order: most capable first (parts that work on each word), then size.
  const rank = (lvl) => models.filter((m) => !m.custom && fitFor(hw, m).level === lvl && m.id !== "devstral" && m.id !== "gptoss" && m.id !== "moe30")
    .sort((a, b) => (b.activeB - a.activeB) || (b.sizeGB - a.sizeGB))[0];
  // null = this PC cannot run a model that is good enough. The UI then offers a cloud model or another PC.
  return rank("fast") || rank("ok") || null;
}
const slugRepo = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_");
const shardRe = /-\d{5}-of-\d{5}\.gguf$/i;

// Choose the .gguf file(s) of one quant from a Hugging Face repo listing.
export function pickFiles(siblings, quant) {
  const q = String(quant).toLowerCase();
  const hit = (n) => { const l = n.toLowerCase(); let i = -1; while ((i = l.indexOf(q, i + 1)) >= 0) { const before = i === 0 ? "-" : l[i - 1], after = l[i + q.length] || "."; if (/[-_.]/.test(before) && /[.-]/.test(after)) return true; } return false; };
  const all = (siblings || []).filter((s) => /\.gguf$/i.test(s.rfilename) && !/mmproj/i.test(s.rfilename) && hit(s.rfilename));
  if (!all.length) return [];
  const single = all.filter((s) => !shardRe.test(s.rfilename)).sort((a, b) => a.rfilename.length - b.rfilename.length);
  if (single.length) return [{ name: single[0].rfilename, size: single[0].size }];
  const firstShard = all.map((s) => s.rfilename).sort()[0]; const prefix = firstShard.replace(/-\d{5}-of-\d{5}\.gguf$/i, "");
  return all.filter((s) => s.rfilename.startsWith(prefix)).sort((a, b) => a.rfilename.localeCompare(b.rfilename)).map((s) => ({ name: s.rfilename, size: s.size }));
}

export class Host {
  // opts: { stateFile, getHw: async () => hw, isBusy: () => bool, onState: (state) => void, log }
  constructor(opts) {
    this.o = opts; this.handle = null; this.dl = null; this.catalogCache = null;
    this.s = { status: "none", modelId: "", label: "", message: "", percent: 0, doneGB: 0, totalGB: 0, speedMBs: 0, etaS: 0, tokPerSec: 0, verdict: "", suggest: null, error: "", restarts: 0, idleMin: 30, customs: [] };
    this.exe = null; // test hook: { cmd, pre: [] }
    this.intentional = false; this.restartLog = []; this.lastUsed = Date.now(); this.fails = 0; this.timer = null; this.launching = null;
  }
  // ---------- state ----------
  set(p) { Object.assign(this.s, p); try { this.o.onState && this.o.onState(this.publicState()); } catch {} }
  publicState() { return { ...this.s, active: this.s.status !== "none", port: PORT }; }
  async _save() { try { await fs.mkdir(path.dirname(this.o.stateFile), { recursive: true }); await fs.writeFile(this.o.stateFile, JSON.stringify({ modelId: this.s.modelId, idleMin: this.s.idleMin, customs: this.s.customs, speed: this.speed || {}, colibriVk: this.s.colibriVk || {} }, null, 2)); } catch {} }
  async init() {
    let c = {}; try { c = JSON.parse(await fs.readFile(this.o.stateFile, "utf8")); } catch {}
    this.s.idleMin = Number.isFinite(c.idleMin) ? c.idleMin : 30; this.s.customs = Array.isArray(c.customs) ? c.customs : []; this.speed = c.speed || {}; this.s.colibriVk = c.colibriVk && typeof c.colibriVk === "object" ? c.colibriVk : {};
    if (c.modelId) {
      const m = this.find(c.modelId);
      if (m) { this.s.modelId = m.id; this.s.label = m.label; this.s.status = (await this.installed(m)) ? "sleeping" : "needs-download"; this.s.message = this.s.status === "sleeping" ? "Ready. Loads when you send a message." : "Not downloaded yet."; const sp = this.speed[m.id]; if (sp) { this.s.tokPerSec = sp.tokPerSec; this.s.verdict = speedVerdict(sp.tokPerSec).level; } }
    }
    clearInterval(this.timer); this.timer = setInterval(() => this._tick().catch(() => {}), 4000); this.timer.unref?.();
  }
  all() { return [...CATALOG, ...this.s.customs.map((c) => ({ ...c, custom: true }))]; }
  find(id) { return this.all().find((m) => m.id === id) || null; }
  get engine() { return this.find(this.s.modelId)?.engine || "llama"; }
  isHostedProvider(provider) { return !!provider && String(provider.base || "").includes(":" + PORT); }
  async hw() { return this.o.getHw ? await this.o.getHw() : null; }

  // ---------- files on disk ----------
  dirFor(m) { return path.join(MODELS_DIR(), m.id.replace(/[^A-Za-z0-9._-]+/g, "_")); }
  async manifest(m) { try { return JSON.parse(await fs.readFile(path.join(this.dirFor(m), "manifest.json"), "utf8")); } catch { return null; } }
  async installedFile(m) {
    const mf = await this.manifest(m);
    if (mf) { let ok = true; for (const f of mf.files) { try { if ((await fs.stat(path.join(this.dirFor(m), f.name))).size !== f.size) ok = false; } catch { ok = false; } } if (ok) return path.join(this.dirFor(m), mf.files[0].name); }
    if (m.tier) return await findLocalModelFile(m.tier); // a file the user already placed by hand
    return null;
  }
  async installed(m) { return !!(await this.installedFile(m)); }

  // ---------- A: download with progress and resume ----------
  async _listFiles(m) {
    const r = await fetch(`${HF()}/api/models/${m.repo}?blobs=true`, { signal: AbortSignal.timeout(25000), headers: { "user-agent": "eta-ide" } });
    if (r.status === 404) throw new Error(`I could not find "${m.repo}" on Hugging Face. Check the name.`);
    if (r.status === 401 || r.status === 403) throw new Error(`"${m.repo}" needs a Hugging Face login. It is not supported yet.`);
    if (!r.ok) throw new Error(`Hugging Face answered ${r.status}.`);
    const j = await r.json(); const files = pickFiles(j.siblings, m.quant);
    if (!files.length) throw new Error(`No ${m.quant} file in ${m.repo}. Try another quant, for example ${m.repo}:Q4_K_M`);
    return files;
  }
  async download(m) {
    if (this.dl) throw new Error("A download is already running.");
    const ctl = new AbortController(); this.dl = { ctl, m, paused: false };
    this.set({ status: "downloading", modelId: m.id, label: m.label, message: "Getting the file list…", error: "", percent: 0, doneGB: 0, totalGB: m.sizeGB || 0, suggest: null });
    try {
      const files = await this._listFiles(m); const total = files.reduce((a, f) => a + f.size, 0);
      const dir = this.dirFor(m); await fs.mkdir(dir, { recursive: true });
      try { const st = await fs.statfs(dir); let have = 0; for (const f of files) { try { have += (await fs.stat(path.join(dir, f.name + ".part"))).size; } catch {} } const need = total - have + 1 * GB; if (st.bavail * st.bsize < need) throw new Error(`Not enough free disk space. Needs about ${(need / GB).toFixed(1)} GB free in ${dir}.`); } catch (e) { if (/Not enough/.test(e.message)) throw e; }
      let finished = 0, lastT = Date.now(), lastB = 0, speed = 0, lastSet = 0;
      for (const f of files) {
        const dest = path.join(dir, f.name);
        if (existsSync(dest) && (await fs.stat(dest)).size === f.size) { finished += f.size; continue; }
        await this._dlFile(`${HF()}/${m.repo}/resolve/main/${encodeURI(f.name)}`, dest, f.size, ctl.signal, (cur) => {
          const done = finished + cur, now = Date.now();
          if (now - lastSet < 500) return; lastSet = now;
          if (now - lastT >= 1000) { speed = (done - lastB) / ((now - lastT) / 1000); lastT = now; lastB = done; }
          this.set({ percent: Math.min(99, Math.round(done / total * 100)), doneGB: +(done / GB).toFixed(2), totalGB: +(total / GB).toFixed(2), speedMBs: +(speed / 1e6).toFixed(1), etaS: speed > 0 ? Math.round((total - done) / speed) : 0, message: "Downloading…" });
        });
        finished += f.size;
      }
      await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ repo: m.repo, quant: m.quant, files: files.map((f) => ({ name: f.name, size: f.size })) }));
      this.dl = null; this.set({ percent: 100, message: "Downloaded." });
    } catch (e) {
      const paused = this.dl && this.dl.paused; this.dl = null;
      if (paused) { this.set({ status: "paused", message: "Paused. Press Resume to continue where it stopped.", speedMBs: 0 }); throw Object.assign(new Error("paused"), { paused: true }); }
      this.set({ status: "error", error: String(e.message || e), message: String(e.message || e), speedMBs: 0 }); throw e;
    }
  }
  async _dlFile(url, dest, size, signal, onBytes) {
    const part = dest + ".part";
    for (let attempt = 0; attempt < 8; attempt++) {
      let have = 0; try { have = (await fs.stat(part)).size; } catch {}
      if (have > size) { await fs.rm(part, { force: true }); have = 0; }
      if (have === size) break;
      try {
        const res = await fetch(url, { signal, headers: { range: `bytes=${have}-`, "user-agent": "eta-ide" } });
        if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Hugging Face refused the download (login needed)."), { fatal: true });
        if (res.status === 416) break;
        if (!res.ok) throw new Error("Hugging Face answered " + res.status);
        if (res.status === 200 && have > 0) { await fs.rm(part, { force: true }); have = 0; } // server ignored the resume request
        const out = createWriteStream(part, { flags: have ? "a" : "w" });
        let cur = have;
        try { for await (const chunk of res.body) { if (!out.write(chunk)) await new Promise((r) => out.once("drain", r)); cur += chunk.length; onBytes(cur); } }
        finally { await new Promise((r) => out.end(r)); }
      } catch (e) {
        if (signal.aborted) throw e; if (e.fatal) throw e;
        this.set({ message: "Connection problem. Trying again…" }); await new Promise((r) => setTimeout(r, Math.min(15000, 1500 * (attempt + 1)))); continue;
      }
      if ((await fs.stat(part)).size === size) break;
    }
    if ((await fs.stat(part).catch(() => ({ size: -1 }))).size !== size) throw new Error("The download stopped before the end. Press Resume to try again.");
    await fs.rename(part, dest);
  }
  pause() { if (this.dl) { this.dl.paused = true; this.dl.ctl.abort(); } }
  async cancel() { const m = this.dl?.m || this.find(this.s.modelId); if (this.dl) { this.dl.paused = false; this.dl.ctl.abort(); } if (m) { try { for (const f of await fs.readdir(this.dirFor(m))) if (f.endsWith(".part")) await fs.rm(path.join(this.dirFor(m), f), { force: true }); } catch {} } this.dl = null; this.set({ status: this.handle ? "ready" : "none", message: "", percent: 0 }); }

  // ---------- choose and start a model ----------
  async addCustom(spec) { // "owner/repo" or "owner/repo:Q4_K_M"
    const mm = String(spec || "").trim().match(/^([\w.-]+\/[\w.-]+?)(?::([\w.-]+))?$/);
    if (!mm) throw new Error("Write it like owner/name or owner/name:Q4_K_M");
    const repo = mm[1], quant = (mm[2] || "Q4_K_M").toUpperCase(); const id = "custom-" + slugRepo(repo + "-" + quant).toLowerCase();
    let m = this.find(id); if (m) return m;
    const probe = { repo, quant }; const files = await this._listFiles(probe); const sizeGB = +(files.reduce((a, f) => a + f.size, 0) / GB).toFixed(1);
    m = { id, label: repo.split("/")[1].replace(/-GGUF$/i, "") + " " + quant, repo, quant, sizeGB, totalB: Math.round(sizeGB * 1.8), activeB: Math.round(sizeGB * 1.8) };
    this.s.customs.push(m); await this._save(); return m;
  }
  async use(idOrSpec) {
    let m = this.find(idOrSpec); if (!m) m = await this.addCustom(idOrSpec);
    if (this.launching) await this.launching.catch(() => {});
    if (this.handle && this.s.modelId !== m.id) this._kill("switch");
    if (!(await this.installed(m))) {
      const hw = await this.hw(); const fit = fitFor(hw, m);
      if (fit.level === "no") throw new Error(`${m.label} is too big for this PC (${m.sizeGB} GB). Choose a smaller one.`);
      await this.download(m);
    }
    this.s.modelId = m.id; this.s.label = m.label; await this._save();
    return await this.wake(true);
  }

  // ---------- run the server ----------
  _exe(hw) { return this.exe || (process.env.ETA_LLAMA_SERVER ? { cmd: process.env.ETA_LLAMA_SERVER, pre: [] } : (() => { const e = findLlamaServer(hw); return e ? { cmd: e, pre: [] } : null; })()); }
  async _buildArgs(m, file, hw) {
    const rec = { family: m.layers === 48 ? "qwen3-coder-next" : m.moe ? "deepseek-coder-v2" : "dense", label: m.label, sizeGB: m.sizeGB, totalB: m.totalB, activeB: m.activeB, fits: true };
    const flags = computeLlamaFlags(hw, rec);
    const vram = hw?.gpu && ["nvidia", "amd"].includes(hw.gpu.vendor) ? (hw.gpu.vramGB || 0) : 0;
    if (!m.moe) { flags.nCpuMoe = 0; if (vram && m.sizeGB > vram * 0.85) flags.ngl = -1; /* too big for the card: let llama.cpp split it itself */ }
    const a = llamaArgsHF("helper", flags, PORT, file); // a local file path skips the download branch
    if (flags.ngl === -1) { const i = a.indexOf("-ngl"); if (i >= 0) a.splice(i, 2); }
    return { args: a, flags };
  }
  async wake(force = false) {
    this.lastUsed = Date.now();
    if (this.handle && !dead(this.handle.proc)) { if (this.s.status !== "ready") this.set({ status: "ready" }); return this.publicState(); }
    if (!this.s.modelId) return this.publicState();
    if (!force && !["sleeping", "stopped", "ready", "restarting"].includes(this.s.status)) return this.publicState();
    if (this.launching) { await this.launching; return this.publicState(); }
    this.launching = this._launch().finally(() => { this.launching = null; });
    await this.launching; return this.publicState();
  }
  async _launch(isRestart = false) {
    const m = this.find(this.s.modelId); if (!m) throw new Error("No model chosen.");
    const hw = await this.hw();
    if (m.engine === "colibri") return await this._launchColibri(m, hw, isRestart);
    const exe = this._exe(hw);
    if (!exe) { const msg = "The model runner (llama-server) is not in this build yet."; this.set({ status: "error", error: msg, message: msg }); throw new Error(msg); }
    const file = await this.installedFile(m); if (!file) { this.set({ status: "needs-download", message: "Not downloaded yet." }); throw new Error("not downloaded"); }
    this.intentional = false; this.set({ status: "loading", message: isRestart ? "Restarting the model…" : "Loading the model into memory…", error: "" });
    try {
      const { args } = await this._buildArgs(m, file, hw);
      const readyMs = Math.max(90000, (m.sizeGB || 5) * 4000);
      const h = await launchLlamaServer(exe.cmd, [...exe.pre, ...args], PORT, (s) => { if (/error|failed|cannot|out of memory/i.test(s)) this.log?.(s); }, readyMs);
      this.handle = h; this.fails = 0; this.set({ status: "ready", message: "Ready.", restarts: this.s.restarts });
      if (!isRestart && !this.speed?.[m.id]) this._speedTest(m).catch(() => {});
    } catch (e) {
      this.handle = null; const msg = this._explain(e); this.set({ status: "error", error: msg, message: msg }); throw new Error(msg);
    }
  }
  async _launchColibri(m, hw, isRestart) {
    const c = findColibri();
    if (!c) { const msg = "Eta Engine is not in this build."; this.set({ status: "error", error: msg, message: msg }); throw new Error(msg); }
    if (!c.python) { const msg = "Python 3 is needed for this model. Install Python from python.org and press Restart."; this.set({ status: "error", error: msg, message: msg }); throw new Error(msg); }
    const file = await this.installedFile(m); if (!file) { this.set({ status: "needs-download", message: "Not downloaded yet." }); throw new Error("not downloaded"); }
    this.intentional = false; this.set({ status: "loading", message: isRestart ? "Restarting the model…" : "Loading the model…", error: "" });
    try {
      colibriImport(c, file, path.join(this.dirFor(m), "colibri"));
      const plan = colibriPlan(hw); const mdir = path.join(this.dirFor(m), "colibri");
      const saved = this.s.colibriVk?.[m.id];
      if (typeof saved === "boolean") plan.vulkan = saved;
      else if (plan.gpuAny) plan.vulkan = await this._pickColibriDevice(c, mdir, plan, m);
      const h = await launchColibri(c, mdir, PORT, plan, (s) => this.log?.(s), 300000);
      this.handle = h; this.apiModel = h.apiModel || ""; this.fails = 0; this.set({ status: "ready", message: "Ready.", restarts: this.s.restarts });
      if (!isRestart && !this.speed?.[m.id]) this._speedTest(m).catch(() => {});
    } catch (e) {
      this.handle = null; const msg = this._explain(e); this.set({ status: "error", error: msg, message: msg }); throw new Error(msg);
    }
  }
  // First start on a PC with any graphics chip: measure the processor alone and with the graphics chip, keep the faster, remember it.
  async _pickColibriDevice(c, mdir, plan, m) {
    const res = {};
    for (const vk of [false, true]) {
      this.set({ status: "loading", message: vk ? "Testing the graphics chip (first start only)…" : "Testing the processor (first start only)…" });
      let h = null;
      try { h = await launchColibri(c, mdir, PORT, { ...plan, vulkan: vk }, (s) => this.log?.(s), 300000); res[vk] = (await measureColibriTokPerSec(PORT, h.apiModel)).tokPerSec || 0; }
      catch { res[vk] = 0; }
      try { h?.stop(); } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    const best = res[true] > res[false] * 1.1;   // the graphics chip only if clearly faster
    this.s.colibriVk = { ...(this.s.colibriVk || {}), [m.id]: best }; this.log?.(`Eta Engine device test: processor ${res[false]}, graphics chip ${res[true]} words/s, using ${best ? "graphics chip" : "processor"}`);
    await this._save();
    return best;
  }
  _explain(e) { const t = String(e?.message || e); if (/out of (device )?memory|alloc/i.test(t)) return "The model did not fit in memory. Close other programs or choose a smaller model."; if (/exited early/.test(t)) return "The model program stopped while loading. Choose a smaller model, or press Restart."; if (/not become ready/.test(t)) return "The model took too long to load. Press Restart, or choose a smaller model."; return t.slice(0, 200); }
  _kill(why) { this.intentional = true; try { this.handle?.stop?.(); } catch {} this.handle = null; if (why === "idle") this.set({ status: "sleeping", message: "Asleep to save memory. Loads when you send a message." }); }
  stop() { this._kill("stop"); this.set({ status: this.s.modelId ? "stopped" : "none", message: "Stopped." }); }
  async restart() { this._kill("restart"); await new Promise((r) => setTimeout(r, 400)); return await this.wake(true); }
  setIdle(min) { this.s.idleMin = Math.max(0, Math.min(1440, Number(min) || 0)); this.set({}); this._save(); }
  async remove(id) {
    const m = this.find(id); if (!m) throw new Error("Unknown model."); if (this.s.modelId === id && (this.handle || this.dl)) throw new Error("Stop this model first.");
    await fs.rm(this.dirFor(m), { recursive: true, force: true });
    if (m.custom) this.s.customs = this.s.customs.filter((x) => x.id !== id);
    if (this.s.modelId === id) this.set({ modelId: "", label: "", status: "none", message: "" });
    await this._save();
  }

  // ---------- C: speed test and a smaller suggestion ----------
  async _speedTest(m) {
    this.set({ message: "Checking speed…" });
    let tok = 0;
    try { const r = m.engine === "colibri" ? await measureColibriTokPerSec(PORT, this.apiModel, { maxTokens: 48, timeoutMs: 240000 }) : await measureLlamaTokPerSec(PORT, { maxTokens: 32, timeoutMs: 240000 }); tok = r.tokPerSec; } catch { tok = 0; } // no answer in 4 minutes = far too slow
    const v = speedVerdict(tok);
    this.speed = this.speed || {}; this.speed[m.id] = { tokPerSec: tok, at: Date.now() }; this._save();
    let suggest = null;
    if (v.level === "tooslow") {
      const hw = await this.hw(); const lv = (x) => fitFor(hw, x).level;
      const cand = this.all().filter((x) => x.sizeGB < m.sizeGB && ["fast", "ok"].includes(lv(x))).sort((x, y) => (lv(x) === "fast" ? 0 : 1) - (lv(y) === "fast" ? 0 : 1) || y.sizeGB - x.sizeGB)[0];
      if (cand) suggest = { id: cand.id, label: cand.label, sizeGB: cand.sizeGB };
    }
    this.set({ tokPerSec: tok, verdict: v.level, suggest, message: v.level === "tooslow" ? "Ready, but far too slow for agent work." : "Ready." });
  }

  // ---------- B + E: watcher ----------
  async _tick() {
    const s = this.s;
    if (this.o.isBusy && this.o.isBusy()) this.lastUsed = Date.now();
    // B: the model program died by itself -> restart (at most 3 times in 10 minutes)
    if (this.handle && dead(this.handle.proc) && !this.intentional && !this.launching) {
      this.handle = null; const now = Date.now(); this.restartLog = this.restartLog.filter((t) => now - t < 600000);
      if (this.restartLog.length >= 3) { this.set({ status: "error", error: "The model keeps stopping. Choose a smaller model, or press Restart.", message: "The model keeps stopping." }); return; }
      this.restartLog.push(now); this.s.restarts++; this.set({ status: "restarting", message: "The model stopped. Starting it again…" });
      this.launching = this._launch(true).catch(() => {}).finally(() => { this.launching = null; });
      return;
    }
    // hung but alive: three failed health checks in a row -> kill, the next tick restarts it
    if (this.handle && s.status === "ready" && !this.launching) {
      let ok = true; try { ok = (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(4000) })).ok; } catch { ok = false; }
      this.fails = ok ? 0 : this.fails + 1; if (this.fails >= 3) { this.fails = 0; try { this.handle.proc.kill(); } catch {} }
    }
    // E: free the memory when idle
    if (this.handle && s.status === "ready" && s.idleMin > 0 && Date.now() - this.lastUsed > s.idleMin * 60000 && !this.launching && !(this.o.isBusy && this.o.isBusy())) this._kill("idle");
  }

  async describe() {
    const hw = await this.hw(); const rows = [];
    for (const m of this.all()) { const sp = this.speed?.[m.id]; rows.push({ id: m.id, label: m.label, sizeGB: m.sizeGB, note: m.note || "", custom: !!m.custom, repo: m.repo, quant: m.quant, installed: await this.installed(m), fit: fitFor(hw, m), tokPerSec: sp ? sp.tokPerSec : null }); }
    return { state: this.publicState(), models: rows, dir: MODELS_DIR(), hw: hw ? { gpu: hw.gpu ? hw.gpu.name : "", vramGB: hw.gpu ? hw.gpu.vramGB : 0, ramGB: hw.ramGB, diskFreeGB: hw.diskFreeGB } : null };
  }
  shutdown() { clearInterval(this.timer); this._kill("exit"); }
}
