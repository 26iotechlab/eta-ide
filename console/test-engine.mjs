// Engine test harness — runs the PRODUCTION engine (agent.mjs) with a mock LLM
// provider (scripted responses over a local HTTP server that speaks the Ollama
// /api/chat shape), so the whole pipeline (Planner → Executor → Gatekeeper →
// command debt → circuit breaker → Reviewer) is exercised deterministically.
// Run: node test-engine.mjs
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { Agent, setProvider, cleanRel, deEntity, stripFences, unwrapTags, gate, search, execTool, detectProviderKind, externalImports, pkgExists, detectTestCmd } from "./agent.mjs";
import { checkPage } from "./browser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = path.join(__dirname, ".test-sandbox");
let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const fresh = (name) => { const d = path.join(SANDBOX, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const ctxFor = (root) => ({ root, log: () => {}, approve: async () => true, autoApprove: true });

// ---------------- unit: weak-model safety nets ----------------
async function testUnits() {
  section("units: path cleaning, de-entity, fences, unwrap");
  check("cleanRel strips /mnt/data/", cleanRel("/mnt/data/x.py") === "x.py");
  check("cleanRel strips stacked prefixes + workspace echo", cleanRel("root/hb1/x.js", "d:\\any\\hb1") === "x.js");
  check("cleanRel leaves normal paths alone", cleanRel("src/app.js") === "src/app.js");
  check("deEntity fixes &lt;div&gt;", deEntity("&lt;div&gt;").text === "<div>");
  check("deEntity leaves clean code alone", deEntity("if (a<b) x();").changed === false);
  check("stripFences removes ```js fences", stripFences("```js\nvar a=1;\n```") === "var a=1;");
  check("stripFences removes think residue", stripFences("<think>hm</think>\nvar a=1;") === "var a=1;");
  check("unwrapTags unwraps <script> for .js", unwrapTags("<script>var a=1;</script>", "x.js").text === "var a=1;");
  check("unwrapTags leaves html alone", unwrapTags("<script>x</script>", "x.html").changed === false);

  section("units: gatekeeper (deterministic verifiers)");
  const root = fresh("gate");
  fs.writeFileSync(path.join(root, "good.js"), "var a = 1;\n");
  fs.writeFileSync(path.join(root, "bad.js"), "function {(\n");
  fs.writeFileSync(path.join(root, "good.json"), '{"a":1}');
  fs.writeFileSync(path.join(root, "bad.json"), "{a:");
  fs.writeFileSync(path.join(root, "page.html"), "<!doctype html><html><body>hi</body></html>");
  fs.writeFileSync(path.join(root, "blob.css"), '{"tool":"write_file","args":{}}');
  check("gate: valid JS passes node --check", (await gate(root, "good.js")).ok);
  check("gate: broken JS fails", !(await gate(root, "bad.js")).ok);
  check("gate: valid JSON ok", (await gate(root, "good.json")).ok);
  check("gate: invalid JSON fails", !(await gate(root, "bad.json")).ok);
  check("gate: real HTML ok", (await gate(root, "page.html")).ok);
  check("gate: action-JSON blob in non-JSON file caught", !(await gate(root, "blob.css")).ok);
  fs.writeFileSync(path.join(root, "escape.js"), "const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };\nmodule.exports = map;\n");
  check("gate: legit escapeHtml entity map passes (bench-9b regression)", (await gate(root, "escape.js")).ok);
  fs.writeFileSync(path.join(root, "corrupt.css"), "body &gt; div { color: red; }");
  check("gate: entity corruption still caught for checker-less types", !(await gate(root, "corrupt.css")).ok);

  section("units: search (ripgrep + JS fallback) and read_file caps");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "// UNIQ_ENGINE_TOKEN here\nconst weird = \"weird(x\";\n");
  process.env.ETA_NO_RG = "1";
  const js1 = await search(root, "UNIQ_ENGINE_TOKEN");
  check("JS-fallback search finds token", js1.includes("a.js:1"), js1.slice(0, 80));
  delete process.env.ETA_NO_RG;
  const s1 = await search(root, "UNIQ_ENGINE_TOKEN");
  check("search (rg or fallback) finds token with file:line", s1.includes("a.js:1"), s1.slice(0, 80));
  const s2 = await search(root, "weird(x");
  check("literal query with regex chars works", s2.includes("a.js:2"), s2.slice(0, 80));
  fs.writeFileSync(path.join(root, "big.txt"), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const r1 = await execTool("read_file", { path: "big.txt" }, ctxFor(root));
  check("read_file capped at 350 lines with header", r1.includes("1000 lines total, showing 1-350") && !r1.includes("line 351"));
  const r2 = await execTool("read_file", { path: "big.txt", start_line: 500, end_line: 505 }, ctxFor(root));
  check("read_file ranged read", r2.includes("showing 500-505") && r2.includes("line 505") && !r2.includes("line 506"));
}

// ---------------- mock LLM provider (Ollama /api/chat shape) ----------------
function startMock(script) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "mock:latest" }] }));
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "mock" }] }));
      const isOpenAI = req.url.startsWith("/v1/");
      let content = "OK";
      try {
        const msgs = JSON.parse(body).messages || [];
        const sys = msgs[0]?.role === "system" ? msgs[0].content : "";
        const firstUser = msgs.find((m) => m.role === "user")?.content || "";
        if (sys.startsWith("You are Eta's Executor")) {
          if (script.seen) script.seen.push(msgs[msgs.length - 1]?.content || "");
          content = JSON.stringify(script.actions.shift() || { tool: "finish", args: { summary: "script exhausted" } });
        }
        else if (sys.includes("expert programmer")) content = script.contents.shift() || "// empty";
        else if (firstUser.startsWith("You are the Planner")) content = "1. Do the task\n2. Verify it";
        else if (firstUser.startsWith("You are the Reviewer")) content = (script.reviews || []).shift() || "APPROVED";
        else if (firstUser.includes("reviewing retrieved knowledge")) content = (script.knowledgeVerdicts || []).shift() || "SUFFICIENT";
        else if (firstUser.includes("Extract DURABLE")) content = script.durable || "NONE";
        else if (firstUser.includes("Compress this coding session")) content = "digest";
      } catch { /* default OK */ }
      let streaming = false; try { streaming = !!JSON.parse(body).stream; } catch { }
      if (streaming && isOpenAI) return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      res.end(JSON.stringify(isOpenAI ? { choices: [{ message: { content } }] } : { message: { content } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

async function runEngine(root, script, agentOpts = {}) {
  const { server, url } = await startMock(script);
  setProvider({ base: url, model: "mock", kind: script.kind || "ollama" });
  const agent = new Agent(root, { maxSteps: 12, autoApprove: true, ...agentOpts });
  const events = [];
  await agent.run(script.task, (e) => events.push(e), async () => true);
  server.close();
  setProvider({ base: "http://localhost:11434", model: "eta-r3" });
  return events;
}

// ---------------- integration A: bug-1 regression (./ must survive) ----------------
async function testRequireDotSlash() {
  section("integration: verify commands with require('./x') succeed (bug-1 regression)");
  const root = fresh("int-a");
  const V1 = "module.exports = { slugify: function (s) { return s.trim().toLowerCase().replace(/\\s+/g, '-'); } };";
  const events = await runEngine(root, {
    task: "create slugify util and verify",
    actions: [
      { tool: "write_file", args: { path: "utils.js" } },
      { tool: "run_command", args: { command: `node -e "const{slugify}=require('./utils');console.log(slugify(' Hello   World '))"` } },
      { tool: "write_file", args: { path: "utils.js" } }, // edit → must emit a line diff
      { tool: "finish", args: { summary: "done" } },
    ],
    contents: [V1, V1 + "\nmodule.exports.VERSION = 2;"],
  });
  const gateEv = events.find((e) => e.type === "gate");
  const runEv = events.filter((e) => e.type === "toolResult" && e.name === "run_command");
  const done = events.find((e) => e.type === "done");
  check("gatekeeper passed the written file", !!gateEv && gateEv.ok === true);
  check("verify command SUCCEEDED (./ preserved)", runEv.length === 1 && runEv[0].result.includes("hello-world") && !/COMMAND FAILED/.test(runEv[0].result), runEv[0]?.result?.slice(0, 100));
  check("run finished with zero warnings", !!done && (done.warnings || []).length === 0, JSON.stringify(done?.warnings));
  let out = ""; try { out = execFileSync(process.execPath, ["-e", "const{slugify}=require('./utils');console.log(slugify(' Hello   World '))"], { cwd: root, timeout: 15000 }).toString().trim(); } catch (e) { out = "ERR " + e.message.slice(0, 80); }
  check("independent re-run prints hello-world", out === "hello-world", out);
  const fw = events.find((e) => e.type === "filewrite");
  check("live-edit: filewrite event carries new-file content", !!fw && fw.file === "utils.js" && /slugify/.test(fw.content || "") && fw.lines >= 1, JSON.stringify(fw && { file: fw.file, lines: fw.lines }));
  const df = events.find((e) => e.type === "diff");
  check("live-edit: diff event reports exact changed lines", !!df && df.addedTotal === 1 && df.removedTotal === 0 && /VERSION = 2/.test((df.added || []).join("\n")), JSON.stringify(df && { start: df.start, a: df.addedTotal, r: df.removedTotal }));
}

// ---------------- integration B: circuit breaker + honest warnings ----------------
async function testCircuitBreaker() {
  section("integration: repeated identical failing command trips the breaker");
  const root = fresh("int-b");
  const failCmd = `node -e "console.error('boom'); process.exit(1)"`;
  const events = await runEngine(root, {
    task: "run a command that fails",
    actions: [
      { tool: "run_command", args: { command: failCmd } },
      { tool: "run_command", args: { command: failCmd } },
      { tool: "run_command", args: { command: failCmd } },
      { tool: "finish", args: { summary: "give up 1" } },
      { tool: "finish", args: { summary: "give up 2" } },
      { tool: "finish", args: { summary: "give up 3" } },
    ],
    contents: [],
  });
  const runResults = events.filter((e) => e.type === "toolResult" && e.name === "run_command").map((e) => e.result);
  const done = events.find((e) => e.type === "done");
  check("first two failures actually executed", runResults.filter((r) => /COMMAND FAILED/.test(r)).length === 2, `got ${runResults.filter((r) => /COMMAND FAILED/.test(r)).length}`);
  check("third attempt blocked by circuit breaker (not executed)", runResults.length === 3 && /STOP —/.test(runResults[2]), runResults[2]?.slice(0, 90));
  check("finish eventually allowed, debt reported honestly", !!done && (done.warnings || []).some((w) => /command still failing/.test(w)), JSON.stringify(done?.warnings));
  check("an answer was emitted (no wedge)", events.some((e) => e.type === "answer"));
}

// ---------------- integration C: entity repair-on-failure ----------------
async function testEntityRepair() {
  section("integration: entity-escaped content repaired only when the gate fails");
  const root = fresh("int-c");
  const events = await runEngine(root, {
    task: "write a greeting script",
    actions: [
      { tool: "write_file", args: { path: "hi.js" } },
      { tool: "finish", args: { summary: "done" } },
    ],
    contents: ["console.log(&quot;hi&quot;);"], // fully entity-escaped JS from the model
  });
  const gateEv = events.find((e) => e.type === "gate");
  check("escaped content repaired and gate passes", !!gateEv && gateEv.ok === true, JSON.stringify(gateEv));
  check("repair was logged", events.some((e) => e.type === "log" && /repaired HTML-escaped/.test(e.text || "")));
  check("file on disk is real JS", fs.readFileSync(path.join(root, "hi.js"), "utf8").includes('console.log("hi");'));
}

async function testByomOpenAI() {
  section("BYOM: full pipeline over an OpenAI-compatible endpoint");
  const root = fresh("int-e");
  const events = await runEngine(root, {
    kind: "openai",
    task: "write a tiny greeting script",
    actions: [
      { tool: "write_file", args: { path: "hello.js" } },
      { tool: "run_command", args: { command: "node hello.js" } },
      { tool: "finish", args: { summary: "done via openai protocol" } },
    ],
    contents: ["console.log('byom-openai-ok');"],
  });
  const gateEv = events.find((e) => e.type === "gate");
  check("OpenAI-protocol run writes + gates", !!gateEv && gateEv.ok === true, JSON.stringify(gateEv));
  check("OpenAI-protocol run verifies + finishes", events.some((e) => e.type === "toolResult" && /byom-openai-ok/.test(e.result || "")) && events.some((e) => e.type === "answer" && /openai protocol/.test(e.text || "")));

  // protocol detection unit: an OpenAI-only server (no /api/tags)
  const oai = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "gpt-mock" }] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => oai.listen(0, "127.0.0.1", r));
  const oaiUrl = `http://127.0.0.1:${oai.address().port}`;
  check("detectProviderKind: openai-only endpoint", (await detectProviderKind(oaiUrl)) === "openai");
  oai.close();
}

