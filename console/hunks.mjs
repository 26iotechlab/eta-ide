// Line diff in blocks ("hunks") so the user can undo ONE changed block of a finished run and keep the others.
// Pure: no files, no git. diffHunks(old, new) lists the blocks; applySelection(old, new, undoIds) builds the text
// where the chosen blocks get their old lines back. 2026-11-13 (job B2).
import crypto from "crypto";

const MAX_D = 2000;          // most different lines the exact diff will handle (memory grows with the square of this)
const MAX_WORK = 30_000_000; // steps before we give up on the exact diff and return ONE block for the changed middle

// Splits text into lines without their line endings. eols[i] is the ending that followed line i ("" for a last line
// without one). Only "\n" and "\r\n" count as line endings.
export function splitLines(text) {
  const lines = [], eols = [];
  const re = /\r?\n/g; let last = 0, m;
  while ((m = re.exec(text))) { lines.push(text.slice(last, m.index)); eols.push(m[0]); last = m.index + m[0].length; }
  if (last < text.length) { lines.push(text.slice(last)); eols.push(""); }
  return { lines, eols, finalNL: text.length > 0 && last === text.length };
}
// "\r\n" when most line endings are CRLF, else "\n".
export function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length, all = (text.match(/\n/g) || []).length;
  return crlf > all - crlf ? "\r\n" : "\n";
}

// Myers O(ND) diff on two arrays of numbers. Returns a list of ops ("=", "-", "+") or null when too costly.
function myers(a, b) {
  const N = a.length, M = b.length, max = N + M;
  if (max === 0) return [];
  const off = max + 1, V = new Int32Array(2 * max + 3), trace = [];
  let work = 0, D = -1;
  outer: for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; work++; }
      V[off + k] = x; work++;
      if (x >= N && y >= M) { D = d; break outer; }
    }
    if (work > MAX_WORK) return null;
    trace.push(V.slice(off - d, off + d + 1)); // values for k = -d..d after round d
  }
  if (D < 0) return null;
  const ops = []; let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const v = trace[d - 1], at = (k) => v[k + d - 1];
    const k = x - y;
    const pk = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    while (x > px && y > py) { ops.push("="); x--; y--; }
    if (x === px) { ops.push("+"); y--; } else { ops.push("-"); x--; }
  }
  while (x > 0 && y > 0) { ops.push("="); x--; y--; }
  return ops.reverse();
}

function hunkId(oldStart, oldLines, newLines) {
  return `${oldStart}-` + crypto.createHash("sha1").update(oldLines.join("\n") + "\u0000" + newLines.join("\n"), "utf8").digest("hex").slice(0, 8);
}
function makeHunk(oldStart, oldLines, newStart, newLines, nl) {
  const ns = newStart - 1;
  return { id: hunkId(oldStart, oldLines, newLines), oldStart, oldLines, newStart, newLines,
    before: nl.slice(Math.max(0, ns - 3), ns), after: nl.slice(ns + newLines.length, ns + newLines.length + 3) };
}

// Lists the changed blocks between two texts. Starts are 1-based. For a pure insert, oldStart is the old line number
// the new lines go before (old line count + 1 at the end); the same for newStart of a pure delete.
export function diffHunks(oldText, newText) {
  const ol = splitLines(oldText).lines, nl = splitLines(newText).lines;
  let pre = 0; while (pre < ol.length && pre < nl.length && ol[pre] === nl[pre]) pre++;
  let suf = 0; while (suf < ol.length - pre && suf < nl.length - pre && ol[ol.length - 1 - suf] === nl[nl.length - 1 - suf]) suf++;
  const oa = ol.slice(pre, ol.length - suf), na = nl.slice(pre, nl.length - suf);
  if (!oa.length && !na.length) return [];
  const ids = new Map(), num = (s) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const ops = myers(oa.map(num), na.map(num));
  if (!ops) return [makeHunk(pre + 1, oa, pre + 1, na, nl)]; // too big for the exact diff: one block for the whole middle
  const hunks = []; let i = 0, j = 0, p = 0;
  while (p < ops.length) {
    if (ops[p] === "=") { i++; j++; p++; continue; }
    const os = i, ns = j;
    while (p < ops.length && ops[p] !== "=") { if (ops[p] === "-") i++; else j++; p++; }
    hunks.push(makeHunk(pre + os + 1, oa.slice(os, i), pre + ns + 1, na.slice(ns, j), nl));
  }
  return hunks;
}

// Text where blocks whose id is in undoIds take their OLD lines and all other blocks keep their NEW lines.
// Undo none gives newText exactly; undo all gives oldText exactly. Otherwise the result keeps newText's main line
// ending and its final newline (or no final newline); restored old lines keep their own endings when both texts
// use the same main line ending.
export function applySelection(oldText, newText, undoIds) {
  const undo = new Set(undoIds || []);
  const hunks = diffHunks(oldText, newText);
  const chosen = hunks.filter((h) => undo.has(h.id)).length;
  if (chosen === 0) return newText;
  if (chosen === hunks.length) return oldText;
  const O = splitLines(oldText), N = splitLines(newText), dom = dominantEol(newText);
  const keepOldEol = dominantEol(oldText) === dom;
  const out = [], eol = [];
  let pn = 0;
  const copyNew = (to) => { for (; pn < to; pn++) { out.push(N.lines[pn]); eol.push(N.eols[pn]); } };
  for (const h of hunks) {
    copyNew(h.newStart - 1);
    if (undo.has(h.id)) {
      for (let k = 0; k < h.oldLines.length; k++) { out.push(h.oldLines[k]); eol.push(keepOldEol ? O.eols[h.oldStart - 1 + k] : dom); }
    } else { for (let k = 0; k < h.newLines.length; k++) { out.push(h.newLines[k]); eol.push(N.eols[h.newStart - 1 + k]); } }
    pn = h.newStart - 1 + h.newLines.length;
  }
  copyNew(N.lines.length);
  let s = "";
  for (let k = 0; k < out.length; k++) s += out[k] + (k < out.length - 1 ? (eol[k] || dom) : (N.finalNL ? (eol[k] || dom) : ""));
  return s;
}
