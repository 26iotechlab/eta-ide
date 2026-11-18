// test-all.mjs — runs every FAST test file (test-*.mjs) one after another and prints one line per file.
// "Fast" = no real model, no GPU, no internet. Files that need those are listed in SKIP with the reason.
// A new test-*.mjs file is picked up automatically; add it to SKIP only when it needs a model / GPU / internet.
// Run: node test-all.mjs            all fast files
//      node test-all.mjs edit moe   only files whose name contains one of these words
//      node test-all.mjs --strict   known old failures also make the exit code 1
//      node test-all.mjs --list     show what would run and what is skipped, run nothing
// Exit code 0 = no NEW failure. One file at a time (memory is tight; some files open one headless browser).
import fs from "fs"; import path from "path"; import { spawn, spawnSync } from "child_process"; import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));

const SKIP = {
  "test-sse.mjs": "a helper for the slow tests, not a test",
  "test-all.mjs": "this file",
  "test-colibri-e2e.mjs": "needs the real 35B model file and the GPU",
  "test-student-e2e.mjs": "needs the real 35B model file and the GPU",
  "test-terminal-e2e.mjs": "needs the real 35B model file and the GPU",
  "test-chat-honesty.mjs": "needs the real 35B model file and the GPU",
  "test-hallucination.mjs": "needs the real 35B model file and the GPU",
  "test-known-errors.mjs": "needs the real 35B model file and the GPU",
  "test-console.mjs": "needs a running engine on port 8710 with a model",
  "test-multiagent.mjs": "needs a running engine on port 8710 with a model",
  "test-catalog.mjs": "needs the internet (starts a web tool and downloads an npx tool)",
  "test-webmcp.mjs": "prints its results only, it has no pass/fail checks",
};
// Per-file time limit in seconds (default 120). A file that runs longer is stopped and counted as failed.
const TIMEOUT = { "test-system.mjs": 420, "test-engine.mjs": 300, "test-security.mjs": 240, "test-ui-phase1.mjs": 180, "test-ui-phase2.mjs": 180, "test-ui-phase3.mjs": 180, "test-host.mjs": 180, "test-leftovers.mjs": 180, "test-hardening.mjs": 180, "test-cloudfirst.mjs": 180 };
// Failures that existed BEFORE 2026-11-15 and are not fixed yet. They are shown every time, never hidden.
// Do not add to this list to make a new failure go away: fix the code or the test instead.
const KNOWN_FAIL = {}; // 2026-11-15: all 5 old test-system failures fixed, none left

const args = process.argv.slice(2), strict = args.includes("--strict"), listOnly = args.includes("--list"), words = args.filter((a) => !a.startsWith("--"));
const all = fs.readdirSync(here).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
const todo = all.filter((f) => !SKIP[f] && (!words.length || words.some((w) => f.includes(w))));
if (listOnly) { for (const f of all) console.log((SKIP[f] ? "skip  " : "run   ") + f + (SKIP[f] ? "   (" + SKIP[f] + ")" : "")); process.exit(0); }

function runOne(file) {
  return new Promise((done) => {
    const limit = (TIMEOUT[file] || 120) * 1000, t0 = Date.now(); let out = "", timedOut = false;
    const ch = spawn(process.execPath, [file], { cwd: here, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    ch.stdout.on("data", (d) => (out += d)); ch.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { timedOut = true; // stop exactly this test and what it started, nothing else
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(ch.pid), "/T", "/F"], { windowsHide: true }); else ch.kill("SIGKILL"); }, limit);
    ch.on("close", (code) => { clearTimeout(timer); done({ file, code, out, timedOut, secs: Math.round((Date.now() - t0) / 1000) }); });
    ch.on("error", (e) => { clearTimeout(timer); done({ file, code: 1, out: out + String(e), timedOut, secs: 0 }); });
  });
}
function judge(r) {
  const lines = r.out.split(/\r?\n/);
  const failLines = lines.filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.replace(/^\s*FAIL\s+/, "").trim());
  const sums = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)], sum = sums[sums.length - 1];
  const passed = sum ? +sum[1] : lines.filter((l) => /^\s*PASS\b/.test(l)).length;
  const failed = sum ? +sum[2] : failLines.length;
  const known = KNOWN_FAIL[r.file] || [];
  const newFails = failLines.filter((l) => !known.some((k) => l.startsWith(k)));
  const knownHit = failLines.filter((l) => known.some((k) => l.startsWith(k)));
  const skippedSelf = /^SKIPPED:/m.test(r.out) && !sum;
  let state;
  if (r.timedOut) state = "TIMEOUT";
  else if (skippedSelf && r.code === 0) state = "SKIPPED";
  else if (r.code === 0 && failed === 0) state = "PASS";
  // non-zero exit: fine ONLY when every failing check is on the known list and the counts agree
  else if (failed > 0 && newFails.length === 0 && knownHit.length === failed) state = "KNOWN";
  else state = "FAIL";
  return { ...r, passed, failed, newFails, knownHit, state };
}

console.log(`Running ${todo.length} fast test file(s), one at a time. Skipped: ${all.length - todo.length}${words.length ? " (filter: " + words.join(", ") + ")" : ""}.\n`);
const results = [];
for (const f of todo) {
  const r = judge(await runOne(f)); results.push(r);
  console.log(`${r.state.padEnd(8)} ${f.padEnd(28)} ${String(r.passed).padStart(5)} passed ${String(r.failed).padStart(3)} failed ${String(r.secs).padStart(4)}s` + (r.state === "KNOWN" ? "   (only failures from the known list)" : r.state === "TIMEOUT" ? `   (stopped after ${TIMEOUT[f] || 120}s)` : ""));
  if (r.state === "FAIL" || r.state === "TIMEOUT") {
    for (const l of r.newFails.slice(0, 12)) console.log("           NEW FAIL: " + l.slice(0, 260));
    if (!r.newFails.length) console.log("           last lines: " + r.out.trim().split(/\r?\n/).slice(-4).join(" | ").slice(0, 500));
  }
}
const by = (s) => results.filter((r) => r.state === s);
const totalPass = results.reduce((a, r) => a + r.passed, 0), totalFail = results.reduce((a, r) => a + r.failed, 0);
console.log(`\n========== files: ${by("PASS").length} passed, ${by("FAIL").length + by("TIMEOUT").length} failed, ${by("KNOWN").length} with known failures only, ${by("SKIPPED").length} skipped themselves ==========`);
console.log(`checks: ${totalPass} passed, ${totalFail} failed`);
for (const r of by("KNOWN")) { console.log(`known old failures in ${r.file} (${r.knownHit.length}, not fixed yet):`); for (const l of r.knownHit) console.log("  - " + l.slice(0, 200)); }
for (const r of results) { const gone = (KNOWN_FAIL[r.file] || []).filter((k) => !r.knownHit.some((l) => l.startsWith(k))); if (gone.length && !r.timedOut) console.log(`note: these known failures of ${r.file} pass now, remove them from KNOWN_FAIL: ${gone.join("; ")}`); }
console.log("not run (need a model, GPU, internet, or are not tests): " + Object.keys(SKIP).filter((f) => f !== "test-all.mjs" && all.includes(f)).join(", "));
const bad = by("FAIL").length + by("TIMEOUT").length + (strict ? by("KNOWN").length : 0);
process.exit(bad ? 1 : 0);