// ---------------- package-exists guard ----------------
async function testPackageGuard() {
  section("package guard: hallucinated imports are gate failures");
  const ei = externalImports("const a = require('express');\nimport x from './local';\nimport fs from 'fs';\nimport { y } from '@scope/pkg/sub';", "js");
  check("js import extraction (skips relative + builtins, keeps scoped)", ei.eco === "npm" && ei.names.includes("express") && ei.names.includes("@scope/pkg") && !ei.names.some((n) => n === "fs" || n.startsWith(".")), JSON.stringify(ei));
  const pi = externalImports("import os\nimport requests\nfrom flask import Flask\n", "py");
  check("py import extraction (skips stdlib)", pi.eco === "pypi" && pi.names.includes("requests") && pi.names.includes("flask") && !pi.names.includes("os"), JSON.stringify(pi));

  // mock registry: /realpkg-abc -> 200, anything else -> 404
  const reg = http.createServer((req, res) => {
    if (req.url.includes("realpkg-abc")) { res.end("{}"); return; }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => reg.listen(0, "127.0.0.1", r));
  process.env.ETA_PKG_REGISTRY = `http://127.0.0.1:${reg.address().port}`;
  check("pkgExists: real package passes", await pkgExists("realpkg-abc", "npm"));
  check("pkgExists: fake package caught", !(await pkgExists("halluc-pkg-zzz9", "npm")));
  const root = fresh("pkg");
  fs.writeFileSync(path.join(root, "uses-fake.js"), "const x = require('halluc-import-qqq7');\nconsole.log(x);\n");
  const g = await gate(root, "uses-fake.js");
  check("gate fails on hallucinated import", !g.ok && /does not exist/.test(g.msg), JSON.stringify(g));
  fs.writeFileSync(path.join(root, "uses-real.js"), "const x = require('realpkg-abc');\nconsole.log(x);\n");
  const g2 = await gate(root, "uses-real.js");
  check("gate passes real import", g2.ok === true, JSON.stringify(g2));
  delete process.env.ETA_PKG_REGISTRY;
  reg.close();
}

// ---------------- workspace ingestion ----------------
// ---------------- quality loop: re-review, honest review warnings, finish nudge ----------------
async function testQualityLoop() {
  section("units: test-command auto-detect (test agent)");
  const troot = fresh("tdetect");
  check("no tests → null", (await detectTestCmd(troot)) === null);
  fs.writeFileSync(path.join(troot, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  check("npm placeholder test script ignored", (await detectTestCmd(troot)) === null);
  fs.writeFileSync(path.join(troot, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
  check("real npm test script detected", (await detectTestCmd(troot)) === "npm test --silent");
  fs.rmSync(path.join(troot, "package.json"));
  fs.writeFileSync(path.join(troot, "test_x.py"), "");
  check("python test files detected", /unittest/.test(String(await detectTestCmd(troot))));

  section("integration: NEEDS_WORK fixes are RE-reviewed before landing");
  let root = fresh("int-q1");
  let events = await runEngine(root, {
    task: "make lib.js",
    actions: [
      { tool: "write_file", args: { path: "lib.js" } },
      { tool: "finish", args: { summary: "done" } },
      { tool: "write_file", args: { path: "lib.js" } }, // reviewer fix round
      { tool: "finish", args: { summary: "fixed" } },
    ],
    contents: ["var a = 1;\n", "module.exports = { a: 2 };\n"],
    reviews: ["NEEDS_WORK\n- the plan requires lib.js to export something", "APPROVED"],
  });
  let reviews = events.filter((e) => e.type === "review");
  let done = events.find((e) => e.type === "done");
  check("fix round is re-reviewed (2 review events)", reviews.length === 2, JSON.stringify(reviews.map((r) => r.approved)));
  check("second review approves the fix", reviews[1]?.approved === true);
  check("no reviewer warning once approved", !!done && !(done.warnings || []).some((w) => /reviewer/i.test(w)), JSON.stringify(done?.warnings));

  section("integration: unresolved review feedback surfaces in done-warnings");
  root = fresh("int-q2");
  events = await runEngine(root, {
    task: "make lib.js",
    actions: [
      { tool: "write_file", args: { path: "lib.js" } },
      { tool: "finish", args: { summary: "done" } },
      { tool: "write_file", args: { path: "lib.js" } },
      { tool: "finish", args: { summary: "fixed" } },
    ],
    contents: ["var a = 1;\n", "var a = 2;\n"],
    reviews: ["NEEDS_WORK\n- missing export", "NEEDS_WORK\n- still missing the export"],
  });
  done = events.find((e) => e.type === "done");
  check("reviewer still unsatisfied → honest warning", !!done && (done.warnings || []).some((w) => /reviewer still unsatisfied/.test(w) && /export/.test(w)), JSON.stringify(done?.warnings));
  check("bounded at maxReviews (2 reviews, no third round)", events.filter((e) => e.type === "review").length === 2);

  section("integration: clean verification nudges finish (anti step-cap polishing)");
  root = fresh("int-q3");
  const script = {
    task: "make lib.js and verify it",
    actions: [
      { tool: "write_file", args: { path: "lib.js" } },
      { tool: "run_command", args: { command: "node lib.js" } },
      { tool: "finish", args: { summary: "done" } },
    ],
    contents: ["console.log('ok');\n"],
    seen: [],
  };
  events = await runEngine(root, script);
  check("verified-success result carries the finish nudge", script.seen.some((s) => /call finish NOW/.test(s)), script.seen.slice(-1)[0]?.slice(0, 120));
  const failScript = {
    task: "run a failing command",
    actions: [
      { tool: "write_file", args: { path: "x.js" } },
      { tool: "run_command", args: { command: `node -e "process.exit(1)"` } },
      { tool: "finish", args: { summary: "done" } },
      { tool: "finish", args: { summary: "done2" } },
      { tool: "finish", args: { summary: "done3" } },
    ],
    contents: ["var ok = true;\n"],
    seen: [],
  };
  await runEngine(fresh("int-q3b"), failScript);
  check("failed command never nudges finish", !failScript.seen.some((s) => /call finish NOW/.test(s)));
}

// ---------------- test gate: project tests must pass before review ----------------
async function testTestGate() {
  section("integration: test gate — tests created by the run must pass (fix round)");
  const root = fresh("int-q4");
  const failing = "import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 2)\nif __name__ == '__main__':\n    unittest.main()\n";
  const fixed = failing.replace("self.assertEqual(1, 2)", "self.assertEqual(1, 1)");
  const events = await runEngine(root, {
    task: "add a tested python module",
    actions: [
      { tool: "write_file", args: { path: "test_calc.py" } },
      { tool: "finish", args: { summary: "done" } },
      // --- test-gate fix round ---
      { tool: "write_file", args: { path: "test_calc.py" } },
      { tool: "run_command", args: { command: 'python -m unittest discover -p "test*.py"' } },
      { tool: "finish", args: { summary: "fixed" } },
    ],
    contents: [failing, fixed],
  });
  const logs = events.filter((e) => e.type === "log").map((e) => e.text || "");
  const done = events.find((e) => e.type === "done");
  check("test gate ran and caught the failing suite", logs.some((t) => /test gate: .* FAIL/.test(t)), JSON.stringify(logs.filter((t) => /test/.test(t))));
  check("test gate re-ran green after the fix round", logs.some((t) => /test gate: .* PASS/.test(t)));
  check("test-gate agent event emitted (regression role)", events.some((e) => e.type === "agent" && e.role === "regression"));
  check("no failing-command warning once the suite passes", !!done && !(done.warnings || []).some((w) => /command still failing/.test(w)), JSON.stringify(done?.warnings));

  section("integration: pre-existing test failures are not charged to the run");
  const root2 = fresh("int-q5");
  fs.writeFileSync(path.join(root2, "test_old.py"), failing); // suite already red BEFORE the run
  const events2 = await runEngine(root2, {
    task: "add util.py",
    actions: [
      { tool: "write_file", args: { path: "util.py" } },
      { tool: "finish", args: { summary: "done" } },
    ],
    contents: ["def add(a, b):\n    return a + b\n"],
  });
  const logs2 = events2.filter((e) => e.type === "log").map((e) => e.text || "");
  const done2 = events2.find((e) => e.type === "done");
  check("baseline detected as pre-existing FAIL", logs2.some((t) => /test baseline: .* FAIL \(pre-existing\)/.test(t)), JSON.stringify(logs2.filter((t) => /test/.test(t))));
  check("gate skipped honestly, not enforced", logs2.some((t) => /test gate: skipped/.test(t)));
  check("run finishes without test debt", !!done2 && !(done2.warnings || []).some((w) => /command still failing/.test(w)), JSON.stringify(done2?.warnings));
}

// ---------------- browser click-probe (live headless, best-effort) ----------------
async function testClickProbe() {
  section("browser click-probe: click-time errors caught (live headless)");
  const root = fresh("probe");
  fs.writeFileSync(path.join(root, "broken.html"),
    "<!doctype html><html><body><h1>Probe</h1><input type='text'><button onclick='notDefinedFn()'>Do it</button></body></html>");
  try {
    const r = await checkPage(root, "broken.html");
    check("click-probe catches undefined handler", !r.ok && r.errors.some((e) => /on click/.test(e) && /notDefinedFn/.test(e)), JSON.stringify(r.errors));
  } catch (e) {
    console.log("  INFO  no local Chromium — click-probe live test skipped: " + String(e.message || e).slice(0, 80));
  }
}

// ---------------- main ----------------
(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  await testUnits();
  await testRequireDotSlash();
  await testCircuitBreaker();
  await testEntityRepair();
  await testByomOpenAI();
  await testPackageGuard();
  await testQualityLoop();
  await testTestGate();
  await testClickProbe();
  console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(fail ? 1 : 0);
})();
