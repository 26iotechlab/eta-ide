// langs.mjs: ONE place for per-language facts the engine needs (STRONG2, 2026-11-16). Plain code, no model, no GPU.
// Every helper is FAIL-OPEN: a crash or a text it cannot read means "no finding" (never "something is wrong").
//   langOfPath / isCodeFile / CODE_EXT_RE  which language a file is in
//   isTestPathAny                          test file names of every language (one table; never a normal source file)
//   codeMask / braceTopBlocks              which characters are code (not strings or comments), and the top-level { } blocks
//   braceStubs / langStubMarker            functions that are still stubs (todo!(), panic("TODO"), NotImplementedException, ...)
//   pickTool / runSyntaxCheck              a syntax checker per language, only when its tool is on the PATH (missing = skip)
//   codeFrames / compiledFailNames         file:line frames and failing test names from Go, Rust, Java, JS, C#, PHP, Swift output
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";

// ---------------------------------------------------------------- languages
const EXT_LANG = {
  py: "python", pyw: "python", pyi: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", vue: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", cs: "csharp", rb: "ruby", php: "php", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
};
export const CODE_EXT_RE = /\.(py|pyw|pyi|js|mjs|cjs|jsx|vue|ts|tsx|mts|cts|go|rs|java|kt|kts|cs|rb|php|swift|c|h|cc|cpp|cxx|hpp|hh|hxx)$/i;
export function langOfPath(rel) {
  try { const m = /\.([A-Za-z0-9]+)$/.exec(String(rel || "")); return m ? EXT_LANG[m[1].toLowerCase()] || "" : ""; } catch { return ""; }
}
export function isCodeFile(rel) { try { return CODE_EXT_RE.test(String(rel || "")); } catch { return false; } }
// languages whose code blocks are { ... } (Ruby uses def/end, Python uses indentation)
export const BRACE_LANGS = new Set(["javascript", "typescript", "go", "rust", "java", "kotlin", "csharp", "php", "swift", "c", "cpp"]);
export function isBraceLang(rel) { return BRACE_LANGS.has(langOfPath(rel)); }
// code languages the definition guard has NO rules for: there it is switched off (a wrong name would revert good work)
export const UNSUPPORTED_CODE_RE = /\.(lua|scala|sc|dart|ex|exs|erl|hrl|hs|ml|mli|fs|fsx|clj|cljs|r|jl|pl|pm|sh|bash|zsh|ps1|psm1|sql|groovy|gradle|m|mm|vb|pas|f90|zig|nim|cr|sol|elm|purs|coffee)$/i;

// ---------------------------------------------------------------- test files (A1)
// One table for every language. Directory rules are case-insensitive (tests/, Tests/, __tests__/, spec/); name rules are exact.
// Never a normal source file: "Contest.java", "latest.py", "testing.go", "spec_helper_lib.js" in src/ stay source files.
const TEST_DIR = /^(?:tests?|__tests__|spec)$/i;
const TEST_DIR_CS = /\.(?:Tests?|UnitTests|IntegrationTests)$/; // C# test projects: Foo.Tests/
const TEST_BASE = [
  /^test_/i,                                          // Python test_x.py (and C test_x.c)
  /_test\./,                                          // Go x_test.go, Python x_test.py, C++ x_test.cc
  /\.test\./, /\.spec\./,                             // JavaScript and TypeScript
  /_spec\.rb$/,                                       // Ruby (RSpec)
  /_tests\.(?:c|cc|cpp|cxx)$/, /_unittest\.(?:c|cc|cpp|cxx)$/, // C and C++
  /(?:Test|Tests)\.(?:java|kt|kts|cs|php|swift|scala|groovy)$/, // Java, Kotlin, C#, PHP, Swift (exact case: Contest.java is source)
  /Spec\.(?:kt|kts|swift|scala|groovy)$/,             // Kotest, Quick, Spock (Spec suffix is their test convention)
  /^test_.*\.rb$/,                                    // Ruby minitest
];
export function isTestPathAny(rel) {
  try {
    const parts = String(rel || "").replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
    if (!parts.length) return false;
    const base = parts[parts.length - 1];
    for (const d of parts.slice(0, -1)) if (TEST_DIR.test(d) || TEST_DIR_CS.test(d) || /^test_/.test(d)) return true; // test_data/ (kept from the old rule)
    return TEST_BASE.some((re) => re.test(base));
  } catch { return false; }
}

