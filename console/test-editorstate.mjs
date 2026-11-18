// Test: editor state for the agent (D4, 2026-11-13). Plain data. NO model, NO server, NO network.
// Run: node test-editorstate.mjs
import { setEditorState, clearEditorState, editorBlock, editorSummary } from "./editorstate.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const T = 1_000_000, WS = "D:\\proj";
const base = { ws: WS, active: { path: "src/a.js", line: 12, col: 3 }, open: ["src/a.js", "src/b.js"],
  problems: [{ path: "src/a.js", line: 12, severity: "error", message: "x is not defined" }, { path: "src/b.js", line: 3, severity: "warning", message: "unused" }] };

clearEditorState(); ok(editorBlock(WS, T) === "" && editorSummary() === null, "nothing sent yet: no block");
setEditorState(base, T); let b = editorBlock(WS, T + 1000);
ok(/Active file: src\/a\.js, cursor at line 12/.test(b) && /Open files: src\/a\.js, src\/b\.js/.test(b), "active file, cursor line and open files are in the block", b);
ok(/Errors the editor reports \(1\):\n- src\/a\.js:12 x is not defined/.test(b), "errors are listed with file and line", b);
ok(!/unused/.test(b), "warnings are not given to the agent");
ok(/background only; the user's request above is what counts/.test(b), "the block says it is background, not the request");
ok(b.startsWith("\n\n"), "the block starts after a blank line so it can be appended");

ok(editorBlock("d:/proj/", T + 1000) !== "", "the folder is matched with other slashes, capital letters and a trailing slash");
ok(editorBlock("D:\\other", T + 1000) === "", "another folder: nothing");
ok(editorBlock("", T + 1000) === "", "no folder: nothing");
ok(editorBlock(WS, T + 10 * 60 * 1000 + 1) === "" && editorBlock(WS, T + 10 * 60 * 1000) !== "", "older than 10 minutes: nothing");

setEditorState({ ws: WS, active: null, open: [], problems: [] }, T); ok(editorBlock(WS, T) === "", "no active file and no errors: nothing");
setEditorState({ ws: WS, active: null, open: [], problems: [{ path: "x.py", line: 1, severity: "error", message: "bad" }] }, T); b = editorBlock(WS, T);
ok(/Errors the editor reports \(1\)/.test(b) && !/Active file/.test(b), "errors without an active file are still given");

const many = Array.from({ length: 30 }, (_, i) => ({ path: "f" + i + ".js", line: i + 1, severity: "error", message: "e" + i }));
setEditorState({ ws: WS, active: null, open: [], problems: many }, T); b = editorBlock(WS, T);
ok(/\(30\)/.test(b) && (b.match(/^- f\d+\.js/gm) || []).length === 10 && /… and 20 more/.test(b), "30 errors: 10 shown, the rest counted", b);

// bad input never crashes and is cut down
for (const bad of [null, undefined, 5, "x", [], { problems: "no" }, { problems: [null, 3, {}] }, { active: "a" }]) { let r; try { r = setEditorState(bad, T); } catch (e) { r = e; } ok(!(r instanceof Error), "bad input is accepted without a crash: " + JSON.stringify(bad)); }
setEditorState({ ws: WS, active: { path: "p".repeat(2000), line: -4, col: 1.5 }, open: Array.from({ length: 30 }, (_, i) => "o" + i), problems: [{ path: "a", line: 1e12, severity: "weird", message: "m\n\nline2\t" + "z".repeat(1000) }] }, T);
b = editorBlock(WS, T); ok(b.length < 1200, "very long paths and messages are cut (block under 1,200 characters)", b.length);
ok(!/\n\n\n/.test(b.slice(2)) && /Open files: o0, o1, o2, o3, o4, o5, o6, o7\n/.test(b + "\n"), "line breaks inside a message are flattened and only 8 open files are listed", b);
ok(/Active file: p+(?!, cursor)/.test(b) || /Active file: p+\n/.test(b), "a bad line number (-4) is dropped, not printed", b.slice(0, 80));
setEditorState({ ws: WS, active: { path: "a.js", line: 1, col: 1 }, open: [], problems: [{ path: "a.js", line: 2, severity: "warning", message: "w" }, { path: "a.js", line: 3, severity: "error", message: "e" }] }, T);
ok(/\(1\):\n- a\.js:3 e/.test(editorBlock(WS, T)), "errors are found even when a warning comes first");
ok(editorSummary().errors === 1 && editorSummary().active === "a.js", "summary counts errors and names the active file");
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
