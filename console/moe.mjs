// Eta MoE Turbo — make a big Mixture-of-Experts model usable on a poor laptop.
//
// The mission: a student on an 8 GB machine should still get the SMART 16B brain,
// not a dumbed-down tiny model. Colibri proved a huge MoE can run on small RAM by
// streaming its rarely-used "expert" chapters from disk and keeping the always-used
// parts resident. Colibri itself is a C engine hard-wired to ONE model, so we don't
// port it — we take its IDEAS and drive an engine that already understands every MoE
// architecture (llama.cpp), falling back to Ollama when the binary isn't present.
//
// The five levers (in order of impact):
//   1. FIT-FIRST  — pick the largest quant of the model that fits RAM. A model that
//                   fits barely streams; one that overflows thrashes the disk. Biggest win.
//   2. PIN HOT    — keep the always-used weights (attention/dense/shared) locked in RAM
//                   (--mlock) so the OS can never evict them (Colibri's "dense stays resident").
//   3. OFFLOAD    — expert FFN tensors -> CPU/RAM, attention -> iGPU/VRAM when useful
//                   (llama.cpp --n-cpu-moe / --override-tensor).
//   4. AUTO-TUNE  — the offload sweet spot is "trial and error" per the guides; automate it.
//   5. REMEMBER   — save the winning setup per-machine to .eta/moe-profile.json.
//
// Honest limit: knowing WHICH individual expert is hot (Colibri's .coli_usage) needs to be
// INSIDE the engine loop; from outside we can't see per-expert routing. So we pin the parts
// we CAN identify (the structurally-always-hot ones) and make the resident cache as large as
// the fit-quant allows — which captures most of the benefit.

import * as os from "os";
import * as path from "path";
import { existsSync, readdirSync } from "fs";
import * as fs from "fs/promises";
import { execFile } from "child_process";

// ------------------------------------------------------------------ model ladder
// Coding MoE models, smallest-active-first. `active` drives SPEED, `total` drives the
// download/RAM. The 16B is the guaranteed FLOOR — every tier at least this smart.
// quants: known Ollama sizes (GB) largest-first; the fit picker walks these down.
export const MOE_LADDER = [
  {
    id: "deepseek-coder-v2:16b", family: "deepseek-coder-v2", label: "DeepSeek-Coder-V2 16B",
    totalB: 15.7, activeB: 2.4, floor: true,
    quants: [
      { tag: "16b-lite-instruct-q8_0", q: "q8_0", gb: 16.7 },
      { tag: "16b-lite-instruct-q6_K", q: "q6_K", gb: 14.1 },
      { tag: "16b-lite-instruct-q5_K_M", q: "q5_K_M", gb: 11.9 },
      { tag: "16b-lite-instruct-q4_K_M", q: "q4_K_M", gb: 10.4 },
      { tag: "16b", q: "q4_0", gb: 8.9 },
      { tag: "16b-lite-instruct-q3_K_M", q: "q3_K_M", gb: 8.1 },
      { tag: "16b-lite-instruct-q2_K", q: "q2_K", gb: 6.4 },
    ],
  },
  {
    id: "qwen3-coder:30b", family: "qwen3-coder", label: "Qwen3-Coder 30B (A3B)",
    totalB: 30.5, activeB: 3.3,
    quants: [
      { tag: "30b-a3b-q8_0", q: "q8_0", gb: 32.5 },
      { tag: "30b-a3b-q6_K", q: "q6_K", gb: 25.1 },
      { tag: "30b-a3b-q5_K_M", q: "q5_K_M", gb: 21.7 },
      { tag: "30b", q: "q4_K_M", gb: 18.6 },
      { tag: "30b-a3b-q3_K_M", q: "q3_K_M", gb: 14.7 },
    ],
  },
  {
    // VERIFIED 2026-07-20 (ollama.com/library/qwen3-coder-next/tags — official, not a community
    // re-upload): 80B total / 3B active, the best active-param efficiency on this ladder (beats
    // even GLM-4.5-Air's 12B). Replaces an EARLIER "glm-4.5-air:106b" entry whose tags (106b-q4_K_M
    // etc.) turned out to be invented, not real — glm-4.5-air has no official Ollama library page
    // at all, only unverified community re-uploads with different tag names. Only 2 real quants
    // exist (no smaller one) — q8_0 pulls in more when the budget can actually hold it, q4_K_M is
    // the floor for a tight box (still needs heavy streaming at the declared MIN_VRAM_GB=4 floor,
    // but half the disk-read burden of q8_0 there).
    id: "qwen3-coder-next", family: "qwen3-coder-next", label: "Qwen3-Coder-Next 80B (A3B)",
    totalB: 80, activeB: 3,
    quants: [
      { tag: "q8_0", q: "q8_0", gb: 85 },
      { tag: "q4_K_M", q: "q4_K_M", gb: 52 },
    ],
  },
];

