// editundo.mjs — Phase 3 (2026-11-15k): Keep / Undo for ONE file edit, also while the run is still working.
// The agent writes the edit first (the checkers need the file on disk). Around each write_file / edit_file call
// the engine keeps the file's bytes from BEFORE that call and a hash of the bytes AFTER it. Then:
//  - Undo, file unchanged since the edit: the exact old bytes go back (atomicWrite), or a file the edit created is removed.
//  - Undo, file changed since the edit: for an edit with ONE changed block, only that block is put back, and only when
//    the later changes do not touch it (and the result is checked line by line). Otherwise it refuses with a plain
//    message and writes NOTHING, so the user's newer work is never overwritten.
//  - Keep: marks the edit as accepted. The file is already on disk; nothing is written.
// The old bytes live in memory only (not in the saved state): after an engine restart Undo says it is not available.
import crypto from "crypto";
import * as fsp from "fs/promises";
import path from "path";
import { guardPath } from "./pathguard.mjs";
import { atomicWrite } from "./atomicwrite.mjs";
import { diffHunks, splitLines } from "./hunks.mjs";

export const MAX_EDIT_BYTES = 4 * 1024 * 1024;   // a bigger file gets no Undo button (memory)
export const MAX_RUN_EDIT_BYTES = 64 * 1024 * 1024; // all old copies of one run together
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rootOf = (run) => run.root || run.workspace;

async function readOrNull(full) {
  try { return await fsp.readFile(full); } catch (e) { if (e && e.code === "ENOENT") return null; throw e; }
}
function asText(buf) { // utf8 text that turns back into exactly the same bytes, else null (binary or broken text)
  if (buf == null) return null; const t = buf.toString("utf8");
  return Buffer.from(t, "utf8").equals(buf) ? t : null;
}

// Called by the agent just before a write_file / edit_file call. Returns a token for `afterEdit`, or null.
export async function beforeEdit(run, rel) {
  if (!run || typeof rel !== "string" || !rel) return null;
  let full; try { full = guardPath(rootOf(run), rel); } catch { return null; }
  let before; try { before = await readOrNull(full); } catch { return null; }
  if (before && before.length > MAX_EDIT_BYTES) return null;
  return { rel, full, before };
}

// Called just after the call. Records the edit when the bytes changed. Returns the event to show, or null.
export async function afterEdit(run, token, tool = "") {
  if (!run || !token) return null;
  let after; try { after = await readOrNull(token.full); } catch { return null; }
  if (after == null) return null; // the call removed or never made the file: nothing to undo here
  if (token.before && token.before.equals(after)) return null; // no change
  if (after.length > MAX_EDIT_BYTES) return null;
  run.edits ||= new Map(); run._editBytes ||= 0;
  const size = token.before ? token.before.length : 0;
  if (run._editBytes + size > MAX_RUN_EDIT_BYTES) return null;
  run._editBytes += size;
  const bt = asText(token.before), at = asText(after);
  const hunks = bt != null && at != null ? diffHunks(bt, at).length : -1; // -1: not text, whole-file undo only
  const id = (run.id || "r") + "-e" + ((run._editSeq = (run._editSeq || 0) + 1));
  const rec = { id, file: token.rel.replace(/\\/g, "/"), full: token.full, before: token.before, afterHash: sha(after), afterText: at, beforeText: bt, hunks, tool: String(tool).slice(0, 20), status: "open", ts: Date.now() };
  run.edits.set(id, rec);
  return { type: "edit", editId: id, file: rec.file, created: token.before == null, hunks, tool: rec.tool };
}

