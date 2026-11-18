// Test: Python for Eta Engine (E1, 2026-11-13). No model, no GPU, no network, no server.
// Run: node test-python.mjs   (from D:\eta-ide\project\console)
import fs from "fs"; import os from "os"; import path from "path"; import crypto from "crypto";
import { spawnSync } from "child_process"; import { createRequire } from "module";
import { pythonCandidates } from "./colibri.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const B = "X:/bundled/python.exe";

// ---- search order (pure) ----
let c = pythonCandidates({}, B, () => true);
ok(c[0][0] === B && c[1][0] === "python" && c[2][0] === "python3" && c[3][0] === "py" && c.length === 4, "bundled Python first, then python, python3, py", c);
c = pythonCandidates({}, B, () => false);
ok(c[0][0] === "python" && c.length === 3, "no bundled Python: only the PC's own Pythons are tried", c);
c = pythonCandidates({ ETA_PYTHON: "D:/my/python.exe" }, B, () => true);
ok(c.length === 1 && c[0][0] === "D:/my/python.exe", "ETA_PYTHON (the user's choice) wins and is the only one tried", c);

// ---- the pinned download is the right file, and it really runs the engine's launcher ----
const buildSrc = fs.readFileSync(path.join(here, "..", "build-eta.mjs"), "utf8");
const pin = /const PYV = \{ version: "([^"]+)", size: (\d+), sha256: "([0-9a-f]{64})" \}/.exec(buildSrc);
ok(!!pin, "build-eta.mjs has a pinned Python (version, size, SHA-256)");
const zip = pin ? path.join(here, "..", "eta-layer", "python", `python-${pin[1]}-embed-amd64.zip`) : "";
if (pin && fs.existsSync(zip)) {
  const buf = fs.readFileSync(zip);
  ok(buf.length === Number(pin[2]), "cached zip has the pinned size", buf.length);
  ok(crypto.createHash("sha256").update(buf).digest("hex") === pin[3], "cached zip matches the pinned SHA-256");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-py-"));
  try {
    const AdmZip = createRequire(path.join(here, "package.json"))("adm-zip");
    new AdmZip(zip).extractAllTo(tmp, true);
    const py = path.join(tmp, "python.exe");
    ok(fs.existsSync(py), "python.exe is in the package");
    let r = spawnSync(py, ["-I", "-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 20000, windowsHide: true });
    ok(r.status === 0 && String(r.stdout).trim() === "3", "the bundled Python starts (Python 3)", r.stderr);
    const coli = path.join(here, "engine", "coli");
    if (fs.existsSync(coli)) {
      r = spawnSync(py, ["-I", coli, "--help"], { encoding: "utf8", timeout: 60000, windowsHide: true, cwd: os.tmpdir() });
      ok(r.status === 0 && /usage: coli/.test(String(r.stdout)), "the engine's launcher runs with the bundled Python (--help)", String(r.stderr).slice(0, 200));
    } else console.log("  SKIP  engine launcher not found in console/engine");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
} else console.log("  SKIP  cached Python zip not found (the build downloads it)");
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