// ------------------------------------------------------------------ Ollama-free model tiers
// 2026-07-21: our BUNDLED llama-server (v9994+) already supports `-hf <repo>:<quant>` — direct
// Hugging Face download + cache + serve, no separate app. MEASURED (this session): Ollama's own
// daemon costs ~200-300MB idle RAM + ~0.5GB extra VRAM + a consistent 8-14% SLOWER inference than
// bare llama.cpp — real, measured resources on exactly the 8GB-RAM box this project targets. This
// is the foundation for dropping Ollama as a required dependency: three tiers, each a verified
// real Hugging Face repo (checked live this session, not guessed), launched directly.
//   flagship — Qwen3-Coder-Next 80B/3B-active, for the 4GB+ VRAM + 8GB+ RAM + SSD tier.
//   floor    — DeepSeek-Coder-V2-Lite-Instruct 16B/2.4B-active, the no-GPU 8GB-RAM floor.
//   helper   — Qwen2.5-Coder-1.5B-Instruct, the cheap judge/router used by EVERY tier.
// Honest scope note: this is the launch-layer foundation only. Migrating agent.mjs's
// resolveHelperModel/_askHelper and server.mjs's onboarding off Ollama is real follow-up work,
// not done in the same pass — see eta-ide-ollama-removal-foundation.md memory.
export const HF_MODELS = {
  // QUANT CHOICE (revised 2026-07-22, user pushback): IQ3_XXS was picked ONLY to size-match the
  // abandoned custom smol-IQ3_KS file, not for quality — bartowski's own repo rates it "lower
  // quality" and it sits near the BOTTOM of the 28 quants offered. User picked Q6_K ("very high
  // quality, near perfect" per bartowski) after seeing the full size/quality spectrum (IQ3_XXS
  // 31.7GB "lower quality" up to Q8_0 84.8GB "extremely high quality, max"), then upgraded to the
  // "_L" variant (Q6_K_L) once noticing it keeps embedding/output layers at Q8_0 for +0.15GB —
  // essentially free quality over plain Q6_K. This tier already accepts real SSD-streaming cost
  // by design (a real dGPU forces the biggest brain regardless of RAM+VRAM budget, per
  // recommendMoE's original big-brain-tier reasoning — quality matters more once you've already
  // accepted the streaming tradeoff) — a bigger, better quant is a strictly better fit for that
  // reasoning than the smaller one was.
  flagship: {
    label: "Qwen3-Coder-Next 80B (A3B)", family: "qwen3-coder-next", totalB: 80, activeB: 3,
    repo: "bartowski/Qwen_Qwen3-Coder-Next-GGUF", quant: "Q6_K_L", sizeGB: 65.94,
  },
  floor: {
    label: "DeepSeek-Coder-V2-Lite-Instruct 16B", family: "deepseek-coder-v2", totalB: 15.7, activeB: 2.4,
    repo: "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF", quant: "Q4_K_M", sizeGB: 10.4,
  },
  helper: {
    label: "Qwen2.5-Coder-1.5B-Instruct", family: "qwen2.5-coder-1.5b", totalB: 1.5, activeB: 1.5,
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF", quant: "Q4_K_M", sizeGB: 1.1,
  },
  // FIM (fill-in-the-middle, Tab-autocomplete) — 2026-07-23, Ollama-free migration. Deliberately
  // the BASE (non-instruct) 1.5B, not the same repo as `helper`: FIM needs raw prefix/suffix
  // completion via llama-server's native /infill endpoint, not chat-tuned behavior. Confirmed live
  // via HF: QuantFactory/Qwen2.5-Coder-1.5B-GGUF is the base quantization (Qwen's own model card:
  // "we do not recommend using base language models for conversations"), Q4_K_M ~0.99GB.
  fim: {
    label: "Qwen2.5-Coder-1.5B (FIM base)", family: "qwen2.5-coder-1.5b-fim", totalB: 1.5, activeB: 1.5,
    repo: "QuantFactory/Qwen2.5-Coder-1.5B-GGUF", quant: "Q4_K_M", sizeGB: 1.0,
  },
};
// A `rec`-shaped object for computeLlamaFlags/pickQuant, from an HF_MODELS entry.
export function hfRec(tier) {
  const m = HF_MODELS[tier];
  if (!m) return null;
  return { family: m.family, label: m.label, quant: m.quant, sizeGB: m.sizeGB, totalB: m.totalB, activeB: m.activeB, fits: true };
}
// ------------------------------------------------------------------ manually-placed model files
// TODO item closed 2026-07-23: the -hf mechanism had NO path to recognize a file the user already
// has (brought back from a phone/another PC) — it only knows how to pull+cache from HF itself.
// Checked two well-known folders, same relative-path convention findLlamaServer already uses for
// the bundled binary: console/models/ (new, portable — copied into the packaged fork same as
// vendor/) and ../llm/ (the existing dev-checkout convention, where the abandoned smol-IQ3_KS file
// already sits). Matched by FILENAME keyword (quant tag + family), not a manifest/checksum — the
// user is placing this file themselves; there's no portable manifest format worth parsing for it.
// ALSO scans for any sibling directory whose name starts with "llm" (case-insensitive) — a fixed
// dev checkout doesn't stay tidy when a real 65GB download comes from a browser/phone: it landed
// in "llm 2" (a second folder, not the original "llm"), which an exact-name check would have
// silently missed. Prefix match, not exact — future variants ("llm-2", "llm_backup") work too.
function localModelDirs() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const parent = path.join(here, "..");
  const found = new Set([path.join(here, "models"), path.join(parent, "llm")]);
  try {
    for (const ent of readdirSync(parent, { withFileTypes: true })) {
      if (ent.isDirectory() && /^llm/i.test(ent.name)) found.add(path.join(parent, ent.name));
    }
  } catch { /* parent unreadable — fall back to the two fixed candidates above */ }
  return [...found].filter((d) => existsSync(d));
}
// Pure matcher (no filesystem I/O) — given filenames already listed from a directory, find the
// best GGUF match for a tier by quant+family keyword, preferring a split file's first shard. A
// split GGUF (Q6_K_L's flagship quant ships as 2 shards, confirmed earlier: 39.7GB+26.3GB=66GB) is
// named "<name>-00001-of-00002.gguf" etc — llama.cpp's -m flag only needs the FIRST shard's path;
// it follows the rest by that naming convention on its own, same as the -hf path does. Exported
// standalone (separate from the directory-scanning wrapper below) specifically so this matching
// logic is unit-testable without ever touching a real model directory.
export function matchLocalModelFile(files, tier) {
  const m = HF_MODELS[tier];
  if (!m) return null;
  const quantTag = m.quant.toLowerCase();
  const familyHints = [...new Set([m.family, m.family.replace(/-/g, "_"), m.family.replace(/-/g, "")])].map((h) => h.toLowerCase());
  const candidates = (files || []).filter((f) => /\.gguf$/i.test(f) && f.toLowerCase().includes(quantTag) && familyHints.some((h) => f.toLowerCase().includes(h)));
  if (!candidates.length) return null;
  // Tolerate a browser/download-manager duplicate suffix ("name-00001-of-00002(3).gguf") on top
  // of the plain split-shard convention — the sort fallback below still orders shard 1 first
  // either way, but the regex should recognize both shapes rather than silently missing the newer one.
  return candidates.find((f) => /-00001-of-\d+(\(\d+\))?\.gguf$/i.test(f)) || candidates.sort()[0];
}
export async function findLocalModelFile(tier) {
  for (const dir of localModelDirs()) {
    let files; try { files = await fs.readdir(dir); } catch { continue; }
    const match = matchLocalModelFile(files, tier);
    if (match) return path.join(dir, match);
  }
  return null;
}
// Sibling to the removed llamaArgs() — same computed flags, but `-hf <repo>:<quant>` instead of
// `-m <path>` UNLESS a matching local file was found (localPath set), in which case it loads that
// file directly and skips the download/cache resolution entirely.
export function llamaArgsHF(tier, flags, port = 8722, localPath = null) {
  const m = HF_MODELS[tier];
  if (!m) throw new Error(`unknown model tier: ${tier}`);
  const a = localPath ? ["-m", localPath] : ["-hf", `${m.repo}:${m.quant}`];
  a.push("--port", String(port), "--host", "127.0.0.1",
    "-c", String(flags.numCtx), "-t", String(flags.threads), "-ngl", String(flags.ngl));
  if (flags.nCpuMoe > 0) a.push("--n-cpu-moe", String(flags.nCpuMoe));
  if (flags.overrideTensor) a.push("--override-tensor", flags.overrideTensor);
  if (flags.mlock) a.push("--mlock");
  if (flags.noMmap) a.push("--no-mmap");
  // LIVE-MEASURED 2026-07-23 (mixed-quant 80B, RTX 3060, budgeted 4GB VRAM): llama-server's own
  // "-fa auto" detection did NOT pick flash attention on this GPU/model/backend combo (4.17-4.23
  // tok/s) — forcing it explicitly on measured 4.80 tok/s (+15%), repeatable. KV cache quantization
  // (q8_0/q8_0) on top made prompt processing + first-token latency modestly but consistently
  // better (promptPerSec 3.11->3.27, firstTokenMs 3858->3672) at <0.1% published perplexity cost,
  // and halves KV cache memory (headroom for the future, even where the raw gen tok/s was a wash).
  // Both are universal, hardware-independent wins — not gated per VRAM tier like nCpuMoe.
  // NOT adopted: -b/-ub batch-size bumps (guides suggest 4096/4096 for CPU+GPU MoE, but measured
  // SLIGHTLY WORSE here at a conservative 1024/1024 — that advice assumes more VRAM headroom than
  // this project's tight-budget tiers have; left at llama.cpp's own defaults).
  a.push("-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0");
  return a;
}
// Launches an HF_MODELS tier directly, Ollama-free — reuses the SAME computeLlamaFlags/
// launchLlamaServer plumbing as the Ollama path, only the arg-builder and model source differ.
// Checks for an already-placed local file FIRST (instant, no network) before falling back to -hf.
export async function startModelHF(tier, hw, port, emit = () => {}) {
  const exe = findLlamaServer(hw);
  if (!exe) throw new Error("no bundled llama-server found");
  const rec = hfRec(tier);
  if (!rec) throw new Error(`unknown model tier: ${tier}`);
  const flags = computeLlamaFlags(hw, rec);
  const localPath = await findLocalModelFile(tier);
  const args = llamaArgsHF(tier, flags, port, localPath);
  if (localPath) emit(`found a local model file for ${rec.label} at ${localPath} — loading it directly, no download needed…`);
  else emit(`launching ${rec.label} (${HF_MODELS[tier].repo}:${HF_MODELS[tier].quant}) via -hf, no Ollama…`);
  // No download to wait through when a local file is found — but "no download" isn't the same
  // as "fast": a flat 60s assumed every local-file load was small (true for the ~1GB helper/fim
  // tiers, not for a 65GB flagship on a low-RAM box, where mmap setup + the backbone read alone
  // can take minutes). Scale with the model's own declared size instead of guessing one constant.
  const readyMs = localPath ? Math.max(60000, rec.sizeGB * 3000) : 300000;
  const h = await launchLlamaServer(exe, args, port, emit, readyMs);
  return { ...h, base: `http://127.0.0.1:${port}`, tier, flags, rec, localModel: !!localPath };
}

