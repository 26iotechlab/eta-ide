// Finding WHERE to work, from evidence on disk instead of from the model's guess. No model calls, no GPU.
//
// Live failure (reality task 09, library bug fix): the plan chose models.py, __init__.py, report.py and loans.py.
// The real bug was in fines.py, which was never even opened. The contract writer had only seen the first 1400
// characters of those wrong files, so it wrote "was likely adding ..." (a guess) and the run ended "done"
// with half the task undone. These helpers close that gap:
//   vocabLocalize      rank project files by how well their own words (names, docstrings, comments) match the task
//   symbolMap          a short map of every file's names, so the model sees the whole project at a glance
//   contractNamedFiles files the contract says must change (they must join the work list)
//   contractHedges     the contract guesses instead of knowing ("likely", "probably", "or maybe")
//   testsExpected      how many NEW tests the task asks for ("a test for each bug" with 2 bugs = 2)
import fs from "node:fs/promises";
import path from "node:path";
import { isTestPathAny, CODE_EXT_RE } from "./langs.mjs";

const SKIP_DIR = new Set(["node_modules", ".git", "__pycache__", ".eta", ".venv", "venv", "dist", "build", ".pytest_cache", ".idea", ".vscode"]);
const CODE_EXT = CODE_EXT_RE; // STRONG2 A7: the shared list (adds kts, mts, cts, vue, hxx, pyi)
const STOPWORDS = new Set(("the and for with that this have has had was were are not but can may will would should could from into over than then them they their there here what when where which who how why one two all any each both some more most such only also very just still even does did done doing been being its our your his her she him you she it a an of in on at to is be by or as if so we i me my us do no yes use used using add make made fix bug bugs report reports please find system code test tests keep existing change other rules rule folder package book books").split(" "));

// STRONG2 A1: the same per-language table as the engine's isTestFile (langs.mjs). The old any-case "Spec.java" / "contest.java"
// matches are gone on purpose: they called normal source files tests.
export function isTestPath(f) { return isTestPathAny(f); }

// split "late_fee", "lateFee", "LateFee" into lower-case words
export function splitIdent(s) {
  return String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\W]+/g, " ").toLowerCase().split(" ").filter(Boolean);
}
// very small stemmer: fees->fee, borrowing->borrow, returned->return, limits->limit
export function stem(w) {
  w = String(w).toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}
export function taskWords(task) {
  const out = new Map(); // stem -> weight (code-looking words weigh more)
  for (const m of String(task).matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const raw = m[0];
    const codeLike = /_/.test(raw) || /[a-z][A-Z]/.test(raw);
    for (const part of splitIdent(raw)) {
      if (part.length < 3 || STOPWORDS.has(part)) continue;
      const s = stem(part);
      if (s.length < 3) continue;
      out.set(s, Math.max(out.get(s) || 0, codeLike ? 3 : 1));
    }
  }
  return out;
}

async function listCode(root, rel = "", acc = [], depth = 0) {
  if (acc.length > 400 || depth > 6) return acc;
  let ents = [];
  try { ents = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) await listCode(root, rel ? rel + "/" + e.name : e.name, acc, depth + 1); }
    else if (CODE_EXT.test(e.name)) acc.push(rel ? rel + "/" + e.name : e.name);
  }
  return acc;
}

// words a file is "about": its identifiers, constants, docstring/comment words, string words
function fileWords(src) {
  const bag = new Map();
  const add = (w, k) => { const s = stem(w); if (s.length >= 3 && !STOPWORDS.has(w)) bag.set(s, (bag.get(s) || 0) + k); };
  for (const m of String(src).matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) for (const p of splitIdent(m[0])) if (p.length >= 3) add(p, 1);
  // names that are DEFINED here count extra: def x / class X / X = ...
  for (const m of String(src).matchAll(/^\s*(?:async\s+)?(?:def|class|function|func|fn|struct|enum|trait|interface|type)\s+([A-Za-z_]\w*)|^([A-Z][A-Z0-9_]{2,})\s*=/gm)) for (const p of splitIdent(m[1] || m[2])) if (p.length >= 3) add(p, 3);
  return bag;
}

// Rank code files by evidence. Returns [{file, score}] best first. Test files are not ranked.
export async function vocabLocalize(root, task, opts = {}) {
  const max = opts.max || 6;
  const files = (await listCode(root)).filter((f) => !isTestPath(f));
  if (!files.length) return [];
  const tw = taskWords(task);
  if (!tw.size) return [];
  const bags = new Map();
  for (const f of files) { try { bags.set(f, fileWords((await fs.readFile(path.join(root, f), "utf8")).slice(0, 40000))); } catch {} }
  // inverse document frequency: a word in every file says nothing
  const df = new Map();
  for (const bag of bags.values()) for (const k of bag.keys()) df.set(k, (df.get(k) || 0) + 1);
  const N = bags.size;
  const rows = [];
  for (const [f, bag] of bags) {
    let score = 0;
    for (const [w, wt] of tw) {
      const c = bag.get(w); if (!c) continue;
      const idf = Math.log(1 + N / (df.get(w) || 1));
      score += wt * idf * (1 + Math.log(c));
    }
    // the file's own NAME is strong evidence ("fines.py" for "fee")
    const nameWords = splitIdent(path.basename(f).replace(/\.[^.]+$/, "")).map(stem);
    for (const [w, wt] of tw) if (nameWords.includes(w)) score += wt * 2;
    if (score > 0) rows.push({ file: f, score: Math.round(score * 100) / 100 });
  }
  rows.sort((a, b) => b.score - a.score);
  if (!rows.length) return [];
  // keep only files that are close to the best, so one clear winner is not diluted by noise
  const top = rows[0].score;
  return rows.filter((r) => r.score >= top * (opts.ratio || 0.45)).slice(0, max);
}

