// The WATCHDOG: plain code (no model) that checks facts while the agent works and puts it back on track when it loses the way.
//
// Why: a small local model slips (wrong expected values, invented changes, missing arguments), and the agent used to trust it.
// Each rule below comes from a failure seen in a live run, and each one checks a FACT on disk, never the model's word.
//
//   repairCall        a tool call with a missing path gets the step's file filled in (live: "Making a targeted fix to ``" x3)
//   scope guard       a step for file A must not leave files B, C changed when the plan gave B, C no job (live: __init__.py rewritten)
//   best state        keep the best tested state seen; a repair that made it worse is undone (live: a repair put the original bug back)
//   contractQuotes    the plan says "change `X` to `Y`" but X exists nowhere in the project: the plan is guessing
//   report            one honest line at the end: what the watchdog corrected
//   14-21 (STRONG2)   untouched stub, wrong-language file, weakened tests, secrets, destructive shell, hardcoded expected
//                     value, summary names that exist nowhere, exact error strings (see the bottom of this file)
import fs from "node:fs/promises";
import path from "node:path";
import { isTestPathAny, langOfPath, codeMask, BRACE_LANGS } from "./langs.mjs";

const SKIP_DIR = new Set(["node_modules", ".git", "__pycache__", ".eta", ".venv", "venv", "dist", "build", ".pytest_cache", ".idea", ".vscode"]);
const CODE_EXT = /\.(py|js|mjs|cjs|ts|tsx|jsx|json|html|css|go|rs|java|kt|c|h|cc|cpp|cxx|hpp|hh|cs|rb|php|swift|toml|mod)$/i;
const MAX_FILES = 300, MAX_BYTES = 200000;

export async function snapshotCode(root) {
  const out = new Map();
  async function walk(rel, depth) {
    if (out.size >= MAX_FILES || depth > 6) return;
    let ents = []; try { ents = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith(".")) await walk(r, depth + 1); }
      else if (CODE_EXT.test(e.name)) {
        try { const st = await fs.stat(path.join(root, r)); if (st.size <= MAX_BYTES) out.set(r, await fs.readFile(path.join(root, r), "utf8")); } catch {}
      }
    }
  }
  await walk("", 0);
  return out;
}

export const betterScore = (a, b) => !!a && (!b || a.good > b.good || (a.good === b.good && a.fails < b.fails));
// Same source code in two snapshots (test files ignored when isTest is given).
export function sameCode(a, b, isTest = null) {
  try {
    if (!a || !b) return false;
    const skip = (f) => typeof isTest === "function" && isTest(f);
    for (const [f, t] of a) if (!skip(f) && b.get(f) !== t) return false;
    for (const f of b.keys()) if (!skip(f) && !a.has(f)) return false;
    return true;
  } catch { return false; }
}

export class Watchdog {
  constructor() { this.events = []; this.best = null; }
  note(rule, text) { this.events.push({ rule, text: String(text || "").slice(0, 200), at: Date.now() }); }

  // 1. A tool call that must name a file but does not: use the file this step is about. Returns a note when it fixed something.
  repairCall(tc, stepFile) {
    if (!tc || !tc.args || typeof tc.args !== "object") return "";
    if (!["edit_file", "write_file"].includes(tc.name)) return "";
    const p = tc.args.path;
    const empty = p === undefined || p === null || (typeof p === "string" && !p.trim());
    if (!empty || !stepFile) return "";
    tc.args.path = stepFile;
    this.note("missing-path", `${tc.name} had no path; used ${stepFile}`);
    return `${tc.name} had no file name: using ${stepFile}, the file this step is about`;
  }

  // 2. After a step for one file: undo changes to files that have no job in the plan. before = snapshotCode() taken before the step.
  // allowed = Set of paths this step may change. Returns the list of files put back.
  async enforceScope(root, before, allowed, emit) {
    const after = await snapshotCode(root);
    const putBack = [];
    for (const [f, now] of after) {
      if (allowed.has(f)) continue;
      const was = before.get(f);
      if (was === undefined) continue; // a new file: not removed here (tests the plan asked for may be new)
      if (was !== now) { try { await fs.writeFile(path.join(root, f), was, "utf8"); putBack.push(f); } catch {} }
    }
    for (const [f, was] of before) { // a file with no job that disappeared
      if (allowed.has(f) || after.has(f)) continue;
      try { await fs.writeFile(path.join(root, f), was, "utf8"); putBack.push(f); } catch {}
    }
    putBack.sort();
    if (putBack.length) {
      this.note("scope", `put back ${putBack.join(", ")}`);
      emit?.({ type: "log", text: `watchdog: ${putBack.join(", ")} ${putBack.length > 1 ? "were" : "was"} changed but the plan gives no job there - put back` });
      emit?.({ type: "narration", text: `I changed ${putBack.join(", ")} by mistake (the plan does not touch ${putBack.length > 1 ? "them" : "it"}), so I put ${putBack.length > 1 ? "them" : "it"} back.` });
    }
    return putBack;
  }

  // 3. Remember the best tested state. score = {good, fails}.
  // GATE1 (2026-11-17) opts.startSnap / opts.isTest: the state the run began with. A first draft that ties the untouched start state
  // (both fail every test) replaces it as the best state, once: a compiling draft is worth more than the stub (benchmark b2r,
  // js-beer-song: 3 compiling drafts tied the stub at "8 failing", and the run ended on a broken file with nothing better recorded).
  async capture(root, score, opts = {}) {
    if (!score || !Number.isFinite(score.good)) return false;
    const sc = { good: score.good, fails: score.fails || 0 };
    if (this.best && !betterScore(score, this.best.score)) {
      const tie = this.best.start && opts.startSnap && sc.good === this.best.score.good && sc.fails === this.best.score.fails;
      if (!tie) return false;
      const snap = await snapshotCode(root);
      if (sameCode(snap, opts.startSnap, opts.isTest)) return false;
      this.best = { score: sc, files: snap, at: Date.now(), start: false, draft: true };
      return true;
    }
    const snap = await snapshotCode(root);
    this.best = { score: sc, files: snap, at: Date.now(), start: !!opts.startSnap && sameCode(snap, opts.startSnap, opts.isTest) };
    return true;
  }
  // The project is worse than the best state seen: put the best state back. Test files are left alone (other rules own them).
  // keep(paths) (optional, 2026-11-16): called with the files about to be overwritten, BEFORE the write, so their drafts can be saved.
  async restoreBestIfWorse(root, score, emit, isTest = () => false, keep = null) {
    if (!this.best || !score || !betterScore(this.best.score, score)) return false;
    const now = await snapshotCode(root);
    if (typeof keep === "function") { try { await keep([...this.best.files].filter(([f, was]) => !isTest(f) && now.get(f) !== was && now.has(f)).map(([f]) => f)); } catch {} }
    const restored = [];
    for (const [f, was] of this.best.files) {
      if (isTest(f)) continue;
      if (now.get(f) !== was) { try { await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true }); await fs.writeFile(path.join(root, f), was, "utf8"); restored.push(f); } catch {} }
    }
    if (!restored.length) return false;
    this.note("best-state", `restored ${restored.join(", ")} (${this.best.score.good} passing, ${this.best.score.fails} failing) over (${score.good}, ${score.fails})`);
    emit?.({ type: "log", text: `watchdog: the last repair made the tests worse (${score.good} passing, ${score.fails} failing); put back the best state seen (${this.best.score.good} passing, ${this.best.score.fails} failing): ${restored.join(", ")}` });
    emit?.({ type: "narration", text: `The last repair made things worse, so I went back to the best version I had (${this.best.score.good} tests passing).` });
    return true;
  }

  // 5. the one-line report
  report() {
    if (!this.events.length) return "";
    const by = {}; for (const e of this.events) by[e.rule] = (by[e.rule] || 0) + 1;
    const line = `watchdog corrected ${this.events.length} slip${this.events.length > 1 ? "s" : ""}: ` + Object.entries(by).map(([k, v]) => `${k} x${v}`).join(", ");
    // STRONG2: the rules 14-21 also say WHAT they found (one short line each), so the report is useful on its own
    const det = this.events.filter((e) => STRONG2_RULES.has(e.rule)).map((e) => `${e.rule}: ${e.text}`);
    return det.length ? line + "\n" + [...new Set(det)].slice(0, 8).map((d) => "  - " + d).join("\n") : line;
  }
}
// rule names of the STRONG2 rules (their notes are listed one by one in report())
export const STRONG2_RULES = new Set(["untouched-stub", "forced-write", "wrong-language-file", "test-weakened", "secret-blocked", "destructive-cmd", "hardcoded-expected", "summary-name", "error-string"]);