// ------------------------------------------------------------------ lazy on-demand helper server
// The RAM-math reason this is LAZY, not always-on: a permanently-running 1.5B helper process
// costs its own ~1-1.5GB continuously (weights + KV cache) — on the same tight 8GB floor box this
// project targets, that's a real bite out of the reserveGB() margin that keeps things from
// thrashing. Ollama's one-daemon-serves-many-models trick let the helper be "always available"
// for free; without it, launch on first actual use, keep it warm for reuse within the run, and
// let the caller shut it down when done (stopHelperServer) rather than leaving it resident forever.
let _helperHandle = null;
export function helperServerRunning() { return _helperHandle; }
export async function ensureHelperServer(hw, port = 8721, emit = () => {}) {
  if (_helperHandle && _helperHandle.proc?.exitCode == null) return _helperHandle;
  // ETA_NO_HELPER_LAUNCH=1 (set by test-system.mjs): a real launch downloads a ~1.1GB model
  // from HuggingFace and spawns llama-server — same reasoning test-moe.mjs already documents for
  // not exercising startModelHF's spawn path in unit tests. Without this guard, any test whose
  // mock Ollama doesn't list the small helper model (test-system.mjs's mock only returns
  // "mock:latest") falls through to a REAL multi-minute download mid-test-run.
  if (process.env.ETA_NO_HELPER_LAUNCH) throw new Error("helper launch disabled (ETA_NO_HELPER_LAUNCH)");
  _helperHandle = await startModelHF("helper", hw, port, emit);
  return _helperHandle;
}
export function stopHelperServer() { try { _helperHandle?.stop?.(); } catch {} _helperHandle = null; }

