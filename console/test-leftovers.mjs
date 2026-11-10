// Test: a server the agent started must not outlive a HARD-killed engine, and a new engine must never stop the
// servers of another engine that is still running. Windows only. No model needed. 2026-11-10.
import fs from "fs"; import os from "os"; import path from "path"; import { spawn, spawnSync } from "child_process";
let pass = 0, fail = 0;
const ok = (c, n, g = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${g})`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "eta-left-home-")), ws = fs.mkdtempSync(path.join(os.tmpdir(), "eta-left-ws-"));
const env = { ...process.env, USERPROFILE: home, HOME: home };
const T = new URL("./terminal.mjs", import.meta.url).href;
// a small "engine": starts one server through Eta's runner, then waits forever
const engine = (port) => spawn(process.execPath, ["--input-type=module", "-e",
  `const t = await import(${JSON.stringify(T)}); const r = await t.startProcess(${JSON.stringify(ws)}, 'node -e "require(\\'http\\').createServer((q,s)=>s.end(\\'up\\')).listen(${port},()=>console.log(\\'listening on http://localhost:${port}\\'))"');
   await new Promise((x) => setTimeout(x, 4000)); console.log("READY " + r.ok); setInterval(() => {}, 1000);`], { env, stdio: ["ignore", "pipe", "inherit"] });
const up = async (port) => { try { return (await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) })).text()) === "up"; } catch { return false; } };
const ready = (p) => new Promise((r) => { let b = ""; p.stdout.on("data", (d) => { b += d; if (/READY/.test(b)) r(/READY true/.test(b)); }); setTimeout(() => r(false), 30000); });

console.log("== engine killed hard");
const e1 = engine(8811);
ok(await ready(e1), "the engine started a server in the background");
ok(await up(8811), "the server answers");
ok(fs.readdirSync(path.join(home, ".eta-ide")).some((f) => f === `procs-${e1.pid}.json`), "the engine wrote down what it started");
spawnSync("taskkill", ["/F", "/PID", String(e1.pid)], { stdio: "ignore" }); await sleep(1500); // hard kill, only the engine (no /T)
ok(await up(8811), "after the hard kill the server is still running (the old bug)");

console.log("== a second engine is running at the same time");
const e2 = engine(8812);
ok(await ready(e2), "a second engine started its own server");

console.log("== a new engine starts");
const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const t = await import(${JSON.stringify(T)}); console.log("STOPPED " + await t.cleanupLeftovers());`], { env, encoding: "utf8" });
await sleep(1500);
ok(/STOPPED [1-9]/.test(r.stdout), "it stops what the dead engine left", r.stdout.trim());
ok(!(await up(8811)), "the left-over server is gone");
ok(await up(8812), "the server of the engine that is still running is NOT touched");
ok(!fs.existsSync(path.join(home, ".eta-ide", `procs-${e1.pid}.json`)), "the dead engine's list is removed");

spawnSync("taskkill", ["/F", "/T", "/PID", String(e2.pid)], { stdio: "ignore" });
spawnSync(process.execPath, ["--input-type=module", "-e", `const t = await import(${JSON.stringify(T)}); await t.cleanupLeftovers();`], { env });
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
