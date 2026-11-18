// Test: the proof card logic (proofcard.mjs) — NO model, NO server, NO browser.
// Run: node test-proofcard.mjs
import fs from "fs"; import path from "path"; import os from "os";
import { buildProofCard, proofCard } from "./proofcard.mjs";
import { gitSnapshot } from "./snapshot.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const LOCAL = ["http://127.0.0.1:8080"];
const tool = (name, args) => ({ type: "tool", name, args });
const res = (name, result) => ({ type: "toolResult", name, result });
const done = (warnings = []) => ({ type: "done", files: [], warnings });

// tests passed
{ const c = buildProofCard({ events: [tool("run_tests", {}), res("run_tests", "5 passed in 0.1s"), { type: "log", text: "test gate: python -m pytest -q → PASS" }, done()], bases: LOCAL });
  ok(c.tests.status === "passed" && /Tests passed/.test(c.tests.text) && c.tests.runs.length === 2, "tests passed", c.tests); }
{ const c = buildProofCard({ events: [tool("run_command", { command: "npm test" }), res("run_command", "ok 3 tests"), done()], bases: LOCAL });
  ok(c.tests.status === "passed" && /npm test/.test(c.tests.text), "a test command run by the agent counts", c.tests); }
// tests failed
{ const c = buildProofCard({ events: [{ type: "log", text: "test gate: python -m pytest -q → FAIL" }, done()], bases: LOCAL });
  ok(c.tests.status === "failed" && /pytest/.test(c.tests.text), "tests failed (test check said FAIL)", c.tests); }
{ const c = buildProofCard({ events: [{ type: "log", text: "test gate: npm test → PASS" }, done(["command still failing: npm test"])], bases: LOCAL });
  ok(c.tests.status === "failed", "the run's own final 'still failing' warning wins over an earlier PASS", c.tests); }
{ const c = buildProofCard({ events: [{ type: "log", text: "test gate: npm test → PASS" }, done(), { type: "regression", text: "'npm test --silent' PASSED before this run but FAILS now" }], bases: LOCAL });
  ok(c.tests.status === "failed" && /npm test --silent/.test(c.tests.text), "a failing check after the run makes it failed", c.tests); }
{ const c = buildProofCard({ events: [tool("run_command", { command: "pytest -q" }), res("run_command", "⚠ COMMAND FAILED (exit 1)\n2 failed"), done()], bases: LOCAL });
  ok(c.tests.status === "failed", "a failing test command run by the agent", c.tests); }
// no tests
{ const c = buildProofCard({ events: [tool("run_command", { command: "python app.py" }), res("run_command", "hello"), { type: "log", text: "baseline check: npm test → PASS" }, done()], bases: LOCAL });
  ok(c.tests.status === "none" && c.tests.text === "No tests were run.", "no tests: a normal command and the before-run check do not count", c.tests); }
{ const c = buildProofCard({ events: [tool("run_tests", {}), res("run_tests", "BLOCKED by hook: no"), done()], bases: LOCAL });
  ok(c.tests.status === "none", "a blocked test call never ran", c.tests); }
{ const c = buildProofCard({ events: [tool("run_tests", {}), res("run_tests", "'pytest' is not recognized as an internal or external command"), done()], bases: LOCAL });
  ok(c.tests.status === "not-run", "a missing test program is not called a pass", c.tests); }
// local only
{ const c = buildProofCard({ events: [tool("read_file", { path: "a.js" }), tool("open_url", { url: "http://localhost:3000/" }), tool("publish_artifact", { path: "r.md" }), tool("check_page", { path: "index.html" }), done()], bases: ["http://127.0.0.1:8080", "http://localhost:11434", "http://[::1]:9000"] });
  ok(c.privacy.local === true && c.privacy.text === "Nothing left this PC." && !c.privacy.left.length, "local-only run: nothing left this PC", c.privacy); }
// web tool used
{ const c = buildProofCard({ events: [tool("web_search", { query: "x" }), done()], bases: LOCAL });
  ok(c.privacy.local === false && c.privacy.left.includes("web search was used"), "web search -> false, and says so", c.privacy); }
{ const c = buildProofCard({ events: [tool("open_url", { url: "https://example.com/a" }), tool("http_request", { url: "api.github.com/x" }), done()], bases: LOCAL });
  ok(c.privacy.local === false && c.privacy.left.some((l) => /example\.com/.test(l)) && c.privacy.left.some((l) => /api\.github\.com/.test(l)), "web fetch -> false, names the site", c.privacy); }
{ const c = buildProofCard({ events: [tool("run_command", { command: "pip install requests" }), tool("mcp__github__create_issue", {}), done()], bases: LOCAL });
  ok(c.privacy.local === false && c.privacy.left.length === 2, "an internet command and an outside tool -> false", c.privacy); }
