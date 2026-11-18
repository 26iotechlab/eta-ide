// Test: the pure helpers of Tab completion and inline edit (D1, D2, 2026-11-13). NO VS Code, NO model, NO server.
// Builds extension/src/editLogic.ts with the extension's own esbuild into a temp file, then checks it.
// Run: node test-ext-logic.mjs
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import { createRequire } from "module"; import { pathToFileURL, fileURLToPath } from "url";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "..", "extension");
const esbuild = createRequire(path.join(extDir, "package.json"))("esbuild");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-extlogic-"));
const out = path.join(tmp, "editLogic.mjs");
await esbuild.build({ entryPoints: [path.join(extDir, "src", "editLogic.ts")], outfile: out, format: "esm", platform: "node", logLevel: "silent" });
const L = await import(pathToFileURL(out).href);

// ghostContext
{ const t = "a".repeat(5000) + "|" + "b".repeat(900);
  const g = L.ghostContext(t, 5000); ok(g.prefix.length === L.GHOST_BEFORE && g.suffix.length === L.GHOST_AFTER && g.suffix[0] === "|", "context is cut to 2000 before and 500 after the cursor", [g.prefix.length, g.suffix.length]);
  const s = L.ghostContext("hello", 2); ok(s.prefix === "he" && s.suffix === "llo", "a short text is split at the cursor");
  const e = L.ghostContext("abc", 99); ok(e.prefix === "abc" && e.suffix === "", "an offset past the end is cut back");
  const n = L.ghostContext("abc", -5); ok(n.prefix === "" && n.suffix === "abc", "a negative offset is cut to 0"); }

// worthAsking
ok(!L.worthAsking("", "x", "js"), "an empty file is not worth asking");
ok(!L.worthAsking("   \n  ", "", "js"), "only blanks before the cursor: not worth asking");
ok(L.worthAsking("function add(a, b) {\n  return ", "\n}", "js"), "normal code at the end of a line: ask");
ok(L.worthAsking("foo(", ")", "js"), "closing bracket right after the cursor (auto-closed): ask");
ok(L.worthAsking("foo(", ");", "js"), "bracket and semicolon after the cursor: ask");
ok(!L.worthAsking("const x = ", "computeSomething(1, 2);", "js"), "real code continues after the cursor on the same line: do not ask");
ok(!L.worthAsking("a", "", "markdown"), "a few letters in a plain text file: do not ask");
ok(L.worthAsking("# Title\n\nSome longer sentence about", "", "markdown"), "a longer line in markdown: ask");

// cleanGhost
ok(L.cleanGhost("", "x", "") === "" && L.cleanGhost(null, "x", "") === "" && L.cleanGhost(undefined, "x", "") === "", "empty or missing answers give nothing");
ok(L.cleanGhost("   \n ", "x", "") === "", "only blanks give nothing");
ok(L.cleanGhost("a + b;\r\n", "return ", "\n}") === "a + b;", "carriage returns and trailing blanks are removed");
ok(L.cleanGhost("total = a + b", "    total = ", "") === "a + b", "echo of the typed text is removed and no double space is left", L.cleanGhost("total = a + b", "    total = ", ""));
ok(L.cleanGhost("total = a + b", "    total", "") === " = a + b" || L.cleanGhost("total = a + b", "    total", "") === "= a + b", "the typed word repeated at the start of the answer is removed", L.cleanGhost("total = a + b", "    total", ""));
ok(L.cleanGhost("x = 1;\n}", "if (a) {\n  ", "\n}") === "x = 1;", "text that repeats what already follows the cursor is cut off", L.cleanGhost("x = 1;\n}", "if (a) {\n  ", "\n}"));
ok(L.cleanGhost("q".repeat(5000), "x", "").length === 1200, "an answer is capped at 1,200 characters");
ok(L.cleanGhost(42, "x", "") === "" && L.cleanGhost({}, "x", "") === "", "a non-text answer gives nothing");

// contextAround
{ const lines = Array.from({ length: 200 }, (_, i) => "line" + i); const text = lines.join("\n");
  const s = text.indexOf("line100"), e = text.indexOf("line102") + "line102".length;
  const c = L.contextAround(text, s, e, 5);
  ok(c.before.startsWith("…\n") && c.before.endsWith("line99\n") || c.before.split("\n").slice(-2)[0] === "line99", "before: the 5 lines above, marked with … because more exist", c.before);
  ok(c.after.endsWith("\n…") && c.after.includes("line103") && !c.after.includes("line102\nline103\nline104\nline105\nline106\nline107"), "after: the lines below, marked with …", c.after);
  const small = L.contextAround("a\nb\nc", 2, 3, 40); ok(small.before === "a\n" && small.after === "\nc" && !small.before.includes("…") && !small.after.includes("…"), "a short file has no … marks", small);
  const edge = L.contextAround(text, 0, 5, 3); ok(edge.before === "" && edge.after.startsWith(""), "selection at the very start: nothing before", edge.before); }

// applyReplacement / describeChange / stillSame
ok(L.applyReplacement("hello world", 6, 11, "there") === "hello there", "replaces exactly the selected span");
ok(L.applyReplacement("abc", 0, 0, "X") === "Xabc" && L.applyReplacement("abc", 3, 3, "X") === "abcX", "an empty span inserts");
ok(L.applyReplacement("abc", 0, 3, "") === "", "an empty replacement deletes (a real use: 'delete this code')");
ok(L.describeChange("a\nb\nc", "a\nB\nc") === "+1 −1 lines", "one changed line: +1 −1", L.describeChange("a\nb\nc", "a\nB\nc"));
ok(L.describeChange("a\nb", "a\nb\nc\nd") === "+2 −0 lines", "two added lines", L.describeChange("a\nb", "a\nb\nc\nd"));
ok(L.describeChange("a\nb\nc", "a") === "+0 −2 lines", "two removed lines", L.describeChange("a\nb\nc", "a"));
ok(L.describeChange("same", "same") === "no change", "same text: no change");
ok(L.stillSame("abc", "abc", 5, 3) === true, "the span is the same although the version moved: still safe");
ok(L.stillSame("abX", "abc", 5, 3) === false, "the span changed and the version moved: not safe");
ok(L.stillSame("abX", "abc", 3, 3) === true, "same version: nothing happened (the span check is only for moved versions)");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