// Same lazy pattern as the helper tier, own process + own port (8723) — FIM (Tab-autocomplete,
// 2026-07-23 Ollama migration) needs its own tiny base-model instance, separate from both the
// main brain (8722) and the instruct-tuned helper/judge (8721): three small, independent
// llama-server processes rather than one daemon serving many models (Ollama's old trick).
let _fimHandle = null;
export function fimServerRunning() { return _fimHandle; }
export async function ensureFimServer(hw, port = 8723, emit = () => {}) {
  if (_fimHandle && _fimHandle.proc?.exitCode == null) return _fimHandle;
  if (process.env.ETA_NO_HELPER_LAUNCH) throw new Error("fim launch disabled (ETA_NO_HELPER_LAUNCH)");
  _fimHandle = await startModelHF("fim", hw, port, emit);
  return _fimHandle;
}
export function stopFimServer() { try { _fimHandle?.stop?.(); } catch {} _fimHandle = null; }

// MINIMUM SUPPORTED SPEC (declared 2026-07-20): 8GB RAM + a real 4GB+ VRAM dGPU. Below this,
// Eta IDE still runs (the floor model streams via mmap) but is NOT the supported experience —
// per the Colibri research (github.com/JustVugg/colibri, July 2026), leaning on raw SSD/mmap
// streaming for an INTERACTIVE agent that makes many model calls per task is impractical
// (measured: 0.05-1 tok/s for an extreme oversized-model case) — a real 4GB+ GPU lets the
// CPU/GPU expert-offload split (fast: RAM<->VRAM over PCIe) do the heavy lifting instead of
// disk reads. A pure-iGPU or <8GB box is the "streams, but slow" tier, not the target spec.
export const MIN_RAM_GB = 8;
export const MIN_VRAM_GB = 4;
export function meetsMinSpec(hw) {
  const ram = hw?.ramGB || 0;
  const vram = (hw?.gpu && ["nvidia", "amd"].includes(hw.gpu.vendor)) ? (hw.gpu.vramGB || 0) : 0;
  const ramOk = ram >= MIN_RAM_GB, vramOk = vram >= MIN_VRAM_GB;
  const reasons = [];
  if (!ramOk) reasons.push(`${ram}GB RAM (need ${MIN_RAM_GB}GB+)`);
  if (!vramOk) reasons.push(vram ? `${vram}GB VRAM (need ${MIN_VRAM_GB}GB+)` : "no dedicated GPU detected (need a 4GB+ VRAM dGPU)");
  return { ok: ramOk && vramOk, ramOk, vramOk, reasons };
}

// REMOVED 2026-07-22 (dead code cleanup): reserveGB/memBudgetGB/pickQuant/recommendMoE were the
// hardware->Ollama-tag recommendation engine for the pre-HF onboarding flow. Confirmed via grep
// (zero call sites in server.mjs/agent.mjs/ui.html beyond their own definitions) that nothing
// live has called this cluster since onboarding switched to recommendHFTier/recommendHF/
// startMainModelHF (Ollama-free, see below) — real, working code that got orphaned by its own
// successor rather than removed at the time. MOE_LADDER itself is KEPT: moeSpecForModel (still
// live, used by agent.mjs for context-budget math) depends on it directly.

