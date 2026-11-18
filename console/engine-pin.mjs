// Pin of the bundled streaming engine (B4, 2026-11-13). The engine in console/engine is third-party code (Colibri, Apache-2.0).
// engine-pin.json lists every file with its size and SHA-256. The build checks the copy that goes into the IDE against it, so a
// changed, damaged or half-updated engine can never ship without notice. To take a new engine version on purpose:
//   node engine-pin.mjs write      (after replacing the files in console/engine; update the version text in eta-layer/third-party-eta.txt)
//   node engine-pin.mjs check      (compares console/engine with engine-pin.json; exit code 1 on any difference)
import * as fs from "fs"; import * as path from "path"; import { createHash } from "crypto"; import { fileURLToPath } from "url";

const SKIP_DIRS = new Set(["__pycache__"]);
const SKIP_EXT = new Set([".pyc"]);

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), base, out); }
    else if (e.isFile() && !SKIP_EXT.has(path.extname(e.name))) out.push(path.relative(base, path.join(dir, e.name)).split(path.sep).join("/"));
  }
  return out;
}
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// [{path,size,sha256}] for every file under dir
export function hashTree(dir) {
  return walk(dir).map((p) => { const f = path.join(dir, p); return { path: p, size: fs.statSync(f).size, sha256: sha(f) }; });
}
export function makePin(dir, meta = {}) {
  return { name: meta.name || "Colibri", version: meta.version || "", source: meta.source || "", created: new Date().toISOString(), files: hashTree(dir) };
}
// Returns { ok, problems:[text] }: files missing, files that differ, and files that are not in the pin.
export function checkPin(dir, pin) {
  const problems = [];
  if (!pin || !Array.isArray(pin.files) || !pin.files.length) return { ok: false, problems: ["the pin file is missing or empty"] };
  if (!fs.existsSync(dir)) return { ok: false, problems: ["engine folder not found: " + dir] };
  const have = new Map(hashTree(dir).map((f) => [f.path, f])); const want = new Map(pin.files.map((f) => [f.path, f]));
  for (const [p, w] of want) {
    const h = have.get(p);
    if (!h) problems.push("missing: " + p);
    else if (h.size !== w.size) problems.push(`size differs: ${p} (${h.size} instead of ${w.size})`);
    else if (h.sha256 !== w.sha256) problems.push("content differs: " + p);
  }
  for (const p of have.keys()) if (!want.has(p)) problems.push("not in the pin: " + p);
  return { ok: problems.length === 0, problems };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const PIN_FILE = path.join(here, "engine-pin.json");
export const readPin = () => { try { return JSON.parse(fs.readFileSync(PIN_FILE, "utf8")); } catch { return null; } };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2]; const dir = path.join(here, "engine");
  if (cmd === "write") {
    const old = readPin();
    const pin = makePin(dir, { name: "Colibri", version: process.argv[3] || old?.version || "2.1.0", source: "https://github.com/JustVugg/colibri" });
    fs.writeFileSync(PIN_FILE, JSON.stringify(pin, null, 2) + "\n"); console.log(`pinned ${pin.files.length} files (${pin.name} ${pin.version})`);
  } else if (cmd === "check") {
    const r = checkPin(dir, readPin()); console.log(r.ok ? "engine matches the pin" : "ENGINE DIFFERS FROM THE PIN:\n  " + r.problems.slice(0, 30).join("\n  ")); process.exit(r.ok ? 0 : 1);
  } else { console.log("usage: node engine-pin.mjs write [version] | check"); process.exit(2); }
}
