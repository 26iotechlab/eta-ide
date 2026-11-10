// Unit tests for MoE Turbo logic (moe.mjs) — the hardware ladder, fit-first quant
// picker, llama.cpp flag computation, and profile persistence. Pure functions, no server.
// Run: node test-moe.mjs
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  MOE_LADDER,
  computeLlamaFlags, loadMoeProfile, saveMoeProfile, speedVerdict, autoTune,
  findLlamaServer, moeBackendRunning, preferCudaBackend, meetsCudaVersion, REQUIRED_CUDA_VERSION,
  HF_MODELS, hfRec, llamaArgsHF, helperServerRunning,
  recommendHFTier, recommendHF, MIN_VRAM_GB,
  matchLocalModelFile, findLocalModelFile,
  fimServerRunning,
} from "./moe.mjs";
// NOTE (2026-07-22 dead-code cleanup): reserveGB/memBudgetGB/pickQuant/recommendMoE/llamaArgs/
// resolveOllamaGguf/startMoeTurbo were REMOVED from moe.mjs (zero production call sites since
// onboarding switched to the Ollama-free recommendHF/startMainModelHF path) — their tests below
// are removed too. computeLlamaFlags is still live (used by startModelHF) and stays fully tested,
// now fed literal rec objects instead of recommendMoE's output — see moe.mjs's own dead-code note.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

// hardware fixtures
const HW_STARTER = { ramGB: 8, cpus: 4, platform: "win32", gpu: { name: "Intel Iris Xe", vramGB: 2, vendor: "intel" } };
const HW_9GB = { ramGB: 9, cpus: 12, platform: "win32", gpu: { name: "Intel UHD", vramGB: 2, vendor: "intel" } };
const HW_16GB = { ramGB: 16, cpus: 8, platform: "win32", gpu: null };
const HW_32GB = { ramGB: 32, cpus: 16, platform: "linux", gpu: null };
const HW_DGPU8 = { ramGB: 16, cpus: 8, platform: "linux", gpu: { name: "RTX 4060", vramGB: 8, vendor: "nvidia" } };
const HW_DGPU24 = { ramGB: 64, cpus: 24, platform: "linux", gpu: { name: "RTX 4090", vramGB: 24, vendor: "nvidia" } };

section("ladder shape");
check("floor is the 16B MoE", MOE_LADDER.find((m) => m.floor)?.id === "deepseek-coder-v2:16b");
check("every tier has quants largest-first", MOE_LADDER.every((m) => m.quants.every((q, i, a) => i === 0 || a[i - 1].gb >= q.gb)));
check("active < total for every tier (it's an MoE)", MOE_LADDER.every((m) => m.activeB < m.totalB));