// ------------------------------------------------------------------ llama.cpp flags
// Compute the offload/pin flags for llama-server for this hardware + chosen model.
//   ngl        : layers offloaded to GPU (0 on iGPU — shared RAM, no benefit)
//   nCpuMoe    : keep expert FFN of the first N layers on CPU/RAM (the streamed part)
//   overrideTensor: force expert FFN tensors to CPU by regex (attention stays fast)
//   mlock      : lock resident weights so the OS can't page them out (pin hot parts)
//   threads    : leave one core for the OS
export function computeLlamaFlags(hw, rec) {
  const ram = hw?.ramGB || 8;
  const g = hw?.gpu || null;
  const realGpu = g && ["nvidia", "amd"].includes(g.vendor) && (g.vramGB || 0) >= 4;
  const threads = Math.max(2, (hw?.cpus || 4) - 1);
  // MoE layer counts (approx) so nCpuMoe can be sized; deepseek-v2-lite=27, qwen3-30b=48, glm-air=46.
  const layers = rec?.family === "qwen3-coder" ? 48 : rec?.family === "qwen3-coder-next" ? 48 : 27;

  let ngl = 0, nCpuMoe = layers, overrideTensor = "";
  if (realGpu) {
    ngl = 999; // all layers offloaded to the GPU
    const vram = g.vramGB || 0;
    const size = rec?.sizeGB || 99;
    if (size <= vram * 0.85) {
      // whole model fits in VRAM → keep EVERYTHING on the GPU (fastest, no CPU offload).
      nCpuMoe = 0;
    } else {
      // too big for VRAM → push the big expert FFN tensors to CPU/RAM (attention stays on
      // GPU: fast + small; experts are big + used less). llama.cpp MoE-offload sweet spot.
      //
      // FIXED 2026-07-23 (live-measured bug): this used to branch on flat VRAM-tier fractions
      // (vram>=12 -> 40% of layers on CPU, etc) PLUS an always-on blanket --override-tensor
      // regex matching every layer's expert tensors unconditionally. Real test on this box
      // (RTX 3060 12GB, real 65.94GB Q6_K_L file): the 40%-of-layers value (nCpuMoe=19, i.e.
      // 29 "resident" layers) does NOT actually fit — removing the blanket regex and passing
      // --n-cpu-moe 19 ALONE crashed with a real Vulkan OutOfDeviceMemory error. The blanket
      // regex was silently rescuing the broken value by re-forcing every layer back onto CPU
      // regardless of --n-cpu-moe, which meant the tier heuristic was DEAD CODE for a model
      // this size — production wasn't crashing, but it also wasn't achieving any real GPU
      // residency beyond the (already GPU-resident-by-default) backbone, which is why speed
      // sat at the same ~2.0-2.1 tok/s as pure CPU-streaming.
      // FIX: use ONE precise formula for every VRAM tier (previously only the <8GB "min-spec"
      // branch got this), and DROP the blanket override-tensor — --n-cpu-moe already generates
      // its own correctly-scoped per-layer rules internally; the extra regex was never needed
      // and was actively masking the bug. LIVE-MEASURED result of this exact fix on the same
      // box/file: nCpuMoe 19->42, tok/s 2.1->2.63 (+25%), promptPerSec 1.59->2.05 (+29%),
      // firstTokenMs 7527->5867 (+22% faster) — real, free improvement, no regression risk
      // (the old value was already unsafe, just silently papered over).
      const BACKBONE_GB_ESTIMATE = 1.8; // measured on qwen3-coder-next mixed Q4/Q2 quant: ~1.7GB
                                        // of 31.7GB total (experts are ~90%+ of file size) —
                                        // non-expert backbone size is near-fixed regardless of
                                        // expert quant level, so this estimate travels across tiers.
      // KV/compute overhead scales with context size (bigger numCtx -> bigger KV cache in VRAM).
      // numCtx tiers mirror the ones computed below; 16384 confirmed safe at 0.5GB live on this
      // box, 32768 (16GB+ tier) is untested so budgeted more conservatively.
      const KV_COMPUTE_OVERHEAD_GB = vram >= 16 ? 1.5 : 0.5;
      const freeForExpertsGB = Math.max(0, vram * 0.85 - BACKBONE_GB_ESTIMATE - KV_COMPUTE_OVERHEAD_GB);
      const perLayerExpertGB = (size * 0.9) / layers; // experts ≈90%+ of total file size
      const residentLayers = perLayerExpertGB > 0 ? Math.min(layers, Math.floor(freeForExpertsGB / perLayerExpertGB)) : 0;
      nCpuMoe = Math.max(0, layers - residentLayers);
    }
  }
  // iGPU / CPU-only: everything streams from RAM via mmap (the OS pages experts in/out).
  // mlock PINS the whole model resident — powerful, but on a tight box it starves the OS
  // and FREEZES the machine (learned the hard way: q2_K 6.4GB pinned on 9GB RAM hung the
  // PC). So only pin when there's a comfortable RAM cushion left for the OS + KV-cache +
  // llama-server overhead. Otherwise rely on mmap streaming — slower but SAFE.
  const MLOCK_HEADROOM_GB = 3.0;
  const sizeGB = rec?.sizeGB || 99;
  const mlock = rec?.fits === true && (ram - sizeGB) >= MLOCK_HEADROOM_GB;
  // Small boxes keep ctx tight — a big KV-cache steals the RAM the model needs to stay resident.
  // This was RAM-only and ignored VRAM entirely — MEASURED (boltons Test 1, 2026-07-20): this
  // exact box (9GB RAM, RTX 3060 12GB VRAM) got numCtx=4096 despite full GPU offload (ngl=999),
  // and a multi-step add-function task hit "prompt is longer than the context length" on its
  // later steps as a direct result. When ngl=999 (realGpu, whole model offloaded), the KV cache
  // lives in VRAM, not system RAM — so a real 4GB+ dGPU (the declared MIN_VRAM_GB floor) should
  // NOT be capped by the RAM-only tier. Bump one VRAM-aware tier when a real GPU is present;
  // RAM still gates the CPU-only/iGPU case where the KV cache genuinely does compete with the
  // model for system RAM. NOTE: reasoned from "KV cache follows the offloaded device" — not yet
  // stress-tested for OOM at the new ceiling; verify live before trusting it on a new box.
  let numCtx = ram <= 9 ? 4096 : ram <= 16 ? 8192 : 16384;
  if (realGpu) {
    const vram = g.vramGB || 0;
    numCtx = vram >= 16 ? 32768 : vram >= 8 ? 16384 : 8192; // vram>=4 (the floor) -> 8192
  }
  return { ngl, nCpuMoe, overrideTensor, mlock, threads, numCtx, noMmap: false };
}

