// @-mentions (D3, 2026-11-13): the user types "@src/app.js" in the message box and the engine attaches that file.
// Two jobs, both plain file work (no model, no network):
//   1) findMentions / expandMentions: find "@path" words in a message, read those files safely, return a text block to append.
//   2) searchFiles: the list shown while the user types "@" (matching file paths of the open folder).
// Safety: only files inside the open folder; never .git or .eta; no binary files; size limits. A word that is not a real file
// (an e-mail address, an @agent name, a typo) is ignored without a word.
import * as fsp from "fs/promises";
import * as path from "path";
import { isSecretFile } from "./cloudguard.mjs";

export const LIMITS = { files: 6, perFile: 12000, total: 36000, maxBytes: 400000, folderEntries: 60, scan: 6000, depth: 8 };
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".eta", "__pycache__", ".venv", "venv", ".next", "build", ".cache", "target", ".idea", ".vscode"]);
const BLOCKED = new Set([".git", ".eta"]);

// "@word" where the @ starts the message or follows a space/bracket. Quotes allow spaces: @"my notes/a b.md".
// The word ends at a space; trailing . , ; : ! ? ) are not part of the path.
export function findMentions(message) {
  const out = []; const seen = new Set();
  const re = /(^|[\s(\[{])@(?:"([^"\n]{1,260})"|([^\s@"'`<>|*?]{1,260}))/g;
  let m;
  while ((m = re.exec(String(message || "")))) {
    let w = m[2] ?? m[3] ?? ""; if (m[2] === undefined) w = w.replace(/[.,;:!?)\]}]+$/, "");
    w = w.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!w || seen.has(w)) continue; seen.add(w); out.push(w);
    if (out.length >= 30) break;
  }
  return out;
}

// Turn a mention into a path inside the folder, or null if it must not be read.
export function resolveInside(ws, word) {
  if (!ws || !word || /\0/.test(word) || /^[a-zA-Z]:/.test(word) || word.startsWith("/")) return null;
  const root = path.resolve(ws); const full = path.resolve(root, word);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((p) => BLOCKED.has(p.toLowerCase()))) return null;
  return { full, rel: parts.join("/") };
}

const fence = (s) => { let f = "```"; while (s.includes(f)) f += "`"; return f; };

// Returns { block, files:[{path,chars,cut}], folders:[path], skipped:[{word,why}] }. `block` is "" when nothing was attached.
// opts.cloud (2026-11-15j): a cloud model is active, so a secret file (.env, id_rsa, *.pem ...) is not attached; it is named as skipped.
export async function expandMentions(message, ws, limits = LIMITS, opts = {}) {
  const res = { block: "", files: [], folders: [], skipped: [] };
  if (!ws) return res;
  const parts = []; let used = 0;
  for (const word of findMentions(message)) {
    if (res.files.length + res.folders.length >= limits.files) { res.skipped.push({ word, why: "too many" }); continue; }
    const r = resolveInside(ws, word); if (!r) continue;
    let st; try { st = await fsp.stat(r.full); } catch { continue; } // not a real file: ignore (could be an @agent or a name)
    if (st.isDirectory()) {
      let names = []; try { names = (await fsp.readdir(r.full, { withFileTypes: true })).filter((d) => !SKIP_DIRS.has(d.name)).map((d) => d.name + (d.isDirectory() ? "/" : "")).sort(); } catch { continue; }
      const shown = names.slice(0, limits.folderEntries);
      parts.push(`### folder ${r.rel}/\n${shown.join("\n")}${names.length > shown.length ? `\n… and ${names.length - shown.length} more` : ""}`);
      res.folders.push(r.rel); continue;
    }
    if (!st.isFile()) continue;
    if (opts.cloud && isSecretFile(r.rel)) { res.skipped.push({ word, why: "secret file (a cloud model is active)" }); continue; }
    if (st.size > limits.maxBytes) { res.skipped.push({ word, why: "file is too large" }); continue; }
    let text; try { const buf = await fsp.readFile(r.full); if (buf.includes(0)) { res.skipped.push({ word, why: "binary file" }); continue; } text = buf.toString("utf8"); } catch { continue; }
    const room = Math.max(0, limits.total - used); if (room < 200) { res.skipped.push({ word, why: "no room left" }); continue; }
    const cap = Math.min(limits.perFile, room); const cut = text.length > cap; const body = cut ? text.slice(0, cap) : text;
    const f = fence(body); used += body.length;
    parts.push(`### file ${r.rel}${cut ? ` (first ${cap} of ${text.length} characters)` : ""}\n${f}\n${body}${body.endsWith("\n") ? "" : "\n"}${f}`);
    res.files.push({ path: r.rel, chars: body.length, cut });
  }
  if (parts.length) res.block = "\n\n[Files the user attached with @ — treat them as part of the request]\n" + parts.join("\n\n");
  return res;
}

// The list for the "@" menu. Matches the typed text against the whole relative path (case does not matter).
// Best first: name starts with the text, then name contains it, then the path contains it, then letters in order.
export async function searchFiles(ws, query, limit = 12, limits = LIMITS) {
  if (!ws) return [];
  const q = String(query || "").toLowerCase().replace(/\\/g, "/"); const root = path.resolve(ws);
  const all = []; let count = 0;
  const walk = async (dir, depth) => {
    if (count >= limits.scan || depth > limits.depth) return;
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (count >= limits.scan) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), depth + 1); }
      else if (e.isFile()) { count++; all.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join("/")); }
    }
  };
  await walk(root, 0);
  const inOrder = (s, t) => { let i = 0; for (const c of s) if (c === t[i]) i++; return i === t.length; };
  const scored = [];
  for (const p of all) {
    const low = p.toLowerCase(), base = low.slice(low.lastIndexOf("/") + 1); let s;
    if (!q) s = 4; else if (base.startsWith(q)) s = 0; else if (base.includes(q)) s = 1; else if (low.includes(q)) s = 2; else if (inOrder(low, q)) s = 3; else continue;
    scored.push({ p, s });
  }
  scored.sort((a, b) => a.s - b.s || a.p.split("/").length - b.p.split("/").length || a.p.length - b.p.length || (a.p < b.p ? -1 : 1));
  return scored.slice(0, limit).map((x) => x.p);
}