// ---------------------------------------------------------------- code mask (strings and comments are not code)
// Returns { mask: Uint8Array (1 = code character), ok }. ok = false when the scanner is not sure (an unclosed string or
// comment): callers must then do nothing. Handles // and /* */ comments, "..." '...' `...` strings, char literals,
// Rust lifetimes and raw strings, C# verbatim strings, C++ raw strings, """ text blocks, JS regex literals, # comments (PHP).
export function codeMask(src, lang) {
  const s = String(src || ""), n = s.length, mask = new Uint8Array(n);
  try {
    const js = lang === "javascript" || lang === "typescript";
    const cfam = lang === "c" || lang === "cpp";
    const charLit = cfam || lang === "java" || lang === "csharp" || lang === "kotlin" || lang === "go";
    const sqString = js || lang === "php" || lang === "python" || lang === "ruby";
    const multiLineDq = lang === "rust" || lang === "php" || lang === "ruby";
    const triple = lang === "kotlin" || lang === "swift" || lang === "java" || lang === "csharp" || lang === "python";
    const isId = (ch) => /[A-Za-z0-9_$]/.test(ch || "");
    let i = 0, lastSig = "", lastWord = "";
    const lineStart = (k) => { let j = k - 1; while (j >= 0 && (s[j] === " " || s[j] === "\t")) j--; return j < 0 || s[j] === "\n"; };
    const fail = () => ({ mask, ok: false });
    while (i < n) {
      const c = s[i], c2 = s[i + 1];
      if (c === "/" && c2 === "/") { while (i < n && s[i] !== "\n") i++; continue; }
      if (c === "/" && c2 === "*") { const j = s.indexOf("*/", i + 2); if (j < 0) return fail(); i = j + 2; continue; }
      if (lang === "php" && c === "#" && c2 !== "[") { while (i < n && s[i] !== "\n") i++; continue; }
      if (cfam && c === "#" && lineStart(i)) { while (i < n && s[i] !== "\n") { if (s[i] === "\\" && s[i + 1] === "\n") i++; i++; } continue; }
      // raw and special strings
      if (triple && c === '"' && c2 === '"' && s[i + 2] === '"') { const j = s.indexOf('"""', i + 3); if (j < 0) return fail(); i = j + 3; lastSig = '"'; continue; }
      if (lang === "csharp" && (c === "@" || c === "$") && (c2 === '"' || ((c2 === "@" || c2 === "$") && s[i + 2] === '"'))) {
        let j = i + (c2 === '"' ? 2 : 3);
        const verbatim = c === "@" || c2 === "@";
        for (; j < n; j++) {
          if (verbatim) { if (s[j] === '"') { if (s[j + 1] === '"') { j++; continue; } break; } }
          else { if (s[j] === "\\") { j++; continue; } if (s[j] === '"') break; if (s[j] === "\n") return fail(); }
        }
        if (j >= n) return fail(); i = j + 1; lastSig = '"'; continue;
      }
      if (cfam && c === "R" && c2 === '"' && !isId(s[i - 1])) {
        const open = s.indexOf("(", i + 2); if (open < 0) return fail();
        const delim = s.slice(i + 2, open); const end = s.indexOf(")" + delim + '"', open); if (end < 0) return fail();
        i = end + delim.length + 2; lastSig = '"'; continue;
      }
      if (lang === "rust" && (c === "r" || (c === "b" && c2 === "r")) && !isId(s[i - 1])) {
        let j = i + (c === "b" ? 2 : 1), hashes = 0;
        while (s[j] === "#") { hashes++; j++; }
        if (s[j] === '"' && (hashes > 0 || j === i + (c === "b" ? 2 : 1))) {
          const close = '"' + "#".repeat(hashes); const end = s.indexOf(close, j + 1); if (end < 0) return fail();
          i = end + close.length; lastSig = '"'; continue;
        }
      }
      if (c === '"' || (c === "'" && sqString) || (c === "`" && (js || lang === "go" || lang === "kotlin"))) {
        const q = c; let j = i + 1;
        const raw = c === "`" && lang === "go";
        for (; j < n; j++) {
          if (!raw && s[j] === "\\") { j++; continue; }
          if (s[j] === q) break;
          if (s[j] === "\n" && q !== "`" && !multiLineDq) return fail();
          if (s[j] === "\n" && q === "`" && lang === "kotlin") return fail();
        }
        if (j >= n) return fail();
        i = j + 1; lastSig = '"'; continue;
      }
      if (c === "'" && lang === "rust") {
        if (c2 === "\\") { const end = s.indexOf("'", i + 2); if (end < 0 || end - i > 12) return fail(); i = end + 1; lastSig = '"'; continue; }
        if (s[i + 2] === "'") { i += 3; lastSig = '"'; continue; }
        if (s[i + 3] === "'" && c2 && c2.charCodeAt(0) >= 0xd800 && c2.charCodeAt(0) <= 0xdbff) { i += 4; lastSig = '"'; continue; }
        mask[i] = 1; i++; continue; // a lifetime: 'a
      }
      if (c === "'" && charLit) {
        let j = i + 1; if (s[j] === "\\") j += 2; else j += 1;
        while (j < n && j - i < 12 && s[j] !== "'" && s[j] !== "\n") j++;
        if (s[j] !== "'") return fail();
        i = j + 1; lastSig = '"'; continue;
      }
      if (c === "'" && lang === "swift") { mask[i] = 1; i++; continue; }
      if (js && c === "/") {
        const allowed = lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/.test(lastWord);
        if (allowed) {
          let j = i + 1, cls = false;
          for (; j < n; j++) {
            if (s[j] === "\\") { j++; continue; }
            if (s[j] === "\n") return fail();
            if (cls) { if (s[j] === "]") cls = false; continue; }
            if (s[j] === "[") { cls = true; continue; }
            if (s[j] === "/") break;
          }
          if (j >= n) return fail();
          j++; while (j < n && /[a-z]/i.test(s[j])) j++;
          i = j; lastSig = "/"; lastWord = ""; continue;
        }
      }
      mask[i] = 1;
      if (!/\s/.test(c)) {
        if (isId(c)) { let j = i; while (j < n && isId(s[j])) { mask[j] = 1; j++; } lastWord = s.slice(i, j); lastSig = s[j - 1]; i = j; continue; }
        lastSig = c; lastWord = "";
      }
      i++;
    }
    return { mask, ok: true };
  } catch { return { mask, ok: false }; }
}