// REMOVED 2026-07-22: llamaArgs (the "-m <local path>" argv builder) was only ever called by
// startMoeTurbo, below, which is also removed — see that note for why. llamaArgsHF (the "-hf
// <repo>:<quant>" sibling, used by the live startModelHF path) is unaffected and stays.

// ------------------------------------------------------------------ profile (REMEMBER)
export function profilePath(root) { return path.join(root || ".", ".eta", "moe-profile.json"); }

export async function loadMoeProfile(root) {
  try { return JSON.parse(await fs.readFile(profilePath(root), "utf8")); } catch { return null; }
}
export async function saveMoeProfile(root, profile) {
  try {
    await fs.mkdir(path.join(root || ".", ".eta"), { recursive: true });
    await fs.writeFile(profilePath(root), JSON.stringify(profile, null, 2));
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ llama-server discovery
// Bundled first (ships with the IDE for zero-config). Prefer the Vulkan build when the box
// has ANY usable GPU (NVIDIA/AMD/Intel iGPU) — one backend accelerates all of them; else the
// portable CPU build. Falls back to PATH.
// Real benchmark (2026-07-24, this exact box, official Q6_K_L 80B, identical flags): CUDA vs
// Vulkan is TIER-DEPENDENT for Nvidia, NOT a blanket win — +26% tok/s (1.76->2.22) at the ~4GB
// VRAM floor, but -28% (2.93->2.11, WORSE) at the real 12GB tier, where Vulkan's own flash-attn+
// KV-quant tuning already wins on raw generation speed (CUDA only edges ahead on prefill there).
// CUDA is also Nvidia-ONLY — AMD/Intel users can never use it, Vulkan stays their only backend
// regardless of VRAM. The <8GB cutoff reuses the SAME tier boundary computeLlamaFlags already
// draws elsewhere (its min-spec/numCtx tiers) — only this narrow <8GB band is actually
// benchmarked; 8-16GB is unverified territory, so default to Vulkan (already known-good) there
// rather than assume CUDA's 4GB-tier win generalizes upward.
export function preferCudaBackend(hw) {
  const g = hw?.gpu || null;
  return !!(g && g.vendor === "nvidia" && (g.vramGB || 0) > 0 && g.vramGB < 8);
}
// Our optional CUDA build was compiled/linked against this CUDA version (see the 2026-07-24
// build note above) — a driver reporting less than this cannot run it correctly.
export const REQUIRED_CUDA_VERSION = "13.2";
// Pure, unit-testable: does the driver's reported max-supported CUDA version (nvidia-smi's plain
// banner, e.g. "13.2") meet what our optional CUDA binary needs? Compared as [major, minor]
// numeric tuples, NOT string/lexicographic comparison — "13.10" must rank above "13.2", which a
// plain string compare would get backwards. Deliberately READ-ONLY: this only decides whether to
// OFFER the CUDA path, never triggers installing or updating anything — driver management is
// left entirely to the user via NVIDIA's own updater (see the 2026-07-24 "detect + recommend
// only" decision — auto-installing/updating a display driver is a real, hard-to-undo system risk
// this project explicitly chose not to take on).
export function meetsCudaVersion(installedVersion, requiredVersion = REQUIRED_CUDA_VERSION) {
  const parse = (v) => String(v ?? "").split(".").map((n) => parseInt(n, 10));
  const [iMaj, iMin] = parse(installedVersion);
  const [rMaj, rMin] = parse(requiredVersion);
  if (!Number.isFinite(iMaj) || !Number.isFinite(rMaj)) return false;
  if (iMaj !== rMaj) return iMaj > rMaj;
  return (iMin || 0) >= (rMin || 0);
}
export function findLlamaServer(hw = null) {
  const exe = os.platform() === "win32" ? "llama-server.exe" : "llama-server";
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const g = hw?.gpu || null;
  const preferVulkan = g && ["nvidia", "amd", "intel"].includes(g.vendor);
  // Vendor/VRAM tier says CUDA would help AND the driver actually supports our build — both must
  // hold, since preferring a backend the driver can't run would be worse than just staying on the
  // universally-working Vulkan path.
  const preferCuda = preferCudaBackend(hw) && meetsCudaVersion(g?.cudaVersion);
  const dirs = preferCuda
    ? ["vendor/llama.cpp-cuda", "vendor/llama.cpp-vulkan", "vendor/llama.cpp", "vendor"]
    : preferVulkan
    ? ["vendor/llama.cpp-vulkan", "vendor/llama.cpp", "vendor"]
    : ["vendor/llama.cpp", "vendor/llama.cpp-vulkan", "vendor"];
  for (const d of dirs) {
    const c = path.join(here, ...d.split("/"), exe);
    if (existsSync(c)) return c;
  }
  const up = path.join(here, "..", "vendor", "llama.cpp", exe);
  return existsSync(up) ? up : null; // caller falls back to Ollama with the fit-quant tag
}

// REMOVED 2026-07-22: ollamaModelsDir/resolveOllamaGguf (locate a pulled Ollama tag's .gguf blob)
// were only ever used by startMoeTurbo, below, also removed — zero other call sites confirmed via
// grep. The live path (startModelHF, further down) downloads/serves directly via llama-server's
// own `-hf` flag and never needs to find a GGUF inside Ollama's blob store at all.

// ------------------------------------------------------------------ MoE Turbo backend (residual)
// startMoeTurbo (launch a pulled Ollama MoE tag directly via llama-server) is REMOVED 2026-07-22 —
// confirmed via grep zero production call sites since onboarding switched to the Ollama-free
// startModelHF path below. What's left here is genuinely still live: moeBackendRunning/
// stopMoeTurbo manage _turboHandle, which startModelHF ALSO populates (same handle, either launch
// path), so /api/moe/status and /api/moe/stop keep working unchanged regardless of which function
// started the server. moeSpecForModel is separately live (agent.mjs uses it for context-budget
// math against whatever model is actually configured, unrelated to the onboarding recommendation).
let _turboHandle = null;
export function moeBackendRunning() { return _turboHandle; }
export function moeSpecForModel(model) {
  const base = String(model).split(":")[0];
  const tag = String(model).split(":")[1] || "";
  const m = MOE_LADDER.find((x) => x.family === base || x.id.split(":")[0] === base);
  if (!m) return null;
  const q = m.quants.find((qq) => tag === qq.tag || tag.endsWith(qq.tag) || model.endsWith(qq.tag)) || m.quants[m.quants.length - 1];
  return { model: m.id, family: m.family, label: m.label, quant: q.q, sizeGB: q.gb, totalB: m.totalB, activeB: m.activeB, fits: true };
}
export function stopMoeTurbo() { try { _turboHandle?.stop?.(); } catch {} _turboHandle = null; }

// ------------------------------------------------------------------ Ollama-free MAIN MODEL launch
// 2026-07-22: onboarding no longer needs Ollama at all — the SAME `-hf` mechanism proven on the
// helper tier now serves the main brain too. The user explicitly decided to DROP the old ladder's
// middle 30B rung for this path (no verified HF repo for it, and the extra machine-profile
// coverage wasn't worth the added complexity) — so the pick is a clean BINARY: a real dGPU
// (MIN_VRAM_GB+) gets the flagship 80B (SSD-streamed experts, same Colibri-backed reasoning as
// recommendMoE's hasMinGpu branch); everything else gets the 16B floor. No model-tag picking, no
// Ollama pull, no GGUF lookup in Ollama's blob store — startModelHF handles download+serve itself.
export function recommendHFTier(hw) {
  const g = hw?.gpu || null;
  const hasMinGpu = g && ["nvidia", "amd"].includes(g.vendor) && (g.vramGB || 0) >= MIN_VRAM_GB;
  return hasMinGpu ? "flagship" : "floor";
}
// UI-facing recommendation — shaped like the old Ollama-ladder recommendModel()'s consumers
// expect (server.mjs's hwProfile()/`/api/hardware`, ui.html's onboarding card): `model`/`tier`/
// `mode`/`sizeGB` for display text, `numCtx`/`maxParallel` for the engine to size itself.
export function recommendHF(hw) {
  const tier = recommendHFTier(hw);
  const rec = hfRec(tier);
  const flags = computeLlamaFlags(hw, rec);
  const vram = hw?.gpu?.vramGB || 0, cpus = hw?.cpus || 0;
  const maxParallel = tier === "flagship" && vram >= 12 ? 3 : tier === "flagship" && vram >= 8 ? 2 : cpus >= 12 ? 2 : 1;
  return {
    tier, model: rec.label, sizeGB: rec.sizeGB, totalB: rec.totalB, activeB: rec.activeB,
    mode: tier === "flagship" ? "standard" : "lite",
    reason: tier === "flagship" ? `${vram}GB+ dGPU detected — the flagship MoE brain, SSD-streamed experts as needed` : "no qualifying dGPU — the 16B floor, sized to run on RAM alone",
    numCtx: flags.numCtx, maxParallel, turbo: flags,
  };
}
// Launch the MAIN brain directly from Hugging Face — picks the tier from hardware alone (no
// user model choice needed now that there's only 2 rungs) and populates the SAME module-level
// _turboHandle that moeBackendRunning/stopMoeTurbo manage, so /api/moe/status and /api/moe/stop
// keep working unchanged regardless of which function launched the backend.
export async function startMainModelHF(hw, port = 8722, emit = () => {}) {
  const tier = recommendHFTier(hw);
  const h = await startModelHF(tier, hw, port, emit);
  _turboHandle = h;
  return h;
}

// ------------------------------------------------------------------ speed probe (PROOF)
// Measures real tokens/sec against an OpenAI-compatible or Ollama endpoint so tuning
// decisions (and the user-facing verdict) are grounded in measurement, never a guess.
export async function measureTokPerSec(base, model, opts = {}) {
  const prompt = opts.prompt || "Write a Python function is_prime(n). Only the code.";
  const numGpu = opts.numGpu;
  const t0 = Date.now();
  let firstMs = null, evalCount = 0, evalNs = 0, text = "";
  const body = { model, prompt, stream: true, options: { num_predict: opts.maxTokens || 120, ...(numGpu != null ? { num_gpu: numGpu } : {}) } };
  const res = await fetch(`${base}/api/generate`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs || 180000) });
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    for (const line of dec.decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.response) { if (firstMs == null) firstMs = Date.now() - t0; text += o.response; }
      if (o.done) { evalCount = o.eval_count || 0; evalNs = o.eval_duration || 0; }
    }
  }
  const tokPerSec = evalNs ? evalCount / (evalNs / 1e9) : 0;
  return { tokPerSec: +tokPerSec.toFixed(2), firstTokenMs: firstMs, tokens: evalCount, totalMs: Date.now() - t0, sample: text.slice(0, 80) };
}

