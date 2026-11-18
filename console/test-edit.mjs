// Edit-path test harness — NO model, NO GPU, NO network, NO server.
// Exercises the REAL agent.mjs edit path (applyOneEdit, parseSearchReplace, Agent.editFile,
// and the edit_file dispatch / jam-breaker inside Agent.execute) with a scripted fake model.
// Some checks describe TARGET behaviour that is not built yet; they are expected to fail until
// those changes land. Checks marked "(A2)" may stay failing for now.
// Run: node test-edit.mjs   (from D:\eta-ide\project\console)
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Agent, applyOneEdit, parseSearchReplace, stripFences, pickEditWindow, topLevelDefs, droppedDefs } from "./agent.mjs";

let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const short = (s, n = 160) => JSON.stringify(String(s ?? "")).slice(0, n);

// ---- fake model: records every messages array, returns scripted replies ----
// editReplies: replies for editFile's own SEARCH/REPLACE call (system prompt "You edit a file ...").
// actions:     replies for the executor's action call (JSON {tool, args}).
function fakeModel({ editReplies = [], actions = [] } = {}) {
  const m = {
    numCtx: 8192, model: "fake", calls: [], editCalls: [], actionCalls: [],
    async chat(messages, ...rest) {
      const copy = messages.map((x) => ({ ...x }));
      m.calls.push(copy);
      // Prompt Keeper (2026-11-15): with the keeper on, the edit call starts with the executor's system text and its own
      // job sits in the user message after a "ROLE CHANGE" line, so look in both places.
      const isEdit = /^You edit a file with SEARCH\/REPLACE/.test(String(messages[0]?.content || "")) || /^ROLE CHANGE[^\n]*\nYou edit a file with SEARCH\/REPLACE/.test(String(messages[messages.length - 1]?.content || ""));
      if (isEdit) { m.editCalls.push(copy); return { content: editReplies.length > 1 ? editReplies.shift() : (editReplies[0] ?? "") }; }
      m.actionCalls.push(copy);
      return { content: actions.length ? actions.shift() : JSON.stringify({ tool: "finish", args: { summary: "done" } }) };
    },
    async ask() { return ""; },
  };
  return m;
}

// ---- temp project folder ----
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "eta-edit-test-"));
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), text, "utf8"); };
const get = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Build a real Agent but with every outside-world hook replaced (no model, no LSP, no MCP).
function makeAgent(model, task = "TASKMARK-123") {
  const ag = new Agent(ROOT, { maxSteps: 6, numCtx: 8192, model: "fake" });
  ag.eta = model;
  ag.memory.eta = model;
  ag.memory.maybeCompact = async (msgs) => msgs;
  ag.task = task;
  ag.mcpNames = new Set();
  ag._lspNote = async () => "";
  ag.critic = async () => null;
  return ag;
}
const noEmit = () => {};

// T7 helper: replay recorded model replies against file contents (no model).
export function replayReplies(replies, fileContent) {
  const rows = []; let applied = 0, failed = 0;
  for (const reply of replies) {
    const blocks = parseSearchReplace(stripFences(reply));
    let content = fileContent, ok = 0; const errs = [];
    for (const b of blocks) { const r = applyOneEdit(content, b.old, b.neu); if (r.ok) { content = r.text; ok++; } else errs.push(r.reason); }
    if (ok) applied++; else failed++;
    rows.push({ blocks: blocks.length, applied: ok, errs, text: content });
  }
  return { applied, failed, rows };
}