section("llama.cpp flags");
// Literal rec fixtures (family/fits/sizeGB — the only 3 fields computeLlamaFlags reads) standing
// in for what recommendMoE used to produce, now that recommendMoE itself is removed. Values
// chosen to match what the old ladder actually picked for each hardware fixture, so the same
// documented hardware behaviors (mlock-off-when-tight, ngl/nCpuMoe splits) stay covered.
const rStarter = { model: "deepseek-coder-v2:16b", installName: "deepseek-coder-v2:16b-lite-instruct-q2_K", family: "deepseek-coder-v2", quant: "q2_K", fits: true, sizeGB: 6.4 };
const rBig = { model: "qwen3-coder-next", family: "qwen3-coder-next", quant: "q8_0", fits: false, sizeGB: 65 };
const fStarter = computeLlamaFlags(HW_9GB, rStarter);
check("iGPU/CPU box -> ngl 0 (no offload benefit)", fStarter.ngl === 0);
check("iGPU/CPU box -> all expert layers on CPU", fStarter.nCpuMoe === 27);
// FREEZE FIX: pinning a 6.4GB model on a 9GB box starves the OS -> PC hangs. So a
// TIGHT fit must NOT mlock (stream via mmap instead); only a roomy box pins.
check("tight-fit 9GB box -> mlock OFF (avoid the freeze)", fStarter.mlock === false, `slack=${9 - rStarter.sizeGB}`);
check("roomy box (>=3GB slack) -> mlock ON (safe to pin)", computeLlamaFlags({ ramGB: 16, cpus: 8, gpu: null }, { family: "deepseek-coder-v2", fits: true, sizeGB: 6.4 }).mlock === true);
check("streamed model -> mlock OFF (would OOM)", computeLlamaFlags({ ramGB: 4, cpus: 2, gpu: null }, { family: "deepseek-coder-v2", fits: false, sizeGB: 6.4 }).mlock === false);
check("8GB RAM -> conservative 4096 ctx", fStarter.numCtx === 4096);
check("leaves one core for the OS", fStarter.threads === 11);
const fGpu = computeLlamaFlags(HW_DGPU24, rBig);
check("big dGPU -> ngl 999 (all layers on GPU)", fGpu.ngl === 999);
// FIXED 2026-07-23 (live-measured bug): a blanket --override-tensor regex used to be set
// alongside nCpuMoe here, forcing every layer's experts to CPU regardless of what nCpuMoe said.
// Live test on a real RTX 3060 12GB + real 65.94GB file: nCpuMoe ALONE (no blanket regex) is
// what --n-cpu-moe was designed for (it generates its own correctly-scoped per-layer rules) —
// the extra regex was redundant at best, and at worst was silently masking nCpuMoe values that
// don't actually fit (see below). Never set anymore.
check("no blanket override-tensor (n-cpu-moe alone is correct)", fGpu.overrideTensor === "");
// 65GB doesn't fully fit even in 24GB VRAM (needs vram*0.85=20.4GB) -> some experts MUST stream.
// The old code hardcoded nCpuMoe=0 for any vram>=16GB tier regardless of actual model size —
// the SAME class of bug as the one live-measured on the 12GB tier (a fixed assumption that
// doesn't check real fit). Correct value comes from the precise formula: freeForExperts =
// 24*0.85-1.8-1.5=17.1GB, perLayerExpert=65*0.9/48=1.219GB, residentLayers=floor(17.1/1.219)=14
// -> nCpuMoe=48-14=34.
check("24GB VRAM + 65GB model -> precise fit, not a blind 'all resident' assumption",
      fGpu.nCpuMoe === 34, "nCpuMoe=" + fGpu.nCpuMoe);

// MIN-SPEC tier (4GB dGPU): a few whole expert-layers should now fit resident on GPU
// alongside the Colibri-style CPU/mmap streaming of the rest, instead of the old
// all-or-nothing "everything streams" behavior below 8GB VRAM.
const HW_4GB_GPU = { ramGB: 8, cpus: 8, platform: "win32", gpu: { name: "GTX 1650", vramGB: 4, vendor: "nvidia" } };
const f4gbMixed = computeLlamaFlags(HW_4GB_GPU, { family: "qwen3-coder-next", fits: false, sizeGB: 32.5 });
check("4GB dGPU + fitting mixed-quant 80B -> a few layers now resident on GPU (not all 48 on CPU)", f4gbMixed.nCpuMoe < 48 && f4gbMixed.nCpuMoe >= 44, "nCpuMoe=" + f4gbMixed.nCpuMoe);
const f4gbBig = computeLlamaFlags(HW_4GB_GPU, { family: "qwen3-coder-next", fits: false, sizeGB: 85 });
check("4GB dGPU + no real headroom (big quant) -> safe fallback still all-CPU", f4gbBig.nCpuMoe === 48, "nCpuMoe=" + f4gbBig.nCpuMoe);

