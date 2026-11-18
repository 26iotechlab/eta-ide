// Test: safe defaults (B4, 2026-11-13) — the agent asks before editing or running commands unless the user opts in.
// No model, no server start, no network. Run: node test-defaults.mjs
import fs from "fs"; import os from "os"; import path from "path";
import { autoApproveDefault } from "./defaults.mjs";
import { Agent } from "./agent.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const read = (f) => fs.readFileSync(path.join(here, f), "utf8");

ok(autoApproveDefault({}) === false, "no environment setting: auto-approve is OFF");
ok(autoApproveDefault({ ETA_AUTO_APPROVE: "0" }) === false, "ETA_AUTO_APPROVE=0: off");
ok(autoApproveDefault({ ETA_AUTO_APPROVE: "true" }) === false, "only the exact value 1 turns it on");
ok(autoApproveDefault({ ETA_AUTO_APPROVE: "1" }) === true, "ETA_AUTO_APPROVE=1: on (for scripts and tests)");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-defaults-"));
try {
  ok(new Agent(root, {}).autoApprove === false, "Agent without an option: asks first");
  ok(new Agent(root, { autoApprove: true }).autoApprove === true, "Agent told autoApprove:true: hands-free");
  ok(new Agent(root, { autoApprove: false }).autoApprove === false, "Agent told autoApprove:false: asks first");
} finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }

const srv = read("server.mjs");
ok(!/autoApprove \?\? true/.test(srv), "server.mjs has no old 'autoApprove ?? true' default left");
ok((srv.match(/autoApprove \?\? AUTO_APPROVE_DEFAULT/g) || []).length >= 6, "server.mjs uses the one shared default in every place that starts a run", (srv.match(/autoApprove \?\? AUTO_APPROVE_DEFAULT/g) || []).length);
const ui = read("ui.html");
const chip = (ui.match(/<input type="checkbox" id="auto"[^>]*>/) || [""])[0];
ok(chip && !/\bchecked\b/.test(chip), "panel: 'Edit automatically' starts unticked", chip);
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