// Puts back the ONE block of a single-block edit inside a file that was changed later somewhere else.
// Returns the new text, or null when that cannot be done safely.
export function undoSingleHunk(beforeText, afterText, currentText) {
  if (beforeText == null || afterText == null || currentText == null) return null;
  const hs = diffHunks(beforeText, afterText);
  if (hs.length !== 1) return null;
  const H = hs[0], B = splitLines(beforeText), A = splitLines(afterText), C = splitLines(currentText);
  const s = H.newStart - 1, e = s + H.newLines.length; // the block's lines in the after-text: [s, e)
  if (e >= A.lines.length) return null; // the block reaches the end of the file: final-newline cases, refuse
  // 1) the edit must be exactly this one block: putting the old lines back into the after-text gives the before bytes
  const rebuild = (L, at, len, oldEols) => {
    const lines = L.lines.slice(), eols = L.eols.slice();
    lines.splice(at, len, ...H.oldLines); eols.splice(at, len, ...oldEols);
    let out = ""; for (let k = 0; k < lines.length; k++) out += lines[k] + eols[k];
    return out;
  };
  const oldEols = B.eols.slice(H.oldStart - 1, H.oldStart - 1 + H.oldLines.length);
  if (oldEols.length !== H.oldLines.length || oldEols.some((x) => !x)) return null;
  if (rebuild(A, s, H.newLines.length, oldEols) !== beforeText) return null;
  // 2) the later changes must not touch the block (touching its edge counts as touching)
  let delta = 0;
  for (const h of diffHunks(afterText, currentText)) {
    const hs0 = h.oldStart - 1, he0 = hs0 + h.oldLines.length;
    if (hs0 <= e && he0 >= s) return null;
    if (he0 < s) delta += h.newLines.length - h.oldLines.length;
  }
  const p = s + delta;
  // 3) the block must still be there, same lines and same line endings
  for (let k = 0; k < H.newLines.length; k++) if (C.lines[p + k] !== H.newLines[k] || C.eols[p + k] !== A.eols[s + k]) return null;
  if (C.lines[p + H.newLines.length] !== A.lines[e]) return null; // the line after the block is the same line
  if (s > 0 && C.lines[p - 1] !== A.lines[s - 1]) return null;     // and the line before it
  return rebuild(C, p, H.newLines.length, oldEols);
}

const MSG = {
  none: "This edit cannot be undone here any more (the engine was restarted, or the edit was too big to keep a copy).",
  kept: "You already kept this edit.",
  undone: "This edit is already undone.",
  busy: "This edit is being undone right now.",
  changed: "The file changed after this edit, so I did not undo it. Your newer work is safe. Edit the file yourself, or use \"Revert this run\" when the run has ended.",
  path: "This file is outside the project folder, so I will not touch it.",
  ws: "This edit belongs to a different project folder.",
};

function sameFolder(a, b) {
  const n = (p) => { const r = path.resolve(String(p || "")); return process.platform === "win32" ? r.toLowerCase() : r; };
  return !!a && !!b && n(a) === n(b);
}
function find(run, editId, ws) {
  if (!run) return { err: { ok: false, error: "No such run.", status: 404 } };
  if (typeof ws !== "string" || !sameFolder(ws, run.workspace)) return { err: { ok: false, error: MSG.ws, status: 403 } };
  const rec = run.edits?.get(String(editId || ""));
  if (!rec) return { err: { ok: false, error: MSG.none, status: 404 } };
  return { rec };
}

function drop(run, rec, status) {
  rec.status = status; run._editBytes = Math.max(0, (run._editBytes || 0) - (rec.before ? rec.before.length : 0));
  rec.before = null; rec.beforeText = null; rec.afterText = null;
}
export function keepEdit(run, editId, ws) {
  const { rec, err } = find(run, editId, ws); if (err) return err;
  if (rec.status === "undone") return { ok: false, error: MSG.undone, status: 409 };
  drop(run, rec, "kept"); // nothing to restore any more: free the memory
  return { ok: true, editId: rec.id, file: rec.file, status: "kept" };
}

export async function undoEdit(run, editId, ws) {
  const { rec, err } = find(run, editId, ws); if (err) return err;
  if (rec.status !== "open") return { ok: false, error: MSG[rec.status] || MSG.none, status: 409 };
  rec.status = "busy";
  try {
    let full;
    try { full = guardPath(rootOf(run), rec.file); } catch { return { ok: false, error: MSG.path, status: 403 }; }
    if (full !== rec.full) return { ok: false, error: MSG.path, status: 403 };
    const cur = await readOrNull(full);
    if (cur != null && sha(cur) === rec.afterHash) { // unchanged since the edit: the exact old bytes go back
      if (rec.before == null) await fsp.unlink(full); else await atomicWrite(full, rec.before);
      drop(run, rec, "undone");
      return { ok: true, editId: rec.id, file: rec.file, status: "undone", how: "exact" };
    }
    // changed since: only a single-block text edit, only when the later changes are elsewhere
    if (cur != null && rec.hunks === 1 && rec.beforeText != null) {
      const next = undoSingleHunk(rec.beforeText, rec.afterText, asText(cur));
      if (next != null) {
        const again = await readOrNull(full); // the file must not change between our check and our write
        if (again && again.equals(cur)) {
          await atomicWrite(full, Buffer.from(next, "utf8"));
          drop(run, rec, "undone");
          return { ok: true, editId: rec.id, file: rec.file, status: "undone", how: "block-merged" };
        }
      }
    }
    return { ok: false, error: MSG.changed, status: 409, conflict: true };
  } catch (e) {
    return { ok: false, error: "Undo failed: " + String(e?.message || e).slice(0, 200), status: 500 };
  } finally { if (rec.status === "busy") rec.status = "open"; }
}