// remote base
{ const c = buildProofCard({ events: [done()], bases: ["https://openrouter.ai/api"] });
  ok(c.privacy.local === false && /openrouter\.ai/.test(c.privacy.text), "remote model base -> false", c.privacy); }
{ const c = buildProofCard({ events: [{ type: "agent", role: "cloud-fallback" }, done()], bases: LOCAL, cloudBase: "https://api.anthropic.com" });
  ok(c.privacy.local === false && /api\.anthropic\.com/.test(c.privacy.text), "the cloud fallback was used -> false", c.privacy); }
{ const c = buildProofCard({ events: [done()], bases: LOCAL, cloudBase: "https://api.anthropic.com" });
  ok(c.privacy.local === true, "a cloud fallback that was set but never used does not count", c.privacy); }
{ const c = buildProofCard({ events: [done()], bases: ["http://127.0.0.1.evil.com:80"] });
  ok(c.privacy.local === false, "a look-alike host is not local", c.privacy); }
// files and undo
{ const c = buildProofCard({ events: [done()], bases: LOCAL, canUndo: true, changes: [{ file: "a.js", status: "modified", added: 3, removed: 1, counted: true }, { file: "b.js", status: "added", added: 10, removed: 0, counted: true }] });
  ok(c.files.list.length === 2 && c.files.added === 13 && c.files.removed === 1 && /2 files changed \(\+13 −1 lines\)/.test(c.files.text), "files changed with line counts", c.files);
  ok(c.undo.available === true, "undo is offered when there is an undo point", c.undo); }
{ const c = buildProofCard({ events: [done()], files: ["x.py"], isolated: true });
  ok(c.files.list[0].file === "x.py" && c.files.list[0].counted === false && c.files.text === "1 file changed." && c.undo.available === false && /branch/.test(c.undo.text), "own-branch run: names only, no undo here", { f: c.files, u: c.undo }); }
{ const c = buildProofCard({ events: [tool("http_request", { url: "127.0.0.1:8080/x" }), tool("http_request", { url: "localhost:3000/api" }), done()], bases: LOCAL });
  ok(c.privacy.local === true, "a local address without http:// stays local", c.privacy); }
// the server's gatherer on a real folder with a real undo point (git only, no model)
{ const ws = fs.mkdtempSync(path.join(os.tmpdir(), "eta-proof-"));
  try {
    fs.writeFileSync(path.join(ws, "keep.js"), "a\nb\nc\n"); fs.writeFileSync(path.join(ws, "gone.js"), "x\ny\n");
    const snapshot = await gitSnapshot(ws);
    if (!snapshot) ok(true, "git missing: real-folder check skipped");
    else {
      fs.writeFileSync(path.join(ws, "keep.js"), "a\nB\nc\nd\n"); fs.writeFileSync(path.join(ws, "new.js"), "1\n2\n3\n"); fs.unlinkSync(path.join(ws, "gone.js"));
      const c = await proofCard({ id: "1", status: "done", workspace: ws, snapshot, files: new Set(["keep.js", "new.js", "gone.js"]), events: [done()], bases: LOCAL });
      const by = Object.fromEntries(c.files.list.map((f) => [f.file, f]));
      ok(by["keep.js"]?.added === 2 && by["keep.js"]?.removed === 1, "a changed file: +2 −1 against the undo point", by["keep.js"]);
      ok(by["new.js"]?.status === "added" && by["new.js"]?.added === 3, "a new file: +3", by["new.js"]);
      ok(by["gone.js"]?.status === "deleted" && by["gone.js"]?.removed === 2, "a deleted file: −2", by["gone.js"]);
      ok(c.undo.available === true && c.privacy.local === true && c.tests.status === "none", "undo offered, local, no tests", { u: c.undo, p: c.privacy, t: c.tests });
    }
  } finally { fs.rmSync(ws, { recursive: true, force: true }); } }
// empty run
{ const c = buildProofCard({});
  ok(c.tests.status === "none" && c.files.text === "No files changed." && c.undo.available === false && c.privacy.local === null, "empty run: no tests, no files, no undo, privacy not known", c);
  const c2 = buildProofCard();
  ok(c2.tests.text === "No tests were run.", "no argument at all does not crash"); }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