try {
  // ------------------------------------------------------------------ T1
  section("T1 applyOneEdit exact match");
  {
    const src = "a = 1\nb = 2\nc = 3\n";
    const r = applyOneEdit(src, "b = 2", "b = 20");
    check("T1 exact unique match replaces", r.ok && r.text === "a = 1\nb = 20\nc = 3\n", short(r.text || r.reason));
    const r2 = applyOneEdit("x = 1\nx = 1\n", "x = 1", "x = 2");
    check("T1 exact match twice gives ok:false", r2.ok === false, short(r2.text));
    check("T1 reason says \"more than once\"", /more than once/i.test(r2.reason || ""), short(r2.reason));
  }

  // ------------------------------------------------------------------ T2
  section("T2 loose match re-indents the replacement");
  {
    const src = "class A:\n    def f(self):\n        x = 1\n        y = 2\n        return x + y\n";
    const search = "    x = 1\n    y = 2";             // 4-space; file has 8-space
    const replace = "    x = 10\n    y = 20\n    if x:\n        y += 1"; // 4-space base + one deeper line
    const r = applyOneEdit(src, search, replace);
    check("T2 loose unique match applies", r.ok === true, short(r.reason));
    const want = "class A:\n    def f(self):\n        x = 10\n        y = 20\n        if x:\n            y += 1\n        return x + y\n";
    check("T2 replacement lines get the file's 8-space indent", r.ok && r.text === want, short(r.text, 300));
  }

  // ------------------------------------------------------------------ T3
  section("T3 loose match in two places");
  {
    const src = "def f():\n        x = 1\n        y = 2\n\ndef g():\n            x = 1\n            y = 2\n";
    const r = applyOneEdit(src, "x = 1\ny = 2", "x = 9\ny = 9");
    check("T3 loose match twice gives ok:false", r.ok === false, short(r.text, 200));
    check("T3 reason says \"more than once\"", r.ok === false && /more than once/i.test(r.reason || ""), short(r.reason));
    check("T3 nothing changed (no text returned)", !(r.ok && r.text !== src));
  }

  // ------------------------------------------------------------------ T4
  section("T4 editFile prompt has the task and the hint");
  {
    put("t4.txt", "alpha\nbeta\ngamma\n");
    const model = fakeModel({ editReplies: ["<<<<<<< SEARCH\nbeta\n=======\nBETA\n>>>>>>> REPLACE"] });
    const ag = makeAgent(model, "TASKMARK-123 make beta loud");
    const r = await ag.editFile({ path: "t4.txt" }, [], noEmit, {}, "HINTMARK-456 change beta");
    const user = model.editCalls[0]?.find((m) => m.role === "user")?.content || "";
    check("T4 editFile called the model once", model.editCalls.length === 1, String(model.editCalls.length));
    check("T4 user message contains the task text", user.includes("TASKMARK-123"), short(user, 200));
    check("T4 user message contains the hint text", user.includes("HINTMARK-456"), short(user, 200));
    check("T4 the edit was applied to the file", get("t4.txt") === "alpha\nBETA\ngamma\n", short(r));
  }

  // ------------------------------------------------------------------ T5
  section("T5 big file: target region after char 12,000 reaches the prompt");
  {
    let big = "";
    let n = 0;
    while (big.length < 15000) big += `line ${String(n++).padStart(5, "0")} filler filler filler filler\n`;
    big += "TARGETMARK = 'change me'\n";
    while (big.length < 20000) big += `line ${String(n++).padStart(5, "0")} filler filler filler filler\n`;
    put("t5.txt", big);
    const at = big.indexOf("TARGETMARK");
    const model = fakeModel({ editReplies: ["<<<<<<< SEARCH\nTARGETMARK = 'change me'\n=======\nTARGETMARK = 'changed'\n>>>>>>> REPLACE"] });
    const ag = makeAgent(model);
    // The hint must NOT contain the target text itself, or the test would pass without the window working.
    await ag.editFile({ path: "t5.txt" }, [], noEmit, {}, "Change the value of the TARGETMARK constant to 'changed'.");
    const user = model.editCalls[0]?.find((m) => m.role === "user")?.content || "";
    check(`T5 setup: file is ~20,000 chars, target at char ${at}`, big.length >= 20000 && at > 12000);
    check("T5 (A2) prompt contains the target region", user.includes("TARGETMARK = 'change me'"), `prompt length ${user.length}`);
  }

  // ------------------------------------------------------------------ T6
  section("T6 edit_file jam-breaker (real execute() dispatch, writeFile spied)");
  async function jamRun(rel, size) {
    let s = ""; let i = 0;
    while (s.length < size) s += `row ${i++} value value value\n`;
    put(rel, s);
    // Three edit_file actions with slightly different args, so the repeat/cycle detectors do not end the pass.
    const actions = [
      JSON.stringify({ tool: "edit_file", args: { path: rel } }),
      JSON.stringify({ tool: "edit_file", args: { path: "./" + rel } }),
      JSON.stringify({ tool: "edit_file", args: { path: rel, why: "third try" } }),
    ];
    const bad = "<<<<<<< SEARCH\nTHIS TEXT IS NOT IN THE FILE\n=======\nnew\n>>>>>>> REPLACE";
    const model = fakeModel({ editReplies: [bad], actions });
    const ag = makeAgent(model);
    const writeCalls = [];
    ag.writeFile = async (args) => { writeCalls.push(args); return `Wrote ${args.path} (spy)`; };
    const events = [];
    await ag.execute([{ role: "system", content: "exec" }, { role: "user", content: "fix it" }], (e) => events.push(e), {}, { maxSteps: 3 });
    const results = events.filter((e) => e.type === "toolResult" && e.name === "edit_file").map((e) => String(e.result));
    return { writeCalls, results, editCalls: model.editCalls.length, fails: ag._editFails?.[rel], content: get(rel), orig: s };
  }
  {
    const big = await jamRun("big6.txt", 6000);
    check("T6 big: 3 edit_file actions reached dispatch", big.results.length === 3, `results=${big.results.length}`);
    check("T6 big: first 2 edits failed", big.results.slice(0, 2).every((r) => /^Edit failed/.test(r)), short(big.results.slice(0, 2)));
    check("T6 big (>5,000 chars): no full-rewrite writeFile after 2 failures", big.writeCalls.length === 0, `writeFile calls=${big.writeCalls.length}`);
    const third = big.results[2] || "";
    check("T6 big: 3rd result tells the model to read_file a section and make a smaller edit", /read_file/i.test(third) && /small/i.test(third), short(third, 220));
    check("T6 big: file unchanged", big.content === big.orig);

    const small = await jamRun("small6.txt", 1200);
    check("T6 small: 3 edit_file actions reached dispatch", small.results.length === 3, `results=${small.results.length}`);
    check("T6 small (<2,000 chars): full-rewrite writeFile still happens on the 3rd try", small.writeCalls.length === 1, `writeFile calls=${small.writeCalls.length}`);
  }

  // ------------------------------------------------------------------ T7
  section("T7 replay recorded model replies");
  {
    const file = "def total(items):\n    if items:\n        s = 0\n        for it in items:\n            s += it\n        return s\n    return 0\n";
    const recorded = [
      // 1) good: exact SEARCH
      "<<<<<<< SEARCH\n        s = 0\n=======\n        s = 0.0\n>>>>>>> REPLACE",
      // 2) wrong indent: SEARCH copied with 4 spaces instead of 8/12
      "```\n<<<<<<< SEARCH\n    for it in items:\n        s += it\n=======\n    for it in items:\n        s += it * 2\n>>>>>>> REPLACE\n```",
      // 3) prose, no blocks
      "Sure! You should change the loop so it doubles each item. Let me know if you need more help.",
    ];
    const rep = replayReplies(recorded, file);
    console.log(`  replay: ${rep.applied} applied, ${rep.failed} failed — ` + rep.rows.map((r, i) => `#${i + 1} blocks=${r.blocks} ok=${r.applied}${r.errs.length ? " err=" + r.errs[0].slice(0, 40) : ""}`).join("; "));
    check("T7 replay counts: 2 applied, 1 failed", rep.applied === 2 && rep.failed === 1, `applied=${rep.applied} failed=${rep.failed}`);
    check("T7 good reply applied", rep.rows[0].applied === 1);
    check("T7 prose reply has no blocks", rep.rows[2].blocks === 0);
    check("T7 wrong-indent reply keeps the file's indent", rep.rows[1].text.includes("\n        for it in items:\n            s += it * 2\n"), short(rep.rows[1].text, 300));
  }

  // ------------------------------------------------------------------ T8 (A2 window)
  section("T8 pickEditWindow: window placement");
  {
    const mk = (n, marks = {}) => Array.from({ length: n }, (_, i) => marks[i] ?? `row ${String(i).padStart(5, "0")} filler filler filler filler`).join("\n");
    const small = mk(50);
    const w0 = pickEditWindow(small, "anything");
    check("T8 small file is sent whole", w0.whole === true && w0.text === small);
    const big = mk(1200, { 100: "def alpha_function_near_start():", 600: "def beta_function_in_middle():", 1150: "def gamma_function_near_end():" });
    check("T8 big file is really bigger than the limit", big.length > 9000, String(big.length));
    for (const [word, line] of [["alpha_function_near_start", 100], ["beta_function_in_middle", 600], ["gamma_function_near_end", 1150]]) {
      const w = pickEditWindow(big, "task text", 9000, `fix the ${word} please`);
      check(`T8 window contains ${word}`, w.text.includes(word) && w.from <= line + 1 && w.to >= line + 1, `${w.from}-${w.to}`);
      check(`T8 window for ${word} fits the limit`, w.text.length <= 9000, String(w.text.length));
    }
    const wl = pickEditWindow(big, "", 9000, "the error is at line 900 of the file");
    check("T8 explicit line number wins", wl.from <= 900 && wl.to >= 900, `${wl.from}-${wl.to}`);
    const wn = pickEditWindow(big, "zzzqqq", 9000, "nothing matches here");
    check("T8 no match falls back to the top of the file", wn.from === 1, String(wn.from));
    const wc = pickEditWindow(big, "filler row", 9000, "filler");
    check("T8 a word found on every line does not crash and stays in the limit", wc.text.length <= 9000);
  }

  // ------------------------------------------------------------------ T9
  section("T9 definition guards for Go, Rust, TypeScript");
  {
    const has = (set, names) => names.every((n) => set.has(n));
    const show = (set) => JSON.stringify([...set]);
    // ---- Go
    const GO = [
      "package main", "", "import \"fmt\"", "",
      "var Debug = false", "const Max = 10", "var (", "\ta = 1", ")", "",
      "type Point struct {", "\tX, Y int", "}", "",
      "type Shape interface {", "\tArea() float64", "}", "",
      "type ID int", "",
      "func Hello(name string) string {", "\tx := 1", "\t_ = x", "\treturn \"hi \" + name", "}", "",
      "func Map[T any](xs []T) []T { return xs }", "",
      "func (p *Point) Move(dx int) {", "\tp.X += dx", "}", "",
      "func (s Stack[T]) Push(v T) {}", "",
      "func main() {", "\tfmt.Println(Hello(\"a\"))", "}", "",
    ].join("\n");
    const goDefs = topLevelDefs(GO, "pkg/main.go");
    check("T9 Go: func, generic func, method, struct, interface, named type, var, const are found",
      has(goDefs, ["Hello", "Map", "Point.Move", "Stack.Push", "Point", "Shape", "ID", "Debug", "Max", "main"]), show(goDefs));
    check("T9 Go: `x := 1` inside a function body is not a definition", !goDefs.has("x"), show(goDefs));
    check("T9 Go: col-0 `x := 1` is not a definition either", !topLevelDefs("x := 1\n", "a.go").has("x"));
    const goNoFunc = GO.replace("func Hello(name string) string {\n\tx := 1\n\t_ = x\n\treturn \"hi \" + name\n}\n", "");
    check("T9 Go: a deleted function is reported", JSON.stringify(droppedDefs(GO, goNoFunc, "main.go")) === JSON.stringify(["Hello"]), JSON.stringify(droppedDefs(GO, goNoFunc, "main.go")));
    const goNoStruct = GO.replace("type Shape interface {\n\tArea() float64\n}\n", "");
    check("T9 Go: a deleted interface is reported", droppedDefs(GO, goNoStruct, "main.go").join(",") === "Shape", JSON.stringify(droppedDefs(GO, goNoStruct, "main.go")));
    check("T9 Go: a deleted method is reported", droppedDefs(GO, GO.replace("func (p *Point) Move(dx int) {", "func helper(dx int) {"), "main.go").includes("Point.Move"));
    check("T9 Go: a rename in place is reported", droppedDefs(GO, GO.replace("func Hello(", "func Greet("), "main.go").join(",") === "Hello");
    check("T9 Go: unchanged set (body edited) reports nothing", droppedDefs(GO, GO.replace("\"hi \"", "\"hello \""), "main.go").length === 0);
    check("T9 Go: without a path the old rules apply (func not tracked)", !topLevelDefs(GO).has("Hello"));
    // ---- Rust
    const RS = [
      "use std::fmt;", "",
      "pub fn add(a: i32, b: i32) -> i32 { a + b }", "",
      "fn private_helper() {}", "",
      "pub(crate) fn crate_only() {}", "",
      "async fn fetch() {}", "",
      "pub const fn cfn() -> u8 { 1 }", "",
      "pub struct Point { x: i32 }", "",
      "enum Color { Red, Green }", "",
      "pub trait Draw { fn draw(&self); }", "",
      "mod inner {", "    pub fn nested() {}", "}", "",
      "static COUNTER: u32 = 0;", "", "pub static mut GLOBAL: u8 = 0;", "",
      "const LIMIT: usize = 5;", "",
      "pub type Res<T> = Result<T, String>;", "",
      "impl Draw for Point {", "    fn draw(&self) {}", "}", "",
      "impl<T: Into<String>> fmt::Display for Wrapper<T> {}", "",
    ].join("\n");
    const rsDefs = topLevelDefs(RS, "src/lib.rs");
    check("T9 Rust: fn, pub fn, pub(crate) fn, async fn, const fn, struct, enum, trait, mod, static, const, type are found",
      has(rsDefs, ["add", "private_helper", "crate_only", "fetch", "cfn", "Point", "Color", "Draw", "inner", "COUNTER", "GLOBAL", "LIMIT", "Res"]), show(rsDefs));
    check("T9 Rust: nested fn and impl blocks give no names", !rsDefs.has("nested") && !rsDefs.has("draw") && ![...rsDefs].some((n) => /impl/.test(n)), show(rsDefs));
    check("T9 Rust: a deleted function is reported", droppedDefs(RS, RS.replace("fn private_helper() {}\n", ""), "lib.rs").join(",") === "private_helper");
    check("T9 Rust: a deleted struct is reported", droppedDefs(RS, RS.replace("pub struct Point { x: i32 }\n", ""), "lib.rs").join(",") === "Point");
    check("T9 Rust: a rename in place is reported", droppedDefs(RS, RS.replace("pub fn add(", "pub fn sum("), "lib.rs").join(",") === "add");
    check("T9 Rust: unchanged set (impl edited) reports nothing", droppedDefs(RS, RS.replace("impl<T: Into<String>>", "impl<T: Into<String> + Clone>"), "lib.rs").length === 0);
    // ---- TypeScript
    const TS = [
      "import { x } from './x';", "",
      "export interface User { id: number }", "",
      "interface Internal { a: string }", "",
      "export type Id = string;", "",
      "type Pair<A, B> = [A, B];", "",
      "export enum Role { Admin, User }", "",
      "export const enum Flag { On, Off }", "",
      "export abstract class Base {}", "",
      "export default class Main {}", "",
      "export default function boot() {}", "",
      "export declare function ext(): void;", "",
      "declare const VERSION: string;", "",
      "export function helper(): number { return 1 }", "",
      "export const API = 'x';", "",
    ].join("\n");
    const tsDefs = topLevelDefs(TS, "src/app.ts");
    check("T9 TS: interface, type, enum, const enum, abstract class, export default class/function, declare are found",
      has(tsDefs, ["User", "Internal", "Id", "Pair", "Role", "Flag", "Base", "Main", "boot", "ext", "VERSION", "helper", "API"]), show(tsDefs));
    check("T9 TS: .tsx/.mts/.cts use the same rules", ["a.tsx", "a.mts", "a.cts"].every((p) => topLevelDefs(TS, p).has("User")));
    check("T9 TS: a deleted interface is reported", droppedDefs(TS, TS.replace("export interface User { id: number }\n", ""), "app.ts").join(",") === "User");
    check("T9 TS: a deleted function is reported", droppedDefs(TS, TS.replace("export function helper(): number { return 1 }\n", ""), "app.ts").join(",") === "helper");
    check("T9 TS: a rename in place is reported", droppedDefs(TS, TS.replace("export type Id =", "export type Key ="), "app.ts").join(",") === "Id");
    check("T9 TS: unchanged set reports nothing", droppedDefs(TS, TS.replace("{ id: number }", "{ id: number; name: string }"), "app.ts").length === 0);
    // ---- no false positives in Python (with and without a path)
    const PY = "\"\"\"Module doc.\ntype foo\nstruct bar\nfn baz\nfunc qux(\ninterface Zed\n\"\"\"\n\ndef f():\n    pass\n\nX = 1\n";
    const pyNo = topLevelDefs(PY), pyRel = topLevelDefs(PY, "pkg/mod.py");
    check("T9 Python: docstring lines 'type foo' / 'struct bar' / 'fn baz' give no extra names (no path)", show(pyNo) === JSON.stringify(["f", "X"]), show(pyNo));
    check("T9 Python: same result with a .py path", show(pyRel) === show(pyNo), show(pyRel));
    check("T9 Python: droppedDefs with and without a .py path agree", JSON.stringify(droppedDefs(PY, "def f():\n    pass\n", "m.py")) === JSON.stringify(droppedDefs(PY, "def f():\n    pass\n")));
    // ---- end to end: editFile on .go and .rs (fake model). No Go/Rust compiler is used:
    // gate() has no checker for these, so it says ok and only the definition guard can stop the edit.
    const goSrc = "package m\n\nfunc Keep() int {\n\treturn 1\n}\n\nfunc Drop() int {\n\treturn 2\n}\n";
    put("e2e/m.go", goSrc);
    const gm = fakeModel({ editReplies: ["<<<<<<< SEARCH\nfunc Drop() int {\n\treturn 2\n}\n=======\n>>>>>>> REPLACE"] });
    const gr = await makeAgent(gm, "tidy the code").editFile({ path: "e2e/m.go" }, [], noEmit, {}, "");
    check("T9 e2e Go: an edit that deletes a function is REVERTED", get("e2e/m.go") === goSrc && /REVERTED/.test(gr), short(gr, 200) + " " + short(get("e2e/m.go")));
    put("e2e/m2.go", goSrc);
    const gm2 = fakeModel({ editReplies: ["<<<<<<< SEARCH\nfunc Drop() int {\n=======\nfunc Renamed() int {\n>>>>>>> REPLACE"] });
    const gr2 = await makeAgent(gm2, "tidy the code").editFile({ path: "e2e/m2.go" }, [], noEmit, {}, "");
    check("T9 e2e Go: a rename in place does not ship with Drop silently gone", /func Drop\(\)/.test(get("e2e/m2.go")), short(gr2, 200) + " " + short(get("e2e/m2.go")));
    const goOk = fakeModel({ editReplies: ["<<<<<<< SEARCH\n\treturn 2\n=======\n\treturn 3\n>>>>>>> REPLACE"] });
    put("e2e/m3.go", goSrc);
    await makeAgent(goOk, "change Drop to return 3").editFile({ path: "e2e/m3.go" }, [], noEmit, {}, "");
    check("T9 e2e Go: a normal body edit still ships", get("e2e/m3.go") === goSrc.replace("return 2", "return 3"), short(get("e2e/m3.go")));
    const rsSrc = "pub fn keep() -> i32 {\n    1\n}\n\npub struct Gone {\n    x: i32,\n}\n\nfn drop_me() -> i32 {\n    2\n}\n";
    put("e2e/lib.rs", rsSrc);
    const rm = fakeModel({ editReplies: ["<<<<<<< SEARCH\nfn drop_me() -> i32 {\n    2\n}\n=======\n>>>>>>> REPLACE"] });
    const rr = await makeAgent(rm, "tidy the code").editFile({ path: "e2e/lib.rs" }, [], noEmit, {}, "");
    check("T9 e2e Rust: an edit that deletes a function is REVERTED", get("e2e/lib.rs") === rsSrc && /REVERTED/.test(rr), short(rr, 200) + " " + short(get("e2e/lib.rs")));
    put("e2e/lib2.rs", rsSrc);
    const rm2 = fakeModel({ editReplies: ["<<<<<<< SEARCH\npub struct Gone {\n    x: i32,\n}\n=======\n>>>>>>> REPLACE"] });
    const rr2 = await makeAgent(rm2, "tidy the code").editFile({ path: "e2e/lib2.rs" }, [], noEmit, {}, "");
    check("T9 e2e Rust: an edit that deletes a struct is REVERTED", get("e2e/lib2.rs") === rsSrc && /REVERTED/.test(rr2), short(rr2, 200));
  }

  // ------------------------------------------------------------------ T10 (B1 approval)
  section("T10 edit_file asks for approval when auto-approve is off");
  {
    const reply = "<<<<<<< SEARCH\nbeta\n=======\nBETA\n>>>>>>> REPLACE";
    const src = "alpha\nbeta\ngamma\n";
    // rejected
    put("t10a.txt", src);
    let asked = [];
    let ag = makeAgent(fakeModel({ editReplies: [reply] }), "make beta loud");
    let r = await ag.editFile({ path: "t10a.txt" }, [], noEmit, { autoApprove: false, approve: async (t, d) => { asked.push([t, d]); return false; } }, "change beta");
    check("T10 approval was asked once", asked.length === 1, String(asked.length));
    check("T10 question names the file and shows the changed lines", asked[0] && /t10a\.txt/.test(asked[0][0]) && /- beta/.test(asked[0][1]) && /\+ BETA/.test(asked[0][1]), short(asked[0]));
    check("T10 rejected: result says User rejected", r === "User rejected.", short(r));
    check("T10 rejected: file is unchanged on disk", get("t10a.txt") === src);
    // approved
    put("t10b.txt", src);
    asked = [];
    ag = makeAgent(fakeModel({ editReplies: [reply] }), "make beta loud");
    r = await ag.editFile({ path: "t10b.txt" }, [], noEmit, { autoApprove: false, approve: async (t, d) => { asked.push(t); return true; } }, "change beta");
    check("T10 approved: edit is applied", get("t10b.txt") === "alpha\nBETA\ngamma\n", short(r));
    // auto-approve on: no question
    put("t10c.txt", src);
    asked = [];
    ag = makeAgent(fakeModel({ editReplies: [reply] }), "make beta loud");
    await ag.editFile({ path: "t10c.txt" }, [], noEmit, { autoApprove: true, approve: async (t) => { asked.push(t); return true; } }, "change beta");
    check("T10 auto-approve on: no question, edit applied", asked.length === 0 && get("t10c.txt") === "alpha\nBETA\ngamma\n", String(asked.length));
    // no approve function at all (old tests / no-UI): still edits
    put("t10d.txt", src);
    ag = makeAgent(fakeModel({ editReplies: [reply] }), "make beta loud");
    await ag.editFile({ path: "t10d.txt" }, [], noEmit, {}, "change beta");
    check("T10 no approve function: edit still applied (no crash)", get("t10d.txt") === "alpha\nBETA\ngamma\n");
    // an edit that changes nothing never asks
    put("t10e.txt", src);
    asked = [];
    ag = makeAgent(fakeModel({ editReplies: ["<<<<<<< SEARCH\nbeta\n=======\nbeta\n>>>>>>> REPLACE"] }), "x");
    r = await ag.editFile({ path: "t10e.txt" }, [], noEmit, { autoApprove: false, approve: async (t) => { asked.push(t); return true; } }, "x");
    check("T10 no-change edit does not ask", asked.length === 0 && /No change/.test(String(r)), short(r));
  }

  // ------------------------------------------------------------------ T11 (B3)
  section("T11 checkpoint after each file write/edit (real execute() dispatch)");
  async function cpRun(actions, hook) {
    put("t11.txt", "alpha\nbeta\n");
    const model = fakeModel({ editReplies: ["<<<<<<< SEARCH\nbeta\n=======\nBETA\n>>>>>>> REPLACE"], actions });
    const ag = makeAgent(model); const got = [];
    if (hook !== "none") ag.checkpoint = hook === "throws" ? async () => { throw new Error("git broke"); } : hook === "hangs" ? () => new Promise(() => {}) : async (info) => { got.push(info); };
    ag.writeFile = async (args) => `Wrote ${args.path} (spy)`;
    const events = [];
    await ag.execute([{ role: "system", content: "exec" }, { role: "user", content: "go" }], (e) => events.push(e), { autoApprove: true, approve: async () => true }, { maxSteps: 2 });
    return { got, events };
  }
  {
    const a = await cpRun([JSON.stringify({ tool: "edit_file", args: { path: "t11.txt" } }), JSON.stringify({ tool: "write_file", args: { path: "./t11b.txt", content: "x" } })], "ok");
    check("T11 a checkpoint is asked for after edit_file and after write_file", a.got.length === 2 && a.got[0].tool === "edit_file" && a.got[1].tool === "write_file", short(a.got));
    check("T11 the file name is clean (no ./)", a.got[1]?.file === "t11b.txt", short(a.got[1]));
    const b = await cpRun([JSON.stringify({ tool: "read_file", args: { path: "t11.txt" } })], "ok");
    check("T11 reading a file makes no checkpoint", b.got.length === 0, short(b.got));
    const c = await cpRun([JSON.stringify({ tool: "edit_file", args: { path: "t11.txt" } })], "throws");
    check("T11 a failing checkpoint does not stop the run", c.events.some((e) => e.type === "toolResult" && e.name === "edit_file"), short(c.events.map((e) => e.type)));
    const d = await cpRun([JSON.stringify({ tool: "edit_file", args: { path: "t11.txt" } })], "none");
    check("T11 no checkpoint function: works as before", d.events.some((e) => e.type === "toolResult" && e.name === "edit_file"));
  }

  // ------------------------------------------------------------------ T12 (A6)
  section("T12 one-call edit: search + replace given in the action, no second model call");
  {
    const noEmit = () => {}; const auto = { autoApprove: true };
    put("t12a.py", "def f():\n    return 1\n\ndef g():\n    return 2\n");
    let model = fakeModel({ editReplies: [] }); let ag = makeAgent(model);
    let r = await ag.editFile({ path: "t12a.py", search: "    return 1", replace: "    return 10" }, [], noEmit, auto, "x");
    check("T12 the edit is applied", get("t12a.py") === "def f():\n    return 10\n\ndef g():\n    return 2\n", short(r));
    check("T12 no second model call was made", model.editCalls.length === 0 && model.calls.length === 0, String(model.calls.length));
    check("T12 the counter notes it", ag._oneCallEdits === 1);

    put("t12b.py", "x = 1\nx = 1\n"); model = fakeModel({ editReplies: [] }); ag = makeAgent(model);
    r = await ag.editFile({ path: "t12b.py", search: "x = 1", replace: "x = 2" }, [], noEmit, auto, "x");
    check("T12 a search text that is not unique is refused by the same match rules", /Edit failed/.test(String(r)) && get("t12b.py") === "x = 1\nx = 1\n", short(r));

    put("t12c.py", "a = 1\n"); model = fakeModel({ editReplies: [] }); ag = makeAgent(model);
    r = await ag.editFile({ path: "t12c.py", search: "NOT THERE", replace: "b = 2" }, [], noEmit, auto, "x");
    check("T12 a search text that is not in the file fails and changes nothing", /Edit failed/.test(String(r)) && get("t12c.py") === "a = 1\n", short(r));

    put("t12d.py", "def f():\n    return 1\n"); model = fakeModel({ editReplies: [] }); ag = makeAgent(model);
    r = await ag.editFile({ path: "t12d.py", search: "    return 1", replace: "    return (" }, [], noEmit, auto, "x");
    check("T12 the compile guard still reverts a broken edit", /BROKE compilation/.test(String(r)) && get("t12d.py") === "def f():\n    return 1\n", short(r));

    put("t12e.py", "def f():\n    return 1\n\ndef g():\n    return 2\n"); model = fakeModel({ editReplies: [] }); ag = makeAgent(model); const asked = [];
    r = await ag.editFile({ path: "t12e.py", search: "    return 2", replace: "    return 3" }, [], noEmit, { autoApprove: false, approve: async (t) => { asked.push(t); return false; } }, "x");
    check("T12 the approval question is still asked, and a rejection changes nothing", asked.length === 1 && /rejected/i.test(String(r)) && /return 2/.test(get("t12e.py")), short(r));

    put("t12f.py", "a = 1\n"); model = fakeModel({ editReplies: ["<<<<<<< SEARCH\na = 1\n=======\na = 5\n>>>>>>> REPLACE"] }); ag = makeAgent(model);
    r = await ag.editFile({ path: "t12f.py", search: "", replace: "zzz" }, [], noEmit, auto, "x");
    check("T12 an empty search text falls back to the normal two-call edit", model.editCalls.length === 1 && get("t12f.py") === "a = 5\n", short(r));
    put("t12g.py", "a = 1\n"); model = fakeModel({ editReplies: ["<<<<<<< SEARCH\na = 1\n=======\na = 6\n>>>>>>> REPLACE"] }); ag = makeAgent(model);
    r = await ag.editFile({ path: "t12g.py", search: 5, replace: null }, [], noEmit, auto, "x");
    check("T12 wrong types fall back to the normal edit", model.editCalls.length === 1 && get("t12g.py") === "a = 6\n", short(r));
  }
} catch (e) {
  check("harness crashed", false, String(e?.stack || e).slice(0, 600));
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log("Failed: " + failures.join(" | "));
process.exit(fail ? 1 : 0);
