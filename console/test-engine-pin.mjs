// Test: the engine pin (B4, 2026-11-13). Temp folders only. NO model, NO server. Also checks the real console/engine against the real pin.
// Run: node test-engine-pin.mjs
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import { hashTree, makePin, checkPin, readPin } from "./engine-pin.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-pin-"));
const W = (r, t) => { const f = path.join(d, r); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
W("coli", "launcher"); W("lib/a.py", "print(1)"); W("lib/__pycache__/a.cpython-313.pyc", "junk"); W("x.pyc", "junk");
const t = hashTree(d); ok(t.map((f) => f.path).join() === "coli,lib/a.py", "the files are listed in a fixed order; __pycache__ and .pyc are left out", t.map((f) => f.path));
ok(t[0].sha256.length === 64 && t[0].size === 8, "each file has its size and a SHA-256");
const pin = makePin(d, { version: "9.9" }); ok(pin.version === "9.9" && pin.name === "Colibri" && pin.files.length === 2, "a pin has name, version and files");
ok(checkPin(d, pin).ok, "an unchanged folder matches");
W("lib/__pycache__/b.pyc", "more junk"); ok(checkPin(d, pin).ok, "new cache files do not matter");
W("coli", "launcher2"); let r = checkPin(d, pin); ok(!r.ok && r.problems.some((p) => /size differs: coli/.test(p)), "a changed file (other size) is found", r.problems);
W("coli", "LAUNCHER"); r = checkPin(d, pin); ok(!r.ok && r.problems.some((p) => /content differs: coli/.test(p)), "a changed file (same size) is found", r.problems);
W("coli", "launcher"); fs.rmSync(path.join(d, "lib/a.py")); r = checkPin(d, pin); ok(!r.ok && r.problems.includes("missing: lib/a.py"), "a missing file is found", r.problems);
W("lib/a.py", "print(1)"); W("extra.exe", "?"); r = checkPin(d, pin); ok(!r.ok && r.problems.includes("not in the pin: extra.exe"), "an extra file is found", r.problems);
ok(!checkPin(d, null).ok && !checkPin(d, { files: [] }).ok && !checkPin(path.join(d, "nope"), pin).ok, "no pin, an empty pin or no folder: not ok");
fs.rmSync(d, { recursive: true, force: true });
// the real engine of this project
const real = readPin(); ok(real && real.files.length > 50 && real.version === "2.1.0", "engine-pin.json exists (Colibri 2.1.0)", real && [real.files.length, real.version]);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const rr = checkPin(path.join(here, "engine"), real); ok(rr.ok, "the real console/engine matches its pin", rr.problems.slice(0, 5));
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
