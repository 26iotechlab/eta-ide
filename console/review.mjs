// Review a finished run block by block and undo single blocks (job B2, 2026-11-13).
// runChanges(run): every file the run wrote that now differs from the run's private snapshot, split into blocks.
// revertHunks(run, file, ids): gives the chosen blocks of ONE file their snapshot lines back; other blocks stay.
import * as fs from "fs"; import * as fsp from "fs/promises"; import * as path from "path";
import { diffHunks, applySelection } from "./hunks.mjs";
import { readSnapshotFile } from "./snapshot.mjs";

const MAX_BYTES = 1 << 20; // files over 1 MB: whole-run Undo only
const SHOW = 40;           // lines shown per side of a block
const win = process.platform === "win32";
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^(\.\/)+/, "");
const key = (p) => (win ? norm(p).toLowerCase() : norm(p));
const hasNul = (b) => b.subarray(0, 8000).includes(0);
const isUtf8 = (b) => Buffer.from(b.toString("utf8"), "utf8").equals(b);

function checkRun(run) {
  if (!run) return "There is no such run.";
  if (run.wtPath || run.branch) return "This run worked in its own copy. Block undo works only for runs in the project folder.";
  if (!run.snapshot) return "This run has no undo point.";
  if (!/^eta:[0-9a-f]{40}$/.test(String(run.snapshot))) return "This run's undo point is an old kind. Use the whole-run Undo.";
  if (!run.workspace || !fs.existsSync(run.workspace)) return "The project folder of this run is missing.";
  return null;
}

// The safe absolute path for a run's file, or null. The file must be one the run wrote, stay inside the project
// folder (also after following links) and never be inside .eta or .git.
function safePath(run, file) {
  const raw = String(file || "");
  if (!raw || raw.includes("\0") || raw.includes(":") || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || /^[\\/]/.test(raw)) return null;
  const rel = norm(raw), parts = rel.split("/");
  if (parts.some((s) => s === ".." || s === "" || s === ".")) return null;
  if (parts.some((s) => /^\.git$/i.test(s)) || /^\.eta$/i.test(parts[0])) return null;
  const listed = new Set([...(run.files || [])].map(key));
  if (!listed.has(key(rel))) return null;
  const ws = path.resolve(run.workspace), abs = path.resolve(ws, rel);
  const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
  if (!inside(ws, abs)) return null;
  try { // a link inside the folder must not point outside it
    const realWs = fs.realpathSync(ws), realAbs = fs.realpathSync(abs);
    if (!inside(realWs, realAbs)) return null;
    const rr = norm(path.relative(realWs, realAbs)).split("/");
    if (rr.some((s) => /^\.git$/i.test(s)) || /^\.eta$/i.test(rr[0])) return null;
  } catch {} // a missing file is handled by the caller
  return { abs, rel };
}

const clip = (lines) => lines.slice(0, SHOW);
const view = (h) => ({ id: h.id, oldStart: h.oldStart, newStart: h.newStart, removed: clip(h.oldLines), removedTotal: h.oldLines.length,
  added: clip(h.newLines), addedTotal: h.newLines.length, before: h.before, after: h.after });

export async function runChanges(run) {
  const bad = checkRun(run); if (bad) return { ok: false, error: bad };
  const files = [], seen = new Set();
  for (const f of run.files || []) {
    const sp = safePath(run, f); if (!sp || seen.has(key(sp.rel))) continue; seen.add(key(sp.rel));
    let cur; try { if (!fs.statSync(sp.abs).isFile()) continue; cur = await fsp.readFile(sp.abs); } catch { continue; } // gone: skip
    let old; try { old = await readSnapshotFile(run, sp.rel, { raw: true }); } catch { files.push({ file: sp.rel, status: "modified", wholeFileOnly: true, hunks: [] }); continue; }
    if (old === null) { files.push({ file: sp.rel, status: "added", wholeFileOnly: true, hunks: [] }); continue; }
    if (old.equals(cur)) continue;
    if (cur.length > MAX_BYTES || old.length > MAX_BYTES) { files.push({ file: sp.rel, status: "modified", tooBig: true, hunks: [] }); continue; }
    if (hasNul(cur) || hasNul(old) || !isUtf8(cur) || !isUtf8(old)) { files.push({ file: sp.rel, status: "modified", binary: true, hunks: [] }); continue; }
    const hunks = diffHunks(old.toString("utf8"), cur.toString("utf8"));
    // only line endings or the final newline changed: there is no block to show
    files.push(hunks.length ? { file: sp.rel, status: "modified", hunks: hunks.map(view) } : { file: sp.rel, status: "modified", wholeFileOnly: true, hunks: [] });
  }
  return { ok: true, files };
}

const locks = new Map(); // one block undo at a time per file
function withLock(k, fn) { const prev = locks.get(k) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(k, next.then(() => {}, () => {})); return next; }

export async function revertHunks(run, file, hunkIds) {
  const bad = checkRun(run); if (bad) return { ok: false, error: bad };
  if (run.status === "running") return { ok: false, error: "The run is still working. Wait until it ends." };
  const ids = Array.isArray(hunkIds) ? [...new Set(hunkIds.filter((x) => typeof x === "string" && x))] : [];
  if (!ids.length) return { ok: false, error: "No block was chosen." };
  const sp = safePath(run, file);
  if (!sp) return { ok: false, error: "This file is not one this run changed inside the project folder." };
  return withLock(key(path.join(run.workspace, sp.rel)), async () => {
    let cur; try { cur = await fsp.readFile(sp.abs); } catch { return { ok: false, error: "The file no longer exists. Use the whole-run Undo." }; }
    const old = await readSnapshotFile(run, sp.rel, { raw: true });
    if (old === null) return { ok: false, error: "This file is new from the run. Use the whole-run Undo for it." };
    if (!old) return { ok: false, error: "This run's undo point cannot be read." };
    if (cur.length > MAX_BYTES || old.length > MAX_BYTES) return { ok: false, error: "This file is too big for block undo. Use the whole-run Undo." };
    if (hasNul(cur) || hasNul(old) || !isUtf8(cur) || !isUtf8(old)) return { ok: false, error: "This file is not plain text. Use the whole-run Undo." };
    const oldText = old.toString("utf8"), curText = cur.toString("utf8");
    const have = new Set(diffHunks(oldText, curText).map((h) => h.id));
    if (!ids.every((id) => have.has(id))) return { ok: false, conflict: true, error: "The file changed since this list was made. Reload the changes." };
    const out = applySelection(oldText, curText, ids);
    await fsp.writeFile(sp.abs, out, "utf8");
    return { ok: true, file: sp.rel, reverted: ids.length, remaining: diffHunks(oldText, out).map((h) => h.id) };
  });
}