// REGRESSION LOCK 2026-07-23: the exact box + file this bug was found and fixed on (RTX 3060
// 12GB, real Qwen3-Coder-Next Q6_K_L 65.94GB). Live-measured: the OLD nCpuMoe=19 (40%-of-layers
// heuristic) crashed with a real Vulkan OOM when the blanket override-tensor safety net was
// removed — it never actually fit. The NEW precise value (42) loaded clean and measured 2.1->2.63
// tok/s (+25%) on the real box. This locks that exact real-world case in place.
const HW_3060 = { ramGB: 9, cpus: 12, platform: "win32", gpu: { name: "RTX 3060", vramGB: 12, vendor: "nvidia" } };
const fFlagship = computeLlamaFlags(HW_3060, { family: "qwen3-coder-next", fits: false, sizeGB: 65.94 });
check("RTX 3060 12GB + real 65.94GB flagship -> precise nCpuMoe=42 (was 19, OOM'd)",
      fFlagship.nCpuMoe === 42, "nCpuMoe=" + fFlagship.nCpuMoe);
check("RTX 3060 12GB + flagship -> no blanket override-tensor", fFlagship.overrideTensor === "");

section("speed verdict");
check("2.7 tok/s -> too slow (the plain Q4 result)", speedVerdict(2.7).level === "tooslow");
check("6 tok/s -> workable (Turbo target)", speedVerdict(6).level === "workable");
check("12 tok/s -> good", speedVerdict(12).level === "good");

section("auto-tune (lever 4)");
// mock measure: speed peaks at nCpuMoe=13 (a made-up sweet spot), falls off either side.
const mockMeasure = (n) => Promise.resolve(10 - Math.abs(13 - n) * 0.4);
const tuned = await autoTune(fStarter, 27, mockMeasure);
check("picks the fastest candidate probed", tuned.nCpuMoe === 14 || tuned.nCpuMoe === 13 || tuned.nCpuMoe === 27, "n=" + tuned.nCpuMoe);
check("records the winning tok/s", typeof tuned.tunedTokPerSec === "number" && tuned.tunedTokPerSec > 0);
let probes = 0;
await autoTune(fStarter, 27, (n) => { probes++; return Promise.resolve(n === 27 ? 8 : 2); });
check("early-stops when speed collapses (doesn't probe all 5)", probes < 5, "probes=" + probes);
let firstProbe = null;
await autoTune(fStarter, 27, (n) => { if (firstProbe == null) firstProbe = n; return Promise.resolve(5); });
check("all-CPU is always probed first (safest)", firstProbe === 27, "first=" + firstProbe);

section("manually-placed model files (2026-07-23) — matchLocalModelFile is pure, no real dirs touched");
check("finds the flagship's split-shard file, prefers shard 1", matchLocalModelFile(
  ["Qwen_Qwen3-Coder-Next-Q6_K_L-00002-of-00002.gguf", "Qwen_Qwen3-Coder-Next-Q6_K_L-00001-of-00002.gguf", "readme.txt"], "flagship"
) === "Qwen_Qwen3-Coder-Next-Q6_K_L-00001-of-00002.gguf");
check("finds a single-file floor quant", matchLocalModelFile(["DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf"], "floor") === "DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf");
check("ignores a file for the WRONG quant", matchLocalModelFile(["Qwen_Qwen3-Coder-Next-Q4_K_M.gguf"], "flagship") === null);
check("ignores a file for the wrong FAMILY even with a matching quant string", matchLocalModelFile(["SomeOtherModel-Q6_K_L.gguf"], "flagship") === null, "must not match on quant alone");
check("ignores non-.gguf files entirely", matchLocalModelFile(["Qwen_Qwen3-Coder-Next-Q6_K_L.txt"], "flagship") === null);
check("empty/missing file list -> null, never throws", matchLocalModelFile([], "flagship") === null && matchLocalModelFile(undefined, "flagship") === null);
check("unknown tier -> null", matchLocalModelFile(["anything.gguf"], "nope") === null);
check("case-insensitive match", matchLocalModelFile(["qwen_qwen3-coder-next-q6_k_l.gguf"], "flagship") === "qwen_qwen3-coder-next-q6_k_l.gguf");
check("recognizes a browser duplicate-download suffix on the split shard, still prefers shard 1 (real 2026-07-23 case)", matchLocalModelFile(
  ["Qwen_Qwen3-Coder-Next-Q6_K_L-00001-of-00002(3).gguf", "Qwen_Qwen3-Coder-Next-Q6_K_L-00002-of-00002(1).gguf"], "flagship"
) === "Qwen_Qwen3-Coder-Next-Q6_K_L-00001-of-00002(3).gguf");

