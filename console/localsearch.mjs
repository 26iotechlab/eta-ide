// localsearch.mjs — built-in, fully local code search (BM25 ranking over file chunks).
// No server, no embeddings, no network. The index lives in memory and refreshes itself
// when a file's size or modified time changes.
import { promises as fs } from "node:fs";
import path from "node:path";

const EXT = /\.(py|js|mjs|cjs|ts|tsx|jsx|java|go|rs|c|cpp|h|hpp|cs|rb|php|swift|kt|css|html|json|md|txt|yml|yaml|toml|sh)$/i;
const IGNORE = new Set(["node_modules", ".git", "dist", ".eta", "__pycache__", ".venv", "venv", "build", ".next", ".cache", "out", "target", "vendor", ".hf-cache"]);
const MAX_FILES = 3000, MAX_FILE_BYTES = 200_000, CHUNK_LINES = 40, OVERLAP = 8;
const K1 = 1.4, B = 0.75;
const STOP = new Set("a an the is are was were be to of in on for and or not with how what where why does do this that it as at by from can i you we".split(" "));

// "getUserName" / "get_user_name" -> get, user, name (plus the whole word)
export function tokenize(text) {
  const out = [];
  for (const w of String(text).match(/[A-Za-z_][A-Za-z0-9_]{1,}|\d{2,}/g) || []) {
    const lower = w.toLowerCase();
    if (!STOP.has(lower)) out.push(lower);
    const parts = w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\s]+/).filter((p) => p.length > 1);
    if (parts.length > 1) for (const p of parts) { const l = p.toLowerCase(); if (!STOP.has(l)) out.push(l); }
  }
  return out;
}

const indexes = new Map(); // root -> { files: Map(rel -> {sig, chunkIds}), chunks: [], df: Map, avgLen }

async function listFiles(root) {
  const found = [];
  const walk = async (dir, rel, depth) => {
    if (depth > 10 || found.length >= MAX_FILES) return;
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (IGNORE.has(e.name) || e.name.startsWith(".") && e.isDirectory()) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r, depth + 1);
      else if (EXT.test(e.name) && found.length < MAX_FILES) found.push(r);
    }
  };
  await walk(root, "", 0);
  return found;
}

export async function indexWorkspace(root, log = () => {}) {
  let idx = indexes.get(root);
  if (!idx) { idx = { files: new Map(), chunks: [], df: new Map(), avgLen: 1 }; indexes.set(root, idx); }
  const list = await listFiles(root);
  const keep = new Set(list);
  let changed = 0;
  for (const rel of [...idx.files.keys()]) if (!keep.has(rel)) { idx.files.delete(rel); changed++; }
  for (const rel of list) {
    let st; try { st = await fs.stat(path.join(root, rel)); } catch { continue; }
    if (st.size > MAX_FILE_BYTES || st.size < 1) { if (idx.files.delete(rel)) changed++; continue; }
    const sig = st.size + ":" + Math.floor(st.mtimeMs);
    const old = idx.files.get(rel);
    if (old && old.sig === sig) continue;
    let src; try { src = await fs.readFile(path.join(root, rel), "utf8"); } catch { continue; }
    const lines = src.split(/\r?\n/);
    const chunks = [];
    for (let s = 0; s < lines.length; s += CHUNK_LINES - OVERLAP) {
      const body = lines.slice(s, s + CHUNK_LINES).join("\n");
      if (body.trim().length < 15) continue;
      const toks = tokenize(rel + " " + body);
      const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      chunks.push({ file: rel, start: s + 1, end: Math.min(s + CHUNK_LINES, lines.length), text: body, tf, len: toks.length });
    }
    idx.files.set(rel, { sig, chunks });
    changed++;
  }
  if (changed || !idx.built) {
    idx.chunks = []; idx.df = new Map();
    for (const f of idx.files.values()) for (const c of f.chunks) {
      idx.chunks.push(c);
      for (const t of c.tf.keys()) idx.df.set(t, (idx.df.get(t) || 0) + 1);
    }
    idx.avgLen = idx.chunks.reduce((n, c) => n + c.len, 0) / Math.max(1, idx.chunks.length);
    idx.built = true;
    log(`local index: ${idx.files.size} file(s), ${idx.chunks.length} chunk(s)${changed ? `, ${changed} updated` : ""}`);
  }
  return { files: idx.files.size, chunks: idx.chunks.length, changed };
}

// Returns the best chunks for a question: [{ file, start, end, score, text }]
export async function queryWorkspace(root, question, k = 6) {
  await indexWorkspace(root);
  const idx = indexes.get(root);
  if (!idx || !idx.chunks.length) return [];
  const terms = [...new Set(tokenize(question))];
  if (!terms.length) return [];
  const N = idx.chunks.length;
  const scored = [];
  for (const c of idx.chunks) {
    let score = 0;
    for (const t of terms) {
      const f = c.tf.get(t); if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * c.len / idx.avgLen));
    }
    if (score > 0) scored.push({ file: c.file, start: c.start, end: c.end, score, text: c.text });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [], perFile = new Map();
  for (const s of scored) { // at most 2 chunks per file so one big file cannot fill the answer
    const n = perFile.get(s.file) || 0; if (n >= 2) continue;
    perFile.set(s.file, n + 1); out.push(s); if (out.length >= k) break;
  }
  return out;
}

export function dropIndex(root) { indexes.delete(root); }