// ------------------------------------------------------------------ auto-tune (lever 4)
// The offload sweet spot ("how many layers' experts to keep off the GPU") is hardware-
// specific and, per every guide, found by trial-and-error. We automate it: probe a few
// nCpuMoe candidates, measure real tok/s at each, keep the fastest. `measureFn(nCpuMoe)`
// returns a tok/s number (the caller wires it to a real launch+probe or, in tests, a mock).
// Early-stops once speed stops improving so we never waste probes.
export async function autoTune(baseFlags, layers, measureFn, emit = () => {}) {
  // Candidate ladder: all-CPU (safest), then progressively fewer expert layers on CPU
  // (more on GPU) — bounded, deduped, descending. The first three steps below `layers`
  // (layers-1/-2/-3) are FINE-grained on purpose: a tight (4-8GB) VRAM budget only has
  // room for a handful of whole expert-layers on GPU, and the coarser ×0.7/×0.5/×0.25
  // steps below jump ~25% of all layers at once — enough VRAM to blow straight past a
  // small card's budget and skip over the narrow window that actually fits.
  const raw = [
    layers, layers - 1, layers - 2, layers - 3,
    Math.round(layers * 0.7), Math.round(layers * 0.5), Math.round(layers * 0.25), 0,
  ];
  const candidates = [...new Set(raw.filter((n) => n >= 0 && n <= layers))].sort((a, b) => b - a);
  let best = null;
  for (const nCpuMoe of candidates) {
    emit(`tuning: trying --n-cpu-moe ${nCpuMoe}…`);
    let tok = 0;
    try { tok = await measureFn(nCpuMoe); } catch { tok = 0; }
    emit(`  ${nCpuMoe} -> ${tok.toFixed(1)} tok/s`);
    if (!best || tok > best.tokPerSec) best = { nCpuMoe, tokPerSec: tok };
    // Fewer-CPU candidates only help with real GPU headroom; if speed dropped vs best, stop.
    else if (tok < best.tokPerSec * 0.9) break;
  }
  return { ...baseFlags, nCpuMoe: best.nCpuMoe, tunedTokPerSec: +best.tokPerSec.toFixed(2) };
}