// "path -> def a, def b, CONST" for every code file, short. For small projects only.
export async function symbolMap(root, opts = {}) {
  const files = (await listCode(root)).filter((f) => !isTestPath(f));
  if (!files.length || files.length > (opts.maxFiles || 40)) return "";
  const lines = [];
  for (const f of files) {
    let src = ""; try { src = (await fs.readFile(path.join(root, f), "utf8")).slice(0, 30000); } catch { continue; }
    const names = [];
    for (const m of src.matchAll(/^\s*(?:async\s+)?(?:def|class|function)\s+([A-Za-z_]\w*)|^([A-Z][A-Z0-9_]{2,})\s*=/gm)) { const n = m[1] || m[2]; if (n && !names.includes(n) && !/^__/.test(n)) names.push(n); }
    // STRONG2 A7: typed languages name their methods without a keyword: Java/C# "public int add(", Kotlin "fun add(", Go "func Add(",
    // Rust "fn add(", Swift "func add(", plus interface/struct/enum/record/object types. Only lines with a modifier or keyword count.
    if (/\.(java|cs|kt|kts|go|rs|swift|php|scala)$/i.test(f)) {
      for (const m of src.matchAll(/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|open|suspend|inline|pub(?:\([^)]*\))?)\s+)*(?:(?:interface|struct|enum|record|object|trait)\s+([A-Za-z_]\w*)|(?:fun|func|fn|function)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|(?:[\w.<>\[\],?]+\s+)([A-Za-z_]\w*)\s*\((?=[^;{\n]*(?:\{|$)))/gm)) {
        const n = m[1] || m[2] || m[3];
        if (!m[3] || /^\s*(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed)\s/.test(m[0])) { if (n && !names.includes(n) && !/^(?:if|for|while|switch|return|new|catch)$/.test(n)) names.push(n); }
      }
    }
    const doc = (src.match(/^\s*(?:"""|''')\s*([^\n"']{3,100})/) || src.match(/^\s*(?:\/\/|#)\s*([^\n]{3,100})/) || [])[1] || "";
    lines.push(`${f}: ${doc ? doc.trim() + " | " : ""}${names.slice(0, 14).join(", ") || "(no definitions)"}`);
  }
  return lines.join("\n").slice(0, opts.maxChars || 2400);
}

// Files named as a heading in a contract: "**path**:", "- path:", "### path", "path:". Existing, non-test files only.
export async function contractNamedFiles(root, contract, isNoChange = () => false, sectionOf = () => "") {
  const found = [];
  const re = /(?:^|\n)\s*(?:[-*#>]+\s*)?\**`?([\w./-]+\.(?:py|js|mjs|cjs|ts|tsx|mts|cts|jsx|vue|go|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hh|cs|rb|php|swift)(?![\w]))`?\**\s*:?/g; // STRONG2 A7: + cjs mts cts vue kts cxx hh php swift; (?!\w) so "a.cpp" is not read as "a.c"
  for (const m of String(contract || "").matchAll(re)) {
    const f = m[1].replace(/^\.\//, "");
    if (found.includes(f) || isTestPath(f)) continue;
    try { await fs.access(path.join(root, f)); } catch { continue; }
    if (isNoChange(sectionOf(contract, f))) continue;
    found.push(f);
  }
  return found;
}

// The contract guesses instead of knowing. Wording copied from the live contract of task 09.
export function contractHedges(contract) {
  const s = String(contract || "");
  const hits = s.match(/\b(was likely|is likely|probably|presumably|maybe|might be|perhaps|or using|or missing|possibly|I assume|assuming)\b/gi) || [];
  return hits.length >= 1 ? [...new Set(hits.map((h) => h.toLowerCase()))] : [];
}

const NUMWORD = { one: 1, a: 1, an: 1, two: 2, both: 2, three: 3, four: 4, five: 5 };
// How many NEW tests does the task ask for? "Add a test for each bug" with 2 numbered bugs = 2.
export function testsExpected(task) {
  const t = String(task || "");
  if (!/\b(add|write|create|include)\b[^.\n]{0,40}\btests?\b/i.test(t) && !/\btests?\b[^.\n]{0,20}\bfor\s+(each|every|both)\b/i.test(t)) return 0;
  const numbered = new Set([...t.matchAll(/(?:^|\n)\s*(\d{1,2})[.)]\s+\S/g)].map((m) => Number(m[1]))).size;
  const each = /\b(for\s+(each|every|both)|a\s+test\s+for\s+each|one\s+test\s+per)\b/i.test(t);
  const spelled = (t.match(/\b(one|two|three|four|five)\s+(new\s+)?tests?\b/i) || [])[1];
  if (spelled) return NUMWORD[spelled.toLowerCase()];
  if (each && numbered >= 2) return Math.min(numbered, 6);
  if (/\bboth\s+(bugs?|problems?|issues?)\b/i.test(t) && each) return 2;
  return 1;
}

// Tasks that list several separate things, e.g. "1. ... 2. ...": how many?
export function numberedItems(task) {
  return new Set([...String(task || "").matchAll(/(?:^|\n)\s*(\d{1,2})[.)]\s+\S/g)].map((m) => Number(m[1]))).size;
}