// 4. The plan says: change `X` to `Y`. If X is a code line that exists in no project file, the plan is guessing.
export async function contractQuoteProblems(root, contract) {
  const quotes = [];
  for (const m of String(contract || "").matchAll(/\b(?:change|replace|rewrite|swap)\s+`([^`\n]{6,160})`\s+(?:to|with|by|into)\s+`/gi)) quotes.push(m[1]);
  if (!quotes.length) return [];
  const all = await snapshotCode(root);
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const hay = [...all.values()].map(norm).join("\n");
  return [...new Set(quotes)].filter((q) => /[(=<>.\[:]/.test(q) && !hay.includes(norm(q)));
}

// 6. The task states a rule in words that code must show somewhere ("lower case", "sorted", "exit with code 1").
// If NONE of the changed files shows it, the model most likely forgot it (live, task 10: tags were not lower-cased).
// Returns [{phrase, hint}] for each rule with no evidence in `sources` (array of file contents).
const SPEC_RULES = [
  { say: /\b(lower[ -]?case|lowercase)\b/i, proof: /\.lower\(|\.casefold\(|\bre\.I\b|IGNORECASE|toLowerCase\(|\.lower\b/, hint: "make the text lower case (for example with .lower())" },
  { say: /\b(upper[ -]?case|uppercase)\b/i, proof: /\.upper\(|toUpperCase\(|\.upper\b/, hint: "make the text upper case (for example with .upper())" },
  { say: /\bnot case[- ]sensitive|case[- ]insensitive|ignor\w* case\b/i, proof: /\.lower\(|\.casefold\(|\bre\.I\b|IGNORECASE|toLowerCase\(|\.upper\(/, hint: "compare without caring about upper or lower case" },
  { say: /\b(sorted|alphabetical(ly)?|in alphabetic order)\b/i, proof: /\bsorted\(|\.sort\(|\.sorted\(|\.toSorted\(|ORDER BY|orderBy/i, hint: "sort the values" },
  { say: /\b(round(ed|s)?\b|\d+ decimal (places|digits)|two decimals)\b/i, proof: /\bround\(|\.toFixed\(|:\.\d+f|%\.\d+f|Decimal|quantize|\bformat\(/, hint: "round or format the number" },
];
export function specEvidenceGaps(task, sources) {
  const t = String(task || ""); const hay = (sources || []).join("\n");
  if (!hay.trim()) return [];
  const gaps = [];
  for (const r of SPEC_RULES) {
    const m = t.match(r.say); if (!m) continue;
    if (!r.proof.test(hay)) gaps.push({ phrase: m[0], hint: r.hint });
  }
  // "exit with code N" (N is not 0): code must show that number as an exit
  for (const m of t.matchAll(/\bexit(?:s|ing)?\s+(?:with\s+)?(?:status\s+|code\s+)?(?:code\s+)?([1-9]\d?)\b/gi)) {
    const n = m[1];
    if (!new RegExp(String.raw`(?:exit|SystemExit|return|process\.exit|sys\.exit)\s*\(?\s*` + n + String.raw`\b`).test(hay)) gaps.push({ phrase: m[0], hint: `exit with code ${n}` });
  }
  const seen = new Set(); return gaps.filter((g) => (seen.has(g.hint) ? false : seen.add(g.hint)));
}

// 7. LIBRARY NAMES THAT DO NOT EXIST (idea from the user's TDI project, checker "H3": introspection, no model).
// Python's own standard library is installed on the PC, so "does os.path.exits exist?" is a FACT, not an opinion.
// Deliberately narrow (TDI's own lesson: precision first): only names reached through a stdlib module that the file imports,
// never methods of objects, never third-party libraries, never a name the file itself defines or assigns.
// Fail-open: any problem running the check means "no findings".
import { execFile } from "node:child_process";
const API_CHECK_PY = String.raw`
import ast, sys, json, importlib
std = getattr(sys, "stdlib_module_names", None)
if not std: print("[]"); sys.exit(0)
files = json.loads(sys.stdin.read()); out = []
def flag(path, line, msg):
    out.append({"file": path, "line": line, "msg": msg})
for path, src in files.items():
    try: tree = ast.parse(src)
    except Exception: continue
    mods = {}
    local = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): local.add(n.name)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for a in n.args.args + n.args.kwonlyargs + n.args.posonlyargs: local.add(a.arg)
            if n.args.vararg: local.add(n.args.vararg.arg)
            if n.args.kwarg: local.add(n.args.kwarg.arg)
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)): local.add(n.id)
        if isinstance(n, ast.ExceptHandler) and n.name: local.add(n.name)
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                top = a.name.split(".")[0]
                if top in std:
                    mods[a.asname or top] = a.name if a.asname else top
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0 and n.module.split(".")[0] in std:
            try: m = importlib.import_module(n.module)
            except Exception: continue
            for a in n.names:
                if a.name == "*": continue
                if not hasattr(m, a.name):
                    try: importlib.import_module(n.module + "." + a.name)
                    except Exception: flag(path, n.lineno, "from %s import %s: %s has no name %s" % (n.module, a.name, n.module, a.name))
    inner = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Attribute): inner.add(id(n.value))
    for n in ast.walk(tree):
        if not isinstance(n, ast.Attribute) or id(n) in inner: continue
        chain = []; cur = n
        while isinstance(cur, ast.Attribute): chain.append(cur.attr); cur = cur.value
        if not (isinstance(cur, ast.Name) and cur.id in mods and cur.id not in local): continue
        chain.reverse()
        try: obj = importlib.import_module(mods[cur.id])
        except Exception: continue
        name = mods[cur.id]
        for a in chain:
            if hasattr(obj, a): obj = getattr(obj, a); name += "." + a; continue
            try: obj = importlib.import_module(name + "." + a); name += "." + a; continue
            except Exception: pass
            flag(path, n.lineno, "%s has no attribute %s" % (name, a)); break
        # only module-level facts: stop at the first non-module object (methods of objects are not judged)
print(json.dumps(out[:20]))
`;
export function stdlibApiProblems(files, python = "python") {
  return new Promise((resolve) => {
    try {
      const entries = Object.entries(files || {}).filter(([f]) => /\.py$/i.test(f));
      if (!entries.length) return resolve([]);
      const child = execFile(python, ["-I", "-c", API_CHECK_PY], { timeout: 20000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        try { const r = JSON.parse(String(stdout).trim() || "[]"); resolve(Array.isArray(r) ? r : []); } catch { resolve([]); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(Object.fromEntries(entries)));
    } catch { resolve([]); }
  });
}

// 8. The same fact check for JavaScript (TDI was only built for Python; Eta users write JS, too).
// Judged: (a) Node's own modules the file imports (fs.readFileSyncc), (b) JavaScript's own global objects (Math.clamp, Array.flatten,
// Object.hasOwnProperties, JSON.parse2, console.print). Never: browser DOM names, npm packages, methods of objects, names the file
// declares itself. Fail-open, like the Python check.
const JS_CHECK = String.raw`
const { builtinModules } = require("module");
let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
  const files = JSON.parse(input || "{}"); const out = [];
  const GLOBALS = ["Math", "JSON", "Object", "Array", "Number", "String", "Date", "Promise", "Reflect", "Symbol", "console", "Intl", "Boolean", "BigInt", "Map", "Set"];
  const flag = (file, line, msg) => out.push({ file, line, msg });
  const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
  const stripped = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'` + "`" + String.raw`\\])\/\/[^\n]*/g, (m, a) => a + " ".repeat(m.length - a.length)).replace(/(["'` + "`" + String.raw`])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[0]);
  const walk = (obj, chain) => { let o = obj; let name = ""; for (const a of chain) { if (o === null || o === undefined) return null; if (!(a in Object(o))) return name + "." + a; o = o[a]; name += "." + a; if (typeof o !== "object" && typeof o !== "function") break; } return null; };
  for (const [file, raw] of Object.entries(files)) {
    const src = stripped(raw);
    const declared = new Set(); const params = new Set();
    for (const m of src.matchAll(/\b(?:let|const|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of src.matchAll(/\(([^()]*)\)\s*=>|function\s*[\w$]*\s*\(([^()]*)\)/g)) for (const p of (m[1] || m[2] || "").split(",")) { const pn = p.replace(/=.*$/, "").replace(/[{}\[\].\s]/g, ""); declared.add(pn); params.add(pn); }
    const importsOnce = {};
    const mods = {};
    for (const m of raw.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([\w:\/.-]+)['"]\s*\)/g)) importsOnce[m[1]] = (importsOnce[m[1]] || 0) + 1, mods[m[1]] = m[2];
    for (const m of raw.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]([\w:\/.-]+)['"]/g)) importsOnce[m[1]] = (importsOnce[m[1]] || 0) + 1, mods[m[1]] = m[2];
    const isBuiltin = (n) => builtinModules.includes(n.replace(/^node:/, ""));
    for (const [alias, mod] of Object.entries(mods)) {
      if (!isBuiltin(mod) || params.has(alias)) continue;
      let real; try { real = require(mod.replace(/^node:/, "")); } catch { continue; }
      // declared once = the import itself; more than once = the name is reused for something else, do not judge
      const decl = [...src.matchAll(new RegExp("\\b(?:let|const|var|function|class)\\s+" + alias.replace(/\$/g, "\\$") + "\\b", "g"))].length;
      if (decl > 1) continue;
      for (const m of src.matchAll(new RegExp("(?<![\\w$.])" + alias.replace(/\$/g, "\\$") + "((?:\\.[A-Za-z_$][\\w$]*)+)", "g"))) {
        const chain = m[1].slice(1).split(".");
        const bad = walk(real, chain); if (bad) { flag(file, lineOf(src, m.index), mod + bad.replace(/^\./, ".") + " does not exist"); }
      }
    }
    for (const m of raw.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]([\w:\/.-]+)['"]/g)) {
      if (!isBuiltin(m[2])) continue;
      let real; try { real = require(m[2].replace(/^node:/, "")); } catch { continue; }
      for (const part of m[1].split(",")) { const nm = part.trim().split(/\s+as\s+/)[0].trim(); if (nm && !(nm in real)) flag(file, lineOf(raw, m.index), m[2] + " has no export " + nm); }
    }
    for (const g of GLOBALS) {
      if (declared.has(g)) continue;
      for (const m of src.matchAll(new RegExp("(?<![\\w$.])" + g + "((?:\\.[A-Za-z_$][\\w$]*)+)", "g"))) {
        const chain = m[1].slice(1).split(".");
        if (chain[0] === "prototype") continue;
        const bad = walk(globalThis[g], chain.slice(0, 1)); if (bad) flag(file, lineOf(src, m.index), g + bad + " does not exist in JavaScript");
      }
    }
  }
  console.log(JSON.stringify(out.slice(0, 20)));
});
`;
export function nodeApiProblems(files, node = process.execPath) {
  return new Promise((resolve) => {
    try {
      const entries = Object.entries(files || {}).filter(([f]) => /\.(?:m|c)?js$/i.test(f));
      if (!entries.length) return resolve([]);
      const child = execFile(node, ["-e", JS_CHECK], { timeout: 20000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        try { const r = JSON.parse(String(stdout).trim() || "[]"); resolve(Array.isArray(r) ? r : []); } catch { resolve([]); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(Object.fromEntries(entries)));
    } catch { resolve([]); }
  });
}
// one call for both languages
export async function libraryApiProblems(files, python = "python") {
  const [py, js] = await Promise.all([stdlibApiProblems(files, python), nodeApiProblems(files)]);
  return [...py, ...js];
}

// ===== 9-13: hardening from the first public benchmark (2026-11-16, 6 JS tasks, 1 pass) =====
// Every rule below is plain code, fail-open (an error means "no finding"), and precision first.

// 9. Which files differ from the run's start. before/after = snapshotCode() maps. A new or deleted file counts as changed.
export function changedSince(before, after) {
  try {
    if (!before || !after) return [];
    const out = [];
    for (const [f, now] of after) { const was = before.get(f); if (was === undefined || was !== now) out.push(f); }
    for (const f of before.keys()) if (!after.has(f)) out.push(f);
    return out.sort();
  } catch { return []; }
}
// a snapshot this big may have missed files (snapshotCode stops at MAX_FILES): then "nothing changed" is not a fact
export function snapshotIsFull(snap) { return !!snap && snap.size >= MAX_FILES; }

// 10. RED GATE: may the run call itself done? Only facts: the last real test run, and whether a file changed.
// o = { testCmd, couldNotRun: "" | reason, green, fails, changeKnown, changedImpl, changedTests, testOnlyTask }
// Live (benchmark): 4 runs ended "done" while their own final test command still failed, one with the target still the untouched stub.
export function redGateVerdict(o = {}) {
  try {
    const parts = [];
    let code = "done";
    const noChange = o.changeKnown !== false && !o.changedImpl && !(o.testOnlyTask && o.changedTests);
    // PRE-EXISTING failures (the suite was already red before the run, and the run did not lock its own spec): not charged to the run,
    // as long as the run changed something and did not make the count worse. Said plainly, never hidden.
    const pre = Number.isFinite(o.preFails) && o.preFails > 0 ? o.preFails : 0;
    if (o.testCmd && !o.couldNotRun && !o.green && o.preExisting && pre && Number.isFinite(o.fails) && o.fails <= pre && !noChange) {
      return { ok: true, status: "done", code: "done-preexisting-failures", text: `Done, but ${o.fails} test${o.fails === 1 ? "" : "s"} still fail${o.fails === 1 ? "s" : ""} that already failed before this run (${pre} at the start).` };
    }
    if (o.testCmd && o.couldNotRun) { code = "tests-could-not-run"; parts.push(`NOT DONE: tests could not run (${o.couldNotRun})`); }
    else if (o.testCmd && !o.green) { code = "tests-failing"; parts.push(`NOT DONE: tests still failing (${Number.isFinite(o.fails) && o.fails > 0 ? o.fails : "some"} failing)${pre && o.preExisting ? `; ${pre} were already failing at the start` : ""}`); }
    if (noChange) {
      if (code === "done") code = "no-change";
      parts.push(o.changedTests ? "NOT DONE: no source file was changed (only test files were)" : "NOT DONE: no file was changed");
    }
    if (code === "done" && !o.testCmd) return { ok: true, status: "done", code: "no-tests", text: "Done, but not checked by tests: no test command was found for this project." };
    if (code === "done") return { ok: true, status: "done", code: "done", text: "" };
    return { ok: false, status: "not-done", code, text: parts.join("; ") };
  } catch { return { ok: true, status: "done", code: "unknown", text: "" }; }
}

// 11. A reviewer or inspector CLAIM that only a measurement can prove. "" = not that kind of claim (left alone).
// Live (benchmark): a reviewer message about a "jest parse error" drove more repair work; such a claim must be re-measured first.
export function claimKind(text) {
  const s = String(text || "");
  if (/\b(parse error|syntax ?error|does(?: not|n't) (?:compile|parse)|won'?t compile|cannot (?:parse|compile)|fail(?:s|ed)? to (?:parse|compile)|unexpected token|compil(?:e|ation) (?:error|fails?|failed))\b/i.test(s)) return "compile";
  if (/\b(tests? (?:fail|fails|failed|are failing|is failing|still fail|do not pass|don'?t pass|does not pass)|failing tests?|test suite (?:fails|failed|does not run|cannot run))\b/i.test(s)) return "tests";
  return "";
}

// 12. TEST LANGUAGE MATCHES THE PROJECT. Live (benchmark): Python test files were written into 4 of 5 JavaScript projects
// (a 9 KB test_main.py in rest-api) and locked as the "authoritative spec".
const LANG_BY_EXT = [
  [/\.py$/i, "python"], [/\.(?:m|c)?js$|\.jsx?$|\.tsx?$/i, "javascript"], [/\.go$/i, "go"], [/\.rs$/i, "rust"],
  [/\.(?:java|kt|kts)$/i, "java"], [/\.cs$/i, "csharp"], [/\.rb$/i, "ruby"], [/\.php$/i, "php"], [/\.swift$/i, "swift"],
  [/\.(?:c|h|cc|cpp|cxx|hpp|hh)$/i, "c"],
];
export function testLangOf(rel) { const f = String(rel || ""); for (const [re, l] of LANG_BY_EXT) if (re.test(f)) return l; return ""; }
const LANG_TEST_NAME = {
  python: "test_<name>.py or <name>_test.py", javascript: "<name>.test.js or <name>.spec.js", go: "<name>_test.go", rust: "tests inside the .rs file (#[cfg(test)]) or tests/<name>.rs",
  java: "<Name>Test.java under src/test/java", csharp: "<Name>Tests.cs", ruby: "<name>_spec.rb or test_<name>.rb", php: "<Name>Test.php", swift: "<Name>Tests.swift", c: "a test file in the project's own test folder",
};
export const isTestName = (rel) => /(^|[\\/])test_|_test\.|\.test\.|\.spec\.|_spec\.|(^|[\\/])tests?[\\/]|(^|[\\/])__tests__[\\/]|(Test|Tests)\.(java|kt|cs|php|swift)$|(^|[\\/])src[\\/]test[\\/]/.test(String(rel)) || isTestPathAny(rel); // STRONG2 A1
const CONFIG_FILE = /(^|[\\/])(babel|jest|vite|vitest|webpack|rollup|eslint|prettier|tailwind|postcss|next|nuxt|svelte|karma|metro)\.config\.\w+$|(^|[\\/])\.?eslintrc\.\w+$|(^|[\\/])(setup|conftest|noxfile|fabfile)\.py$/i;
// Languages a test file may be written in: languages of test files that already exist + languages of the project's own source files
// + what the build files say. Returns { allowed:Set, existingTests:Set, primary:"" }. An empty set means "not known" (empty folder): nothing is refused.
export async function projectTestLangs(root) {
  const allowed = new Set(), existingTests = new Set(), src = {};
  try {
    const snap = await snapshotCode(root);
    for (const f of snap.keys()) {
      const l = testLangOf(f); if (!l) continue;
      if (isTestName(f)) { existingTests.add(l); allowed.add(l); }
      else if (!CONFIG_FILE.test(f)) { src[l] = (src[l] || 0) + 1; allowed.add(l); }
    }
    let ents = []; try { ents = await fs.readdir(root); } catch {}
    if (ents.includes("package.json")) allowed.add("javascript");
    if (ents.includes("go.mod")) allowed.add("go");
    if (ents.includes("Cargo.toml")) allowed.add("rust");
    if (ents.some((e) => /^(pom\.xml|build\.gradle(\.kts)?)$/.test(e))) allowed.add("java");
    if (ents.some((e) => /^(pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Pipfile|tox\.ini)$/.test(e))) allowed.add("python");
    const primary = Object.entries(src).sort((a, b) => b[1] - a[1])[0]?.[0] || (ents.includes("package.json") ? "javascript" : "") || [...existingTests][0] || "";
    return { allowed, existingTests, primary };
  } catch { return { allowed: new Set(), existingTests: new Set(), primary: "" }; }
}
// "" when this test file is fine; else the tool error for the model (it names the right language and file name pattern).
export function wrongLanguageTest(rel, langs) {
  try {
    if (!isTestName(rel)) return "";
    const l = testLangOf(rel);
    if (!l || !langs || !langs.allowed || !langs.allowed.size || langs.allowed.has(l)) return "";
    const want = langs.primary || [...langs.allowed][0] || "";
    return `REFUSED: ${rel} is a ${l} test file, but this is a ${want || [...langs.allowed].join("/")} project (no ${l} code or tests exist here). ` +
      `Write tests in ${want || "the project's language"} instead, named like ${LANG_TEST_NAME[want] || "the existing test files"}${langs.existingTests && langs.existingTests.has(want) ? ", next to the test files that already exist" : ""}. Nothing was written.`;
  } catch { return ""; }
}
// The task itself says the tests are already there ("The test file x.spec.js is already in this folder").
export function testsAlreadyGiven(task) {
  const s = String(task || "");
  return /\btest(?:s| files?| suite)?\b(?:[^.\n]|\.(?=\w)){0,120}\b(?:is|are) already (?:in|here|present|provided|included|written|there|part of)\b/i.test(s)
    || /\b(?:existing|provided|given) (?:test files?|tests|test suite|spec files?)\b/i.test(s)
    || /\balready (?:has|have|contains?|includes?) (?:a |the )?(?:test|tests|test files?|test suite|spec)\b/i.test(s);
}

// 13. A restore must never throw a draft away: save the text first, so a retry (or the user) can reuse it.
// entries = [{ rel, content }]. Returns the saved paths (relative to root), e.g. ".eta/drafts/src__a.js.1". The same text is saved once.
export async function saveDrafts(root, entries) {
  const saved = [];
  try {
    const dir = path.join(root, ".eta", "drafts");
    for (const e of entries || []) {
      if (!e || !e.rel || typeof e.content !== "string" || !e.content.trim()) continue;
      try {
        await fs.mkdir(dir, { recursive: true });
        const base = String(e.rel).replace(/[\\/:]+/g, "__");
        let have = []; try { have = await fs.readdir(dir); } catch {}
        const mine = have.filter((x) => x.startsWith(base + ".") && /^\d+$/.test(x.substring(base.length + 1)));
        let same = "";
        for (const h of mine) { try { if ((await fs.readFile(path.join(dir, h), "utf8")) === e.content) { same = h; break; } } catch {} }
        if (same) { saved.push(".eta/drafts/" + same); continue; }
        const n = mine.reduce((m, x) => Math.max(m, Number(x.substring(base.length + 1)) || 0), 0) + 1;
        await fs.writeFile(path.join(dir, `${base}.${n}`), e.content, "utf8");
        saved.push(`.eta/drafts/${base}.${n}`);
      } catch {}
    }
  } catch {}
  return saved;
}

// ===== 14-21: STRONG2 (2026-11-16). Plain code, per-language tables, fail-open (an error = no finding), precision first. =====
// Each one is either a REPORT/HINT, or acts only on a fact that is certain (a file this run created, a test file the run changed).
// Each can be overridden by the task text (the user asked for exactly that).

// 14. UNTOUCHED STUB (B1). Live (rest-api, benchmark): the target file was never written; the run "repaired nothing" for 20 minutes.
// startSnap/nowSnap = snapshotCode() maps; targets = files the task is about; stubsOf(rel, text) = the engine's stub detector.
// Returns [{ file, why }] for each target that is unchanged since the start or still has stub markers.
export function untouchedTargets(startSnap, nowSnap, targets, stubsOf) {
  const out = [];
  try {
    for (const f of [...new Set(targets || [])]) {
      const was = startSnap?.get?.(f), now = nowSnap?.get?.(f);
      if (now === undefined) continue; // not on disk (a new file the task wants: other rules own that)
      let stubs = []; try { stubs = (typeof stubsOf === "function" ? stubsOf(f, now) : []) || []; } catch { stubs = []; }
      if (was !== undefined && was === now) out.push({ file: f, why: stubs.length ? `unchanged since the start, still a stub (${stubs.map((s) => s.name).slice(0, 3).join(", ")})` : "unchanged since the start" });
      else if (stubs.length) out.push({ file: f, why: `still has stub markers (${stubs.map((s) => s.name).slice(0, 3).join(", ")})` });
    }
  } catch {}
  return out;
}

// 15. WRONG-LANGUAGE FILE (B2). Which languages this project uses: its build files + the languages of its files at the start.
const MANIFEST_LANG = [
  [/^package\.json$|^tsconfig\.json$|^deno\.jsonc?$/, "javascript"], [/^go\.mod$/, "go"], [/^Cargo\.toml$/, "rust"],
  [/^pom\.xml$|^build\.gradle(\.kts)?$|^settings\.gradle(\.kts)?$/, "java"], [/\.(csproj|sln|fsproj)$/, "csharp"],
  [/^Gemfile$|^Rakefile$|\.gemspec$/, "ruby"], [/^composer\.json$/, "php"], [/^Package\.swift$/, "swift"],
  [/^requirements[\w.-]*\.txt$|^pyproject\.toml$|^setup\.py$|^setup\.cfg$|^Pipfile$|^tox\.ini$/, "python"],
  [/^CMakeLists\.txt$|^meson\.build$/, "c"],
];
// languages named in a task ("in Go", "a TypeScript file", "C#"): the task may ask for a file in such a language
const LANG_WORDS = {
  python: /\bpython\b|\.py\b/i, javascript: /\b(?:java ?script|js|node(?:\.js)?|typescript|ts|react|vue|frontend|front-end|browser|web ?page)\b|\.(?:m|c)?[jt]sx?\b/i,
  go: /\b(?:go|golang)\b|\.go\b/i, rust: /\brust\b|\.rs\b|\bcargo\b/i, java: /\b(?:java|kotlin|jvm|android|gradle|maven)\b|\.(?:java|kts?)\b/i,
  csharp: /\b(?:c#|csharp|\.net|dotnet)\b|\.cs\b|C#/i, ruby: /\b(?:ruby|rails|rspec)\b|\.rb\b/i, php: /\b(?:php|laravel)\b|\.php\b/i,
  swift: /\b(?:swift|ios|xcode)\b|\.swift\b/i, c: /\b(?:c\+\+|cpp|c language|in c|header)\b|C\+\+|\.(?:c|h|cc|cpp|hpp)\b/i,
};
export async function projectLangs(root, startSnap = null) {
  const langs = new Set();
  try {
    const snap = startSnap || await snapshotCode(root);
    for (const f of snap.keys()) { if (CONFIG_FILE.test(f)) continue; const l = testLangOf(f); if (l) langs.add(l); if (/\.html?$/i.test(f)) langs.add("javascript"); }
    let ents = []; try { ents = await fs.readdir(root); } catch {}
    for (const e of ents) for (const [re, l] of MANIFEST_LANG) if (re.test(e)) langs.add(l);
    for (const e of ents) if (/\.html?$/i.test(e)) langs.add("javascript"); // a web page may get its script
  } catch {}
  return langs;
}
// "" = this file is fine; else why it is in a language the project does not use. Never judged: an empty project, a config file,
// a non-code file, a file the task names, a language the task names.
export function wrongLanguageFile(rel, langs, task) {
  try {
    const l = testLangOf(rel);
    if (!l || !langs || !langs.size || langs.has(l)) return "";
    if (CONFIG_FILE.test(rel)) return "";
    const t = String(task || ""), base = String(rel).replace(/\\/g, "/").split("/").pop();
    if (t.includes(base) || t.includes(String(rel).replace(/\\/g, "/"))) return "";
    if (LANG_WORDS[l] && LANG_WORDS[l].test(t)) return "";
    return `${rel} is a ${l} file, but this project uses ${[...langs].join(", ")} and the task does not ask for ${l}`;
  } catch { return ""; }
}

// 16. TEST-WEAKENING DIFF (B3). Counts per test file: test functions, assertions, skip/only markers, always-true assertions.
const TEST_FN_RE = [
  /^[ \t]*(?:async[ \t]+)?def[ \t]+test\w*/gm,                                       // Python, Ruby minitest
  /\b(?:it|test)(?:\.each\s*\([^)]*\))?\s*\(\s*["'`]/g,                             // jest, vitest, mocha, node:test
  /^func[ \t]+Test\w*[ \t]*\(/gm,                                                     // Go
  /#\[(?:tokio::|async_std::)?test\]/g,                                               // Rust
  /@Test\b|\[(?:Test|Fact|Theory|TestMethod|TestCase)\b/g,                            // Java, Kotlin, C#
  /^[ \t]*(?:it|specify|scenario)[ \t]+["']/gm,                                       // RSpec
  /function[ \t]+test\w*[ \t]*\(/g,                                                   // PHPUnit
  /func[ \t]+test\w*[ \t]*\(/g,                                                       // XCTest
  /\bTEST(?:_F|_P)?\s*\(|\bTEST_CASE\s*\(/g,                                          // GoogleTest, Catch2
];
const ASSERT_RE = /\b(?:assert\w*!?|expect|XCTAssert\w*|EXPECT_[A-Z_]+|ASSERT_[A-Z_]+|REQUIRE(?:_[A-Z_]+)?|CHECK(?:_[A-Z_]+)?)\s*[({]|\bassert\.\w+\s*\(|\bassert[ \t]+\S|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\.should\b|\bself\.fail\s*\(/g;
const SKIP_RE = /\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe)\s*\(|\b(?:it|test|describe|context)\.(?:skip|only|todo)\s*\(|@(?:Ignore|Disabled)\b|\bt\.Skip(?:f|Now)?\s*\(|#\[ignore\]|pytest\.mark\.(?:skip|xfail)|@unittest\.(?:skip|expectedFailure)|\bself\.skipTest\s*\(|\[Ignore\b|\[Fact\s*\(\s*Skip\s*=|markTestSkipped|\bskip\s*\(\s*["'`]|\bpending\s*\(|GTEST_SKIP\s*\(|XCTSkip/g;
const TRIVIAL_RE = [
  /\bassert[ \t]+(?:True|1|not[ \t]+False)\b[ \t]*(?:#.*)?$/gm,
  /\bassert[ \t]+(\w+)[ \t]*==[ \t]*\1\b[ \t]*$/gm,
  /\bassert(?:True|_)?\s*\(\s*(?:True|true|1)\s*\)/g,
  /\bself\.assertTrue\s*\(\s*(?:True|1)\s*\)/g,
  /\bexpect\s*\(\s*(?:true|1)\s*\)\s*\.\s*(?:toBe|toEqual|toBeTruthy|toStrictEqual)\s*\(\s*(?:true|1)?\s*\)/g,
  /\bassert(?:_eq)?!\s*\(\s*true\s*\)/g,
  /\bXCTAssertTrue\s*\(\s*true\s*\)/g,
  /\bassertEquals\s*\(\s*(\w+|"[^"]*"|\d+)\s*,\s*\1\s*\)/g,
  /\bexpect\s*\(\s*(\w+|"[^"]*"|'[^']*'|\d+)\s*\)\s*\.\s*(?:toBe|toEqual)\s*\(\s*\1\s*\)/g,
];
function stripComments(text, rel) {
  let s = String(text || "");
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/^[ \t]*\/\/.*$/gm, "");
  if (/\.(py|rb|sh)$/i.test(rel || "") || !rel) s = s.replace(/^[ \t]*#(?!\[).*$/gm, "");
  return s;
}
export function testStrength(text, rel = "") {
  const s = stripComments(text, rel);
  const count = (re) => { try { re.lastIndex = 0; return (s.match(re) || []).length; } catch { return 0; } };
  return {
    tests: TEST_FN_RE.reduce((a, re) => a + count(re), 0),
    asserts: count(ASSERT_RE),
    skips: count(SKIP_RE),
    trivial: TRIVIAL_RE.reduce((a, re) => a + count(re), 0),
  };
}
// "" = not weaker; else a short reason ("2 fewer tests, a new skip marker").
export function testWeakening(before, after, rel = "") {
  try {
    if (typeof before !== "string" || typeof after !== "string" || before === after) return "";
    const a = testStrength(before, rel), b = testStrength(after, rel);
    const why = [];
    if (b.tests < a.tests) why.push(`${a.tests - b.tests} fewer test${a.tests - b.tests > 1 ? "s" : ""} (${a.tests} -> ${b.tests})`);
    if (b.asserts < a.asserts) why.push(`${a.asserts - b.asserts} fewer assertion${a.asserts - b.asserts > 1 ? "s" : ""} (${a.asserts} -> ${b.asserts})`);
    if (b.skips > a.skips) why.push(`${b.skips - a.skips} new skip/only marker${b.skips - a.skips > 1 ? "s" : ""}`);
    if (b.trivial > a.trivial) why.push(`${b.trivial - a.trivial} new always-true assertion${b.trivial - a.trivial > 1 ? "s" : ""}`);
    return why.join(", ");
  } catch { return ""; }
}
// the task itself asks to change, remove or skip tests: rule 16 stands down
export function taskAllowsTestChange(task) {
  const t = String(task || "");
  // the verb must take the tests as its object ("remove the obsolete test", "update the calc tests"), not "fix add() so the tests pass"
  return /\b(?:change|update|modify|fix|rewrite|remove|delete|drop|skip|disable|rename|replace|simplify|refactor|edit|correct|adjust)\s+(?:(?:the|these|those|this|that|a|an|my|our|some|all|every|its|failing|broken|old|obsolete|existing|outdated|flaky|wrong)\s+){0,3}(?:[\w-]+\s+)?(?:tests?|specs?|assert(?:ion)?s?|test[ _-]?(?:file|case|suite)s?)\b/i.test(t)
    || /\b(?:tests?|specs?)\b[^.\n]{0,20}\b(?:should be|must be|need to be|can be) (?:removed|deleted|changed|updated|rewritten|skipped|disabled)\b/i.test(t)
    || /\b(?:tests?|specs?|assert(?:ion)?s?)\b[^.\n]{0,40}\b(?:are|is) (?:wrong|outdated|broken|incorrect|flaky|obsolete)\b/i.test(t);
}

// 17. SECRET IN FILE (B4). Key shapes only (precision first); documentation examples and xxxx placeholders do not count.
const SECRET_SHAPES = [
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["an OpenAI-style API key", /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g],
  ["a private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["a Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["a Stripe secret key", /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g],
];
const PLACEHOLDER = /EXAMPLE|(?:x{6,}|X{6,}|\*{6,}|0{8,}|1{8,})|your[_-]?(?:key|token)|dummy|fake|placeholder|redacted|changeme/i;
// [{ kind, sample }] for key shapes in `text` that were NOT already in `oldText` and are not in the task text.
export function secretFindings(text, oldText = "", task = "") {
  const out = [];
  try {
    const s = String(text || ""), old = String(oldText || ""), t = String(task || "");
    if (/\b(?:secret|key|token|credential)s?\b[^.\n]{0,40}\b(?:scanner|detector|redact\w*|mask\w*|filter|test data|fixture|sample)\b|\b(?:redact|mask|detect|scan)\w*\b[^.\n]{0,40}\b(?:secrets?|keys?|tokens?)\b/i.test(t)) return [];
    for (const [kind, re] of SECRET_SHAPES) {
      re.lastIndex = 0;
      for (const m of s.matchAll(re)) {
        const v = m[0];
        if (PLACEHOLDER.test(v) || old.includes(v) || t.includes(v)) continue;
        if (/^(.)\1+$/.test(v.replace(/^[A-Za-z]+[-_]/, ""))) continue;
        out.push({ kind, sample: v.slice(0, 6) + "..." });
        break;
      }
    }
  } catch {}
  return out;
}
export function secretRefusal(rel, found) {
  const kinds = [...new Set((found || []).map((f) => f.kind))].join(", ");
  return `REFUSED: ${rel} would contain what looks like a real secret (${kinds}). Never write keys or tokens into a file: read the value from an environment variable instead (process.env.NAME in JavaScript, os.environ["NAME"] in Python, os.Getenv("NAME") in Go) and say in a comment which variable to set. Nothing was written.`;
}

// 18. DESTRUCTIVE SHELL (B5): extends the engine's built-in safety hook (DANGEROUS_CMD in agent.mjs) with more commands and with
// writes or deletes OUTSIDE the project folder. "" = allowed. The task text can allow a command by naming it.
const DESTRUCTIVE = [
  [/\bgit\s+reset\s+--hard\b/i, "git reset --hard (throws away uncommitted work)"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "git clean -f (deletes untracked files)"],
  [/\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)|\bgit\s+restore\s+(?:--\S+\s+)*\.(?:\s|$)/i, "git checkout/restore . (throws away all changes)"],
  [/\bdel\s+(?:\/[a-z]\s+)*\/s\b|\berase\s+(?:\/[a-z]\s+)*\/s\b/i, "del /s (deletes a whole folder tree)"],
  [/\b(?:rmdir|rd)\s+(?:\/[a-z]\s+)*\/s\b/i, "rmdir /s (deletes a whole folder tree)"],
  [/(?:^|[;&|(]\s*)format(?:\.com)?\s+\S/i, "format (wipes a disk)"],
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b/i, "DROP/TRUNCATE (deletes database data)"],
  [/\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|iex|Invoke-Expression|python\d?|node|perl|ruby)\b/i, "downloads a script and runs it (curl | sh)"],
  [/\biex\s*\(\s*(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+Net\.WebClient)/i, "downloads a script and runs it (iex)"],
  [/\bRemove-Item\b[^\n|;&]*-Recurse\b[^\n|;&]*(?:\s[A-Za-z]:\\?\s*$|\s\/\s*$|\s~\s*$|\s\*\s*$)/i, "Remove-Item -Recurse on a whole drive or folder"],
];
const WRITE_CMDS = /^(?:rm|del|erase|rmdir|rd|unlink|shred|Remove-Item|ri|mv|move|Move-Item|cp|copy|xcopy|robocopy|Copy-Item|Set-Content|Add-Content|Out-File|New-Item|tee|touch|truncate|chmod|chown)$/i;
const DEST_ONLY = /^(?:mv|move|Move-Item|cp|copy|xcopy|robocopy|Copy-Item)$/i;
function splitArgs(seg) { const out = []; for (const m of String(seg).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]); return out; }
function outsideRoot(arg, root) {
  try {
    let a = String(arg || "").trim(); if (!a) return false;
    if (/^(?:\/dev\/null|nul|\$null|NUL:?)$/i.test(a)) return false;
    if (/[$%`]/.test(a) && !/^(?:~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)/i.test(a)) return false; // unknown variable: no verdict
    if (/^(?:~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)(?:[\\/]|$)/i.test(a)) return true;
    if (/^-/.test(a)) return false;
    const tmp = String(process.env.TEMP || process.env.TMPDIR || "/tmp").toLowerCase();
    const full = path.resolve(root, a);
    if (full.toLowerCase().startsWith(tmp)) return false;
    const rel = path.relative(path.resolve(root), full);
    return rel.startsWith("..") || path.isAbsolute(rel);
  } catch { return false; }
}
export function destructiveCommand(command, opts = {}) {
  try {
    const c = String(command || ""), task = String(opts.task || "");
    for (const [re, what] of DESTRUCTIVE) {
      const m = re.exec(c);
      if (m && !(task && task.toLowerCase().includes(m[0].trim().toLowerCase()))) return what;
    }
    if (!opts.root) return "";
    // writes and deletes outside the project folder: redirections, then each command segment
    for (const m of c.matchAll(/(?:^|[^0-9&>])>>?\s*("?)([^\s"|;&<>]+)\1/g)) {
      if (outsideRoot(m[2], opts.root) && !task.includes(m[2])) return `writes outside the project folder (> ${m[2]})`;
    }
    for (const seg of c.split(/&&|\|\||[;&|\n]/)) {
      const args = splitArgs(seg.trim()); if (!args.length) continue;
      const cmd = args[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
      if (!WRITE_CMDS.test(cmd)) continue;
      const rest = args.slice(1).filter((a) => !/^-|^\/[a-z]$/i.test(a));
      const targets = DEST_ONLY.test(cmd) ? rest.slice(-1) : rest;
      for (const t of targets) if (outsideRoot(t, opts.root) && !task.includes(t)) return `${cmd} touches a path outside the project folder (${t})`;
    }
  } catch {}
  return "";
}

// 19. HARDCODED EXPECTED VALUE (B6, hint only). A literal that a locked test expects AND that a source function returns as a bare
// constant while ignoring all its parameters: the code may be "passing" one test by copying its answer.
// tests/sources = { rel: text }. Returns [{ file, fn, literal }].
const TRIVIAL_LIT = /^(?:0|1|-1|0\.0|true|false|True|False|None|null|nil|undefined|""|''|\[\]|\{\})$/;
function expectedLiterals(text) {
  const lits = new Set();
  for (const line of String(text || "").split("\n")) {
    if (!/\b(?:assert\w*|expect|XCTAssert\w*|EXPECT_\w+|ASSERT_\w+|want|expected)\b/.test(line)) continue;
    for (const m of line.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)(?![\w.])|("(?:[^"\\\n]|\\.){1,80}")|('(?:[^'\\\n]|\\.){1,80}')/g)) {
      const v = m[1] || m[2] || m[3]; if (v && !TRIVIAL_LIT.test(v)) lits.add(m[1] ? String(Number(v)) : v.slice(1, -1));
    }
  }
  return lits;
}
export function hardcodedExpected(tests, sources) {
  const out = [];
  try {
    const want = new Set(); for (const t of Object.values(tests || {})) for (const l of expectedLiterals(t)) want.add(l);
    if (!want.size) return [];
    const norm = (v) => { const s = String(v).trim().replace(/;$/, ""); if (/^-?\d+(?:\.\d+)?$/.test(s)) return String(Number(s)); const q = /^(["'`])(.*)\1$/.exec(s); return q ? q[2] : null; };
    for (const [rel, src] of Object.entries(sources || {})) {
      const s = String(src || "");
      // Python: def f(a, b):\n    return LIT   (one statement)
      for (const m of s.matchAll(/^([ \t]*)def[ \t]+(\w+)[ \t]*\(([^)]*)\)[^:\n]*:[ \t]*\n(?:[ \t]*(?:#.*|"""[^\n]*"""|'''[^\n]*''')?\n)*[ \t]+return[ \t]+([^\n#]+?)[ \t]*(?:#.*)?\n(?![ \t]+\S)/gm)) {
        const params = m[3].split(",").map((p) => p.split(/[:=]/)[0].replace(/[*\s]/g, "")).filter((p) => p && p !== "self" && p !== "cls");
        const lit = norm(m[4]); if (lit === null || !params.length || !want.has(lit)) continue;
        out.push({ file: rel, fn: m[2], literal: lit });
      }
      // { } languages: name(params) ... { return LIT; }   (the whole body is one return)
      for (const m of s.matchAll(/\b(\w+)[ \t]*\(([^()]*)\)[^{};\n]*\{\s*return[ \t]+([^;\n{}]+?)[ \t]*;?\s*\}/g)) {
        if (/^(?:if|for|while|switch|catch|function)$/.test(m[1])) continue;
        const params = m[2].split(",").map((p) => p.trim()).filter(Boolean);
        const lit = norm(m[3]); if (lit === null || !params.length || !want.has(lit)) continue;
        const names = params.map((p) => (p.match(/([A-Za-z_$][\w$]*)\s*(?::[^,]*)?(?:=.*)?$/) || [])[1]).filter(Boolean);
        if (names.some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(m[3]))) continue;
        out.push({ file: rel, fn: m[1], literal: lit });
      }
    }
  } catch {}
  return out.slice(0, 10);
}

// 20. SUMMARY-NAME CHECK (B7, TDI H5-lite, report only). Names in the model's final message (`backticked`, CamelCase, snake_case)
// that appear in NO project file and not in the task: the summary may describe work that does not exist.
const COMMON_NAMES = new Set("JavaScript TypeScript GitHub PowerShell NodeJS README OpenAI JSON YAML HTML CSS HTTP HTTPS API REST SQL URL UTF-8 macOS iOS npm pytest unittest jest vitest mocha DevTools VSCode LocalStorage OAuth WebSocket NaN null undefined true false None True False self this".split(" ").map((x) => x.toLowerCase()));
export function unknownSummaryNames(summary, projectText, task) {
  try {
    const s = String(summary || ""), hay = String(projectText || ""), t = String(task || "");
    if (!s.trim() || !hay.trim()) return [];
    const cands = new Set();
    for (const m of s.matchAll(/`([^`\n]{2,60})`/g)) { const v = m[1].trim().replace(/\(\)$/, ""); if (/^[A-Za-z_$][\w$.]*$/.test(v)) cands.add(v); }
    for (const m of s.matchAll(/\b([a-z]+(?:[A-Z][a-z0-9]+){1,}|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){1,}|[a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/g)) cands.add(m[1]);
    const out = [];
    for (const c of cands) {
      const last = c.split(".").pop();
      if (COMMON_NAMES.has(c.toLowerCase()) || c.length < 4) continue;
      if (t.includes(c) || t.includes(last)) continue;
      if (hay.includes(last)) continue;
      out.push(c);
    }
    return out.slice(0, 8);
  } catch { return []; }
}

// 21. EXACT ERROR STRINGS (B8). The task quotes an error message near "error/message/raise/throw/exception"; no changed file has it.
// Returns [{ phrase, hint }] (the same shape as specEvidenceGaps, so the engine sends them to the same repair prompt).
export function exactErrorStringGaps(task, sources, extraStrings = []) {
  try {
    const t = String(task || ""), hay = (sources || []).join("\n");
    if (!hay.trim()) return [];
    const want = new Set();
    for (const m of t.matchAll(/(["'`“])([^"'`”\n]{4,120})(?:["'`”])/g)) {
      const q = m[2], at = m.index;
      const near = t.slice(Math.max(0, at - 80), Math.min(t.length, at + q.length + 80));
      if (!/\b(?:errors?|messages?|raises?|raised|throws?|thrown|exceptions?|rejects?|rejected|fails? with|panics?|warns?|warning)\b/i.test(near)) continue;
      if (!/[A-Za-z]{2}/.test(q) || /^[\w.\/\\-]+\.(?:py|js|ts|go|rs|java|json|md|txt)$/.test(q)) continue; // a file name is not a message
      want.add(q);
    }
    for (const x of extraStrings || []) if (typeof x === "string" && x.length >= 4 && /[A-Za-z]{2}/.test(x)) want.add(x);
    const gaps = [];
    for (const q of want) if (!hay.includes(q)) gaps.push({ phrase: q, hint: `use this EXACT error message text, character for character: "${q}"` });
    return gaps.slice(0, 6);
  } catch { return []; }
}

// ---------------------------------------------------------------- GATE1 WRITE GATE checks (2026-11-17, plain code)
// Used by agent.mjs gatedWrite() after every model-made write. Each function compares the PREVIOUS text of a file with the NEW
// text and answers "" (fine) or a short reason. Any error inside = "" (fail-open: a checker problem never blocks a write).
// Measured cause (benchmark b2r, js-beer-song): an edit left a second copy of verse()/recite() after the first one; the old gate
// passed it, and the test suite could not even start.

// Top-level definition headers per language. Languages where a name may legally appear twice at the top level (C/C++ prototypes,
// Ruby re-opened classes, Kotlin/Swift extensions, TypeScript declaration merging of interfaces) are left out or narrowed.
const TOP_DEF_RE = {
  python: /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)|^class[ \t]+([A-Za-z_]\w*)/gm,
  javascript: /^(?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)|^(?:export[ \t]+)?(?:const|let|class)[ \t]+([A-Za-z_$][\w$]*)/gm,
  typescript: /^(?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)(?=[ \t]*[(<])(?![^\n]*;[ \t]*$)|^(?:export[ \t]+)?(?:const|let|class)[ \t]+([A-Za-z_$][\w$]*)/gm,
  go: /^func[ \t]+(\([^)]*\)[ \t]*)?([A-Za-z_]\w*)/gm,
  rust: /^(?:pub(?:\([^)]*\))?[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?fn[ \t]+([A-Za-z_]\w*)|^(?:pub(?:\([^)]*\))?[ \t]+)?(?:struct|enum|trait)[ \t]+([A-Za-z_]\w*)/gm,
  java: /^(?:public[ \t]+|final[ \t]+|abstract[ \t]+|sealed[ \t]+)*(?:class|interface|enum|record)[ \t]+([A-Za-z_]\w*)/gm,
  php: /^function[ \t]+([A-Za-z_]\w*)|^(?:final[ \t]+|abstract[ \t]+)?class[ \t]+([A-Za-z_]\w*)/gm,
};
function topDefCounts(text, lang) {
  const re = TOP_DEF_RE[lang]; const out = new Map();
  if (!re) return out;
  const src = String(text || ""), lines = src.split("\n");
  re.lastIndex = 0; let m;
  while ((m = re.exec(src))) {
    let name = lang === "go" ? ((m[1] ? m[1].replace(/[()\s*]/g, " ").trim().split(/\s+/).pop() + "." : "") + m[2]) : (m[1] || m[2]);
    if (!name || name === "_") continue;
    if (lang === "python") { // a decorated twin is often legal (@overload, @x.register, @x.setter at module level)
      const ln = src.slice(0, m.index).split("\n").length - 1; const before = (lines[ln - 1] || "").trim();
      if (/^@.*\b(overload|register|setter|getter|deleter|dispatch)\b/.test(before)) continue;
    }
    out.set(name, (out.get(name) || 0) + 1);
  }
  return out;
}
// (ii) a definition that the new text holds twice (more often than the old text did), or a file that grew to >= 1.6x with a long
// block of lines repeated (a pasted second half without its header line). Test files skip the repeated-block rule (similar tests).
export function spliceProblem(rel, prev, next, isTest = false) {
  try {
    const lang = langOfPath(rel); const p = String(prev || ""), n = String(next || "");
    if (!lang || !p.trim() || !n.trim()) return "";
    const pc = topDefCounts(p, lang), nc = topDefCounts(n, lang);
    const twice = [...nc].filter(([k, c]) => c >= 2 && c > (pc.get(k) || 0)).map(([k]) => k);
    if (twice.length) return `the new text defines ${twice.slice(0, 4).join(", ")} twice at the top level (a duplicated half-file splice)`;
    if (!isTest && p.length >= 200 && n.length >= 1.6 * p.length) {
      // lines that are only a quoted text (song verses, messages, data tables) are not code: a pasted half-file has code lines
      const norm = (t) => t.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4 && !/^[{}()\[\];,]+$/.test(l) && !/^["'`]/.test(l));
      const win = (arr) => { const m = new Map(); for (let i = 0; i + 6 <= arr.length; i++) { const k = arr.slice(i, i + 6).join("\n"); if (!m.has(k)) m.set(k, []); m.get(k).push(i); } return m; };
      const nw = win(norm(n)), pw = win(norm(p));
      for (const [k, pos] of nw) {
        const apart = pos.length >= 2 && pos[pos.length - 1] - pos[0] >= 6;
        if (apart && pos.length > (pw.get(k)?.length || 0)) return `the file grew from ${p.length} to ${n.length} characters and repeats a block of at least 6 lines (a duplicated half-file splice)`;
      }
    }
    return "";
  } catch { return ""; }
}
// Python brackets and strings ('#' comments, '' "" and triple quotes). ok = false when a string is still open at the end.
function pyBrackets(src) {
  const s = String(src || ""); let depth = 0, i = 0; const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "#") { while (i < n && s[i] !== "\n") i++; continue; }
    if (c === '"' || c === "'") {
      if (s[i + 1] === c && s[i + 2] === c) { const j = s.indexOf(c + c + c, i + 3); if (j < 0) return { ok: false, depth }; i = j + 3; continue; }
      let j = i + 1; for (; j < n; j++) { if (s[j] === "\\") { j++; continue; } if (s[j] === c) break; if (s[j] === "\n") return { ok: false, depth }; }
      if (j >= n) return { ok: false, depth }; i = j + 1; continue;
    }
    if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth--;
    i++;
  }
  return { ok: true, depth };
}
function bracketState(src, lang) {
  if (lang === "python") return pyBrackets(src);
  if (!BRACE_LANGS.has(lang)) return null;
  const s = String(src || ""); const { mask, ok } = codeMask(s, lang);
  if (!ok) return { ok: false, depth: 0 };
  let depth = 0; for (let i = 0; i < s.length; i++) { if (!mask[i]) continue; const c = s[i]; if (c === "{" || c === "(" || c === "[") depth++; else if (c === "}" || c === ")" || c === "]") depth--; }
  return { ok: true, depth };
}
// (iii) the old text was balanced, the new text ends with an open string or open brackets: the model's reply was cut off.
export function cutOffProblem(rel, prev, next) {
  try {
    const lang = langOfPath(rel); if (!lang || !String(prev || "").trim() || !String(next || "").trim()) return "";
    const a = bracketState(prev, lang); if (!a || !a.ok || a.depth !== 0) return "";
    const b = bracketState(next, lang); if (!b) return "";
    if (!b.ok) return "the new text ends inside an open string or comment (the reply was cut off before the end)";
    if (b.depth > 0) return `the new text ends with ${b.depth} bracket(s) still open (the reply was cut off before the end)`;
    return "";
  } catch { return ""; }
}
