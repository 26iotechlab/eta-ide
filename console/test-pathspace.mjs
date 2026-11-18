// Test: the engine finds its own files when the install folder has a SPACE in it, like "...\Programs\Eta IDE" (2026-11-14).
// Old code used new URL(import.meta.url).pathname, which leaves "%20" in the path, so llama-server.exe (the local model server) was never found.
// Copies moe.mjs into a temp folder with a space. NO model, NO GPU.  Run: node test-pathspace.mjs
import fs from "fs"; import os from "os"; import path from "path"; import { pathToFileURL } from "url";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/%20/g, " "));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta space test "));
const con = path.join(root, "Eta IDE", "console"); fs.mkdirSync(path.join(con, "vendor", "llama.cpp"), { recursive: true });
fs.copyFileSync(path.join(here, "moe.mjs"), path.join(con, "moe.mjs"));
const exe = os.platform() === "win32" ? "llama-server.exe" : "llama-server";
fs.writeFileSync(path.join(con, "vendor", "llama.cpp", exe), "fake");
const m = await import(pathToFileURL(path.join(con, "moe.mjs")).href);
const found = m.findLlamaServer(null);
ok(/ /.test(con), "the test folder really has a space in its name", con);
ok(found && path.normalize(found) === path.normalize(path.join(con, "vendor", "llama.cpp", exe)), "llama-server is found inside a folder with a space", found);
ok(found && !/%20/.test(found), "the path has no %20 in it", found);
// the source files must not bring the old pattern back
for (const f of ["moe.mjs", "server.mjs"]) {
  const src = fs.readFileSync(path.join(here, f), "utf8");
  ok(!/new URL\(import\.meta\.url\)\.pathname/.test(src), `${f}: no new URL(import.meta.url).pathname`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