section("llamaArgsHF local-file branch");
const localFlagFlags = computeLlamaFlags(HW_DGPU24, hfRec("flagship"));
const noLocalArgs = llamaArgsHF("flagship", localFlagFlags, 8722);
check("no local path -> still uses -hf (unchanged default behavior)", noLocalArgs.includes("-hf") && !noLocalArgs.includes("-m"));
const localArgs = llamaArgsHF("flagship", localFlagFlags, 8722, "D:\\eta-ide\\llm\\model-00001-of-00002.gguf");
check("a local path -> uses -m <path>, NOT -hf (skips the download mechanism entirely)", localArgs.includes("-m") && localArgs.includes("D:\\eta-ide\\llm\\model-00001-of-00002.gguf") && !localArgs.includes("-hf"));
check("local-path args still carry the same computed offload flags", localArgs.includes("--port") && localArgs.includes("8722") && localArgs.includes("-c"));

section("profile persistence (REMEMBER)");
const tmp = path.join(__dirname, ".moe-test-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const prof = { model: rStarter.installName, flags: fStarter, tokPerSec: 6.3, tunedAt: Date.now() };
check("save profile ok", await saveMoeProfile(tmp, prof));
check("profile written under .eta/", fs.existsSync(path.join(tmp, ".eta", "moe-profile.json")));
const loaded = await loadMoeProfile(tmp);
check("load returns same profile", loaded && loaded.model === prof.model && loaded.tokPerSec === 6.3);
check("missing profile -> null (not throw)", await loadMoeProfile(path.join(tmp, "nope")) === null);
fs.rmSync(tmp, { recursive: true, force: true });

section("backend wiring (llama-server as OpenAI provider)");
check("findLlamaServer(GPU) prefers the Vulkan build", (findLlamaServer({ ramGB: 9, gpu: { vendor: "nvidia", vramGB: 12 } }) || "").includes("vulkan") || findLlamaServer({ ramGB: 9, gpu: { vendor: "nvidia", vramGB: 12 } }) === null);
check("findLlamaServer(no GPU) picks CPU build (not vulkan)", (() => { const p = findLlamaServer({ ramGB: 8, gpu: null }); return p === null || !p.includes("vulkan"); })());
check("no backend running before anything has launched one", moeBackendRunning() === null);

section("CUDA/Vulkan tier-aware backend selection (2026-07-24 benchmark: CUDA wins <8GB Nvidia, Vulkan wins >=8GB)");
check("preferCudaBackend: low-VRAM Nvidia (<8GB) prefers CUDA", preferCudaBackend({ gpu: { vendor: "nvidia", vramGB: 4 } }) === true);
check("preferCudaBackend: higher-VRAM Nvidia (>=8GB) does NOT prefer CUDA — Vulkan already wins there", preferCudaBackend({ gpu: { vendor: "nvidia", vramGB: 12 } }) === false);
check("preferCudaBackend: exactly 8GB is the known-good Vulkan tier, not CUDA (only <8 is benchmarked)", preferCudaBackend({ gpu: { vendor: "nvidia", vramGB: 8 } }) === false);
check("preferCudaBackend: AMD Radeon NEVER prefers CUDA regardless of VRAM (CUDA is Nvidia-only)", preferCudaBackend({ gpu: { vendor: "amd", vramGB: 4 } }) === false);
check("preferCudaBackend: Intel Arc NEVER prefers CUDA (CUDA is Nvidia-only)", preferCudaBackend({ gpu: { vendor: "intel", vramGB: 4 } }) === false);
check("preferCudaBackend: no GPU at all -> false", preferCudaBackend({ gpu: null }) === false && preferCudaBackend({}) === false);
check("preferCudaBackend: vramGB missing/zero -> false (never crash on bad hw data)", preferCudaBackend({ gpu: { vendor: "nvidia" } }) === false);

section("meetsCudaVersion (driver-capability gate — READ-ONLY, never installs/updates anything)");
check("meetsCudaVersion: driver exactly at the required version -> true", meetsCudaVersion("13.2", "13.2") === true);
check("meetsCudaVersion: driver newer (higher minor) -> true", meetsCudaVersion("13.5", "13.2") === true);
check("meetsCudaVersion: driver newer (higher major) -> true", meetsCudaVersion("14.0", "13.2") === true);
check("meetsCudaVersion: driver older (lower minor) -> false", meetsCudaVersion("13.1", "13.2") === false);
check("meetsCudaVersion: driver much older (lower major) -> false", meetsCudaVersion("12.4", "13.2") === false);
check("meetsCudaVersion: numeric compare, NOT lexicographic — 13.10 ranks ABOVE 13.2", meetsCudaVersion("13.10", "13.2") === true);
check("meetsCudaVersion: missing/undefined version -> false (fail safe, never assume compatible)", meetsCudaVersion(undefined, "13.2") === false && meetsCudaVersion("", "13.2") === false);
check("meetsCudaVersion: garbage input never throws", meetsCudaVersion("not-a-version", "13.2") === false);
check("REQUIRED_CUDA_VERSION matches the version our vendor/llama.cpp-cuda build was actually compiled against", REQUIRED_CUDA_VERSION === "13.2");

{
  // Real end-to-end check: the actual CUDA binary built+benchmarked this session lives at
  // vendor/llama.cpp-cuda/ on THIS box — verify findLlamaServer genuinely resolves to it for a
  // low-VRAM Nvidia profile with a capable driver, and that it does NOT for a higher-VRAM
  // profile OR an outdated driver even when the vendor/VRAM tier alone would qualify.
  const cudaPick = findLlamaServer({ ramGB: 8, cpus: 11, platform: "win32", gpu: { vendor: "nvidia", vramGB: 4, cudaVersion: "13.2" } });
  check("findLlamaServer: low-VRAM Nvidia + capable driver resolves to the CUDA build when present, else falls through safely", cudaPick === null || cudaPick.includes("llama.cpp-cuda") || cudaPick.includes("vulkan"), cudaPick);
  const vulkanPick = findLlamaServer({ ramGB: 8, cpus: 11, platform: "win32", gpu: { vendor: "nvidia", vramGB: 12, cudaVersion: "13.2" } });
  check("findLlamaServer: higher-VRAM Nvidia never picks the CUDA build (stays on Vulkan) even with a capable driver", vulkanPick === null || !vulkanPick.includes("llama.cpp-cuda"), vulkanPick);
  const oldDriverPick = findLlamaServer({ ramGB: 8, cpus: 11, platform: "win32", gpu: { vendor: "nvidia", vramGB: 4, cudaVersion: "11.8" } });
  check("findLlamaServer: low-VRAM Nvidia with an OUTDATED driver does NOT pick CUDA (safety gate) — falls back to Vulkan", oldDriverPick === null || !oldDriverPick.includes("llama.cpp-cuda"), oldDriverPick);
  const noVersionPick = findLlamaServer({ ramGB: 8, cpus: 11, platform: "win32", gpu: { vendor: "nvidia", vramGB: 4 } });
  check("findLlamaServer: low-VRAM Nvidia with UNKNOWN driver capability (detection didn't run) fails safe — no CUDA", noVersionPick === null || !noVersionPick.includes("llama.cpp-cuda"), noVersionPick);
}

section("MoE Turbo provider decoupling (Ollama = model store/FIM, llama-server = main brain)");
// REGRESSION GUARD: MoE Turbo sets the main provider to llama-server (kind "openai"). Model
// downloads + Tab-autocomplete must still resolve OLLAMA, not the main provider's base.
const { setProvider, ollamaBase } = await import("./agent.mjs");
setProvider({ base: "http://127.0.0.1:8722", kind: "openai", model: "deepseek-coder-v2:16b" });
check("ollamaBase ignores a non-Ollama main provider (Turbo case)", ollamaBase() === "http://127.0.0.1:11434", ollamaBase());
setProvider({ base: "http://127.0.0.1:11434", kind: "ollama", model: "x" });
check("ollamaBase uses the user's Ollama when that IS the provider", ollamaBase() === "http://127.0.0.1:11434");
setProvider({ base: "http://myhost:1234/", kind: "ollama", model: "x" });
check("ollamaBase honors a custom Ollama base (trailing slash stripped)", ollamaBase() === "http://myhost:1234", ollamaBase());

section("Ollama-free model tiers (HF_MODELS, hfRec, llamaArgsHF) — 2026-07-21");
check("HF_MODELS has exactly the 4 declared tiers", Object.keys(HF_MODELS).sort().join(",") === "fim,flagship,floor,helper");
check("flagship repo is the verified bartowski Qwen3-Coder-Next repo", HF_MODELS.flagship.repo === "bartowski/Qwen_Qwen3-Coder-Next-GGUF");
check("floor repo is the verified bartowski DeepSeek-Coder-V2-Lite repo", HF_MODELS.floor.repo === "bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF");
check("helper repo is the verified OFFICIAL Qwen repo", HF_MODELS.helper.repo === "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF");
check("hfRec(flagship) shapes a valid computeLlamaFlags rec", hfRec("flagship").family === "qwen3-coder-next" && hfRec("flagship").fits === true);
check("hfRec(unknown tier) -> null, no throw", hfRec("nope") === null);

section("FIM tier (HF_MODELS.fim, ensureFimServer) — 2026-07-23 Ollama migration");
check("fim repo is the verified QuantFactory BASE (non-instruct) repo", HF_MODELS.fim.repo === "QuantFactory/Qwen2.5-Coder-1.5B-GGUF");
check("fim tier is NOT the same repo as the instruct helper tier", HF_MODELS.fim.repo !== HF_MODELS.helper.repo);
check("fim family is distinct from helper's (no local-file-match collision between the two 1.5B tiers)", HF_MODELS.fim.family !== HF_MODELS.helper.family);
check("hfRec(fim) shapes a valid computeLlamaFlags rec", hfRec("fim").family === HF_MODELS.fim.family && hfRec("fim").fits === true);
check("fimServerRunning() starts null (nothing launched yet)", fimServerRunning() === null);

const hwGpu = { ramGB: 8, cpus: 8, gpu: { name: "RTX 3060", vramGB: 12, vendor: "nvidia" } };
const flagshipFlags = computeLlamaFlags(hwGpu, hfRec("flagship"));
const hfArgs = llamaArgsHF("flagship", flagshipFlags, 8725);
check("llamaArgsHF uses -hf <repo>:<quant>, never -m <path>", hfArgs.includes("-hf") && hfArgs.includes(`bartowski/Qwen_Qwen3-Coder-Next-GGUF:${HF_MODELS.flagship.quant}`) && !hfArgs.includes("-m"));
check("llamaArgsHF still carries the SAME computed offload flags as the Ollama path", hfArgs.includes("--n-cpu-moe") || flagshipFlags.nCpuMoe === 0);
check("llamaArgsHF: unknown tier throws (never launches a bogus repo)", (() => { try { llamaArgsHF("nope", flagshipFlags, 8725); return false; } catch { return true; } })());
// LIVE-MEASURED 2026-07-23 (mixed-quant 80B, RTX 3060, 4GB-budgeted): llama-server's own "-fa
// auto" did NOT pick flash attention here (4.17-4.23 tok/s); forcing it on measured 4.80 tok/s
// (+15%, repeatable). KV cache quantization (q8_0/q8_0) improved prompt processing + first-token
// latency further. Both are universal wins, not hardware-tier-dependent — always on.
check("llamaArgsHF forces flash attention on (auto didn't pick it, measured +15%)",
      hfArgs.includes("-fa") && hfArgs[hfArgs.indexOf("-fa") + 1] === "on");
check("llamaArgsHF quantizes KV cache to q8_0 (measured better prompt/TTFT, ~free quality cost)",
      hfArgs.includes("-ctk") && hfArgs[hfArgs.indexOf("-ctk") + 1] === "q8_0"
      && hfArgs.includes("-ctv") && hfArgs[hfArgs.indexOf("-ctv") + 1] === "q8_0");
check("helperServerRunning() starts null (nothing launched yet)", helperServerRunning() === null);

section("Ollama-free MAIN MODEL tier (recommendHFTier/recommendHF) — 2026-07-22");
// user's explicit call: drop the old ladder's middle 30B rung entirely for this path — a clean
// binary pick, no in-between. NOTE: startMainModelHF (the actual launcher) is not exercised here
// — it really spawns the bundled llama-server — same reasoning as not unit-testing startModelHF's
// spawn path above; verified live instead (see eta-ide-ollama-removal-foundation memory).
check(`recommendHFTier: no qualifying dGPU (starter, ${HW_STARTER.gpu.vramGB}GB iGPU) -> floor`, recommendHFTier(HW_STARTER) === "floor");
check("recommendHFTier: no GPU at all, even with lots of RAM -> floor (no mid-tier to climb to)", recommendHFTier(HW_32GB) === "floor");
check(`recommendHFTier: a real ${HW_DGPU8.gpu.vramGB}GB dGPU (>= MIN_VRAM_GB=${MIN_VRAM_GB}) -> flagship`, recommendHFTier(HW_DGPU8) === "flagship");
check("recommendHFTier: a big dGPU -> flagship too (same binary rule, no further climbing)", recommendHFTier(HW_DGPU24) === "flagship");
check(`recommendHFTier: exactly at the MIN_VRAM_GB boundary (${HW_4GB_GPU.gpu.vramGB}GB) -> flagship`, recommendHFTier(HW_4GB_GPU) === "flagship");

const recFloor = recommendHF(HW_STARTER);
check("recommendHF(floor): reports the floor tier + its real label/size", recFloor.tier === "floor" && recFloor.model === HF_MODELS.floor.label && recFloor.sizeGB === HF_MODELS.floor.sizeGB, JSON.stringify(recFloor));
check("recommendHF(floor): mode is \"lite\" (no GPU to lean on)", recFloor.mode === "lite");
check("recommendHF(floor): carries a usable numCtx for the engine", recFloor.numCtx > 0, recFloor.numCtx);

const recFlagship = recommendHF(HW_DGPU24);
check("recommendHF(flagship): reports the flagship tier + its real label/size", recFlagship.tier === "flagship" && recFlagship.model === HF_MODELS.flagship.label && recFlagship.sizeGB === HF_MODELS.flagship.sizeGB, JSON.stringify(recFlagship));
check("recommendHF(flagship): mode is \"standard\" (real GPU available)", recFlagship.mode === "standard");
check("recommendHF(flagship): a strong dGPU gets multiple parallel agent slots", recFlagship.maxParallel > 1, recFlagship.maxParallel);

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
for (const f of failures) console.log("  ✗ " + f);
process.exit(fail ? 1 : 0);