// Top-level { } blocks of a brace-language file. namer(text) -> Set of definition names on a header line (the engine
// passes its own topLevelDefs so the names match the definition guard exactly). Returns [{name, names, start, end, text}]
// with character offsets, or null when the file cannot be read safely (unbalanced braces, unclosed string): then the
// callers must not touch the file.
export function braceTopBlocks(src, rel, namer) {
  try {
    const lang = langOfPath(rel);
    if (!BRACE_LANGS.has(lang) || typeof namer !== "function") return null;
    const s = String(src || "");
    const { mask, ok } = codeMask(s, lang);
    if (!ok) return null;
    // brace depth at every character (code characters only count)
    const depthAt = new Int32Array(s.length + 1);
    let d = 0;
    for (let k = 0; k < s.length; k++) {
      depthAt[k] = d;
      if (!mask[k]) continue;
      if (s[k] === "{") d++;
      else if (s[k] === "}") { d--; if (d < 0) return null; }
    }
    depthAt[s.length] = d;
    if (d !== 0) return null;
    const lineStarts = [0]; for (let k = 0; k < s.length; k++) if (s[k] === "\n") lineStarts.push(k + 1);
    const lineText = (li) => s.slice(lineStarts[li], li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : s.length);
    const blocks = [];
    for (let li = 0; li < lineStarts.length; li++) {
      const ls = lineStarts[li];
      if (depthAt[ls] !== 0) continue;
      const t = lineText(li);
      const first = t.search(/\S/); if (first < 0 || !mask[ls + first]) continue;
      let names; try { names = namer(t.replace(/^\s+/, "")); } catch { names = null; }
      if (!names || !names.size) continue;
      // find the opening brace of this header: stop at ';' or '=' (a declaration / expression body) and at a new header line
      let k = ls, paren = 0, open = -1;
      for (; k < s.length && k - ls < 4000; k++) {
        if (!mask[k]) continue;
        const ch = s[k];
        if (ch === "(" || ch === "[") paren++;
        else if (ch === ")" || ch === "]") paren--;
        else if (paren <= 0 && ch === "{") { open = k; break; }
        else if (paren <= 0 && ch === ";") break;
        else if (paren <= 0 && ch === "=" && s[k + 1] !== ">" && s[k + 1] !== "=" && s[k - 1] !== "=" && s[k - 1] !== "!" && s[k - 1] !== "<" && s[k - 1] !== ">") break;
        else if (ch === "\n" && paren <= 0) {
          // the header ended without a brace on this line: Allman style "{" on the next line, or an indented continuation, is fine
          let m = k + 1; while (m < s.length && /[ \t\r\n]/.test(s[m])) { if (s[m] === "\n") { /* blank line */ } m++; }
          const lineBeg = s.lastIndexOf("\n", m - 1) + 1;
          if (s[m] === "{") continue;
          if (m > lineBeg && !/^\s*$/.test(s.slice(lineBeg, m))) continue; // indented continuation line
          if (m === lineBeg && s[m] !== "{") break;
        }
      }
      if (open < 0) continue;
      let dd = 0, close = -1;
      for (let m = open; m < s.length; m++) {
        if (!mask[m]) continue;
        if (s[m] === "{") dd++;
        else if (s[m] === "}") { dd--; if (dd === 0) { close = m; break; } }
      }
      if (close < 0) return null;
      // attributes and annotations right above the header belong to the block (@Test, #[test], [Fact])
      let startLi = li;
      while (startLi > 0) { const prev = lineText(startLi - 1).trim(); if (/^(?:@\w|#\[|\[[A-Z]\w*(?:\(.*\))?\]$)/.test(prev) && depthAt[lineStarts[startLi - 1]] === 0) startLi--; else break; }
      let end = close + 1;
      const eol = s.indexOf("\n", end); const rest = s.slice(end, eol < 0 ? s.length : eol);
      if (/^[\s;]*$/.test(rest)) end = eol < 0 ? s.length : eol;
      const start = lineStarts[startLi];
      blocks.push({ name: [...names][0], names: [...names], start, end, text: s.slice(start, end) });
      while (li + 1 < lineStarts.length && lineStarts[li + 1] <= end) li++;
    }
    return blocks;
  } catch { return null; }
}

// ---------------------------------------------------------------- stubs (A5)
// A function body that is ONLY one of these (after comments are removed) is a stub: the task wants real code there.
const STUB_BODY = [
  { re: /^(?:todo|unimplemented)!\s*\([^;]*\)\s*;?$/, why: "is still todo!() / unimplemented!()" },                       // Rust
  { re: /^panic\s*\(\s*["'`][^"'`]*(?:todo|not (?:yet )?implemented|implement)[^"'`]*["'`]\s*\)\s*;?$/i, why: "only panics with a TODO / not-implemented message" }, // Go
  { re: /^throw\s+new\s+(?:System\.)?NotImplementedException\s*\([^;]*\)\s*;?$/, why: "only throws NotImplementedException" }, // C#
  { re: /^throw\s+new\s+(?:java\.lang\.)?UnsupportedOperationException\s*\(\s*"[^"]*(?:implement|todo|delete this statement)[^"]*"\s*\)\s*;?$/i, why: "only throws UnsupportedOperationException(\"...implement...\")" }, // Java
  { re: /^throw\s+(?:new\s+)?\\?(?:[\w\\]*Error|[\w\\]*Exception)\s*\(\s*(["'`])[^"'`]*(?:remove this (?:statement|line)|not (?:yet )?implemented|implement (?:this|me|the)|todo)[^"'`]*\1\s*\)\s*;?$/i, why: "only throws a 'not implemented' error" }, // JS, TS, PHP, Java, Kotlin
  { re: /^(?:kotlin\.)?TODO\s*\([^;]*\)\s*;?$/, why: "is still TODO()" },                                                 // Kotlin
  { re: /^fatalError\s*\(\s*"[^"]*(?:implement|todo)[^"]*"\s*\)\s*;?$/i, why: "only calls fatalError(\"...implement...\")" }, // Swift
];
export function langStubMarker(rel, content) {
  // whole-file marker check, for the rerank of a freshly written file (cheap, no function boundaries)
  try {
    const lang = langOfPath(rel), s = String(content || "");
    if (lang === "rust" && /\b(?:todo|unimplemented)!\s*\(/.test(s)) return "todo!() / unimplemented!()";
    if (lang === "go" && /\bpanic\s*\(\s*["'`][^"'`\n]*(?:please implement|not (?:yet )?implemented|\btodo\b)/i.test(s)) return 'panic("not implemented")';
    if (lang === "csharp" && /\bthrow\s+new\s+(?:System\.)?NotImplementedException\b/.test(s)) return "NotImplementedException";
    if ((lang === "java" || lang === "kotlin") && /UnsupportedOperationException\s*\(\s*"[^"\n]*(?:implement|delete this statement)/i.test(s)) return "UnsupportedOperationException";
    if (lang === "kotlin" && /(?:^|[=\s{])TODO\s*\(/.test(s)) return "TODO()";
    if (lang === "swift" && /\bfatalError\s*\(\s*"[^"\n]*(?:implement|todo)/i.test(s)) return "fatalError()";
    if ((lang === "javascript" || lang === "typescript" || lang === "php") && /\bthrow\s+new\s+\\?[\w\\]*(?:Error|Exception)\s*\(\s*["'`][^"'`\n]*(?:remove this (?:statement|line)|please implement|not (?:yet )?implemented|implement (?:this|me) )/i.test(s)) return "throw 'not implemented'";
    return "";
  } catch { return ""; }
}
// Function headers (any depth) per language: group 1 = the name.
const FN_HEADER = {
  javascript: [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/, /^\s*(?:static\s+|async\s+|get\s+|set\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[\[(]/],
  rust: [/^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*fn\s+([A-Za-z_]\w*)/],
  java: [/^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>\n]+>\s+)?[\w.$<>\[\],? ]+?\s+(?!if\b|for\b|while\b|switch\b|catch\b|return\b|new\b|else\b)([A-Za-z_$][\w$]*)\s*\([^;]*$/],
  kotlin: [/^\s*(?:(?:public|private|protected|internal|abstract|open|final|override|suspend|inline|operator|infix|tailrec|external|actual|expect)\s+)*fun\s+(?:<[^>\n]*>\s*)?(?:[\w<>?,. ]+\.)?([A-Za-z_]\w*)\s*\(/],
  csharp: [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly)\s+)*[\w.<>\[\],?() ]+?\s+(?!if\b|for\b|foreach\b|while\b|switch\b|catch\b|return\b|new\b|using\b|lock\b)([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\s*\([^;]*$/],
  php: [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/],
  swift: [/^\s*(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|@\w+)\s+)*func\s+([A-Za-z_]\w*)/],
  c: [/^(?!\s*(?:return|if|else|while|for|switch|do|case|goto|sizeof|typedef)\b)\s*(?:[A-Za-z_][\w:<>,*& \t]*?[\s*&]+)([A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/],
};
FN_HEADER.typescript = FN_HEADER.javascript; FN_HEADER.cpp = FN_HEADER.c;
// Functions whose body is still a stub. Returns [{ name, cls: null, why, start, end, bodyStart, bodyEnd }] (offsets into content).
// Python and unknown languages: [] (Python has its own detector in the engine).
export function braceStubs(rel, content) {
  try {
    const lang = langOfPath(rel);
    const s = String(content || "");
    if (lang === "ruby") return rubyStubs(s);
    if (!BRACE_LANGS.has(lang) || !FN_HEADER[lang]) return [];
    const { mask, ok } = codeMask(s, lang);
    if (!ok) return [];
    const out = [];
    const lines = s.split("\n");
    let off = 0;
    for (const line of lines) {
      const ls = off; off += line.length + 1;
      const first = line.search(/\S/); if (first < 0 || !mask[ls + first]) continue;
      let name = "", from = ls;
      for (const re of FN_HEADER[lang]) { const m = re.exec(line); if (m) { name = m[1]; from = /\{\s*$/.test(m[0]) ? ls + m.index + m[0].lastIndexOf("{") : ls + line.indexOf(name, m.index) + name.length; break; } }
      if (!name) continue;
      // the body: first code "{" after the header (on this line or the next one), to its matching "}"
      let k = from, paren = 0, open = -1;
      for (; k < s.length && k - ls < 1500; k++) {
        if (!mask[k]) continue;
        const ch = s[k];
        if (ch === "(") paren++; else if (ch === ")") paren--;
        else if (paren <= 0 && ch === "{") { open = k; break; }
        else if (paren <= 0 && (ch === ";" || (ch === "=" && s[k + 1] !== ">"))) break;
      }
      if (open < 0) continue;
      let dd = 0, close = -1;
      for (let m = open; m < s.length; m++) { if (!mask[m]) continue; if (s[m] === "{") dd++; else if (s[m] === "}") { dd--; if (dd === 0) { close = m; break; } } }
      if (close < 0) continue;
      // body text without comments (strings stay: the stub message lives in one)
      const body = stripCommentsLite(s.slice(open + 1, close), lang === "php").replace(/\s+/g, " ").trim();
      if (!body) continue;
      const hit = STUB_BODY.find((b) => b.re.test(body));
      if (hit) out.push({ name, cls: null, why: hit.why, start: ls, end: close + 1, bodyStart: open + 1, bodyEnd: close });
    }
    return out;
  } catch { return []; }
}
function stripCommentsLite(t, hash = false) {
  // remove // and /* */ comments that are not inside a string (good enough for a short body)
  let out = "", i = 0, q = "";
  while (i < t.length) {
    const c = t[i];
    if (q) { out += c; if (c === "\\") { out += t[i + 1] || ""; i += 2; continue; } if (c === q) q = ""; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    if (c === "/" && t[i + 1] === "/") { while (i < t.length && t[i] !== "\n") i++; continue; }
    if (c === "/" && t[i + 1] === "*") { const j = t.indexOf("*/", i + 2); i = j < 0 ? t.length : j + 2; continue; }
    if (hash && c === "#" && t[i + 1] !== "[") { while (i < t.length && t[i] !== "\n") i++; continue; }
    out += c; i++;
  }
  return out;
}
// Ruby: a def whose only statement is `raise NotImplementedError` or `raise "...implement..."` (empty methods are legal Ruby)
function rubyStubs(s) {
  const out = [];
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)def\s+(?:self\.)?([\w]+[?!=]?)/.exec(lines[i]); if (!m) continue;
    const ind = m[1].length, body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j]; if (!t.trim()) continue;
      const ti = t.search(/\S/);
      if (ti <= ind && /^\s*end\b/.test(t)) break;
      if (ti <= ind) { j = -1; break; }
      if (!/^\s*#/.test(t)) body.push(t.trim());
    }
    if (j < 0 || body.length !== 1) continue;
    if (/^raise\s+(?:NotImplementedError\b|["'][^"']*(?:implement|todo)[^"']*["'])/i.test(body[0])) out.push({ name: m[2], cls: null, why: "only raises NotImplementedError", start: 0, end: 0 });
  }
  return out;
}

// ---------------------------------------------------------------- syntax checkers (A4)
// Find a tool on the PATH without running anything (so a fake PATH can be tested). "" = not installed.
export function pickTool(names, pathEnv = process.env.PATH || process.env.Path || "", platform = process.platform) {
  try {
    const dirs = String(pathEnv || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
    const exts = platform === "win32" ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()) : [""];
    for (const name of [].concat(names)) {
      for (const d of dirs) {
        for (const e of platform === "win32" ? exts : [""]) {
          const p = path.join(d.replace(/^"|"$/g, ""), name + e);
          try { if (fs.statSync(p).isFile()) return p; } catch {}
        }
      }
    }
  } catch {}
  return "";
}
// Each checker: tools (first found wins), args(file), and a filter that says whether the output is a real SYNTAX error.
// Tools that also judge types/imports (javac, tsc, gcc) only count their syntax messages: a missing import is not a syntax error.
const TS_SYNTAX_CODES = /\berror TS(?:1002|1003|1005|1009|1010|1011|1109|1110|1126|1127|1128|1131|1135|1136|1138|1160|1161|1434)\b/;
export const SYNTAX_CHECKERS = {
  // a verdict needs the tool's own "file:line:col:" message: a broken install ("is not recognized") is never a syntax error
  go: { tools: ["gofmt"], args: (f) => ["-e", "-l", f], syntax: (out, code) => code !== 0 && /:\d+:\d+: /.test(out) },
  rust: { tools: ["rustfmt"], args: (f) => ["--edition", "2021", "--check", f], syntax: (out) => /^error(?:\[E\d+\])?: (?:expected|unexpected|mismatched closing delimiter|this file contains an unclosed delimiter|unterminated|unknown start of token|missing|unclosed)/m.test(out) },
  ruby: { tools: ["ruby"], args: (f) => ["-c", f], syntax: (out, code) => code !== 0 && /syntax error|unexpected/i.test(out) },
  php: { tools: ["php"], args: (f) => ["-l", f], syntax: (out, code) => code !== 0 && /Parse error|syntax error/i.test(out) },
  typescript: { tools: ["tsc"], args: (f) => ["--noEmit", "--pretty", "false", "--skipLibCheck", "--target", "esnext", "--module", "esnext", "--jsx", "preserve", f], syntax: (out) => TS_SYNTAX_CODES.test(out) },
  swift: { tools: ["swiftc"], args: (f) => ["-parse", f], syntax: (out, code) => code !== 0 && /:\d+:\d+: error:/.test(out) },
  java: { tools: ["javac"], args: (f, tmp) => ["-d", tmp, "-proc:none", "-Xlint:none", f], syntax: (out) => /error: (?:';' expected|'\)' expected|'\(' expected|'\{' expected|'\}' expected|\<identifier\> expected|class, interface, enum,? or record expected|illegal start of (?:expression|type)|reached end of file while parsing|unclosed (?:string|character|comment) literal|not a statement|'else' without 'if'|orphaned)/.test(out) },
  c: { tools: ["gcc", "clang"], args: (f) => ["-fsyntax-only", "-x", "c", f], syntax: (out) => !/fatal error:/.test(out) && /error: (?:expected|stray|unterminated|missing terminating)/.test(out) },
  cpp: { tools: ["g++", "clang++"], args: (f) => ["-fsyntax-only", "-x", "c++", f], syntax: (out) => !/fatal error:/.test(out) && /error: (?:expected|stray|unterminated|missing terminating)/.test(out) },
  // kotlin (kotlinc) and C# (dotnet) are left out on purpose: each start takes many seconds, too slow for every write.
};
const _syntaxCache = new Map();
// Runs the checker for this file. Resolves to null when there is no checker or its tool is missing (fail-open), else { ok, msg }.
export function runSyntaxCheck(full, rel, opts = {}) {
  return new Promise((resolve) => {
    try {
      const lang = langOfPath(rel);
      const chk = SYNTAX_CHECKERS[lang];
      if (!chk) return resolve(null);
      if (/\.h$/i.test(String(rel))) return resolve(null); // a .h file may be C or C++: no guess
      const tool = pickTool(chk.tools, opts.pathEnv ?? (process.env.PATH || process.env.Path || ""));
      if (!tool) return resolve(null);
      let src = ""; try { src = fs.readFileSync(full, "utf8"); } catch { return resolve(null); }
      const key = lang + "|" + tool + "|" + src.length + "|" + simpleHash(src);
      if (_syntaxCache.has(key)) return resolve(_syntaxCache.get(key));
      let tmp = ""; if (lang === "java") { try { tmp = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "eta-javac-")); } catch { return resolve(null); } }
      const q = (a) => `"${String(a).replace(/"/g, '\\"')}"`;
      const cmd = [q(tool), ...chk.args(full, tmp).map(q)].join(" ");
      const name = path.basename(tool).replace(/\.(exe|cmd|bat|com)$/i, "");
      exec(cmd, { timeout: opts.timeout || 20000, windowsHide: true, maxBuffer: 1 << 20, cwd: opts.cwd || path.dirname(full) }, (err, so, se) => {
        try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        if (err && (err.killed || err.signal)) return resolve(null); // timed out: no verdict
        const out = String(se || "") + String(so || "");
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        let r;
        try { r = chk.syntax(out, code) ? { ok: false, msg: `${name} syntax check FAILED: ${out.trim().slice(-500)}` } : { ok: true, msg: `${name} syntax OK` }; } catch { r = null; }
        if (r) { if (_syntaxCache.size > 200) _syntaxCache.clear(); _syntaxCache.set(key, r); }
        resolve(r);
      });
    } catch { resolve(null); }
  });
}
function simpleHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }

// ---------------------------------------------------------------- failure frames and names (A6)
const FRAME_EXT = "go|rs|m?js|cjs|jsx|tsx?|mts|cts|kts?|java|cs|php|swift|rb|c|cc|cpp|cxx|h|hpp";
const STD_FRAME = /node_modules|node:internal|^internal[\\/]|[\\/]usr[\\/](?:lib|local|include)|[\\/]go[\\/]src[\\/]|[\\/]rustc[\\/]|\.cargo[\\/]registry|\.rustup[\\/]|java\.base|jdk[\\/]|[\\/]vendor[\\/]phpunit|[\\/]\.m2[\\/]|[\\/]gems[\\/]|<anonymous>|^native$/i;
// file:line frames from non-Python output, in the order they appear (innermost first for JS, Go, Java stacks).
// Returns [{ file, line }]. Java frames give only the file name (no folder): callers match it by base name.
export function codeFrames(out) {
  const res = [];
  try {
    const s = String(out || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    const seen = new Set();
    const add = (file, line) => { file = String(file).replace(/^file:\/\/\/?/, ""); const k = file + ":" + line; if (!file || STD_FRAME.test(file) || seen.has(k)) return; seen.add(k); res.push({ file, line: +line }); };
    const re = new RegExp(String.raw`(?:^|[\s("'\[])((?:[A-Za-z]:)?[\w.\/\\@~-]*\.(?:` + FRAME_EXT + String.raw`)):(\d+)(?::\d+)?`, "gm");
    for (const m of s.matchAll(re)) add(m[1], m[2]);
    for (const m of s.matchAll(/\bat [\w.$<>]+\(([\w$-]+\.(?:java|kt|scala|groovy)):(\d+)\)/g)) add(m[1], m[2]);      // Java / Kotlin stack
    for (const m of s.matchAll(/\bin ((?:[A-Za-z]:)?[^\s:]+\.cs):line (\d+)/g)) add(m[1], m[2]);                         // C# stack
    for (const m of s.matchAll(/\bin ((?:[A-Za-z]:)?[^\s]+\.php) on line (\d+)/g)) add(m[1], m[2]);                      // PHP error
  } catch {}
  return res;
}
// Names of failing tests in compiled-language and JavaScript runner output (stuck detection needs WHICH tests fail).
export function compiledFailNames(out) {
  const names = [];
  try {
    const s = String(out || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    for (const m of s.matchAll(/^\s*--- FAIL: (\S+)/gm)) names.push("go:" + m[1]);                                   // go test
    for (const m of s.matchAll(/^test (\S+) \.\.\. FAILED\b/gm)) names.push("rust:" + m[1]);                         // cargo test
    for (const m of s.matchAll(/^\[ERROR\]\s+([A-Za-z_$][\w$.]*\.[A-Za-z_$][\w$]*)(?::\d+)?\s/gm)) if (!/^(?:Tests|Failures|Errors|BUILD|COMPILATION)\b/.test(m[1])) names.push("junit:" + m[1]); // maven surefire
    for (const m of s.matchAll(/^([A-Za-z_$][\w$.]*) > ([^\n]+?) FAILED\s*$/gm)) names.push("junit:" + m[1] + "." + m[2].trim()); // gradle
    for (const m of s.matchAll(/^\s*Failed ([A-Za-z_][\w.]*) \[/gm)) names.push("dotnet:" + m[1]);                     // dotnet test
    for (const m of s.matchAll(/^\s*●\s+(?!Console\b|Test suite failed to run)(.+?)\s*$/gm)) names.push("jest:" + m[1]); // jest / vitest
    for (const m of s.matchAll(/^\s*(?:✖|×|not ok \d+ -)\s+(.+?)\s*(?:\(\d+(?:\.\d+)?m?s\))?\s*$/gm)) names.push("node:" + m[1]); // node:test
  } catch {}
  return [...new Set(names)];
}