// Verdict thresholds for interactive agent use.
export function speedVerdict(tokPerSec) {
  if (tokPerSec >= 10) return { level: "good", emoji: "✅", note: "usable for agent work" };
  if (tokPerSec >= 4) return { level: "workable", emoji: "🟡", note: "slow but workable" };
  return { level: "tooslow", emoji: "🔴", note: "too slow for agent work" };
}

// ------------------------------------------------------------------ live launcher
// Spawn llama-server with the given argv; resolve once it answers /health. Returns a
// handle { proc, port, stop() }. The caller keeps it running as the MoE backend.
export async function launchLlamaServer(serverExe, args, port, emit = () => {}, readyMs = 120000) {
  const { spawn } = await import("child_process");
  emit(`launching llama-server on :${port}…`);
  const proc = spawn(serverExe, args, { windowsHide: true });
  proc.stderr?.on("data", (d) => { const s = String(d); if (/error|failed|cannot/i.test(s)) emit("llama: " + s.trim().slice(0, 200)); });
  const t0 = Date.now();
  while (Date.now() - t0 < readyMs) {
    if (proc.exitCode != null || proc.signalCode != null) throw new Error(`llama-server exited early (code ${proc.exitCode})`);
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (h.ok) { emit(`llama-server ready on :${port}`); return { proc, port, stop: () => { try { proc.kill(); } catch {} } }; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  try { proc.kill(); } catch {}
  throw new Error("llama-server did not become ready in time");
}

// Measure tok/s against a live llama-server via its native /completion timings.
export async function measureLlamaTokPerSec(port, opts = {}) {
  const prompt = opts.prompt || "Write a Python function is_prime(n). Only the code.";
  const body = { prompt, n_predict: opts.maxTokens || 120, temperature: 0.2, stream: false };
  const r = await fetch(`http://127.0.0.1:${port}/completion`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs || 180000) });
  const o = await r.json();
  const t = o.timings || {};
  return {
    tokPerSec: +(t.predicted_per_second || 0).toFixed(2),
    promptPerSec: +(t.prompt_per_second || 0).toFixed(2),
    firstTokenMs: t.prompt_ms != null ? Math.round(t.prompt_ms) : null, // prefill time = time-to-first-token
    tokens: t.predicted_n || 0, sample: String(o.content || "").slice(0, 80),
  };
}

const _pexec = (cmd, args, ms = 15000) => new Promise((r) => {
  const c = execFile(cmd, args, { timeout: ms, windowsHide: true }, (e, so, se) => r({ code: e?.code ?? 0, stdout: so || "", stderr: se || "" }));
  c.on("error", () => r({ code: -1, stdout: "", stderr: "spawn error" }));
});
export { _pexec as _execFileP };
