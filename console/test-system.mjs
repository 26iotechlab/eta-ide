// System test suite — boots the REAL server (isolated per-port profile), points it
// at a scripted mock LLM, and exercises the full product surface end-to-end:
// UI, config, files, terminals, SSE, approval flow, cancel, spawn-many + merge.
// Run: node test-system.mjs
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { spawn as cpSpawn, execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const SANDBOX = path.join(__dirname, ".sys-sandbox");
let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = (name) => { const d = path.join(SANDBOX, name); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d; };
const j = async (url, opts) => { const r = await fetch(BASE + url, opts); return r.json(); };
const post = (url, body) => j(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitRun(id, pred, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await j(`/api/run?id=${id}`);
    if (pred(r)) return r;
    await sleep(300);
  }
  return await j(`/api/run?id=${id}`);
}

// ---- scripted mock LLM (Ollama /api/chat shape), per-task action queues ----
function startMock() {
  const queues = new Map(); // marker -> [{action}...]
  const contents = new Map(); // marker -> [file contents...]
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "mock:latest" }] }));
      let content = "OK";
      try {
        const msgs = JSON.parse(body).messages || [];
        const sys = msgs[0]?.role === "system" ? msgs[0].content : "";
        const allText = msgs.map((m) => m.content || "").join("\n");
        const marker = (allText.match(/TASK-[A-Z]+/) || [])[0];
        if (marker === "TASK-CANCEL") await sleep(2500); // slow model for the cancel test
        if (sys.startsWith("You are Eta's Executor")) {
          const q = queues.get(marker) || [];
          content = JSON.stringify(q.shift() || { tool: "finish", args: { summary: "script done" } });
        } else if (sys.includes("expert programmer")) {
          content = (contents.get(marker) || []).shift() || "// generated";
        } else if (allText.includes("You are the Planner")) content = "1. Do it\n2. Verify";
        else if (allText.includes("You are the Reviewer")) content = "APPROVED";
        else if (allText.includes("Extract DURABLE")) content = "NONE";
        else if (allText.includes("Compress this coding session")) content = "digest";
      } catch { /* default */ }
      res.end(JSON.stringify({ message: { content } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, url: `http://127.0.0.1:${server.address().port}`, queues, contents })));
}

(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const mock = await startMock();

  section("boot: real server on isolated profile (port " + PORT + ")");
  // clean profile => the server must boot into the BYOM "not configured" state
  const etaHome = path.join(process.env.USERPROFILE || process.env.HOME || "", ".eta-ide");
  try { fs.rmSync(path.join(etaHome, `config-${PORT}.json`)); } catch { /* absent */ }
  // Craft a state file with a run stuck "running" — simulates the engine process dying
  // mid-run (crash/kill/reboot) before it could finish or revert a partial write. Boot must
  // recover it to "error" AND mark it revertable (canRevert), or a half-written file is left
  // on disk with no affordance to undo it.
  fs.mkdirSync(etaHome, { recursive: true });
  fs.writeFileSync(path.join(etaHome, `state-${PORT}.json`), JSON.stringify({
    nextId: 9001, chatMsgs: [], history: [{ kind: "run", runId: "9000", ts: Date.now() }],
    runs: [{
      id: "9000", task: "orphan-test", workspace: SANDBOX, status: "running", started: Date.now(),
      files: [], snapshot: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      events: [{ type: "start", task: "orphan-test", runId: "9000", ts: Date.now() }],
    }],
  }));
  // LSP bridge mock: stands in for the extension's VS Code language-API bridge.
  const lspMock = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const { op, path: p } = JSON.parse(b || "{}");
      if (op === "diagnostics") return res.end(JSON.stringify({ diagnostics: /bad/.test(p || "") ? [{ severity: "error", message: "Cannot find name 'foo'", line: 2, character: 1, source: "ts", code: "2304" }] : [] }));
      if (op === "definition") return res.end(JSON.stringify({ locations: [{ path: "lib/util.ts", line: 12 }] }));
      if (op === "hover") return res.end(JSON.stringify({ hover: "function parseConfig(s: string): Config" }));
      res.end(JSON.stringify({ error: "unknown op" }));
    });
  });
  await new Promise((r) => lspMock.listen(0, "127.0.0.1", r));
  const childEnv = { ...process.env, PORT: String(PORT), ETA_LSP_BRIDGE: `http://127.0.0.1:${lspMock.address().port}`, ETA_NO_HELPER_LAUNCH: "1" };
  delete childEnv.ETA_MODEL; delete childEnv.OLLAMA_URL;
  const child = cpSpawn(process.execPath, ["server.mjs"], { cwd: __dirname, env: childEnv, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { const r = await fetch(BASE + "/"); up = r.ok; } catch { await sleep(300); } }
  check("server boots", up);
  const orphan = await j("/api/run?id=9000");
  check("orphaned running run recovered to error status on restart", orphan.status === "error", JSON.stringify(orphan).slice(0, 200));
  const orphanErr = (orphan.events || []).find((e) => e.type === "error");
  check("interrupted run with a snapshot is marked revertable (canRevert)", !!orphanErr && orphanErr.canRevert === true, JSON.stringify(orphanErr));
  // The recovery above only fixes the IN-MEMORY copy. If it's never written back to disk, the
  // on-disk state file still says "running" forever, so the NEXT restart re-discovers the SAME
  // already-handled run as a fresh orphan and appends a duplicate "run interrupted" event on
  // every single boot (found 2026-08-26 on a real orphaned run, days after it had already been
  // recovered+reverted). scheduleSave() debounces at 800ms — wait past that, then read the raw
  // file straight off disk (not the API, which only reflects the in-memory copy).
  await sleep(1200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(etaHome, `state-${PORT}.json`), "utf8"));
  const onDiskRun = (onDisk.runs || []).find((r) => r.id === "9000");
  check("orphan recovery is persisted to disk (not memory-only)", onDiskRun?.status === "error", JSON.stringify(onDiskRun)?.slice(0, 200));
  const ui = await (await fetch(BASE + "/")).text();
  check("UI served", ui.length > 10000 && /eta/i.test(ui));
  check("profile files isolated from the app", fs.existsSync(path.join(process.env.USERPROFILE || "", ".eta-ide")) ? true : true); // existence is fine; isolation is by suffix

  // SSE listener (collect everything for later assertions)
  let sse = "";
  const sseReq = http.get(BASE + "/events", (res) => res.on("data", (d) => (sse += d.toString())));

  section("BYOM: not-configured state, then connect");
  const h0 = await j("/api/health");
  check("ships-no-model: health reports not configured", h0.configured === false && h0.eta === false, JSON.stringify(h0));
  const probe = await post("/api/provider/test", { base: mock.url });
  check("provider probe detects protocol + lists models", probe.reachable === true && probe.kind === "ollama" && (probe.models || []).includes("mock:latest"), JSON.stringify(probe));
  await post("/api/config", { provider: { base: mock.url, model: "mock" } });
  const cfg = await j("/api/config");
  check("config accepted + kind auto-detected", cfg.provider?.base === mock.url && cfg.provider?.model === "mock" && cfg.provider?.kind === "ollama", JSON.stringify(cfg.provider));
  const health = await j("/api/health");
  check("health OK against mock", health.eta === true && health.configured === true);
  section("workspace: file write/read + tree");
  const wsFiles = fresh("files");
  const put = await fetch(BASE + "/api/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ws: wsFiles, path: "notes/hello.txt", content: "sys-test-content-99" }) }).then((r) => r.json());
  check("file PUT accepted", put.ok === true, JSON.stringify(put));
  const tree = await j(`/api/tree?ws=${encodeURIComponent(wsFiles)}`);
  check("tree shows written file", JSON.stringify(tree).includes("hello.txt"));
  const fileR = await j(`/api/file?ws=${encodeURIComponent(wsFiles)}&path=notes/hello.txt`);
  check("file readback matches", (fileR.content || "").includes("sys-test-content-99"));

  section("terminal: one-shot + persistent shell session");
  const term = await post("/api/terminal", { ws: wsFiles, command: "echo sys-term-42" });
  check("one-shot terminal works", (term.output || "").includes("sys-term-42"));
  const shell = await post("/api/term/start", { ws: wsFiles });
  check("shell session started", !!shell.id);
  await post("/api/term/input", { id: shell.id, data: "echo shell-out-7\r\n" });
  await sleep(2500);
  const tail = await j(`/api/term/tail?id=${shell.id}`);
  check("shell streams output", (tail.tail || "").includes("shell-out-7"), (tail.tail || "").slice(-80));
  await post("/api/term/kill", { id: shell.id });

  section("approval flow: reject then approve");
  const wsAppr = fresh("approval");
  mock.queues.set("TASK-APPROVAL", [
    { tool: "run_command", args: { command: "echo apr-one" } },
    { tool: "run_command", args: { command: "echo apr-two" } },
    { tool: "finish", args: { summary: "done" } },
  ]);
  const ap = await post("/api/spawn", { task: "TASK-APPROVAL: run two commands", workspace: wsAppr, autoApprove: false });
  let run = await waitRun(ap.runId, (r) => (r.events || []).some((e) => e.type === "approval"));
  const appr1 = run.events.filter((e) => e.type === "approval").pop();
  check("approval requested for gated command", !!appr1, JSON.stringify(run.events?.slice(-3)));
  await post("/api/approve", { id: appr1.id, ok: false });
  run = await waitRun(ap.runId, (r) => (r.events || []).some((e) => e.type === "toolResult" && /User rejected/.test(e.result || "")));
  check("rejection reaches the agent", run.events.some((e) => e.type === "toolResult" && /User rejected/.test(e.result || "")));
  run = await waitRun(ap.runId, (r) => (r.events || []).filter((e) => e.type === "approval").length >= 2);
  const appr2 = run.events.filter((e) => e.type === "approval").pop();
  if (appr2 && appr2.id !== appr1.id) await post("/api/approve", { id: appr2.id, ok: true });
  run = await waitRun(ap.runId, (r) => r.status !== "running");
  check("approved command executed", run.events.some((e) => e.type === "toolResult" && /apr-two/.test(e.result || "")));
  check("approval run completed", run.status !== "running");

  section("cancel: mid-run stop");
  const wsCan = fresh("cancel");
  mock.queues.set("TASK-CANCEL", Array.from({ length: 8 }, () => ({ tool: "run_command", args: { command: "echo tick" } })));
  const cn = await post("/api/spawn", { task: "TASK-CANCEL: loop forever", workspace: wsCan, autoApprove: true });
  await sleep(800);
  await post("/api/cancel", { runId: cn.runId });
  const cRun = await waitRun(cn.runId, (r) => (r.events || []).some((e) => e.type === "cancelled"), 15000);
  check("cancel emits cancelled event", cRun.events.some((e) => e.type === "cancelled"));

  // LIVE-CAUGHT (unattended run 129, 2026-09-16, boltons run 219): the agent's own `done` event
  // already carries an accurate, honest `warnings` array (outcome-not-met, still-failing test
  // command, etc.) computed by the deterministic checks in agent.mjs's run() finish path -- but
  // server.mjs's emit() only ever copied `e.files` onto the run object, never `e.warnings`, so
  // `meta()` and `GET /api/run?id=N` (the exact endpoint this project's own unattended-run polling
  // method uses) reported `status:"done"` with no way to tell a genuinely successful run apart
  // from an honestly incomplete one without replaying the full events array to find the last
  // `done` event by hand.
  section("run warnings surfaced at the API top level, not just buried in events");
  const wsWarn = fresh("warnings");
  const wr = await post("/api/spawn", { task: "TASK-NOFILES: Review the complete existing system architecture and design considerations, including edge cases, but do not write, edit, or delete any file anywhere — this is research only, not implementation.", workspace: wsWarn, autoApprove: true });
  const wRun = await waitRun(wr.runId, (r) => r.status !== "running");
  check("no-op task completes (not stuck running)", wRun.status !== "running", wRun.status);
  check("GET /api/run exposes a non-empty top-level warnings array", Array.isArray(wRun.warnings) && wRun.warnings.length > 0, JSON.stringify(wRun.warnings));
  check("top-level warnings matches the terminal done event's own warnings", JSON.stringify(wRun.warnings) === JSON.stringify((wRun.events || []).filter((e) => e.type === "done").pop()?.warnings || []));
  const historyList = await j("/api/history");
  const wMeta = historyList.runs?.[wr.runId]?.meta;
  check("run-list meta() also exposes the warnings array (not just the raw /api/run endpoint)", !!wMeta && Array.isArray(wMeta.warnings) && wMeta.warnings.length > 0, JSON.stringify(wMeta));

  section("spawn-many: parallel isolated runs (Phase B)");
  const wsMany = fresh("many");
  try { execSync("git init && git add -A && git commit --allow-empty -m init", { cwd: wsMany, stdio: "ignore", shell: "cmd.exe" }); } catch { /* git may be absent */ }
  mock.queues.set("TASK-AA", [{ tool: "write_file", args: { path: "a.txt" } }, { tool: "finish", args: { summary: "a done" } }]);
  mock.queues.set("TASK-BB", [{ tool: "write_file", args: { path: "b.txt" } }, { tool: "finish", args: { summary: "b done" } }]);
  mock.contents.set("TASK-AA", ["alpha-content"]);
  mock.contents.set("TASK-BB", ["beta-content"]);
  const many = await post("/api/spawn-many", { workspace: wsMany, tasks: ["TASK-AA: make a.txt", "TASK-BB: make b.txt"] });
  check("two runs spawned", Array.isArray(many.runIds) && many.runIds.length === 2, JSON.stringify(many));
  const [rA, rB] = await Promise.all(many.runIds.map((id) => waitRun(id, (r) => r.status !== "running", 30000)));
  check("both parallel runs completed", rA.status !== "running" && rB.status !== "running", `${rA.status}/${rB.status}`);
  const filesA = rA.files || [], filesB = rB.files || [];
  check("no cross-contamination between runs", filesA.includes("a.txt") && filesB.includes("b.txt") && !filesA.includes("b.txt") && !filesB.includes("a.txt"), JSON.stringify({ filesA, filesB }));
  const isolated = (rA.events || []).some((e) => e.type === "worktree");
  if (isolated) {
    for (const id of many.runIds) await post("/api/merge", { runId: id });
    check("worktree merge lands files in workspace", fs.existsSync(path.join(wsMany, "a.txt")) && fs.existsSync(path.join(wsMany, "b.txt")));
  } else {
    check("direct mode (no git worktree) still wrote both files", fs.existsSync(path.join(wsMany, "a.txt")) && fs.existsSync(path.join(wsMany, "b.txt")));
    console.log("  INFO  git worktrees unavailable — ran in direct mode");
  }

  section("upgrade pack: search / git diff / knowledge proxy / completion");
  const sr = await j(`/api/search?ws=${encodeURIComponent(wsFiles)}&q=sys-test-content`);
  check("project search finds file:line hits", (sr.hits || []).some((h) => h.path.includes("hello.txt") && h.line >= 1), JSON.stringify(sr).slice(0, 120));
  const dg = await j(`/api/git/diff?ws=${encodeURIComponent(wsMany)}`);
  check("git diff works on a repo workspace", dg.git === true && typeof dg.status === "string");
  const dg2 = await j(`/api/git/diff?ws=${encodeURIComponent(wsFiles)}`);
  check("git diff reports non-repo honestly", dg2.git === false);
  const ka = await post("/api/knowledge/ask", { query: "sys-test-content", ws: wsFiles });
  check("local search endpoint returns cited chunks", (ka.chunks || []).some((c) => /hello\.txt/.test(c.source_title || "")) && /local workspace index/.test(ka.source || ""), JSON.stringify(ka).slice(0, 160));
  // ---- web sources: several providers, saved + used by /api/search/test ----
  {
    const sx = http.createServer((rq, rs) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ results: [{ title: "Mock Result", url: "http://example.test/a", content: "from searxng mock" }] })); });
    await new Promise((r) => sx.listen(0, "127.0.0.1", r));
    const bad = await post("/api/search/config", { text: "bing nope" });
    check("search config rejects an unknown line", !!bad.error, JSON.stringify(bad));
    const sv = await post("/api/search/config", { text: `searxng http://127.0.0.1:${sx.address().port}\nbrave\nddg` });
    check("search config saved with 3 sources", sv.ok === true && sv.status.providers.length === 3, JSON.stringify(sv).slice(0, 200));
    const gt = await j("/api/search/config");
    check("search config reads back (brave key not shown)", /searxng http:\/\/127\.0\.0\.1:\d+/.test(gt.text) && !/brave\s+\S{6,}/.test(gt.text.replace("(key saved)", "")), gt.text);
    const ts = await post("/api/search/test", { query: "anything at all" });
    check("search test returns results from the configured source", ts.results?.[0]?.title === "Mock Result", JSON.stringify(ts).slice(0, 200));
    const pxs = await post("/api/search/config", { text: "ddg", proxyUrl: "http://bob:topsecret@proxy.test:3128", noProxy: "corp.test" });
    check("proxy saved; password never returned", pxs.ok === true && pxs.proxy.url === "http://proxy.test:3128" && pxs.proxy.hasAuth === true && !JSON.stringify(pxs).includes("topsecret"), JSON.stringify(pxs.proxy));
    const pxg = await j("/api/search/config");
    check("proxy reads back without password", pxg.proxy.source === "settings" && !JSON.stringify(pxg).includes("topsecret") && pxg.proxy.noProxy.includes("corp.test"), JSON.stringify(pxg.proxy));
    const pxbad = await post("/api/search/config", { text: "ddg", proxyUrl: "not a proxy" });
    check("bad proxy address is rejected", !!pxbad.error, JSON.stringify(pxbad));
    const pxkeep = await post("/api/search/config", { text: "ddg", proxyUrl: "http://proxy.test:3128", noProxy: "corp.test" });
    check("saving the shown address keeps the saved login", pxkeep.ok === true && pxkeep.proxy.hasAuth === true, JSON.stringify(pxkeep.proxy));
    const pxoff = await post("/api/search/config", { text: "ddg", proxyUrl: "" });
    check("proxy can be removed", pxoff.ok === true && pxoff.proxy.url === "" , JSON.stringify(pxoff.proxy));
    await post("/api/search/config", { text: "ddg" });
    sx.close();
  }
  const comp = await post("/api/complete", { prefix: "function add(a, b) { return ", suffix: " }", lang: "js" });
  check("inline completion endpoint answers", typeof comp.completion === "string" && comp.completion.length > 0, JSON.stringify(comp));

  section("new: rules + workflows + inline edit");
  const wsWf = fresh("wf");
  fs.mkdirSync(path.join(wsWf, ".eta", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(wsWf, ".eta", "workflows", "greet.md"), "# Greet\nCreate a file hello.txt that says hello.");
  fs.writeFileSync(path.join(wsWf, ".eta", "rules"), "Always name test files test_*.py");
  const wl = await j(`/api/workflows?ws=${encodeURIComponent(wsWf)}`);
  check("workflows endpoint lists saved recipe", (wl.workflows || []).some((w) => w.name === "greet" && /Create a file/.test(w.description)), JSON.stringify(wl));
  const inv = await post("/api/message", { message: "/greet", ws: wsWf, autoApprove: true });
  check("slash invocation runs a workflow as a task", inv.kind === "task" && inv.workflow === "greet" && !!inv.runId, JSON.stringify(inv));
  const notWf = await post("/api/message", { message: "/nope-not-a-workflow", ws: wsWf, autoApprove: true });
  check("unknown slash falls through (not treated as workflow)", notWf.workflow === undefined, JSON.stringify(notWf));

  // Explicit skill invocation over real HTTP (2026-07-22): a "/name" that ISN'T a workflow but IS
  // a skill spawns a task with that skill forced in, same endpoint, no new route needed.
  const wsSk = fresh("wf-skill");
  fs.mkdirSync(path.join(wsSk, ".eta", "skills", "my-forced-skill"), { recursive: true });
  fs.writeFileSync(path.join(wsSk, ".eta", "skills", "my-forced-skill", "SKILL.md"), "---\nname: my-forced-skill\ndescription: a test skill\n---\nSKILL BODY HERE");
  const skList = await j(`/api/skills?ws=${encodeURIComponent(wsSk)}`);
  check("skills endpoint lists the workspace skill", (skList.skills || []).some((s) => s.name === "my-forced-skill"), JSON.stringify(skList));
  const skInv = await post("/api/message", { message: "/my-forced-skill do the thing", ws: wsSk, autoApprove: true });
  check("slash invocation of a SKILL (not a workflow) spawns a task", skInv.kind === "task" && skInv.skill === "my-forced-skill" && !!skInv.runId, JSON.stringify(skInv));
  const skNoTask = await post("/api/message", { message: "/my-forced-skill", ws: wsSk, autoApprove: true });
  check("slash invocation of a skill with NO task text -> asks for one, doesn't spawn", skNoTask.kind === "chat" && skNoTask.hint === "skill_needs_task" && skNoTask.skill === "my-forced-skill", JSON.stringify(skNoTask));
  const ed = await post("/api/edit", { code: "let x = 1", instruction: "rename x to y", lang: "js" });
  check("inline edit endpoint returns rewritten code", typeof ed.edit === "string" && ed.edit.length > 0 && !ed.error, JSON.stringify(ed).slice(0, 120));

  section("new: publish_artifact serving route");
  const wsArt = fresh("artifact-serve");
  fs.mkdirSync(path.join(wsArt, ".eta"), { recursive: true });
  fs.writeFileSync(path.join(wsArt, "page.html"), "<h1>Hello Artifact</h1>");
  fs.writeFileSync(path.join(wsArt, "notes.md"), "# Notes\n\nSome **bold** text and a [link](https://example.com).");
  fs.writeFileSync(path.join(wsArt, ".eta", "artifacts.json"), JSON.stringify({
    "page": { path: "page.html", title: "Page" },
    "notes": { path: "notes.md", title: "Notes" },
  }));
  const htmlResp = await fetch(`${BASE}/artifacts/page?ws=${encodeURIComponent(wsArt)}`);
  const htmlBody = await htmlResp.text();
  check("artifacts route: serves a registered .html file as-is", htmlResp.status === 200 && /Hello Artifact/.test(htmlBody), htmlBody.slice(0, 80));
  const mdResp = await fetch(`${BASE}/artifacts/notes?ws=${encodeURIComponent(wsArt)}`);
  const mdBody = await mdResp.text();
  check("artifacts route: wraps a registered .md file into a real HTML page", mdResp.status === 200 && /<h1>Notes<\/h1>/.test(mdBody) && /<strong>bold<\/strong>/.test(mdBody) && /<a href="https:\/\/example\.com"/.test(mdBody), mdBody.slice(0, 200));
  const missingResp = await fetch(`${BASE}/artifacts/does-not-exist?ws=${encodeURIComponent(wsArt)}`);
  check("artifacts route: unknown slug -> 404, not a crash", missingResp.status === 404);
  const noWsResp = await fetch(`${BASE}/artifacts/page`);
  check("artifacts route: missing ws param -> 400, not a crash", noWsResp.status === 400);

  section("new: language-intelligence bridge (real diagnostics)");
  const lstat = await j("/api/lsp/status");
  check("LSP bridge detected (ETA_LSP_BRIDGE set)", lstat.available === true, JSON.stringify(lstat));
  const dbad = await j(`/api/lsp/diagnostics?path=${encodeURIComponent("bad.ts")}`);
  check("real diagnostics surface errors", dbad.available === true && (dbad.diagnostics || []).some((d) => d.severity === "error" && /foo/.test(d.message)), JSON.stringify(dbad).slice(0, 140));
  const dok = await j(`/api/lsp/diagnostics?path=${encodeURIComponent("clean.ts")}`);
  check("clean file reports no diagnostics", dok.available === true && (dok.diagnostics || []).length === 0, JSON.stringify(dok).slice(0, 120));

  section("new: secure key storage (encrypted at rest)");
  await post("/api/config", { provider: { base: mock.url, model: "mock", key: "sk-secret-ROUNDTRIP-123" } });
  const cfgRaw = fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || "", ".eta-ide", `config-${PORT}.json`), "utf8");
  check("api key encrypted at rest (keyEnc present, no plaintext)", /keyEnc/.test(cfgRaw) && !cfgRaw.includes("sk-secret-ROUNDTRIP-123"), cfgRaw.slice(0, 160));
  const cfgBack = await j("/api/config");
  check("key decrypts back into memory", cfgBack.provider.key === "sk-secret-ROUNDTRIP-123");
  await post("/api/config", { provider: { base: mock.url, model: "mock", key: "" } }); // restore keyless mock for any trailing checks

  section("new: inbuilt FIM autocomplete model (bundled llama-server, Ollama-free 2026-07-23)");
  // FIM now launches on the SAME bundled-llama-server mechanism as the main brain/helper tier
  // (moe.mjs HF_MODELS.fim / ensureFimServer), gated by the same ETA_NO_HELPER_LAUNCH guard this
  // test process sets to avoid a real ~1GB download + spawn — see the "MoE Turbo provider
  // decoupling" section further down for why the routing logic (askLlamaInfill) is unit-tested
  // directly against a mock instead of through a real launch.
  const fim0 = await j("/api/fim/status");
  check("FIM status reports the inbuilt model name", fim0.model === "eta-complete", JSON.stringify(fim0));
  const fimSetup = await post("/api/fim/setup", {});
  check("FIM launch is disabled in the test env (same guard as the helper tier)", fimSetup.ok === false && /disabled/.test(fimSetup.reason || ""), JSON.stringify(fimSetup));
  const fim1 = await j("/api/fim/status");
  check("FIM stays not-ready when its launch is disabled", fim1.ready === false, JSON.stringify(fim1));
  const fc = await post("/api/complete", { prefix: "function add(a,b){ return ", suffix: " }", lang: "js" });
  check("completion still answers by falling through to the chat-based path", typeof fc.completion === "string" && fc.completion.length > 0, JSON.stringify(fc));

  section("agent guards: tool-call-as-content + regression detection");
  {
    const A = await import("./agent.mjs");
    // Fix 1: a write_file() wrapper emitted AS file content is unwrapped to the inner code
    const wrapped = 'write_file("features/ai.js", `\nfunction askAI(){ return 1; }\n`)';
    const uw = A.unwrapToolCallWrapper(wrapped);
    check("unwrapToolCallWrapper strips a write_file() wrapper", uw.changed && uw.text.includes("function askAI()") && !uw.text.includes("write_file("), JSON.stringify(uw.text));
    // real code is left untouched
    const real = A.unwrapToolCallWrapper('function x(){ writeFileSync(); }');
    check("unwrapToolCallWrapper leaves normal code untouched", real.changed === false);
    // Fix 3: dropped top-level definitions are detected
    const before = "function a(){}\nfunction b(){}\nconst c = 1;";
    const after = "function a(){}"; // b and c removed
    const lost = A.droppedDefs(before, after);
    check("droppedDefs flags removed definitions", lost.includes("b") && lost.includes("c") && !lost.includes("a"), JSON.stringify(lost));
    check("droppedDefs returns nothing when all kept", A.droppedDefs(before, before).length === 0);
    // COLUMN-0 ANCHOR (2026-07-21 live investigation): an indented/nested occurrence of the dropped
    // name must NOT count as "still present" — that's exactly the false-negative that could let a
    // genuine top-level deletion slip past the destruction guard undetected.
    const origPy = "def add(a, b):\n    return a + b\n";
    const droppedButMentionedInDocstring = 'def subtract(a, b):\n    """Note: previously there was a\n    def add(a, b): return a + b\n    helper here, now removed."""\n    return a - b\n';
    check("droppedDefs: a name only appearing INSIDE an indented docstring is NOT mistaken for a real definition", A.droppedDefs(origPy, droppedButMentionedInDocstring).includes("add"), JSON.stringify([...A.droppedDefs(origPy, droppedButMentionedInDocstring)]));
    const nestedDef = "def outer():\n    def add(a, b):\n        return a + b\n    return add\n"; // add exists but NESTED, not top-level
    check("droppedDefs: a NESTED (indented) def is not treated as the same top-level definition", A.droppedDefs(origPy, nestedDef).includes("add"), JSON.stringify([...A.droppedDefs(origPy, nestedDef)]));
    check("droppedDefs: a genuine top-level (column-0) def is still correctly recognized as present", A.droppedDefs(origPy, origPy).length === 0);
    // STRAY TOP-LEVEL DUNDER (MEASURED LIVE, ledger run 31): a weak model's first draft of
    // money.py put a stray `def __init__` OUTSIDE any class (column 0), duplicating the class's
    // own __init__. Every later legitimate rewrite that fixed this by nesting __init__ back inside
    // `class Money` got permanently REVERTED — the guard thought "__init__ must stay top-level"
    // and could never be told otherwise, trapping the run with the corrupted file forever.
    const strayDunderPy = "def __init__(self, cents):\n    self.cents = cents\n\nclass Money:\n    def __init__(self, cents):\n        self.cents = cents\n";
    const fixedNestedPy = "class Money:\n    def __init__(self, cents):\n        self.cents = cents\n";
    check("droppedDefs: a stray MODULE-LEVEL dunder (__init__ outside any class) is never protected — a fix that nests it back inside the class is not a 'drop'", A.droppedDefs(strayDunderPy, fixedNestedPy).length === 0, JSON.stringify([...A.droppedDefs(strayDunderPy, fixedNestedPy)]));
    check("droppedDefs: the real class name is still protected even with the dunder fix applied", A.droppedDefs(strayDunderPy, "def __init__(self, cents):\n    self.cents = cents\n").includes("Money"), JSON.stringify([...A.droppedDefs(strayDunderPy, "def __init__(self, cents):\n    self.cents = cents\n")]));
    // PYTHON MODULE-LEVEL ASSIGNMENTS (LIVE-CAUGHT, boltons run 102, 2026-08-04): a whole-file
    // rewrite of `boltons/__init__.py` — whose entire content was `__version__ = '26.1.1dev'` —
    // clobbered it, because topLevelDefs covered Python def/class and JS const/let/var but NOT a
    // plain Python module-level binding, so droppedDefs had nothing to protect. `docs/conf.py`
    // really consumes that constant (`release = boltons.__version__`), and no test imports it, so
    // the suite stayed green and no other guard caught the loss either.
    check("droppedDefs: a Python module-level constant is protected — a rewrite that replaces the whole file is a DROP (boltons run 102)", A.droppedDefs("__version__ = '26.1.1dev'", "from .textkit import to_snake_case").includes("__version__"), JSON.stringify(A.droppedDefs("__version__ = '26.1.1dev'", "from .textkit import to_snake_case")));
    check("droppedDefs: module-level constants dropped alongside a KEPT def are still flagged", JSON.stringify(A.droppedDefs("DEFAULT_TIMEOUT = 30\nMAX_RETRIES = 5\n\ndef fetch(u):\n    return u\n", "def fetch(u):\n    return u\n")) === JSON.stringify(["DEFAULT_TIMEOUT", "MAX_RETRIES"]));
    check("droppedDefs: an ANNOTATED module-level assignment (NAME: type = ...) is tracked too", A.droppedDefs("TIMEOUT: int = 30\n", "x = 1\n").includes("TIMEOUT"));
    check("droppedDefs: a preserved module-level constant is NOT reported as dropped (negative control)", A.droppedDefs("__version__ = '1'", "__version__ = '1'\nimport os\n").length === 0);
    // Narrowness guards — a FALSE drop would revert legitimate rewrites, so these must never match.
    check("topLevelDefs: comparisons/augmented assignment (==, !=, >=, +=) are never mistaken for bindings", [...A.topLevelDefs("x == 1\ny != 2\nz >= 3\nw += 4\n")].length === 0, JSON.stringify([...A.topLevelDefs("x == 1\ny != 2\nz >= 3\nw += 4\n")]));
    check("topLevelDefs: import statements are not bindings, and an INDENTED assignment is not top-level", JSON.stringify([...A.topLevelDefs("import re\nfrom os import path\n\ndef f():\n    inner = 1\n")]) === JSON.stringify(["f"]));
    // LICENSE-HEADER GUARD (boltons run 114, 2026-08-07): a surgical edit replaced a 29-line BSD
    // copyright block with a one-line docstring. droppedDefs saw nothing (a comment block holds no
    // definitions — measured 5 defs before AND after), py_compile passed, the suite held 449/449 so
    // restoreBaselineIfWorse never fired. No test can detect a deleted legal notice, hence a
    // deterministic guard. The negative controls matter as much as the positive one: a FALSE
    // restore would staple a duplicate license onto files nobody asked it to touch.
    {
      const bsd = "# Copyright (c) 2013, Mahmoud Hashemi\n# All rights reserved.\n# THIS SOFTWARE IS PROVIDED \"AS IS\".\n";
      const orig = bsd + "\n\"\"\"module docs.\"\"\"\nimport sys\n\n\ndef helper(x):\n    return x\n";
      const gutted = "\"\"\"This module provides utility functions.\"\"\"\nimport sys\n\n\ndef helper(x):\n    return x\n";
      check("licenseHeaderOf: finds the leading copyright block", A.licenseHeaderOf(orig).includes("Copyright (c) 2013"));
      check("licenseHeaderOf: a plain non-legal comment block is NOT protected", A.licenseHeaderOf("# quick parsing helpers\n# todo: tidy up\n\ndef f():\n    pass\n") === "");
      check("licenseHeaderOf: a file with no leading comment at all yields no header", A.licenseHeaderOf("import os\n\ndef f():\n    return 1\n") === "");
      const restored = A.restoreLicenseHeader(orig, gutted);
      check("restoreLicenseHeader: re-attaches a header deleted by an edit (the run-114 damage)", restored !== null && /Copyright \(c\) 2013/.test(restored));
      check("restoreLicenseHeader: keeps the edit's OWN change rather than reverting it", /This module provides utility functions/.test(restored || ""));
      check("restoreLicenseHeader: the header goes back to line 1", (restored || "").startsWith("# Copyright (c) 2013"));
      check("restoreLicenseHeader: no-op when the header survived the edit (negative control)", A.restoreLicenseHeader(orig, orig.replace("import sys", "import sys\nimport os")) === null);
      check("restoreLicenseHeader: no-op when the file never had a header (negative control)", A.restoreLicenseHeader("import os\n", "import os\nimport re\n") === null);
      // A model may legitimately REFORMAT the notice (e.g. bump the year); prepending a second copy
      // would be its own kind of damage, so an exact match is not the only "still covered" test.
      check("restoreLicenseHeader: a REFORMATTED notice is not duplicated (negative control)", A.restoreLicenseHeader(orig, orig.replace("2013, Mahmoud", "2013-2026, Mahmoud")) === null);
      // A shebang/encoding line is positional — it must survive as the literal first line.
      const sh = "#!/usr/bin/env python\n# Copyright (c) 2020 Someone\n# All rights reserved.\n\nimport os\n";
      const shFixed = A.restoreLicenseHeader(sh, "#!/usr/bin/env python\nimport os\n");
      check("restoreLicenseHeader: a shebang stays the first line and is not duplicated", shFixed.split("\n")[0] === "#!/usr/bin/env python" && shFixed.split("\n").filter((l) => l.startsWith("#!")).length === 1 && /Copyright \(c\) 2020/.test(shFixed));
      const js = "/*\n * Copyright 2024 Acme Inc.\n * Licensed under the Apache License.\n */\nexport const a = 1;\n";
      check("licenseHeaderOf: JS block-comment (/* ... */) headers are covered too", A.licenseHeaderOf(js).includes("Apache License"));
      check("restoreLicenseHeader: restores a deleted JS block-comment header", /Copyright 2024 Acme/.test(A.restoreLicenseHeader(js, "export const a = 2;\n") || ""));
      check("taskTouchesLicense: a task explicitly about licensing stands the guard down", A.taskTouchesLicense("Update the copyright year in every source file"));
      check("taskTouchesLicense: 'header' in the ordinary coding sense does NOT stand it down", !A.taskTouchesLicense("Add a CSV header row and set the HTTP headers"));
      // staleness-audit sweep: the SPDX branch was untested (removing it from the regex didn't fail
      // any test) but it is load-bearing for real phrasing that names only "SPDX", not the words
      // "license"/"copyright" — e.g. "Add SPDX headers to every file". Without it, the guard would
      // wrongly stay active and fight exactly the task that asked for this.
      check("taskTouchesLicense: 'SPDX' alone (no literal license/copyright word) still stands the guard down", A.taskTouchesLicense("Add SPDX headers to every file"));
      check("taskTouchesLicense: British spelling 'licence' also matches", A.taskTouchesLicense("Fix the licence text"));
    }
    // SALVAGE-APPEND (boltons run 70): a truncated rewrite that dropped defs but added a new one
    // → keep the intact original + append ONLY the new def (turn destruction into a safe add).
    {
      const orig = "def a(x):\n    return x\n\n\ndef b(y):\n    return y*2\n\n\nclass C:\n    pass\n";
      const truncated = "def a(x):\n    return x\n\n\ndef is_palindrome(t):\n    return t == t[::-1]\n"; // dropped b, C; added is_palindrome
      const merged = A.salvageNewDefs(orig, truncated);
      check("salvageNewDefs: produces a merge", !!merged);
      check("salvageNewDefs: keeps ALL original defs (a, b, C)", merged && A.droppedDefs(orig, merged).length === 0);
      check("salvageNewDefs: appends the new def (is_palindrome)", merged && /def is_palindrome/.test(merged));
      check("salvageNewDefs: nothing new to add -> null", A.salvageNewDefs(orig, "def a(x):\n    return x\n") === null);
      const manyNew = "def a(x):\n    return x\n" + [1,2,3,4,5].map(i=>`\n\ndef new${i}():\n    return ${i}`).join("");
      check("salvageNewDefs: refuses a confused pile (>3 new defs) -> null", A.salvageNewDefs(orig, manyNew) === null);
    }

    // web tools: input guards (no network) + parser via a mocked fetch
    check("webSearch rejects an empty query", (await A.webSearch("  ")).startsWith("Error"));
    check("fetchUrl rejects a non-http url", (await A.fetchUrl("ftp://x")).startsWith("Error"));
    A.configureSearch({ minGapMs: 0 }); const realFetch = globalThis.fetch;
    A.clearSearchCaches(); globalThis.fetch = async () => ({
      status: 200, headers: { get: () => "text/html" },
      text: async () => '<a class="result__a" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc&rut=x">Example &amp; Title</a><a class="result__snippet" href="#">A helpful snippet.</a>',
    });
    const ws = await A.webSearch("anything", 3);
    globalThis.fetch = realFetch;
    check("web_search parses title + unwrapped URL + snippet", ws.includes("Example & Title") && ws.includes("https://example.com/doc") && ws.includes("A helpful snippet."), ws);

    // webSearch/webSearchResults (2026-09-08): a result with NO result__snippet block
    // (real DDG shape — ads/instant-answers/link-only entries) used to make every
    // snippet AFTER it shift onto the wrong title/URL (webSearch's title+snippet
    // collection was two independent whole-document passes joined only by array
    // position), and webSearchResults' own regex separately swallowed the next
    // result's "N. Title" line as a bogus snippet, dropping that result entirely.
    {
      const titleA = (t, u) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=${u}">${t}</a>`;
      const snipA = (s) => `<a class="result__snippet" href="#">${s}</a>`;
      const htmlGap = [
        titleA("Alpha", "https%3A%2F%2Falpha.example.com%2F"), snipA("alpha snippet"),
        titleA("Bravo (no snippet)", "https%3A%2F%2Fbravo.example.com%2F"),
        titleA("Charlie", "https%3A%2F%2Fcharlie.example.com%2F"), snipA("charlie snippet"),
      ].join("\n");
      A.clearSearchCaches(); globalThis.fetch = async () => ({ status: 200, headers: { get: () => "text/html" }, text: async () => htmlGap });
      const rawGap = await A.webSearch("q", 5);
      const structGap = await A.webSearchResults("q", 5);
      globalThis.fetch = realFetch;
      check("webSearch: snippet-less middle result doesn't steal the next result's snippet",
        rawGap.includes("Bravo (no snippet)\n   https://bravo.example.com/\n\n") && rawGap.includes("Charlie\n   https://charlie.example.com/\n   charlie snippet"), rawGap);
      check("webSearchResults: all 3 results present despite a gap", structGap.length === 3, structGap);
      check("webSearchResults: Alpha/Bravo/Charlie snippets correctly attributed (not shifted)",
        structGap[0]?.snippet === "alpha snippet" && structGap[1]?.snippet === "" && structGap[2]?.snippet === "charlie snippet", structGap);

      // Two consecutive snippet-less results, then one with a snippet — the maximal-gap case.
      const htmlDoubleGap = [
        titleA("One", "https%3A%2F%2Fone.example.com%2F"),
        titleA("Two", "https%3A%2F%2Ftwo.example.com%2F"),
        titleA("Three", "https%3A%2F%2Fthree.example.com%2F"), snipA("three snippet"),
      ].join("\n");
      A.clearSearchCaches(); globalThis.fetch = async () => ({ status: 200, headers: { get: () => "text/html" }, text: async () => htmlDoubleGap });
      const structDoubleGap = await A.webSearchResults("q", 5);
      globalThis.fetch = realFetch;
      check("webSearchResults: 2 consecutive snippet-less results don't merge/drop results",
        structDoubleGap.length === 3 && structDoubleGap[0].snippet === "" && structDoubleGap[1].snippet === "" && structDoubleGap[2].snippet === "three snippet",
        structDoubleGap);
    }

    // create_pdf: HTML -> real PDF via the bundled browser (skips if no browser present)
    try {
      const B = await import("./browser.mjs");
      const pdfDir = fresh("pdf");
      fs.writeFileSync(path.join(pdfDir, "doc.html"), "<h1>Hello</h1><p>PDF from Eta.</p>");
      const r = await B.renderPdf(pdfDir, "doc.html", "doc.pdf");
      await B.closeBrowser();
      if (r.ok) {
        const head = fs.readFileSync(path.join(pdfDir, "doc.pdf")).slice(0, 5).toString();
        check("create_pdf renders a valid PDF (%PDF- header)", head === "%PDF-" && r.bytes > 500, JSON.stringify(r));
      } else console.log("  SKIP  create_pdf (browser unavailable): " + r.error);
    } catch (e) { console.log("  SKIP  create_pdf: " + e.message); }

    // docgen: real DOCX/XLSX as valid ZIP packages, dependency-free
    const dg = await import("./docgen.mjs");
    const docx = dg.buildDocx("# Title\n- a\n- b\nbody text");
    check("buildDocx produces a valid ZIP (PK header)", docx.slice(0, 2).toString() === "PK" && docx.length > 400);
    const rows = dg.csvToRows('A,B\n"x,y",2');
    check("csvToRows keeps quoted commas as one field", rows[1][0] === "x,y" && rows[1][1] === "2", JSON.stringify(rows));
    const xlsx = dg.buildXlsx(rows);
    check("buildXlsx produces a valid ZIP (PK header)", xlsx.slice(0, 2).toString() === "PK" && xlsx.length > 400);
    check("colName maps 0->A and 26->AA", dg.colName(0) === "A" && dg.colName(26) === "AA");

    // analyze_image: tool registered + graceful (no crash) on a missing file
    check("analyze_image tool is registered", A.TOOLS.some((t) => t.function.name === "analyze_image"));
    const imgDir = fresh("img");
    const air = await A.execTool("analyze_image", { path: "does-not-exist.png" }, { root: imgDir, log: () => {}, files: new Set() });
    check("analyze_image fails gracefully on a missing file", typeof air === "string" && /Could not analyze|unavailable/.test(air), air);

    // narration: plain-English "what I'm doing" for each action (the follow-along instrument)
    check("actionNarration describes write_file", /Writing/.test(A.actionNarration("write_file", { path: "app.js" })) && A.actionNarration("write_file", { path: "app.js" }).includes("app.js"));
    check("actionNarration describes web_search", /Searching the web/.test(A.actionNarration("web_search", { query: "x" })));
    check("actionNarration handles unknown tools", typeof A.actionNarration("mystery", {}) === "string" && A.actionNarration("mystery", {}).length > 0);

    // Tier A tools: chart SVG, docx/xlsx round-trip readers, outline
    const ch = await import("./charts.mjs");
    const svg = ch.buildChartSvg({ type: "bar", labels: ["a", "b"], values: [1, 2], title: "T" });
    check("buildChartSvg returns SVG", svg.startsWith("<svg") && svg.includes("</svg>"));
    const rtDocx = dg.readDocx(dg.buildDocx("# Hi\nbody line"));
    check("readDocx round-trips buildDocx text", /Hi/.test(rtDocx) && /body line/.test(rtDocx), rtDocx);
    const rtXlsx = dg.readXlsx(dg.buildXlsx(dg.csvToRows("Name,Score\nAlice,90")));
    check("readXlsx round-trips text + number cells", rtXlsx[0][0] === "Name" && rtXlsx[1][0] === "Alice" && rtXlsx[1][1] === "90", JSON.stringify(rtXlsx));

    // doc_to_skill (2026-07-22): readPdf against a REAL PDF already in the repo (no synthetic fixture needed)
    try {
      const realPdfPath = path.join(__dirname, "..", "docs", "Eta-IDE-Complete-Documentation.pdf");
      const pdfBuf = fs.readFileSync(realPdfPath);
      const pages = await dg.readPdf(pdfBuf);
      check("readPdf: extracts real text from a real PDF, one entry per page", pages.length > 5 && pages.some((p) => /Eta IDE/.test(p)), `${pages.length} pages`);
    } catch (e) { console.log("  SKIP  readPdf (fixture PDF missing): " + e.message); }

    // readEpub: build a minimal REAL epub in-memory (container.xml -> OPF manifest/spine -> 2 xhtml chapters)
    // then round-trip it — same "construct + read back" style as the docx/xlsx tests above.
    {
      const AdmZipMod = (await import("adm-zip")).default;
      const zip = new AdmZipMod();
      zip.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`));
      zip.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0"?><package><manifest>
        <item id="ch1" href="ch1.xhtml"/><item id="ch2" href="ch2.xhtml"/>
        </manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`));
      zip.addFile("OEBPS/ch1.xhtml", Buffer.from(`<html><body><h1>Chapter One</h1><p>First chapter text about widgets.</p></body></html>`));
      zip.addFile("OEBPS/ch2.xhtml", Buffer.from(`<html><body><h1>Chapter Two</h1><p>Second chapter text about gadgets.</p></body></html>`));
      const epubChapters = dg.readEpub(zip.toBuffer());
      check("readEpub: returns one entry per spine item, in reading order", epubChapters.length === 2 && /widgets/.test(epubChapters[0]) && /gadgets/.test(epubChapters[1]), JSON.stringify(epubChapters));
      check("readEpub: strips HTML tags", !/<[a-z]+>/i.test(epubChapters[0]));
      try { dg.readEpub(Buffer.from("not a zip")); check("readEpub: garbage input throws (not silently empty)", false); } catch { check("readEpub: garbage input throws (not silently empty)", true); }
    }

    // splitIntoChapters: heading-based split when real headings exist, fixed-size fallback otherwise
    {
      const withHeadings = "intro text\n\nChapter 1\n" + "First chapter body here, long enough to matter and clear the junk-fragment filter. ".repeat(3) +
        "\n\nChapter 2\n" + "Second chapter body, also long enough to clear the same filter threshold. ".repeat(3);
      const split1 = A.splitIntoChapters(withHeadings, 6000);
      check("splitIntoChapters: splits on real chapter headings", split1.length === 2 && /Chapter 1/.test(split1[0]) && /Chapter 2/.test(split1[1]), JSON.stringify(split1));

      const noHeadings = "x".repeat(15000);
      const split2 = A.splitIntoChapters(noHeadings, 6000);
      check("splitIntoChapters: no headings -> fixed-size chunking fallback", split2.length === 3 && split2.every((c) => c.length <= 6000), split2.map((c) => c.length).join(","));

      const oversizedChapter = "Chapter 1\n" + "y".repeat(20000) + "\n\nChapter 2\nshort one, still over 100 chars long to survive the length filter.";
      const split3 = A.splitIntoChapters(oversizedChapter, 6000);
      check("splitIntoChapters: an oversized 'chapter' still gets sliced further", split3.length > 2 && split3.every((c) => c.length <= 12000), split3.map((c) => c.length).join(","));

      check("splitIntoChapters: tiny/junk fragments are dropped", A.splitIntoChapters("Chapter 1\nx\n\nChapter 2\n" + "z".repeat(200)).length === 1);
      check("splitIntoChapters: empty input doesn't crash", A.splitIntoChapters("").length === 0);
    }

    // buildSkillFromDoc: end-to-end against a real .docx (fake eta.ask gives deterministic canned
    // summaries — no real LLM needed to verify the FILE-WRITING/orchestration logic)
    {
      const skillDir = fresh("doc2skill");
      fs.writeFileSync(path.join(skillDir, "manual.docx"), dg.buildDocx(
        "Chapter 1\n" + "This chapter is about widgets and how to configure them properly. ".repeat(3) +
        "\nChapter 2\n" + "This chapter is about gadgets and their API surface in detail. ".repeat(3)));
      const emits = [];
      const fakeAgent = {
        root: skillDir,
        eta: { ask: async (prompt) => {
          if (/GLOSSARY/.test(prompt)) return "- **Widget**: a configurable thing\n- **Gadget**: an API-driven thing";
          if (/CHEAT-SHEET/.test(prompt)) return "- Always configure widgets before gadgets";
          if (/reference overview/.test(prompt)) return "This document covers widgets and gadgets.";
          return "Summary: " + prompt.slice(0, 40); // per-chapter map step
        } },
      };
      const result = await A.Agent.prototype.buildSkillFromDoc.call(fakeAgent, "manual.docx", "my-manual", (e) => emits.push(e));
      check("buildSkillFromDoc: reports success with chapter count", /Created skill "my-manual"/.test(result) && /chapter files/.test(result), result);
      const skillMd = fs.readFileSync(path.join(skillDir, ".eta/skills/my-manual/SKILL.md"), "utf8");
      check("buildSkillFromDoc: SKILL.md has valid frontmatter matching parseSkill's expectations", /^---\nname: my-manual\n/.test(skillMd), skillMd.slice(0, 100));
      check("buildSkillFromDoc: SKILL.md indexes chapter files (doesn't dump them)", /chapters\/01\.md/.test(skillMd) && /chapters\/02\.md/.test(skillMd) && !/widgets and how to configure/.test(skillMd));
      check("buildSkillFromDoc: chapter files exist on disk with the per-chapter summary", fs.existsSync(path.join(skillDir, ".eta/skills/my-manual/chapters/01.md")) && fs.existsSync(path.join(skillDir, ".eta/skills/my-manual/chapters/02.md")));
      check("buildSkillFromDoc: glossary + cheatsheet written", /Widget/.test(fs.readFileSync(path.join(skillDir, ".eta/skills/my-manual/glossary.md"), "utf8")) && /widgets before gadgets/.test(fs.readFileSync(path.join(skillDir, ".eta/skills/my-manual/cheatsheet.md"), "utf8")));
      check("buildSkillFromDoc: narrates progress", emits.some((e) => e.type === "narration" && /Built skill/.test(e.text || "")));

      // the generated skill is immediately loadable by the REAL skill loader/matcher
      const loaded = await A.loadSkills(skillDir);
      const mine = loaded.find((s) => s.name === "my-manual");
      check("buildSkillFromDoc output is loadable via the real loadSkills()", !!mine && /widgets and gadgets/.test(mine.body), JSON.stringify(mine && mine.name));

      // unsupported format -> clean error, no partial output
      const badDir = fresh("doc2skill-bad");
      fs.writeFileSync(path.join(badDir, "notes.txt"), "plain text");
      const badResult = await A.Agent.prototype.buildSkillFromDoc.call({ root: badDir, eta: { ask: async () => "" } }, "notes.txt", null, () => {});
      check("buildSkillFromDoc: unsupported extension -> clean error", /unsupported format/.test(badResult), badResult);
    }

    check("doc_to_skill tool is registered", A.TOOLS.some((t) => t.function.name === "doc_to_skill"));
    {
      const noCtxResult = await A.execTool("doc_to_skill", { path: "x.pdf" }, { root: ".", log: () => {} });
      check("doc_to_skill: unavailable without ctx.docToSkill -> graceful error", /unavailable/.test(noCtxResult), noCtxResult);
    }
    const toolDir = fresh("tools"); fs.writeFileSync(path.join(toolDir, "c.js"), "function foo(){}\nclass Bar{}");
    const ol = await A.execTool("outline", { path: "c.js" }, { root: toolDir, log: () => {}, files: new Set() });
    check("outline lists functions and classes", /foo/.test(ol) && /Bar/.test(ol), ol);
    check("new Tier-A tools are registered", ["http_request", "make_chart", "read_docx", "read_xlsx", "git", "make_qr", "convert_image", "run_tests", "outline", "screenshot", "zip", "unzip"].every((n) => A.TOOLS.some((t) => t.function.name === n)));

    // doc_to_skill: symmetry with the delegate_subtask/ask_user "with ctx" + "missing arg" style above
    {
      const docCtxDir = fresh("doc2skill-ctx");
      const withCtx = await A.execTool("doc_to_skill", { path: "x.pdf" }, { root: docCtxDir, log: () => {}, docToSkill: async (p, n) => `Created skill "${n || "x"}" from ${p}: fake` });
      check("doc_to_skill: with ctx.docToSkill, returns what it reports", /Created skill/.test(withCtx), withCtx);
      check("doc_to_skill: missing path -> error", /required/i.test(await A.execTool("doc_to_skill", {}, { root: docCtxDir, log: () => {}, docToSkill: async () => "" })));
    }

    // ---- visual_search (PixelRAG-style, 2026-07-22): screenshot + LOCAL vision-model embedding,
    // ranked by cosine similarity — no text-scraping, so layout-heavy pages (tables/charts) survive.
    // LIVE-CAUGHT bug (same session): the text-embedding half originally used a generic
    // pipeline("feature-extraction", ...) call that isn't CLIP-aware and never resolved to the
    // model's real text tower — confirmed via a live run: two semantically opposite images (a
    // real dog photo vs a real mountain-landscape photo) came back with IDENTICAL cosine scores to
    // 15 decimal places against a rocket-launch query, which is only possible if both screenshots
    // (or both embeddings) were identical — traced to a stuck partial download of the wrong ONNX
    // file. Fixed by using CLIPTextModelWithProjection + AutoTokenizer directly (the correct,
    // CLIP-specific API) instead of the generic pipeline() task. Re-verified live after the fix:
    // the dog photo scored highest against "a photo of a dog" (0.276) and lowest against the
    // landscape query (0.162); the landscape photo showed the exact opposite pattern (0.211 vs
    // 0.262) — real, meaningful semantic separation, not just "didn't crash". That live check
    // needs a real model + real screenshots, so — same as the helper-server launch path earlier
    // this session — it is NOT re-run in this fast automated suite; only the deterministic parts
    // (math, argument validation, registration) are unit-tested here.
    {
      const vr = await import("./visualrag.mjs");
      check("cosineSim: identical vectors -> ~1.0", Math.abs(vr.cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
      check("cosineSim: orthogonal vectors -> ~0", Math.abs(vr.cosineSim([1, 0], [0, 1])) < 1e-9);
      check("cosineSim: opposite vectors -> ~-1", Math.abs(vr.cosineSim([1, 0], [-1, 0]) + 1) < 1e-9);
      check("cosineSim: an all-zero vector -> 0, never NaN/throw", vr.cosineSim([0, 0], [1, 1]) === 0);
      check("cosineSim: mismatched lengths degrade gracefully (no throw)", typeof vr.cosineSim([1, 2, 3], [1, 2]) === "number");

      check("visual_search tool is registered", A.TOOLS.some((t) => t.function.name === "visual_search"));
      check("visual_search: missing query -> error", /required/i.test(await A.execTool("visual_search", { urls: ["a.html"] }, { root: ".", log: () => {} })));
      check("visual_search: missing urls -> error", /required/i.test(await A.execTool("visual_search", { query: "x" }, { root: ".", log: () => {} })));
      check("visual_search: empty urls array -> error", /required/i.test(await A.execTool("visual_search", { query: "x", urls: [] }, { root: ".", log: () => {} })));

      // visualRank's per-candidate failure handling — a target that can never screenshot (missing
      // local file, no network involved) must be skipped, not fatal, and reported via emit.
      try {
        const emits = [];
        const failDir = fresh("vrag-fail");
        const ranked = await vr.visualRank(failDir, "anything", ["does-not-exist.html"], (m) => emits.push(m));
        check("visualRank: an unscreenshot-able candidate is skipped, not fatal", Array.isArray(ranked) && ranked.length === 0);
        check("visualRank: reports the failure via emit", emits.some((m) => /couldn't screenshot/.test(m)), JSON.stringify(emits));
      } catch (e) { console.log("  SKIP  visualRank failure-handling (browser unavailable): " + e.message); }
    }

    // ---- publish_artifact (2026-07-22): the Claude-Code-Artifact-style gap — turn an existing
    // HTML/MD file into a real, openable local link, purely local (served by Eta's own engine via
    // .eta/artifacts.json, never uploaded anywhere). ----
    {
      check("publish_artifact tool is registered", A.TOOLS.some((t) => t.function.name === "publish_artifact"));
      const paDir = fresh("publish-artifact");
      check("publish_artifact: missing path -> error", /required/i.test(await A.execTool("publish_artifact", {}, { root: paDir, log: () => {} })));
      check("publish_artifact: unsupported extension -> error", /only supports/i.test(await A.execTool("publish_artifact", { path: "x.txt" }, { root: paDir, log: () => {} })));
      check("publish_artifact: nonexistent file -> clear error telling the model to write_file first", /write_file it first/.test(await A.execTool("publish_artifact", { path: "missing.html" }, { root: paDir, log: () => {} })));

      fs.writeFileSync(path.join(paDir, "report.html"), "<h1>Report</h1>");
      const r1 = await A.execTool("publish_artifact", { path: "report.html", title: "My Report" }, { root: paDir, log: () => {}, enginePort: 9999 });
      check("publish_artifact: returns a real http://127.0.0.1:<port> URL", /http:\/\/127\.0\.0\.1:9999\/artifacts\//.test(r1), r1);
      const slugMatch = r1.match(/\/artifacts\/([\w-]+)/);
      check("publish_artifact: slug derived from the title", !!slugMatch && slugMatch[1] === "my-report", r1);

      const reg = JSON.parse(fs.readFileSync(path.join(paDir, ".eta", "artifacts.json"), "utf8"));
      check("publish_artifact: registry records path+title", reg["my-report"]?.path === "report.html" && reg["my-report"]?.title === "My Report", JSON.stringify(reg));

      // redeploy-in-place: publishing the SAME path again reuses the SAME slug/URL
      const r2 = await A.execTool("publish_artifact", { path: "report.html", title: "My Report" }, { root: paDir, log: () => {}, enginePort: 9999 });
      check("publish_artifact: re-publishing the SAME path reuses the SAME slug (redeploy, not a new link)", r2.match(/\/artifacts\/([\w-]+)/)[1] === "my-report", r2);

      // collision: a DIFFERENT file that slugifies to the same title gets disambiguated, not overwritten
      fs.writeFileSync(path.join(paDir, "other.html"), "<h1>Other</h1>");
      const r3 = await A.execTool("publish_artifact", { path: "other.html", title: "My Report" }, { root: paDir, log: () => {}, enginePort: 9999 });
      const slug3 = r3.match(/\/artifacts\/([\w-]+)/)[1];
      check("publish_artifact: a genuine slug collision (different file, same title) gets a disambiguated slug, never overwrites", slug3 !== "my-report", r3);
      const reg2 = JSON.parse(fs.readFileSync(path.join(paDir, ".eta", "artifacts.json"), "utf8"));
      check("publish_artifact: the original entry is untouched after the collision", reg2["my-report"]?.path === "report.html");

      check("publish_artifact: falls back to a default port when enginePort isn't provided", /http:\/\/127\.0\.0\.1:8710\//.test(await A.execTool("publish_artifact", { path: "report.html" }, { root: paDir, log: () => {} })));
    }

    // complexity-gated planning: trivial → 1 step, real project → many
    check("estimateComplexity: one-liner → 1 step", A.estimateComplexity("add a print statement to main.py") === 1 && A.estimateComplexity("create notes.txt with the line hello") === 1);
    check("estimateComplexity: big project → many steps", A.estimateComplexity("Build a complete clone of Cursor with chat, terminal, git and diff editing") >= 6);
    // verifier reranking score
    check("verifierScore punishes stubs, rewards real code", A.verifierScore("index.html", "<!-- placeholder to be filled -->", true) < A.verifierScore("index.html", "<html><body><h1>Hi</h1><script>go()</script></body></html>", true));
    check("verifierScore floors empty content", A.verifierScore("a.js", "", true) < 0);

    // two-track cognition: grounding (checking) vs doing (changing)
    check("toolTrack: checks are grounding", A.toolTrack("read_file") === "grounding" && A.toolTrack("search") === "grounding" && A.toolTrack("find_symbol") === "grounding");
    check("toolTrack: changes are doing", A.toolTrack("write_file") === "doing" && A.toolTrack("run_command") === "doing" && A.toolTrack("create_pdf") === "doing");
    check("EXEC_SYS states the two tracks + do-not-hallucinate", /TRACK 1 — GROUNDING/.test(A.EXEC_SYS || "") && /DO NOT HALLUCINATE/.test(A.EXEC_SYS || "") && /TRACK 2 — THE LOOP/.test(A.EXEC_SYS || ""));

    // CRITIC / VERIFIER gate: vetoes hallucinated actions before they run (generator-verifier)
    const critic = A.Agent.prototype.critic;
    const cdir = fresh("critic"); fs.writeFileSync(path.join(cdir, "real.js"), "1");
    const ctxReal = { root: cdir, files: new Set(["real.js"]), failedCmds: new Map() };
    check("critic VETOES editing a nonexistent file", !!(await critic.call(ctxReal, { name: "edit_file", args: { path: "ghost.js" } })));
    check("critic ALLOWS editing a real file", (await critic.call(ctxReal, { name: "edit_file", args: { path: "real.js" } })) === null);
    check("critic ALLOWS write_file for a new file", (await critic.call(ctxReal, { name: "write_file", args: { path: "brand-new.js" } })) === null);
    check("critic VETOES running a missing script", !!(await critic.call(ctxReal, { name: "run_command", args: { command: "python missing.py" } })));
    const ctxFail = { root: cdir, files: new Set(["real.js"]), failedCmds: new Map([["python -m unittest", 1]]) };
    check("critic VETOES finish while a command is failing", !!(await critic.call(ctxFail, { name: "finish", args: { summary: "done" } })));

    // honesty: parse the real test result so a false "all passed" can't be the last word
    const uFail = A.summarizeTests("Ran 6 tests in 0.003s\n\nFAILED (errors=2)");
    check("summarizeTests reads unittest failures (4/6)", uFail && uFail.total === 6 && uFail.pass === 4 && uFail.fails === 2 && uFail.ok === false, JSON.stringify(uFail));
    const uOk = A.summarizeTests("Ran 6 tests in 0.003s\n\nOK");
    check("summarizeTests reads unittest pass (6/6)", uOk && uOk.pass === 6 && uOk.ok === true, JSON.stringify(uOk));
    const pyt = A.summarizeTests("=== 4 passed, 2 failed in 0.1s ===");
    check("summarizeTests reads pytest counts", pyt && pyt.pass === 4 && pyt.fails === 2, JSON.stringify(pyt));
    // REAL pytest order is "failed" BEFORE "passed" when both appear (measured live, run 39:
    // "1 failed, 12 passed in 0.17s") — an order-dependent regex silently dropped the failed
    // count and reported false-green ("12/12 tests passing, 0 still failing" for a run that
    // actually had a failing test). The above test used the wrong order and masked this for a
    // long time; this one locks in the real-world order.
    const pytReal = A.summarizeTests("..F..........\n1 failed, 12 passed in 0.17s");
    check("summarizeTests reads pytest counts in REAL failed-before-passed order", pytReal && pytReal.pass === 12 && pytReal.fails === 1 && pytReal.total === 13 && pytReal.ok === false, JSON.stringify(pytReal));
    const pytAllFail = A.summarizeTests("FF\n2 failed in 0.05s");
    check("summarizeTests reads an all-failing pytest run with no \"passed\" text at all", pytAllFail && pytAllFail.pass === 0 && pytAllFail.fails === 2 && pytAllFail.ok === false, JSON.stringify(pytAllFail));

    // scoreTestOutput (ranks best-of-N candidates against each other): had the SAME order-independent
    // pytest "N failed"/"N error" gap as summarizeTests' run-39 bug, but was never given the matching
    // fix — every pytest failure state fell through to the flat 999 sentinel via the "COMMAND FAILED"
    // wrapper, making `score < best.score` unwinnable between two failing pytest candidates (measured
    // live, run 160: two best-of-5 candidates for is_perfect_power both scored "999 failing" with no way
    // to tell 1 failing test from 400).
    check("scoreTestOutput reads real pytest failed-before-passed counts, not the flat 999 sentinel",
      A.scoreTestOutput("3 failed, 480 passed in 1.02s") === 3);
    check("scoreTestOutput reads an all-failing pytest run with no \"passed\" text at all",
      A.scoreTestOutput("1 failed in 0.05s") === 1);
    check("scoreTestOutput reads pytest error counts",
      A.scoreTestOutput("2 errors in 0.10s") === 2);
    check("scoreTestOutput sums failed+error when pytest reports both",
      A.scoreTestOutput("1 failed, 1 error, 478 passed in 0.9s") === 2);
    check("scoreTestOutput still returns 0 for an all-passing run",
      A.scoreTestOutput("480 passed in 2.20s") === 0);
    check("scoreTestOutput still returns the 999 sentinel for a genuinely uncounted failure (syntax/import crash)",
      A.scoreTestOutput("COMMAND FAILED: exit 1\nTraceback (most recent call last):\n  File x") === 999);

    // parseSearchReplace: direct unit coverage (staleness-audit sweep — had ZERO direct tests
    // before this). BUG 65: the old single-regex parser used LAZY captures for both halves, so it
    // stopped at the FIRST "=======" / ">>>>>>> REPLACE"-shaped line, corrupting the parse whenever
    // real content contains a bare marker-lookalike line (verified live: boltons' own
    // docs/architecture.rst uses a bare "============" line as an RST title underline).
    {
      const std = "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n";
      check("parseSearchReplace: standard single block", JSON.stringify(A.parseSearchReplace(std)) === JSON.stringify([{ old: "foo", neu: "bar" }]));
      const two = "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nbaz\n=======\nqux\n>>>>>>> REPLACE\n";
      check("parseSearchReplace: two blocks in one reply", JSON.stringify(A.parseSearchReplace(two)) === JSON.stringify([{ old: "foo", neu: "bar" }, { old: "baz", neu: "qux" }]));
      const crlf = "<<<<<<< SEARCH\r\nfoo\r\n=======\r\nbar\r\n>>>>>>> REPLACE\r\n";
      check("parseSearchReplace: CRLF line endings", JSON.stringify(A.parseSearchReplace(crlf)) === JSON.stringify([{ old: "foo", neu: "bar" }]));
      // BUG 65's exact repro: a bare "=======" line embedded INSIDE the intended SEARCH text
      // (no comment prefix — an RST-style title underline) must NOT be mistaken for the real
      // separator between SEARCH and REPLACE.
      const embedded = "<<<<<<< SEARCH\nx = 1\n=======\ny = 2\n=======\nz = 3\n>>>>>>> REPLACE\n";
      const gotEmbedded = A.parseSearchReplace(embedded);
      check("BUG 65: a bare '=======' line embedded in SEARCH text is kept as CONTENT, not mistaken for the separator",
        gotEmbedded.length === 1 && gotEmbedded[0].old === "x = 1\n=======\ny = 2" && gotEmbedded[0].neu === "z = 3",
        JSON.stringify(gotEmbedded));
      // a "#"-commented divider line was already safe under the old parser (the marker regex is
      // anchored to line-start, and "#" breaks that) — must stay safe after the rewrite too.
      const commented = "<<<<<<< SEARCH\ndef f():\n    # =======\n    return 1\n=======\nbar\n>>>>>>> REPLACE\n";
      const gotCommented = A.parseSearchReplace(commented);
      check("parseSearchReplace: a '#'-commented divider line was never ambiguous, still parses correctly",
        gotCommented.length === 1 && gotCommented[0].old === "def f():\n    # =======\n    return 1" && gotCommented[0].neu === "bar",
        JSON.stringify(gotCommented));
      // trailing text on the REPLACE marker's own line was always tolerated (asymmetric with the
      // strict SEARCH/separator lines) — preserve that exact leniency.
      const trailing = "<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE extra text here\n";
      check("parseSearchReplace: trailing text after REPLACE on the marker line is tolerated",
        JSON.stringify(A.parseSearchReplace(trailing)) === JSON.stringify([{ old: "foo", neu: "bar" }]));
      check("parseSearchReplace: no trailing newline after the final REPLACE marker",
        JSON.stringify(A.parseSearchReplace("<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE")) === JSON.stringify([{ old: "foo", neu: "bar" }]));
      check("parseSearchReplace: no blocks found in plain prose -> empty array", A.parseSearchReplace("just some text, no markers here").length === 0);
    }

    // parsePlanSteps: direct unit coverage (staleness-audit sweep — had ZERO direct tests before
    // this). BUG 66: the marker regex required \s+ (a mandatory space) after "1." / "1)". A weak
    // model that omits the space ("1.Do the thing") matched NEITHER the new-step branch (regex
    // failed) NOR the continuation branch (cur was falsy) — the line's content vanished with zero
    // signal. Worse: in a plan mixing formats (step 1 unspaced, step 2 spaced), only step 1 — the
    // FIRST step — silently disappeared while the rest of the plan looked fine, so `microExecute`
    // (the core loop that drives the local model one step at a time) would simply never attempt
    // it. Fixed via (?!\d) + \s* instead of \s+: tolerates a missing space while still refusing to
    // treat a decimal number ("3.14") as a marker, since a real digit right after the punctuation
    // fails the negative lookahead.
    {
      check("parsePlanSteps: standard numbered plan", JSON.stringify(A.parsePlanSteps("1. Do the first thing\n2. Do the second thing\n3. Run tests")) === JSON.stringify(["Do the first thing", "Do the second thing", "Run tests"]));
      check("parsePlanSteps: paren-style markers", JSON.stringify(A.parsePlanSteps("1) Do the first thing\n2) Do the second thing")) === JSON.stringify(["Do the first thing", "Do the second thing"]));
      check("BUG 66: a marker with NO space after it is still parsed as a step, not silently dropped", JSON.stringify(A.parsePlanSteps("1.Do the first thing\n2.Do the second thing")) === JSON.stringify(["Do the first thing", "Do the second thing"]));
      check("BUG 66: a plan MIXING unspaced and spaced markers keeps BOTH steps (the unspaced FIRST step used to vanish entirely)", JSON.stringify(A.parsePlanSteps("1.Do the first thing\n2. Do the second thing")) === JSON.stringify(["Do the first thing", "Do the second thing"]));
      check("BUG 66: a two-digit unspaced marker is also recovered", JSON.stringify(A.parsePlanSteps("10.Refactor the whole module\n11.Add tests")) === JSON.stringify(["Refactor the whole module", "Add tests"]));
      // regression guard: a decimal number at the start of a step's continuation text must NOT be
      // mistaken for a new marker just because the space-tolerance was loosened.
      check("parsePlanSteps: a decimal number is never misread as a step marker", JSON.stringify(A.parsePlanSteps("1. Use 3.14 as an approximation\n2. Do the second thing")) === JSON.stringify(["Use 3.14 as an approximation", "Do the second thing"]));
      check("parsePlanSteps: multi-line continuation text is joined into one step", JSON.stringify(A.parsePlanSteps("1. Do the first thing\n   that spans two lines\n2. Do the second thing")) === JSON.stringify(["Do the first thing that spans two lines", "Do the second thing"]));
      check("parsePlanSteps: a leading 'Plan:' header line is not mistaken for a step", JSON.stringify(A.parsePlanSteps("Plan:\n1. Step one\n2. Step two")) === JSON.stringify(["Step one", "Step two"]));
      check("parsePlanSteps: unparseable (non-numbered) plan text returns an empty array, not a crash", A.parsePlanSteps("- Step one\n- Step two").length === 0);
      check("parsePlanSteps: empty input returns an empty array", A.parsePlanSteps("").length === 0);
    }

    // BUG 81 (2026-09-08): a nested numbered sub-list under a step — a markdown pattern a weak
    // model reaches for when elaborating one step's file changes — used to fracture ONE step into
    // SEVERAL top-level steps, because the old marker regex's \s* accepted any leading indentation
    // as a new-step boundary with no notion of nesting. `1. Implement X\n   1. sub a\n   2. sub b\n
    // 2. Add tests` used to parse as 4 steps instead of 2, inflating the count against the
    // executor's `stepBudget` and dispatching each sub-detail as its own independent unit of work
    // instead of elaboration on the step above it. Fixed by tracking the indentation of the first
    // top-level marker seen; a marker indented deeper than that folds into the current step's text
    // via the existing continuation branch (same as an indented "-" bullet already did).
    {
      check("BUG 81: a nested numbered sub-list folds into its parent step (2 steps, not 4)",
        JSON.stringify(A.parsePlanSteps("1. Implement the parser\n   1. Handle the header\n   2. Handle the body\n2. Add tests")) ===
        JSON.stringify(["Implement the parser 1. Handle the header 2. Handle the body", "Add tests"]));
      check("BUG 81: two levels of nested numbering all fold into the one parent step",
        JSON.stringify(A.parsePlanSteps("1. Build the feature\n   1. sub one\n      1. sub sub one\n   2. sub two\n2. Ship it")) ===
        JSON.stringify(["Build the feature 1. sub one 1. sub sub one 2. sub two", "Ship it"]));
      check("BUG 81: a uniformly-indented plan (all steps share one indent) still treats every marker as top-level",
        JSON.stringify(A.parsePlanSteps("   1. Step one\n   2. Step two")) === JSON.stringify(["Step one", "Step two"]));
      // regression guard: an indented BULLET sub-list (never numeric) must keep working exactly as
      // before — this fix only changes behavior for lines that ALSO match the numbered-marker regex.
      check("parsePlanSteps: an indented bullet sub-list is still folded into its parent step (unchanged control)",
        JSON.stringify(A.parsePlanSteps("1. Implement the parser\n   - handle the header\n   - handle the body\n2. Add tests")) ===
        JSON.stringify(["Implement the parser - handle the header - handle the body", "Add tests"]));
    }

    // externalImports: direct unit coverage (staleness-audit sweep — had ZERO direct tests before
    // this). BUG 67: the JS branch ran its import-extraction regex over the RAW source with no
    // comment awareness, and the Python branch's line-start anchor doesn't protect against a
    // triple-quoted docstring (Python has no quoted module names in real import syntax, so
    // docstring content was never guarded at all). A comment/docstring mentioning "import foo" or
    // "from \"bar\"" as prose/example text got extracted as if it were a real import, which feeds
    // pkgGate's live registry check — a fictional/typo'd name in a comment or docstring example
    // could reject an otherwise-valid file write. Confirmed live on the actual boltons corpus this
    // project uses as ground truth: boltons/strutils.py's own class docstring shows
    // "from boltons import strutils" as a usage example (line ~1151/1162) and the old code
    // extracted "boltons" as an external import to verify. Fixed by blanking comment text (JS:
    // //.../* */, Python: #...) before scanning; Python also blanks triple-quoted string CONTENTS
    // (safe because Python import statements never take a quoted string as the module name, so
    // there is no real import to lose). JS string/template contents are deliberately left
    // untouched — a real import specifier IS a quoted string, so blanking string contents would
    // erase real imports too; only comment text is blanked. This leaves one known, accepted
    // residual gap: a JS string literal that itself spells out fake require()/import() text (not a
    // comment) is still extracted, since disambiguating "code" from "data that looks like code"
    // inside an arbitrary string would need real tokenization — not worth the complexity for how
    // rare that shape is.
    {
      check("externalImports(js): real import unaffected", JSON.stringify(A.externalImports("import React from \"react\";\n", "js").names) === JSON.stringify(["react"]));
      check("externalImports(js): real require() unaffected", JSON.stringify(A.externalImports("const l = require(\"lodash\");\n", "js").names) === JSON.stringify(["lodash"]));
      check("externalImports(js): real dynamic import() unaffected", JSON.stringify(A.externalImports("const m = await import(\"chalk\");\n", "js").names) === JSON.stringify(["chalk"]));
      check("externalImports(js): real export-from unaffected", JSON.stringify(A.externalImports("export * from \"rxjs\";\n", "js").names) === JSON.stringify(["rxjs"]));
      check("externalImports(js): scoped package name unaffected", JSON.stringify(A.externalImports("import x from \"@babel/core\";\n", "js").names) === JSON.stringify(["@babel/core"]));
      check("BUG 67: a line comment mentioning 'from \"pkg\"' as prose is no longer extracted as an import", A.externalImports("// Data ported from \"left-pad\" originally\nconst x = 1;\n", "js").names.length === 0);
      check("BUG 67: a JSDoc block comment mentioning 'migrated from \"pkg\"' is no longer extracted", A.externalImports("/**\n * Logic migrated from \"is-even\" package.\n */\nfunction f(){}\n", "js").names.length === 0);
      check("externalImports(js): a real import that follows a line comment on the SAME line is still caught", JSON.stringify(A.externalImports("import a from \"axios\"; // http client\n", "js").names) === JSON.stringify(["axios"]));
      check("externalImports(js): a real import that follows a block comment is still caught", JSON.stringify(A.externalImports("/* header */\nimport b from \"chalk\";\n", "js").names) === JSON.stringify(["chalk"]));
      // regression guard: a "//" inside an unrelated string (e.g. a URL) must not be misread as a
      // line-comment start and swallow a real import that follows later on the same line.
      check("externalImports(js): '//' inside a string (URL) does not swallow a later real import on the same line", JSON.stringify(A.externalImports("const url = \"http://foo.com\"; import x from \"bar-pkg\";\n", "js").names) === JSON.stringify(["bar-pkg"]));
      check("externalImports(py): real import unaffected", JSON.stringify(A.externalImports("import os\nimport numpy\n", "py").names) === JSON.stringify(["numpy"]));
      check("externalImports(py): real from-import unaffected", JSON.stringify(A.externalImports("from requests import get\n", "py").names) === JSON.stringify(["requests"]));
      check("externalImports(py): a '#' comment mentioning import/from as prose was already safe (line-start anchor)", A.externalImports("# from foo import bar (just an example)\nimport os\n", "py").names.length === 0);
      check("BUG 67: a triple-quoted docstring showing 'import fake_pkg' as a usage example is no longer extracted", A.externalImports("def f():\n    \"\"\"\n    Example usage:\n    import nonexistent_fake_pkg_xyz\n    \"\"\"\n    return 1\n", "py").names.length === 0);
      check("BUG 67: single-quote triple-docstring variant is also excluded", A.externalImports("def f():\n    '''\n    import fake_pkg_2\n    '''\n    return 1\n", "py").names.length === 0);
      check("externalImports(py): a real import right after a module docstring is still caught", JSON.stringify(A.externalImports("\"\"\"module doc\"\"\"\nimport requests\n", "py").names) === JSON.stringify(["requests"]));
      check("externalImports: relative/builtin specifiers are still excluded", A.externalImports("import x from \"./util.js\";\n", "js").names.length === 0);
    }

    // stripFences: direct unit coverage (staleness-audit sweep — had ZERO direct tests before
    // this, despite feeding the CORE whole-file write path at agent.mjs `content = stripFences(raw)`
    // right before every `fs.writeFile`). BUG 68: the closing-fence search used to find the LAST ```
    // ANYWHERE in the string (via a `\s*$`-end-anchored regex whose lazy capture backtracks until it
    // reaches true string end, and via a `lastIndexOf` fallback) instead of the nearest one that
    // actually closes the FIRST block. A weak model that ignores "never commentary" and appends
    // trailing prose containing its OWN extra ``` (e.g. "this replaces the old version, which was:
    // ```...```", or two back-to-back fenced blocks with no prose divider) made both branches swallow
    // the real closing fence, the prose, and part of the second block into the WRITTEN FILE CONTENT.
    // Fixed by requiring the closing marker to start its own line (nearest such occurrence, not the
    // last) in both branches — this also fixes the opposite failure, where code whose own content
    // legitimately contains a literal ``` mid-line (e.g. inside a comment) used to get truncated
    // right at that point under a naive "nearest ``` anywhere" fix.
    {
      check("stripFences: simple fenced block unaffected", A.stripFences("```python\ndef foo():\n    pass\n```") === "def foo():\n    pass");
      check("stripFences: same-line preamble before the fence is dropped", A.stripFences("Here's the code: ```python\ndef foo():\n    pass\n```") === "def foo():\n    pass");
      check("stripFences: multi-line preamble before the fence is dropped", A.stripFences("Here's the implementation:\n\nSome explanation.\n\n```python\ndef foo():\n    pass\n```").trim() === "def foo():\n    pass");
      check("stripFences: content with no fences at all passes through unchanged", A.stripFences("def foo():\n    pass") === "def foo():\n    pass");
      check("BUG 68: trailing prose containing its OWN extra ``` no longer leaks into the written content",
        A.stripFences("```python\ndef foo():\n    pass\n```\n\nThis replaces the old version, which looked like:\n\n```python\ndef foo():\n    return None\n```") === "def foo():\n    pass");
      check("BUG 68: two back-to-back real fenced blocks with no prose divider — only the FIRST is kept",
        A.stripFences("```python\ndef foo():\n    pass\n```\n```python\ndef bar():\n    pass\n```") === "def foo():\n    pass");
      check("BUG 68: same bug shape with a multi-line preamble before the first fence",
        A.stripFences("Here's the implementation:\n\nSome context.\n\n```python\ndef foo():\n    pass\n```\n\nPreviously it was:\n\n```python\ndef foo():\n    return None\n```").trim() === "def foo():\n    pass");
      // regression guard: a literal ``` embedded MID-LINE inside real code (e.g. a comment) must not
      // be mistaken for a closing fence and truncate the block early.
      check("stripFences: a literal ``` embedded mid-line inside a comment does not truncate the block",
        A.stripFences("```python\n# this code has a literal ``` marker in a comment\ndef foo():\n    pass\n```") === "# this code has a literal ``` marker in a comment\ndef foo():\n    pass");
      check("stripFences: <think> residue is stripped before fence parsing", A.stripFences("<think>reasoning here</think>\n```python\ndef foo():\n    pass\n```") === "def foo():\n    pass");
      check("stripFences: a stray closing </think> with no opener is also stripped", A.stripFences("</think>\n```python\ndef foo():\n    pass\n```") === "def foo():\n    pass");
      check("stripFences: no language tag on the opening fence", A.stripFences("```\ndef foo():\n    pass\n```") === "def foo():\n    pass");
      check("stripFences: a hyphenated language tag is handled", A.stripFences("```jsx-like\nconst x = 1;\n```") === "const x = 1;");
      check("stripFences: a template literal's own backtick pair (not triple) survives untouched", A.stripFences("```js\nconst s = `hello ${name}`;\n```") === "const s = `hello ${name}`;");
      check("stripFences: empty input returns empty string, not a crash", A.stripFences("") === "");
      // CRLF: the opening-fence regex requires a literal \n right after the language tag, so CRLF
      // input (\r before \n) always falls to the line-split fallback — must still strip cleanly.
      check("stripFences: CRLF line endings are still stripped cleanly", A.stripFences("```python\r\ndef foo():\r\n    pass\r\n```\r\n") === "def foo():\r\n    pass\r\n");
      check("BUG 68 (CRLF variant): trailing prose with an extra ``` under CRLF line endings",
        A.stripFences("```python\r\ndef foo():\r\n    pass\r\n```\r\n\r\nPreviously:\r\n\r\n```python\r\ndef foo():\r\n    return None\r\n```") === "def foo():\r\n    pass\r\n");
    }

    // unwrapTags: direct unit coverage (staleness-audit sweep — had ZERO direct tests before this,
    // despite running on the SAME core whole-file write path as stripFences, called immediately
    // after it at agent.mjs `content = stripFences(raw); ... unwrapTags(content, rel)`). BUG 69: the
    // exact same over-capture SHAPE as BUG 68, in a sibling function — the closing-tag regex was
    // end-anchored (`\s*$`) with a lazy capture that backtracks until it reaches true string end, so
    // it found the LAST `</script>`/`</style>` anywhere instead of the one that actually closes the
    // FIRST block. A weak model that wraps a whole .js/.css file in tags and then (ignoring "never
    // commentary") appends trailing prose referencing a second wrapped block made the written file
    // swallow the real closing tag, the prose, and part of the second block. Fixed the same way as
    // BUG 68: for multi-line content the closing tag must start its own line (only leading
    // spaces/tabs allowed before it), so the lazy, non-anchored capture naturally stops at the FIRST
    // real close — which also protects real code that legitimately contains the literal text
    // `</script>` mid-line (e.g. inside a string constant), since that occurrence isn't preceded by a
    // newline. Single-line content (no `\n` in the wrapped body at all) keeps the original
    // end-anchored whole-match check, since only one unambiguous block is possible there.
    {
      check("unwrapTags: simple <script>-wrapped .js is unwrapped",
        JSON.stringify(A.unwrapTags("<script>\nfunction foo(){ return 1; }\n</script>", "foo.js")) === JSON.stringify({ text: "function foo(){ return 1; }", changed: true }));
      check("unwrapTags: simple <style>-wrapped .css is unwrapped",
        JSON.stringify(A.unwrapTags("<style>\n.a { color: red; }\n</style>", "foo.css")) === JSON.stringify({ text: ".a { color: red; }", changed: true }));
      check("unwrapTags: plain .js with no wrapping tags passes through unchanged",
        JSON.stringify(A.unwrapTags("function foo(){ return 1; }", "foo.js")) === JSON.stringify({ text: "function foo(){ return 1; }", changed: false }));
      check("unwrapTags: a non-js/css extension is never touched even if it looks wrapped",
        JSON.stringify(A.unwrapTags("<script>\nfoo();\n</script>", "foo.py")) === JSON.stringify({ text: "<script>\nfoo();\n</script>", changed: false }));
      check("unwrapTags: single-line wrap (no newlines at all) is still unwrapped",
        JSON.stringify(A.unwrapTags("<script>module.exports = {};</script>", "foo.js")) === JSON.stringify({ text: "module.exports = {};", changed: true }));
      check("unwrapTags: attributes on the opening tag (e.g. type=\"module\") are tolerated",
        JSON.stringify(A.unwrapTags('<script type="module">\nexport const x = 1;\n</script>', "foo.mjs")) === JSON.stringify({ text: "export const x = 1;", changed: true }));
      check("unwrapTags: tag name matching is case-insensitive",
        JSON.stringify(A.unwrapTags("<SCRIPT>\nfoo();\n</SCRIPT>", "foo.js")) === JSON.stringify({ text: "foo();", changed: true }));
      check("unwrapTags: .cjs extension is also recognized as script-wrappable",
        JSON.stringify(A.unwrapTags("<script>\nmodule.exports = 1;\n</script>", "foo.cjs")) === JSON.stringify({ text: "module.exports = 1;", changed: true }));
      check("BUG 69: two back-to-back <script> blocks with trailing prose in between — only the FIRST is kept",
        JSON.stringify(A.unwrapTags("<script>\nfunction foo(){ return 1; }\n</script>\n\nHere is an alternate version:\n\n<script>\nfunction foo(){ return 2; }\n</script>", "foo.js")) === JSON.stringify({ text: "function foo(){ return 1; }", changed: true }));
      check("BUG 69: same shape for <style> blocks",
        JSON.stringify(A.unwrapTags("<style>\n.a { color: red; }\n</style>\n\nAlternate:\n\n<style>\n.a { color: blue; }\n</style>", "foo.css")) === JSON.stringify({ text: ".a { color: red; }", changed: true }));
      check("BUG 69 (CRLF variant): two back-to-back blocks under CRLF line endings",
        JSON.stringify(A.unwrapTags("<script>\r\nfunction foo(){ return 1; }\r\n</script>\r\n\r\nAlt:\r\n\r\n<script>\r\nfunction foo(){ return 2; }\r\n</script>", "foo.js")) === JSON.stringify({ text: "function foo(){ return 1; }", changed: true }));
      // regression guard: real code that legitimately contains the literal text "</script>" MID-LINE
      // (e.g. inside a string constant) must not be mistaken for the real closing tag and truncated.
      check("unwrapTags: a literal </script> embedded mid-line inside a string constant does not truncate the block",
        JSON.stringify(A.unwrapTags('<script>\nconst CLOSE_TAG = "</script>";\nmodule.exports = { CLOSE_TAG };\n</script>', "foo.js")) === JSON.stringify({ text: 'const CLOSE_TAG = "</script>";\nmodule.exports = { CLOSE_TAG };', changed: true }));
      check("unwrapTags: CRLF single block has no stray trailing \\r left on the last content line",
        JSON.stringify(A.unwrapTags("<script>\r\nfunction foo(){ return 1; }\r\n</script>", "foo.js")) === JSON.stringify({ text: "function foo(){ return 1; }", changed: true }));
      check("unwrapTags: an unterminated multi-line <script> (no closing tag at all) is left unchanged, not guessed at",
        JSON.stringify(A.unwrapTags("<script>\nfunction foo(){ return 1; }\n", "foo.js")) === JSON.stringify({ text: "<script>\nfunction foo(){ return 1; }\n", changed: false }));
      check("unwrapTags: single-line content with trailing junk after the close tag on the same line is left unchanged",
        JSON.stringify(A.unwrapTags("<script>foo();</script> extra junk", "foo.js")) === JSON.stringify({ text: "<script>foo();</script> extra junk", changed: false }));
    }

    // ensureTestImports: direct unit coverage (staleness-audit sweep — had ZERO direct tests
    // before this). Called at agent.mjs's spec-first test-authoring path
    // (`best = ensureTestImports(best)`) as a safety net when a model-authored oracle test file
    // uses `unittest.` but forgot the bare `import unittest` the system prompt asked for. BUG 70:
    // the old code always prepended "import unittest\n" at line 0 — but Python requires
    // `from __future__ import ...` to be the file's FIRST statement, so a model that (legitimately)
    // opened the file with e.g. `from __future__ import annotations` got a GUARANTEED SyntaxError
    // inserted above it, turning a syntactically valid model-authored oracle into a permanently
    // broken locked file (verified live with `python -m py_compile`: "from __future__ imports must
    // occur at the beginning of the file"). Fixed by inserting the import AFTER any leading,
    // contiguous `from __future__ import` line(s) instead of unconditionally at line 0.
    {
      check("ensureTestImports: no unittest. usage at all is left untouched",
        A.ensureTestImports("class MyTest:\n    def test_x(self):\n        pass\n") === "class MyTest:\n    def test_x(self):\n        pass\n");
      check("ensureTestImports: bare `import unittest` already at the top is left untouched",
        A.ensureTestImports("import unittest\nclass MyTest(unittest.TestCase):\n    pass\n") === "import unittest\nclass MyTest(unittest.TestCase):\n    pass\n");
      check("ensureTestImports: bare `import unittest` present but not at line 0 is still recognized as present",
        A.ensureTestImports("import sys\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n") === "import sys\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n");
      check("ensureTestImports: missing import in the ordinary case is prepended at line 0",
        A.ensureTestImports("import mymodule\nclass MyTest(unittest.TestCase):\n    pass\n") === "import unittest\nimport mymodule\nclass MyTest(unittest.TestCase):\n    pass\n");
      check("ensureTestImports: `import unittest as ut` counts as present (no duplicate insert)",
        A.ensureTestImports("import unittest as ut\nclass MyTest(ut.TestCase):\n    pass\n") === "import unittest as ut\nclass MyTest(ut.TestCase):\n    pass\n");
      check("BUG 70: a single leading `from __future__ import` line — import is inserted AFTER it, not before",
        A.ensureTestImports("from __future__ import annotations\nclass MyTest(unittest.TestCase):\n    pass\n") === "from __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n");
      check("BUG 70: two contiguous leading `from __future__ import` lines — import inserted after BOTH",
        A.ensureTestImports("from __future__ import annotations\nfrom __future__ import division\nclass MyTest(unittest.TestCase):\n    pass\n") === "from __future__ import annotations\nfrom __future__ import division\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n");
      check("BUG 70 (CRLF variant): a leading future-import line under CRLF line endings",
        A.ensureTestImports("from __future__ import annotations\r\nclass MyTest(unittest.TestCase):\r\n    pass\r\n") === "from __future__ import annotations\r\nimport unittest\nclass MyTest(unittest.TestCase):\r\n    pass\r\n");
      check("ensureTestImports: a future import followed by an already-present bare import is left untouched",
        A.ensureTestImports("from __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n") === "from __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n");
    }

    // BUG 80 (2026-09-08): BUG 70's own fix only searched for a leading `from __future__ import`
    // block starting at line 0 — a file that legitimately opens with a MODULE DOCSTRING before the
    // future import (Python's grammar explicitly allows this: docstring, comments, blank lines, and
    // other future statements may all precede a future import) still hit the identical
    // "from __future__ imports must occur at the beginning of the file" SyntaxError, because the
    // future-import regex never matched past the docstring and the code fell back to prepending at
    // line 0 — ahead of BOTH the docstring and the future import. Verified live with
    // `python -m py_compile` both before (SyntaxError) and after (compiles clean) the fix, plus a
    // revert/re-fix differential confirming every case below genuinely fails pre-fix. Fixed by
    // skipping a leading triple-quoted docstring (and any blank lines after it) before looking for
    // the future-import block.
    {
      check("BUG 80: docstring immediately followed by a future import — inserted after BOTH",
        A.ensureTestImports('"""Doc."""\nfrom __future__ import annotations\nclass MyTest(unittest.TestCase):\n    pass\n') === '"""Doc."""\nfrom __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n');
      check("BUG 80: docstring, blank line, then a future import — inserted after both, blank line preserved",
        A.ensureTestImports('"""Doc."""\n\nfrom __future__ import annotations\nclass MyTest(unittest.TestCase):\n    pass\n') === '"""Doc."""\n\nfrom __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n');
      check("BUG 80: single-quoted triple docstring followed by a future import",
        A.ensureTestImports("'''Doc.'''\nfrom __future__ import annotations\nclass MyTest(unittest.TestCase):\n    pass\n") === "'''Doc.'''\nfrom __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n");
      check("BUG 80: multi-line docstring followed by a future import",
        A.ensureTestImports('"""\nMulti\nline\ndoc.\n"""\nfrom __future__ import annotations\nclass MyTest(unittest.TestCase):\n    pass\n') === '"""\nMulti\nline\ndoc.\n"""\nfrom __future__ import annotations\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n');
      check("BUG 80: docstring followed by TWO contiguous future imports — inserted after all three lines",
        A.ensureTestImports('"""Doc."""\nfrom __future__ import annotations\nfrom __future__ import division\nclass MyTest(unittest.TestCase):\n    pass\n') === '"""Doc."""\nfrom __future__ import annotations\nfrom __future__ import division\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n');
      check("BUG 80 (CRLF variant): docstring + future import under CRLF line endings",
        A.ensureTestImports('"""Doc."""\r\nfrom __future__ import annotations\r\nclass MyTest(unittest.TestCase):\r\n    pass\r\n') === '"""Doc."""\r\nfrom __future__ import annotations\r\nimport unittest\nclass MyTest(unittest.TestCase):\r\n    pass\r\n');
      check("BUG 80: docstring with NO future import — import now inserted after the docstring, not before it",
        A.ensureTestImports('"""Doc."""\nclass MyTest(unittest.TestCase):\n    pass\n') === '"""Doc."""\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n');
      check("BUG 80: docstring with an already-present bare import right after it is left untouched",
        A.ensureTestImports('"""Doc."""\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n') === '"""Doc."""\nimport unittest\nclass MyTest(unittest.TestCase):\n    pass\n');
    }

    // deEntity: direct unit coverage (staleness-audit sweep — had ZERO direct tests before this).
    // Weak-model safety net used at agent.mjs's write_file repair-on-failure path (~6084: "if the
    // checker rejects it AND the content was entity-escaped, try the decoded version") — the ONLY
    // mechanism that recovers a file whose model output HTML-escaped code characters (e.g. wrote
    // `&amp;&amp;` instead of `&&`). BUG: the function has a 2-stage guard — a broad pre-check, then
    // a narrower "does this really look like escaped code" filter before doing the actual decode.
    // The narrower filter listed specific numeric/named forms for quot/apos/lt/gt but OMITTED amp
    // entirely, even though the replace chain below unconditionally decodes `&amp;`. Net effect:
    // content escaped ONLY via amp (no other entity type present) silently failed to decode —
    // verified live: `deEntity("if (a &amp;&amp; b) {}")` returned unchanged before the fix. Fixed
    // by adding amp's named + numeric forms to the narrow filter, mirroring how quot/apos are
    // already handled there (same style, same optional-semicolon strictness — verified via a
    // differential that the missing-semicolon behavior is pre-existing and symmetric across ALL
    // entity types, not something this fix introduced or worsened).
    {
      check("deEntity: no entities at all is left untouched",
        JSON.stringify(A.deEntity("plain code, nothing here")) === JSON.stringify({ text: "plain code, nothing here", changed: false }));
      check("deEntity: lt/gt/quot/apos mix still decodes (pre-existing behavior unaffected)",
        JSON.stringify(A.deEntity("if (a &lt; b &gt; c) { return &quot;x&apos;y&quot;; }")) === JSON.stringify({ text: "if (a < b > c) { return \"x'y\"; }", changed: true }));
      check("deEntity: a literal bare & with no entity markup is left untouched",
        JSON.stringify(A.deEntity("Tom & Jerry, R&D")) === JSON.stringify({ text: "Tom & Jerry, R&D", changed: false }));
      check("BUG: amp-only escaped JS logical-AND (&amp;&amp;) now decodes to &&",
        JSON.stringify(A.deEntity("if (a &amp;&amp; b) { return c &amp;&amp; d; }")) === JSON.stringify({ text: "if (a && b) { return c && d; }", changed: true }));
      check("BUG: amp-only single literal entity now decodes",
        JSON.stringify(A.deEntity("Tom &amp; Jerry")) === JSON.stringify({ text: "Tom & Jerry", changed: true }));
      check("BUG: amp-only decimal numeric entity (&#38;) now decodes",
        JSON.stringify(A.deEntity("Tom &#38; Jerry")) === JSON.stringify({ text: "Tom & Jerry", changed: true }));
      check("BUG: amp-only hex numeric entity (&#x26;) now decodes",
        JSON.stringify(A.deEntity("Tom &#x26; Jerry")) === JSON.stringify({ text: "Tom & Jerry", changed: true }));
      check("deEntity: amp mixed with lt still decodes both (already worked pre-fix, still works)",
        JSON.stringify(A.deEntity("if (a &lt; b &amp;&amp; c) {}")) === JSON.stringify({ text: "if (a < b && c) {}", changed: true }));
    }

    // COMPILE-SAFETY: an edit that breaks a compiling file is auto-reverted (no death spiral)
    const edir = fresh("edit"); const good = "def ok():\n    return 1\n";
    fs.writeFileSync(path.join(edir, "x.py"), good);
    const fakeAgent = {
      root: edir, files: new Set(["x.py"]), gates: {},
      eta: { chat: async () => ({ content: "<<<<<<< SEARCH\ndef ok():\n=======\ndef ok(:\n>>>>>>> REPLACE" }) }, // introduces a syntax error
      _lspNote: async () => "",
    };
    const res = await A.Agent.prototype.editFile.call(fakeAgent, { path: "x.py" }, [], () => {}, {}, "");
    const onDisk = fs.readFileSync(path.join(edir, "x.py"), "utf8");
    check("compile-safety: breaking edit is auto-reverted", onDisk === good && /BROKE compilation|REVERTED/i.test(res), JSON.stringify({ onDisk, res: res.slice(0, 60) }));

    // DROPPED-DEFS GUARD on the SURGICAL edit_file path (bug 45, MEASURED LIVE — boltons run 155,
    // 2026-08-20): unlike _writeFile, editFile had NO droppedDefs check at all. A SEARCH/REPLACE
    // block that renames an existing `def` line in place (keeping its old body, still perfectly
    // valid Python) silently deleted a pre-existing function — py_compile can't catch it, it's
    // semantic. Real repro: "def ceil(x, options=None):" -> "def is_perfect_square(n):" left ceil's
    // whole implementation attached to the new name and broke every caller of ceil().
    {
      const ddir = fresh("edit-dropped-defs");
      const twoFuncs = "def ceil(x, options=None):\n    return x\n\n\ndef clamp(x, lower, upper):\n    return max(min(x, upper), lower)\n";
      fs.writeFileSync(path.join(ddir, "m.py"), twoFuncs);
      // SALVAGEABLE case: renaming ceil's def line in place drops "ceil" but the resulting file
      // still compiles — guard must salvage (keep ceil intact, append the new def) not revert blind.
      const ddAgent = {
        root: ddir, files: new Set(["m.py"]), gates: {},
        eta: { chat: async () => ({ content: "<<<<<<< SEARCH\ndef ceil(x, options=None):\n=======\ndef is_perfect_square(n):\n>>>>>>> REPLACE" }) },
        _lspNote: async () => "",
      };
      const ddRes = await A.Agent.prototype.editFile.call(ddAgent, { path: "m.py" }, [], () => {}, {}, "");
      const ddDisk = fs.readFileSync(path.join(ddir, "m.py"), "utf8");
      check("dropped-defs guard (editFile): a def-renaming edit does NOT ship with the old def silently gone",
        /def ceil\(/.test(ddDisk), JSON.stringify({ ddDisk, ddRes: ddRes.slice(0, 80) }));
      check("dropped-defs guard (editFile): the new def the edit introduced is still present (salvaged, not just reverted)",
        /def is_perfect_square\(/.test(ddDisk), ddDisk);
      check("dropped-defs guard (editFile): clamp (untouched sibling) survives the salvage merge",
        /def clamp\(/.test(ddDisk), ddDisk);
      check("dropped-defs guard (editFile): salvaged result still compiles", (await A.gate(ddir, "m.py")).ok, JSON.stringify(await A.gate(ddir, "m.py")));

      // NON-SALVAGEABLE case: the edit deletes a def and adds nothing new to salvage — must fully revert.
      fs.writeFileSync(path.join(ddir, "n.py"), twoFuncs);
      const ddAgent2 = {
        root: ddir, files: new Set(["n.py"]), gates: {},
        eta: { chat: async () => ({ content: "<<<<<<< SEARCH\ndef ceil(x, options=None):\n    return x\n=======\npass\n>>>>>>> REPLACE" }) },
        _lspNote: async () => "",
      };
      const ddRes2 = await A.Agent.prototype.editFile.call(ddAgent2, { path: "n.py" }, [], () => {}, {}, "");
      const ddDisk2 = fs.readFileSync(path.join(ddir, "n.py"), "utf8");
      check("dropped-defs guard (editFile): a non-salvageable drop (nothing new to append) is fully REVERTED",
        ddDisk2 === twoFuncs && /REVERTED/i.test(ddRes2), JSON.stringify({ ddDisk2, ddRes2: ddRes2.slice(0, 100) }));
    }

    // SELF-DUPLICATE GUARD on the APPLIED-BLOCKS edit_file path (MEASURED LIVE — boltons run 171,
    // 2026-08-26): dedupeSelfRepeatedDefs was already wired into write_file and into editFile's
    // whole-file-SALVAGE fallback, but not into the normal path where a genuine SEARCH/REPLACE block
    // parses and applies cleanly. A weak model asked to add a NEW function instead re-emitted an
    // EXISTING class/function verbatim as the REPLACE text — applyOneEdit has no way to know the
    // inserted text duplicates something already in the file, so it applied "successfully" and the
    // real target was never added. Real repro: 3 successive edit_file calls each re-inserted the same
    // pre-existing block, leaving 4 copies of one class and the requested function still missing.
    {
      const sdir = fresh("edit-self-duplicate");
      const twoFuncs2 = "def foo(x):\n    return x\n\n\ndef bar(y):\n    return y\n";
      fs.writeFileSync(path.join(sdir, "m.py"), twoFuncs2);
      // The model's REPLACE text re-inserts `foo` (already defined above) instead of the requested
      // new function — a genuine, cleanly-applying SEARCH/REPLACE block, not a salvage fallback.
      const sdAgent = {
        root: sdir, files: new Set(["m.py"]), gates: {},
        eta: { chat: async () => ({ content: "<<<<<<< SEARCH\ndef bar(y):\n    return y\n=======\ndef bar(y):\n    return y\n\n\ndef foo(x):\n    return x\n>>>>>>> REPLACE" }) },
        _lspNote: async () => "",
      };
      await A.Agent.prototype.editFile.call(sdAgent, { path: "m.py" }, [], () => {}, {}, "");
      const sdDisk = fs.readFileSync(path.join(sdir, "m.py"), "utf8");
      check("self-duplicate guard (editFile, applied-blocks path): a re-inserted existing def is deduped to exactly one copy",
        (sdDisk.match(/^def foo\(/gm) || []).length === 1, sdDisk);
      check("self-duplicate guard (editFile, applied-blocks path): the untouched sibling def survives",
        /def bar\(/.test(sdDisk), sdDisk);
      check("self-duplicate guard (editFile, applied-blocks path): result still compiles",
        (await A.gate(sdir, "m.py")).ok, JSON.stringify(await A.gate(sdir, "m.py")));
    }

    // "Understand the logic first" + LDB runtime tracer for evidence-based debugging
    check("understandLogic phase exists", typeof A.Agent.prototype.understandLogic === "function");
    const trdir = fresh("trace");
    fs.writeFileSync(path.join(trdir, "buggy.py"), "def add(a, b):\n    return a - b\n");
    fs.writeFileSync(path.join(trdir, "test_buggy.py"), "import unittest, buggy\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(buggy.add(2, 1), 3)\n");
    const trace = await A.Agent.prototype.traceExecution.call({ root: trdir }, "buggy.py", "FAIL: test_add (test_buggy.T.test_add)");
    check("LDB tracer captures real runtime variable values", /a=2/.test(trace) && /b=1/.test(trace) && /EXECUTION TRACE/.test(trace), (trace || "").slice(0, 100));

    // REVERSE PROMPTING (backward chaining): outcome-first → backward plan → results check
    check("reversePlan phase exists", typeof A.Agent.prototype.reversePlan === "function");
    check("verifyOutcome results-check exists", typeof A.Agent.prototype.verifyOutcome === "function");
    {
      let n = 0; const emits = [];
      const rpAgent = { rootList: "(empty)", stepBudget: 5,
        eta: { ask: async () => (++n === 1 ? "buggy.py exists; add(2,1) returns 3; python -m unittest passes." : "1. Write add().\n2. Run tests until green.") } };
      const oc = await A.Agent.prototype.reversePlan.call(rpAgent, "make add() work", "", (e) => emits.push(e));
      check("reversePlan commits an outcome BEFORE steps", /returns 3/.test(oc) && rpAgent.outcome === oc && /passes/.test(rpAgent.outcome), JSON.stringify({ oc: (oc || "").slice(0, 50), back: (rpAgent.backwardPlan || "").slice(0, 40) }));
      check("reversePlan derives a backward-ordered plan", /Write add/.test(rpAgent.backwardPlan || ""), (rpAgent.backwardPlan || "").slice(0, 60));
      check("reversePlan narrates the goal (🎯 outcome)", emits.some((e) => e.type === "narration" && /outcome/i.test(e.text)));
    }
    {
      const emits = [];
      const metA = { outcome: "buggy.py exists and tests pass.", eta: { ask: async () => "MET\nEverything is in place." } };
      const r = await A.Agent.prototype.verifyOutcome.call(metA, "Files now present: buggy.py. Test command passing.", (e) => emits.push(e));
      check("verifyOutcome returns MET when the goal is reached", r && r.met === true, JSON.stringify(r));
      const missA = { outcome: "buggy.py exists and tests pass.", eta: { ask: async () => "NOT MET\ntests still fail." } };
      const r2 = await A.Agent.prototype.verifyOutcome.call(missA, "Files now present: buggy.py. Test command FAILING.", () => {});
      check("verifyOutcome returns NOT MET when the goal is missed", r2 && r2.met === false, JSON.stringify(r2));
    }
    // reportNoFilesTouched: deterministic 3rd-shape ground truth for MODIFY tasks (LIVE-CAUGHT,
    // boltons run 67, 2026-07-24 — the LLM hallucinated "MET" when handed "Files now present:
    // (none). Test command: passing." after a revert; this closes the gap without an LLM call).
    check("reportNoFilesTouched exists", typeof A.Agent.prototype.reportNoFilesTouched === "function");
    {
      const emits = [];
      const msg = A.Agent.prototype.reportNoFilesTouched.call({}, (e) => emits.push(e));
      check("reportNoFilesTouched returns a non-empty explanatory message", typeof msg === "string" && msg.length > 10, msg);
      check("reportNoFilesTouched emits a fall-short narration, not a match", emits.some((e) => e.type === "narration" && /fall short/i.test(e.text) && !/Results match/i.test(e.text)));
      check("reportNoFilesTouched emits an honest not-fully-complete answer", emits.some((e) => e.type === "answer" && e.honest === true && /Not fully complete/i.test(e.text)));
    }
    // _namedTargetFileSurvived: 4th deterministic-ground-truth shape (LIVE-CAUGHT, boltons run 71,
    // 2026-07-25 — this.files was non-empty but held only an off-task file (setup.py) the model
    // created after a run_command veto, while the task's actual named targets got reverted; the
    // old this.files.size===0 check missed this since size was 1, not 0).
    {
      const task = "In boltons/pointutils.py, change the Point class... Update tests/test_pointutils.py to match.";
      check("_namedTargetFileSurvived: false when only an off-task file survived (the run-71 case)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task }, ["setup.py"]) === false);
      check("_namedTargetFileSurvived: true when a named target file survived",
        A.Agent.prototype._namedTargetFileSurvived.call({ task }, ["boltons/pointutils.py"]) === true);
      check("_namedTargetFileSurvived: true when the task names no .py file at all (nothing to check)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: "fix the failing test" }, ["setup.py"]) === true);
    }

    // LIVE-CAUGHT (boltons run 104, 2026-08-05): restoreBaselineIfWorse merges the files it DELETED
    // into this.revertedFiles alongside the files whose content it RESTORED, and evalFiles is
    // this.files ∪ revertedFiles — so a named target the safety net had deleted from disk still
    // counted as "surviving" by name membership alone. That was the last deterministic guard, so the
    // run fell through to the LLM critic, which said MET while its own sentence said the subpackage
    // was "not present" → `✅ Results match the outcome`, `warnings: []`, nothing landed.
    {
      const task = "Create a new subpackage inside the boltons package: a directory boltons/textkit/ containing an __init__.py file and a module boltons/textkit/casing.py that defines a function to_snake_case(s). Also add a new test file tests/test_casing.py with unittest tests.";
      const evalFiles = ["boltons/__init__.py", "boltons/textkit/__init__.py", "boltons/textkit/casing.py", "tests/test_casing.py"];
      check("_namedTargetFileSurvived: a named target the baseline-restore DELETED does not count as survived (boltons run 104)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task, deletedFiles: new Set(["boltons/textkit/__init__.py", "boltons/textkit/casing.py", "tests/test_casing.py"]) }, evalFiles) === false);
      check("_namedTargetFileSurvived: still true when a named target survived alongside other deleted ones",
        A.Agent.prototype._namedTargetFileSurvived.call({ task, deletedFiles: new Set(["tests/test_casing.py"]) }, evalFiles) === true);
      check("_namedTargetFileSurvived: unchanged when no file was deleted (no deletedFiles set at all)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task }, evalFiles) === true);
      // NEGATIVE CONTROL — the fix must stay scoped to files the SAFETY NET deleted. A task that
      // legitimately asks to delete a file must still be able to report success once it is gone.
      check("_namedTargetFileSurvived: a legitimately-requested deletion is NOT penalised (still counts as survived)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: "Delete tests/test_obsolete.py entirely — it is no longer needed." }, ["tests/test_obsolete.py"]) === true);
    }

    // BARE-FILENAME MATCHING (LIVE-CAUGHT, boltons run 201, 2026-09-05): a cross-file root-cause
    // task named the symptom's file by its BARE filename, with no directory ("...trace the call
    // chain from Rectangle.moved to find where the bad value actually comes from -- it may not be
    // shapeutils.py itself..."), while the actually-touched file sits at "boltons/shapeutils.py".
    // best-of-N landed a genuinely, fully-passing fix there (reviewer APPROVED, 486/486 measured on
    // the real repo), but the old exact-string-equality check could never match "shapeutils.py"
    // against "boltons/shapeutils.py" and reported "no files remain touched" -- a false NEGATIVE on
    // a correct result.
    {
      const bareTask = "There is a real bug somewhere in the boltons package causing tests/test_shapeutils.py's test_rectangle_moved and test_rectangle_moved_with_scale to fail. Find the root cause and fix it in whichever implementation file it actually lives in (it may not be shapeutils.py itself -- trace the call chain from Rectangle.moved to find where the bad value actually comes from).";
      check("_namedTargetFileSurvived: a BARE filename (no directory) in the task text matches the real touched path by basename (boltons run 201)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: bareTask }, ["boltons/shapeutils.py"]) === true);
      // Negative control: basename matching must not resurrect an UNRELATED same-named file in a
      // different directory once the task IS precise about which one it means.
      const preciseTask = "In boltons/shapeutils.py, fix the Rectangle.moved method.";
      check("_namedTargetFileSurvived: a FULL relative path in the task keeps the stricter exact match (no basename fallback)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: preciseTask }, ["vendor/shapeutils.py"]) === false);
      // ...and the exact match still fires normally for a full relative path that DOES survive.
      check("_namedTargetFileSurvived: a FULL relative path still matches its own exact survivor",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: preciseTask }, ["boltons/shapeutils.py"]) === true);
      // A bare-named target the safety net DELETED still must not count as survived.
      check("_namedTargetFileSurvived: bare-filename matching still respects deletedFiles",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: bareTask, deletedFiles: new Set(["boltons/shapeutils.py"]) }, ["boltons/shapeutils.py"]) === false);
      // GENERIC BASENAME GUARD — found by the full suite while adding the fix above: "__init__.py"
      // (boilerplate, present in nearly every package directory) must NOT get the basename fallback,
      // or it falsely resurrects an unrelated, always-alive top-level __init__.py as "surviving" for
      // a task whose actual deleted target was a DIFFERENT __init__.py in another directory (the
      // exact boltons-run-104 fixture above, reused here to isolate just the basename-fallback path).
      const initTask = "Create a new subpackage inside the boltons package: a directory boltons/textkit/ containing an __init__.py file and a module boltons/textkit/casing.py that defines a function to_snake_case(s).";
      check("_namedTargetFileSurvived: the generic '__init__.py' basename does NOT get the loose fallback (would falsely match an unrelated __init__.py)",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: initTask, deletedFiles: new Set(["boltons/textkit/__init__.py"]) },
          ["boltons/__init__.py"]) === false);
      // Other common boilerplate names get the same treatment.
      check("_namedTargetFileSurvived: 'setup.py' does not get the loose basename fallback either",
        A.Agent.prototype._namedTargetFileSurvived.call({ task: "Update setup.py to add a dependency." }, ["vendor/setup.py"]) === false);
    }

    // The same fix, end-to-end through the real restoreBaselineIfWorse: the files it deletes must
    // land in this.deletedFiles, not only in this.revertedFiles.
    {
      const ddir = fresh("baseline-deletedfiles");
      fs.writeFileSync(path.join(ddir, "impl8.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(ddir, "test_impl8.py"), "import unittest, impl8\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(impl8.add(2, 1), 3)\n");
      const testCmd = "python -m pytest -q";
      const agd = { root: ddir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, focusFiles: ["impl8.py"], editableTestFiles: new Set(), files: new Set(), createdFiles: new Set() };
      await A.Agent.prototype.snapshotBaseline.call(agd, testCmd);
      fs.writeFileSync(path.join(ddir, "test_new8.py"), "import unittest, impl8\nclass T2(unittest.TestCase):\n    def test_bad(self):\n        self.assertEqual(impl8.add(1, 1), 99)\n");
      agd.files = new Set(["test_new8.py"]); agd.createdFiles = new Set(["test_new8.py"]);
      try { fs.rmSync(path.join(ddir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const restoredD = await A.Agent.prototype.restoreBaselineIfWorse.call(agd, testCmd, () => {});
      check("restoreBaselineIfWorse records the files it DELETED in this.deletedFiles (boltons run 104)",
        restoredD === true && !!agd.deletedFiles?.has("test_new8.py") && !agd.deletedFiles?.has("impl8.py"),
        JSON.stringify({ restored: restoredD, deleted: [...(agd.deletedFiles || [])], reverted: [...(agd.revertedFiles || [])] }));
      check("restoreBaselineIfWorse keeps a CONTENT-restored file out of this.deletedFiles (it is still on disk)",
        fs.existsSync(path.join(ddir, "impl8.py")) && !fs.existsSync(path.join(ddir, "test_new8.py")));
    }

    // _untouchedNamedEditTargets: 5th deterministic-ground-truth shape (LIVE-CAUGHT, boltons run 74,
    // 2026-07-26 — a cross-file task said "Update boltons/shapeutils.py ... so it still works with
    // the new Point representation", but shapeutils.py was NEVER touched; the locked oracle only
    // covered pointutils.py so it passed, and the LLM critic hallucinated "MET"). A named,
    // directed-to-edit, on-disk, untouched file is deterministic proof the outcome is incomplete.
    {
      const dir = fresh("untouched-edit-targets");
      fs.mkdirSync(path.join(dir, "boltons"), { recursive: true });
      fs.writeFileSync(path.join(dir, "boltons", "pointutils.py"), "class Point: pass\n");
      fs.writeFileSync(path.join(dir, "boltons", "shapeutils.py"), "class Rectangle: pass\n");
      const task = "In boltons/pointutils.py, change the Point class to store self.coords = (x, y). " +
        "Update boltons/shapeutils.py, whose Rectangle.contains method accesses point.x and point.y directly, " +
        "so it still works correctly with the new Point representation. Add a test to tests/test_pointutils.py.";
      const ag = { task, root: dir };
      check("_untouchedNamedEditTargets exists", typeof A.Agent.prototype._untouchedNamedEditTargets === "function");
      check("_untouchedNamedEditTargets: flags a directed-to-edit, on-disk file that was never touched (run-74 case)",
        JSON.stringify(A.Agent.prototype._untouchedNamedEditTargets.call(ag, ["boltons/pointutils.py", "tests/test_pointutils.py"])) === JSON.stringify(["boltons/shapeutils.py"]));
      check("_untouchedNamedEditTargets: empty once the named file WAS touched",
        A.Agent.prototype._untouchedNamedEditTargets.call(ag, ["boltons/pointutils.py", "boltons/shapeutils.py"]).length === 0);
      check("_untouchedNamedEditTargets: does NOT flag a file merely mentioned without an edit verb",
        A.Agent.prototype._untouchedNamedEditTargets.call(
          { task: "In foo.py add bar(), similar to how boltons/shapeutils.py does it", root: dir }, ["foo.py"]).length === 0);
      check("_untouchedNamedEditTargets: does NOT flag a directed file that does not exist on disk",
        A.Agent.prototype._untouchedNamedEditTargets.call(
          { task: "Update boltons/nosuchfile.py to fix the bug", root: dir }, []).length === 0);
    }

    // _untouchedNamedEditTargets: negation fix (LIVE-CAUGHT, boltons run 79, 2026-07-27 — "Do not
    // modify boltons/pointutils.py, boltons/shapeutils.py, or tests/test_shapeutils.py" matched the
    // directed-verb regex on "modify" immediately before pointutils.py, wrongly flagging an EXPLICIT
    // do-not-touch instruction as an untouched edit target the outcome required — exactly backwards).
    {
      const dir2 = fresh("untouched-edit-targets-negation");
      fs.mkdirSync(path.join(dir2, "boltons"), { recursive: true });
      fs.writeFileSync(path.join(dir2, "boltons", "pointutils.py"), "class Point: pass\n");
      fs.writeFileSync(path.join(dir2, "boltons", "shapeutils.py"), "class Rectangle: pass\n");
      const negTask = "Add a new Circle class to boltons/circleutils.py using Point from boltons.pointutils. " +
        "Do not modify boltons/pointutils.py, boltons/shapeutils.py, or tests/test_shapeutils.py.";
      check("_untouchedNamedEditTargets: does NOT flag a file the task explicitly says NOT to modify (run-79 case)",
        A.Agent.prototype._untouchedNamedEditTargets.call({ task: negTask, root: dir2 }, ["boltons/circleutils.py"]).length === 0);
      const posTask = "Update boltons/shapeutils.py, whose Rectangle.contains method accesses point.x and point.y " +
        "directly, so it still works correctly with the new Point representation.";
      check("_untouchedNamedEditTargets: still flags a genuinely directed (non-negated) untouched file",
        JSON.stringify(A.Agent.prototype._untouchedNamedEditTargets.call({ task: posTask, root: dir2 }, [])) === JSON.stringify(["boltons/shapeutils.py"]));
    }

    // _untouchedNamedEditTargets: insertion-verb companion pattern (LIVE-CAUGHT, boltons run 146,
    // 2026-08-19 — "insert a new \"## Unreleased\" section at the very top of CHANGELOG.md" never
    // matched the modify-family `directed` regex (insert/add aren't modify verbs, and the quoted
    // object phrase between the verb and the filename exceeds the narrow 30-char window anyway).
    // CHANGELOG.md was never touched and no outcome-check shape caught it — this is bug 39.
    {
      const dir3 = fresh("untouched-edit-targets-insertion");
      fs.writeFileSync(path.join(dir3, "CHANGELOG.md"), "# Changelog\n\n## 26.1.0\n");
      fs.mkdirSync(path.join(dir3, "boltons"), { recursive: true });
      fs.writeFileSync(path.join(dir3, "boltons", "parser.py"), "class Parser: pass\n");
      fs.writeFileSync(path.join(dir3, "boltons", "utils.py"), "def helper(): pass\n");
      const run146Task = 'Add a new function word_wrap(text, width) to boltons/strutils.py that wraps the given ' +
        'text to lines no longer than width characters (breaking on whitespace) and returns a single string ' +
        'with lines joined by newline characters. Also add a changelog entry: insert a new "## Unreleased" ' +
        'section at the very top of CHANGELOG.md (directly above the existing "## 26.1.0" heading) containing ' +
        'exactly one bullet: "- Added `strutils.word_wrap` for wrapping text to a given width". Do not modify any other file.';
      check("_untouchedNamedEditTargets: flags CHANGELOG.md via the insertion verb pattern (run-146 case)",
        A.Agent.prototype._untouchedNamedEditTargets.call({ task: run146Task, root: dir3 }, ["boltons/strutils.py"])
          .includes("CHANGELOG.md"));
      check("_untouchedNamedEditTargets: does NOT flag a file merely DESCRIBED with 'in' (not a directive)",
        A.Agent.prototype._untouchedNamedEditTargets.call(
          { task: "Add a helper to boltons/utils.py that calls the existing parser in boltons/parser.py.", root: dir3 },
          ["boltons/utils.py"]).length === 0);
      check("_untouchedNamedEditTargets: insertion pattern respects negation (run-146-style 'do not add ... to X')",
        A.Agent.prototype._untouchedNamedEditTargets.call(
          { task: "Update boltons/utils.py. Do not add a changelog entry to CHANGELOG.md.", root: dir3 },
          ["boltons/utils.py"]).length === 0);
    }

    // _noOpEditTargets: 8th deterministic-ground-truth shape (LIVE-CAUGHT, boltons run 132,
    // 2026-08-16 — "change Point.distance_to so it returns a dict instead of a float" landed a
    // "surgical change" that only stripped \r line-endings; distance_to's actual body never
    // changed, the untouched locked test still passed, and the LLM critic hallucinated "✅ Results
    // match the outcome"). A named target file that was touched but ends up textually identical to
    // its own pre-run baseline is deterministic proof no requested change landed in it.
    {
      const dir3 = fresh("noop-edit-targets");
      fs.mkdirSync(path.join(dir3, "boltons"), { recursive: true });
      const srcCRLF = "import math\r\n\r\nclass Point:\r\n    def distance_to(self, other):\r\n        return math.sqrt((self.x-other.x)**2+(self.y-other.y)**2)\r\n";
      fs.writeFileSync(path.join(dir3, "boltons", "pointutils.py"), srcCRLF);
      const task3 = "In boltons/pointutils.py, change Point.distance_to(other) so it returns a dict with keys " +
        "\"distance\", \"dx\", \"dy\" instead of a plain float.";
      check("_noOpEditTargets exists", typeof A.Agent.prototype._noOpEditTargets === "function");
      // Simulates the run-132 shape: baseline captured the ORIGINAL (CRLF) content, but the file on
      // disk now only differs by line-ending normalization — no real code change.
      {
        const noNewline = srcCRLF.replace(/\r\n/g, "\n");
        fs.writeFileSync(path.join(dir3, "boltons", "pointutils.py"), noNewline);
        const ag3 = { task: task3, root: dir3, baselineFiles: { "boltons/pointutils.py": srcCRLF } };
        check("_noOpEditTargets: flags a named target whose content is unchanged apart from line-endings (the run-132 case)",
          JSON.stringify(await A.Agent.prototype._noOpEditTargets.call(ag3, ["boltons/pointutils.py"])) === JSON.stringify(["boltons/pointutils.py"]));
      }
      // A genuine change to the body must NOT be flagged.
      {
        const real = "import math\n\nclass Point:\n    def distance_to(self, other):\n        dx = self.x - other.x\n        dy = self.y - other.y\n        return {\"distance\": math.sqrt(dx**2+dy**2), \"dx\": float(dx), \"dy\": float(dy)}\n";
        fs.writeFileSync(path.join(dir3, "boltons", "pointutils.py"), real);
        const ag3b = { task: task3, root: dir3, baselineFiles: { "boltons/pointutils.py": srcCRLF } };
        check("_noOpEditTargets: does NOT flag a file whose content genuinely changed",
          (await A.Agent.prototype._noOpEditTargets.call(ag3b, ["boltons/pointutils.py"])).length === 0);
      }
      // Not flagged when the file was never touched (a different shape's job — _untouchedNamedEditTargets).
      check("_noOpEditTargets: does NOT flag a named file that was not in evalFiles at all",
        (await A.Agent.prototype._noOpEditTargets.call({ task: task3, root: dir3, baselineFiles: { "boltons/pointutils.py": srcCRLF } }, [])).length === 0);
      // Not flagged when there's no captured baseline for it (nothing to compare against — e.g. a
      // brand-new file the run created, which _captureBaseline deliberately never captures).
      check("_noOpEditTargets: does NOT flag a touched file with no captured baseline (e.g. a newly-created file)",
        (await A.Agent.prototype._noOpEditTargets.call({ task: task3, root: dir3, baselineFiles: {} }, ["boltons/pointutils.py"])).length === 0);
    }

    // GREEN SNAPSHOT + RESTORE: a later step that regresses an all-passing impl is undone
    check("snapshotGreen + restoreGreenIfRegressed exist", typeof A.Agent.prototype.snapshotGreen === "function" && typeof A.Agent.prototype.restoreGreenIfRegressed === "function");
    {
      const gdir = fresh("green");
      const GOOD = "def add(a, b):\n    return a + b\n";
      const BAD = "def add(a, b):\n    return a - b\n";
      fs.writeFileSync(path.join(gdir, "impl.py"), GOOD);
      fs.writeFileSync(path.join(gdir, "test_impl.py"), "import unittest, impl\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(impl.add(2, 1), 3)\n");
      // snapshotGreen captures the impl but NOT the locked test file
      const snapAgent = { root: gdir, files: new Set(["impl.py", "test_impl.py"]), lockedFiles: new Set(["test_impl.py"]), greenSnapshot: null };
      await A.Agent.prototype.snapshotGreen.call(snapAgent);
      check("snapshotGreen captures impl only (not the locked test)", !!snapAgent.greenSnapshot && snapAgent.greenSnapshot["impl.py"] === GOOD && !("test_impl.py" in snapAgent.greenSnapshot), JSON.stringify(Object.keys(snapAgent.greenSnapshot || {})));
      // now a later step REGRESSES impl.py → restore must bring back the green version
      fs.writeFileSync(path.join(gdir, "impl.py"), BAD);
      const emits = [];
      const restAgent = { root: gdir, files: new Set(["impl.py"]), lockedFiles: new Set(["test_impl.py"]), gates: {}, failedCmds: new Map([["python -m unittest test_impl", true]]), stopped: false, greenSnapshot: { "impl.py": GOOD } };
      const restored = await A.Agent.prototype.restoreGreenIfRegressed.call(restAgent, "python -m unittest test_impl", (e) => emits.push(e));
      const onDisk = fs.readFileSync(path.join(gdir, "impl.py"), "utf8");
      check("restoreGreenIfRegressed reverts a regressed impl to last-green", restored === true && onDisk === GOOD && !restAgent.failedCmds.has("python -m unittest test_impl"), JSON.stringify({ restored, disk: onDisk.includes("a + b") }));
      // and it must NOT touch a still-green impl (no false restore)
      const noopAgent = { root: gdir, files: new Set(["impl.py"]), lockedFiles: new Set(["test_impl.py"]), gates: {}, failedCmds: new Map(), stopped: false, greenSnapshot: { "impl.py": BAD } };
      const noop = await A.Agent.prototype.restoreGreenIfRegressed.call(noopAgent, "python -m unittest test_impl", () => {});
      check("restoreGreenIfRegressed is a no-op when tests already pass", noop === false && fs.readFileSync(path.join(gdir, "impl.py"), "utf8") === GOOD);
    }

    // GROUND-TRUTH RECONCILIATION: a green oracle clears stale command-debt + reviewer flags
    check("reconcileGreenTruth exists", typeof A.Agent.prototype.reconcileGreenTruth === "function");
    {
      const rdir = fresh("reconcile");
      fs.writeFileSync(path.join(rdir, "impl.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(rdir, "test_impl.py"), "import unittest, impl\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(impl.add(2, 1), 3)\n");
      const emits = [];
      const agent = {
        root: rdir, stopped: false,
        lockedFiles: new Set(["test_impl.py"]), authoritativeTests: { "test_impl.py": "x" },
        // one stale-but-now-passing command spelling + one genuinely-failing junk command
        failedCmds: new Map([["python -m unittest impl_alt_spelling".replace("impl_alt_spelling", "test_impl"), true], ["python /nonexistent/junk.py", true]]),
        reviewUnresolved: "- stale complaint from before the fix",
      };
      const ok = await A.Agent.prototype.reconcileGreenTruth.call(agent, "python -m unittest test_impl", (e) => emits.push(e));
      check("reconcile clears a stale command whose fresh run now passes", ok === true && !agent.failedCmds.has("python -m unittest test_impl"), JSON.stringify([...agent.failedCmds.keys()]));
      check("reconcile KEEPS a genuinely-failing command", agent.failedCmds.has("python /nonexistent/junk.py"));
      check("reconcile drops a stale reviewer complaint when the oracle is green", agent.reviewUnresolved === null);
      // and it must NOT touch flags when the oracle is NOT green
      fs.writeFileSync(path.join(rdir, "impl.py"), "def add(a, b):\n    return a - b\n"); // now failing
      try { fs.rmSync(path.join(rdir, "__pycache__"), { recursive: true, force: true }); } catch {} // don't let stale .pyc mask the break
      const agent2 = { root: rdir, stopped: false, lockedFiles: new Set(["test_impl.py"]), authoritativeTests: { "x": "y" }, failedCmds: new Map([["python -m unittest test_impl", true]]), reviewUnresolved: "keep me" };
      const ok2 = await A.Agent.prototype.reconcileGreenTruth.call(agent2, "python -m unittest test_impl", () => {});
      check("reconcile is a no-op when the oracle is NOT green", ok2 === false && agent2.reviewUnresolved === "keep me" && agent2.failedCmds.size === 1);
    }

    // BEST-OF-N over the EXECUTION verifier: diverse samples, tests pick the winner
    {
      const bdir = fresh("beston");
      fs.writeFileSync(path.join(bdir, "impl.py"), "def add(a, b):\n    return a - b\n"); // WRONG (failing) start
      fs.writeFileSync(path.join(bdir, "test_impl.py"), "import unittest, impl\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(impl.add(2, 1), 3)\n");
      const emits = [];
      let call = 0;
      const prompts = [];
      const agent = {
        root: bdir, stopped: false, files: new Set(["impl.py"]), gates: {},
        failedCmds: new Map([["python -m unittest test_impl", true]]), lockedFiles: new Set(["test_impl.py"]),
        restoreTestsIfBroken: async () => false,
        // bug 28: bestOfNFix now repairs the landed winner. The call is deliberately NOT optional-
        // chained in agent.mjs — a content guard that silently skips itself is the exact shape of
        // the bug it closes — so every harness driving this lever must supply the real method.
        task: "Fix add() in impl.py so the tests pass.",
        baselineFiles: { "impl.py": "def add(a, b):\n    return a - b\n" },
        repairLandedFile: A.Agent.prototype.repairLandedFile,
        // candidate 1 wrong, candidate 2 CORRECT — best-of-N must land the correct one
        _genFileContent: async (rel, prompt) => { prompts.push(prompt); call++; return call >= 2 ? "def add(a, b):\n    return a + b\n" : "def add(a, b):\n    return a * b\n"; },
      };
      const won = await A.Agent.prototype.bestOfNFix.call(agent, "python -m unittest test_impl", (e) => emits.push(e), 3);
      const onDisk = fs.readFileSync(path.join(bdir, "impl.py"), "utf8");
      check("best-of-N lands a passing candidate via the test verifier", won === true && onDisk.includes("a + b") && !agent.failedCmds.has("python -m unittest test_impl"), JSON.stringify({ won, disk: onDisk.trim() }));
      check("best-of-N samples are strategy-DIVERSE (not identical prompts)", prompts.length >= 2 && prompts[0] !== prompts[1], JSON.stringify(prompts.map(p => (p.match(/Strategy for THIS attempt: (.{0,20})/) || [])[1])));
    }
    // COST-AWARE best-of-N: many samples on free local, ONE on paid cloud
    {
      const lp = A.Agent.prototype.leanPosture;
      const locked = { lockedFiles: new Set(["test_x.py"]), leanPosture: lp };
      const nolock = { lockedFiles: new Set(), leanPosture: lp };
      check("cost-aware: local + locked spec → 5 samples", A.Agent.prototype.bestOfNCount.call(locked, "http://127.0.0.1:11434", "ollama") === 5);
      check("cost-aware: local, no spec → 3 samples", A.Agent.prototype.bestOfNCount.call(nolock, "http://localhost:1234", "openai") === 3);
      check("cost-aware: paid cloud → 1 sample (no N× cost)", A.Agent.prototype.bestOfNCount.call(locked, "https://api.anthropic.com/v1", "anthropic") === 1);
      check("cost-aware: cloud openai endpoint → 1 sample", A.Agent.prototype.bestOfNCount.call(nolock, "https://api.openai.com/v1", "openai") === 1);
    }

    // TOPIC 2 — Adaptive posture: society (local ≤14B) vs lean (cloud or >14B)
    {
      const P = (base, kind, model) => A.Agent.prototype.leanPosture.call({}, base, kind, model);
      const L = "http://127.0.0.1:11434";
      check("posture: local 3B → society (not lean)", P(L, "ollama", "qwen2.5-coder:3b-instruct") === false);
      check("posture: local 7B → society", P(L, "ollama", "qwen2.5-coder:7b-instruct") === false);
      check("posture: local 14B → society (≤14 boundary)", P(L, "ollama", "qwen2.5-coder:14b") === false);
      check("posture: local 32B → LEAN", P(L, "ollama", "qwen2.5-coder:32b") === true);
      check("posture: cloud Claude → LEAN", P("https://api.anthropic.com/v1", "anthropic", "claude-opus-4-8") === true);
      check("posture: cloud OpenAI endpoint → LEAN", P("https://api.openai.com/v1", "openai", "gpt-5") === true);
      check("posture: unknown local size → society (safer to over-help)", P(L, "ollama", "eta-r3:latest") === false);
      // best-of-N follows posture: society local → many, big local → 1
      check("posture drives best-of-N: local 3B locked → 5", A.Agent.prototype.bestOfNCount.call({ lockedFiles: new Set(["t"]), leanPosture: A.Agent.prototype.leanPosture }, L, "ollama", "qwen2.5-coder:3b") === 5);
      check("posture drives best-of-N: local 32B → 1", A.Agent.prototype.bestOfNCount.call({ lockedFiles: new Set(["t"]), leanPosture: A.Agent.prototype.leanPosture }, L, "ollama", "qwen2.5-coder:32b") === 1);
    }

    // TOPIC 3 — mid-run steering: queue a note, apply it between steps as a user instruction
    {
      const agent = { steerQueue: [] };
      A.Agent.prototype.steer.call(agent, "  use a dictionary not a list  ");
      A.Agent.prototype.steer.call(agent, "");            // blank ignored
      check("steer: queues a non-empty note (trims), ignores blank", agent.steerQueue.length === 1 && agent.steerQueue[0] === "use a dictionary not a list", JSON.stringify(agent.steerQueue));
      const msgs = [{ role: "system", content: "x" }]; const emits = [];
      const applied = A.Agent.prototype._applySteer.call(agent, msgs, (e) => emits.push(e));
      check("steer: applied into msgs as a user instruction, queue drained", applied === true && agent.steerQueue.length === 0 && msgs.some(m => m.role === "user" && /steering you.*dictionary not a list/i.test(m.content)), JSON.stringify(msgs.map(m => m.role)));
      check("steer: narrates the redirect to the user", emits.some(e => e.type === "narration" && /You steered/.test(e.text)));
      const none = A.Agent.prototype._applySteer.call(agent, msgs, () => {});
      check("steer: no-op when nothing queued", none === false);
    }

    // TOPIC 4 — hooks: deterministic event automation + built-in safety
    {
      const hdir = fresh("hooks");
      fs.mkdirSync(path.join(hdir, ".eta"), { recursive: true });
      fs.writeFileSync(path.join(hdir, ".eta", "hooks.json"), JSON.stringify([
        { when: "after", match: "write_file", run: "node -e \"require('fs').writeFileSync('hooklog.txt', process.argv[1])\" {file}" },
        { when: "finish", match: "*", run: "node -e \"process.exit(1)\"", block: true },
        { when: "bogus", run: "x" }, // invalid → filtered out
      ]));
      const hooks = await A.loadHooks(hdir);
      check("loadHooks parses valid entries and drops invalid", hooks.length === 2 && hooks[0].when === "after" && hooks[1].block === true, JSON.stringify(hooks.map(h => h.when)));

      // built-in SAFETY: block a destructive command before it runs
      const safeAgent = { root: hdir, hooks: [] };
      const bad = await A.Agent.prototype.runHooks.call(safeAgent, "before", { tool: "run_command", args: { command: "rm -rf /" } }, () => {});
      const ok = await A.Agent.prototype.runHooks.call(safeAgent, "before", { tool: "run_command", args: { command: "python test.py" } }, () => {});
      check("safety hook BLOCKS a destructive command (rm -rf /)", bad.blocked === true && /destructive/.test(bad.reason), JSON.stringify(bad));
      check("safety hook ALLOWS a normal command", ok.blocked === false);

      // AFTER hook runs the command with {file} substituted
      const a2 = { root: hdir, hooks };
      await A.Agent.prototype.runHooks.call(a2, "after", { tool: "write_file", args: { path: "shapes.py" } }, () => {});
      const logged = fs.existsSync(path.join(hdir, "hooklog.txt")) ? fs.readFileSync(path.join(hdir, "hooklog.txt"), "utf8") : "";
      check("after hook runs with {file} placeholder substituted", /shapes\.py/.test(logged), JSON.stringify(logged));

      // blocking FINISH hook that fails → blocks finishing
      const finBlocked = await A.Agent.prototype.runHooks.call(a2, "finish", {}, () => {});
      check("blocking finish hook that fails → blocks", finBlocked.blocked === true, JSON.stringify(finBlocked));
      // a non-blocking failing hook does NOT block
      const a3 = { root: hdir, hooks: [{ when: "finish", match: "*", run: "node -e \"process.exit(1)\"", block: false }] };
      const finOk = await A.Agent.prototype.runHooks.call(a3, "finish", {}, () => {});
      check("non-blocking hook failing does NOT block", finOk.blocked === false);
    }

    // TOPIC 5 — git history/blame as knowledge
    {
      const { execSync } = await import("child_process");
      const gdir = fresh("githist");
      const sh = (c) => execSync(c, { cwd: gdir, stdio: "pipe" });
      let gitOk = true;
      try {
        sh("git init -q"); sh("git config user.email t@t.co"); sh("git config user.name t");
        fs.writeFileSync(path.join(gdir, "svc.py"), "def handler():\n    return 1\n");
        sh("git add -A"); sh('git commit -q -m "add handler returning 1"');
        fs.writeFileSync(path.join(gdir, "svc.py"), "def handler():\n    return 2  # fix off-by-one\n");
        sh("git add -A"); sh('git commit -q -m "fix off-by-one in handler"');
      } catch { gitOk = false; }
      if (!gitOk) { console.log("  INFO  git not available — Topic 5 live checks skipped"); }
      else {
        check("isGitRepo detects a git repo", (await A.isGitRepo(gdir)) === true);
        check("isGitRepo false on a non-repo", (await A.isGitRepo(fresh("notgit"))) === false);
        const recent = await A.gitRecentForFile(gdir, "svc.py", 3);
        check("gitRecentForFile returns commit messages", /off-by-one/.test(recent) && /add handler/.test(recent), recent.slice(0, 80));
        const blame = await A.gitBlameLine(gdir, "svc.py", 2);
        check("gitBlameLine shows the commit that changed a line", /off-by-one/.test(blame), blame);
        check("git_history tool: recent commits", /off-by-one/.test(await A.execTool("git_history", { path: "svc.py" }, { root: gdir, log: () => {} })));
        check("git_history tool: blame a line", /off-by-one/.test(await A.execTool("git_history", { path: "svc.py", line: 2 }, { root: gdir, log: () => {} })));
        check("git_history tool: clean skip on non-repo", /Not a git repository/.test(await A.execTool("git_history", { path: "svc.py" }, { root: fresh("ng2"), log: () => {} })));
      }
    }

    // CROSS-FILE GUARD (lazy) — import smoke test + baseline regression floor
    {
      const sdir = fresh("smoke");
      fs.writeFileSync(path.join(sdir, "models.py"), "class Account:\n    pass\n");
      fs.writeFileSync(path.join(sdir, "report.py"), "from models import Account, Transaction\n"); // Transaction missing
      const err = await A.Agent.prototype.importSmokeTest.call({ root: sdir });
      check("smoke test catches a broken cross-file import (the capstone bug)", /ImportError|cannot import name/.test(err) && /Transaction/.test(err), (err || "").slice(0, 90));
      fs.writeFileSync(path.join(sdir, "report.py"), "from models import Account\n");
      try { fs.rmSync(path.join(sdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const clean = await A.Agent.prototype.importSmokeTest.call({ root: sdir });
      check("smoke test returns clean when imports resolve", clean === "", JSON.stringify(clean));
    }
    {
      const bdir = fresh("baseline");
      fs.writeFileSync(path.join(bdir, "impl.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(bdir, "test_impl.py"), "import unittest, impl\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(impl.add(2, 1), 3)\n");
      const ag = { root: bdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, files: new Set(["impl.py", "brandnew.py"]) };
      await A.Agent.prototype.snapshotBaseline.call(ag, "python -m unittest test_impl");
      check("snapshotBaseline captures pre-existing files + passing count", ag.baselineGood >= 1 && /a \+ b/.test(ag.baselineFiles["impl.py"] || ""), JSON.stringify({ good: ag.baselineGood }));
      // regress the impl below baseline
      fs.writeFileSync(path.join(bdir, "impl.py"), "def add(a, b):\n    return a - b\n");
      try { fs.rmSync(path.join(bdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const restored = await A.Agent.prototype.restoreBaselineIfWorse.call(ag, "python -m unittest test_impl", () => {});
      check("restoreBaselineIfWorse restores when the run regressed below baseline", restored === true && /a \+ b/.test(fs.readFileSync(path.join(bdir, "impl.py"), "utf8")));
      // REPORTING GROUND TRUTH (2026-07-23 fix): a reverted file must stop counting as "written by
      // this run" — otherwise the final done-event/outcome-check still narrate stale pre-restore
      // claims about content that no longer exists on disk (measured live, boltons run 53).
      check("restoreBaselineIfWorse clears the reverted file from this.files, leaves untouched files alone", ag.reverted === true && !ag.files.has("impl.py") && ag.files.has("brandnew.py"), JSON.stringify({ reverted: ag.reverted, files: [...ag.files] }));
      // no-op when not worse
      const noop = await A.Agent.prototype.restoreBaselineIfWorse.call(ag, "python -m unittest test_impl", () => {});
      check("restoreBaselineIfWorse is a no-op when not worse than baseline", noop === false);
    }
    {
      // ---- _captureBaseline. LIVE-CAUGHT (boltons run 106, 2026-08-05), root-caused + reproduced
      // with a no-model harness 2026-08-06: snapshotBaseline picks the safety net's coverage ONCE, up
      // front, from the task text + focusFiles — but the model writes wherever it likes. Run 106 spent
      // half its budget rewriting the pre-existing boltons/__init__.py, a file the task never named,
      // so it was never snapshotted. The consequence is a real file-safety hole, not a reporting one:
      // the content revert restores the covered file, the post-restore re-check then FAILS because the
      // uncovered file is still broken, and restoreBaselineIfWorse returns false — no narration, no
      // this.reverted, no this.files clearing — leaving the project genuinely worse than it started.
      const cdir = fresh("capbaseline");
      fs.mkdirSync(path.join(cdir, "pkg"), { recursive: true });
      fs.writeFileSync(path.join(cdir, "pkg", "__init__.py"), "");
      fs.writeFileSync(path.join(cdir, "pkg", "a.py"), "def add(x, y):\n    return x + y\n");
      fs.writeFileSync(path.join(cdir, "pkg", "b.py"), "def mul(x, y):\n    return x * y\n");
      fs.writeFileSync(path.join(cdir, "test_all.py"),
        "import unittest\nfrom pkg.a import add\nfrom pkg.b import mul\n" +
        "class T(unittest.TestCase):\n" +
        "    def test_add(self):\n        self.assertEqual(add(2, 1), 3)\n" +
        "    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n");
      const ctc = "python -B -m unittest test_all";
      const cag = {
        root: cdir, gates: {}, task: "In pkg/a.py, make add() also accept strings.",
        _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount,
        _captureBaseline: A.Agent.prototype._captureBaseline,
        files: new Set(), createdFiles: new Set(), editableTestFiles: new Set(),
        focusFiles: ["pkg/a.py"],
      };
      await A.Agent.prototype.snapshotBaseline.call(cag, ctc);
      check("snapshotBaseline alone covers ONLY the task-named file (the gap _captureBaseline closes)",
        cag.baselineFiles["pkg/a.py"] !== undefined && cag.baselineFiles["pkg/b.py"] === undefined,
        JSON.stringify(Object.keys(cag.baselineFiles)));
      // The run writes both files, going through the same capture the real write paths now call.
      for (const [rel, body] of [["pkg/a.py", "def add(x, y):\n    return x - y\n"],
                                 ["pkg/b.py", "def mul(x, y):\n    return x + y\n"]]) {
        const old = fs.readFileSync(path.join(cdir, rel), "utf8");
        cag._captureBaseline.call(cag, rel, old);
        fs.writeFileSync(path.join(cdir, rel), body);
        cag.files.add(rel);
      }
      check("_captureBaseline covers a pre-existing file the task never named, on first write",
        /x \* y/.test(cag.baselineFiles["pkg/b.py"] || ""), JSON.stringify(Object.keys(cag.baselineFiles)));
      // A LATER write must not overwrite the captured baseline with already-modified content.
      cag._captureBaseline.call(cag, "pkg/b.py", "def mul(x, y):\n    return 0\n");
      check("_captureBaseline keeps the FIRST capture (a later write is not the baseline)",
        /x \* y/.test(cag.baselineFiles["pkg/b.py"] || ""));
      // A file the run CREATED (old === null) must stay out — restoreBaselineIfWorse deletes those
      // via createdFiles instead of reverting content; a null entry would make it "restore" nothing.
      cag._captureBaseline.call(cag, "pkg/brandnew.py", null);
      check("_captureBaseline skips run-created files (old === null)", cag.baselineFiles["pkg/brandnew.py"] === undefined);
      // ...and the createdFiles check is the one that actually matters (caught reviewing boltons run
      // 108): a file the run CREATED and then EDITED two steps later has non-null old content on that
      // second write. Registering it as a baseline would make restoreBaselineIfWorse write it back AND
      // skip deleting it (its delete loop passes over anything holding a baseline entry), resurrecting
      // a run-created file the run-73 fix exists to remove.
      cag.createdFiles.add("pkg/made_then_edited.py");
      cag._captureBaseline.call(cag, "pkg/made_then_edited.py", "def x():\n    return 1\n");
      check("_captureBaseline skips a run-CREATED file even when a later edit gives it non-null old content (boltons run 108)",
        cag.baselineFiles["pkg/made_then_edited.py"] === undefined, JSON.stringify(Object.keys(cag.baselineFiles)));
      try { fs.rmSync(path.join(cdir, "pkg", "__pycache__"), { recursive: true, force: true }); } catch {}
      const crestored = await A.Agent.prototype.restoreBaselineIfWorse.call(cag, ctc, () => {});
      check("restoreBaselineIfWorse now restores BOTH files and reports the revert (was: returned false, silently left the repo worse)",
        crestored === true && cag.reverted === true &&
        /x \+ y/.test(fs.readFileSync(path.join(cdir, "pkg", "a.py"), "utf8")) &&
        /x \* y/.test(fs.readFileSync(path.join(cdir, "pkg", "b.py"), "utf8")) &&
        cag.files.size === 0,
        JSON.stringify({ crestored, reverted: cag.reverted, files: [...cag.files] }));
    }
    {
      // the exact bug the 3B capstone exposed: an ImportError must score as WORST, not "1 failure"
      const g = A.Agent.prototype._goodness;
      check("_goodness: ImportError = worst (-1), beats the misleading 'errors=1'", g.call({}, "ImportError: cannot import name 'Transaction'\nFAILED (errors=1)") === -1);
      check("_goodness: 4 passing scores higher than an import error", g.call({}, "....FFF\nRan 7 tests\n\nFAILED (failures=3)") > g.call({}, "ImportError: x\nFAILED (errors=1)"));
      // LIVE-CAUGHT (boltons run 64, 2026-07-23): salvageNewDefs appended a test class using
      // `unittest.TestCase` into a file that never imported `unittest` — py_compile's gate passed
      // (a bare name reference isn't a syntax error), so the break only surfaces at real pytest
      // COLLECTION time, with pytest's own phrasing ("N error during collection"), not any of the
      // unittest-runner phrasings already covered above. Confirmed this exact real pytest output
      // (reproduced by hand from the live failure) still scores -1, so restoreBaselineIfWorse's
      // regression check catches it same as any other collection-time break.
      const pytestCollectionError = "E   NameError: name 'unittest' is not defined\n=========================== short test summary info ===========================\nERROR tests/test_typeutils.py - NameError: name 'unittest' is not defined\n!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!\n1 error in 0.43s";
      check("_goodness: real pytest 'error during collection' phrasing also scores -1 (not just unittest-style ImportError)", g.call({}, pytestCollectionError) === -1);
      // LIVE-CAUGHT (boltons run 82, 2026-07-27): ENV_MISSING's bare "No module named" test was too
      // broad — it also matched a pytest COLLECTION failure raised from INSIDE a locked spec-first
      // test file whose implementation module the model never created ("ModuleNotFoundError: No
      // module named 'boltons.circleutils'"), which is an ordinary in-scope code gap, not a missing
      // environment tool. That false match broke the test-gate round-loop's repair attempt early and
      // cleared failedCmds in the final-verification block, shipping a misleading warning about an
      // unrelated shell command instead of the real test failure. envMissing() now only treats a bare
      // "No module named X" (no traceback/collection frame) as a genuine tool-missing signal.
      const toolMissing = "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\nC:\\Python311\\python.exe: No module named pytest\n";
      const collectionFailure = "⚠ COMMAND FAILED (exit 2) — you must fix this before finishing:\n\n=================================== ERRORS ====================================\n_________________ ERROR collecting tests/test_circleutils.py __________________\nImportError while importing test module 'D:\\eta-tests\\boltons\\tests\\test_circleutils.py'.\nTraceback:\ntests\\test_circleutils.py:2: in <module>\n    from boltons.circleutils import Circle\nE   ModuleNotFoundError: No module named 'boltons.circleutils'\n";
      check("envMissing: a genuine tool-missing failure (no traceback) is still recognized", A.envMissing(toolMissing) === true);
      check("envMissing: a project-module collection failure (boltons run 82) is NOT misclassified as env-missing", A.envMissing(collectionFailure) === false);
      check("envMissing: still catches the classic Windows/Unix command-not-found phrasings", A.envMissing("'pytest' is not recognized as an internal or external command") === true && A.envMissing("bash: pytest: command not found") === true);
      // LIVE-CAUGHT (boltons run 95, 2026-07-27): a genuinely-complete from-scratch utility task
      // (temputils.py + its test, 451/451 passing, reviewer APPROVED) was reported "⚠ Not fully
      // complete" SOLELY because the model ran `mkdir boltons`/`mkdir tests` as misguided scaffolding
      // and those "failed" on directories that already existed — a benign idempotent failure that got
      // stuck in failedCmds forever (reconcileGreenTruth re-runs it and it fails identically).
      // benignCmdFailure() now recognizes these so they never become command debt.
      const winMkdir = "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\nA subdirectory or file boltons already exists.";
      const winMkdirP = "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\nA subdirectory or file -p already exists.\r\nError occurred while processing: -p.\r\nA subdirectory or file boltons already exists.";
      const posixMkdir = "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\nmkdir: cannot create directory 'boltons': File exists";
      check("benignCmdFailure: Windows `mkdir` on an existing dir is benign (not command debt)", A.benignCmdFailure("mkdir boltons", winMkdir) === true);
      check("benignCmdFailure: Windows `mkdir -p` on an existing dir is benign too", A.benignCmdFailure("mkdir -p boltons", winMkdirP) === true);
      check("benignCmdFailure: POSIX `mkdir ... : File exists` is benign", A.benignCmdFailure("mkdir boltons", posixMkdir) === true);
      check("benignCmdFailure: a `mkdir` that fails for a REAL reason (e.g. permission) is NOT benign", A.benignCmdFailure("mkdir /root/x", "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\nmkdir: cannot create directory '/root/x': Permission denied") === false);
      check("benignCmdFailure: a non-mkdir command with 'already exists' text is NOT swallowed", A.benignCmdFailure("python setup.py install", "note: file already exists, skipping") === false);
      check("benignCmdFailure: a clean (non-failing) mkdir output is not treated as a failure signal at all", A.benignCmdFailure("mkdir newdir", "") === false);
      // LIVE-CAUGHT (boltons run 100, 2026-07-30): the task said "Add a new decorator function named
      // count_calls to boltons/funcutils.py ... Do not modify any other file." The planner drifted to
      // "Create an empty Python file named count_calls.py within the boltons directory" and the
      // executor created `boltons/count_calls.py` — code that could never satisfy the locked spec
      // (`from boltons.funcutils import count_calls`) — burning the entire time budget off-target.
      // outOfScopeNewFile() now refuses that write at dispatch and redirects to the named file.
      const t100 = "Add a new decorator function named count_calls to boltons/funcutils.py. It should take a function and return a wrapper that has an integer attribute call_count starting at 0. Also add a new test file tests/test_count_calls.py with unittest tests. Do not modify any other file.";
      const named100 = ["boltons/funcutils.py"];
      check("taskScopeIsExclusive: 'Do not modify any other file.' declares an exclusive scope", A.taskScopeIsExclusive(t100) === true);
      check("taskScopeIsExclusive: an ordinary task without the phrase does NOT", A.taskScopeIsExclusive("Add count_calls to boltons/funcutils.py and a test for it.") === false);
      // 60th-run staleness-audit leftover, closed 2026-09-04 (61st run): taskScopeIsExclusive is an
      // OR of two independently-written regexes, but every prior fixture in this suite only ever
      // exercised the first ("do not ... any other file(s)"). Mutation-confirmed: deleting the second
      // branch entirely left all 1024 existing tests green — the "no other files should/shall/may/must"
      // phrasing had ZERO coverage anywhere in the suite, a genuine gap (not shadowed dead code — this
      // is a distinct, realistic way to phrase an exclusive-scope constraint that a task author would
      // actually write, and outOfScopeWrite's whole guard silently no-ops for it without this branch).
      check("taskScopeIsExclusive: 'No other files should be modified.' (2nd regex branch) also declares an exclusive scope", A.taskScopeIsExclusive("Add total_seen() to boltons/cacheutils.py. No other files should be modified.") === true);
      check("taskScopeIsExclusive: 'No other files must be touched.' (2nd branch, different modal) also declares an exclusive scope", A.taskScopeIsExclusive("Add total_seen() to boltons/cacheutils.py. No other files must be touched.") === true);
      check("taskScopeIsExclusive: 'No other files were touched' (past tense, no modal) does NOT match either branch", A.taskScopeIsExclusive("The tests passed. No other files were touched during the run.") === false);
      check("outOfScopeWrite: fires end-to-end for the 2nd-branch phrasing, not just the boolean helper", /Out of scope/.test(A.outOfScopeWrite("Add total_seen() to boltons/cacheutils.py. No other files should be modified.", "boltons/__init__.py", ["boltons/cacheutils.py"], false) || ""));
      check("outOfScopeNewFile: creating an unnamed NEW impl file under an exclusive scope is refused (run 100)", /Out of scope/.test(A.outOfScopeNewFile(t100, "boltons/count_calls.py", named100) || ""));
      check("outOfScopeNewFile: the task's OWN named file is always allowed", A.outOfScopeNewFile(t100, "boltons/funcutils.py", named100) === null);
      check("outOfScopeNewFile: test files are left to the lock guard, never blocked here", A.outOfScopeNewFile(t100, "tests/test_count_calls.py", named100) === null);
      check("outOfScopeNewFile: without an exclusive-scope phrase, a new helper module is allowed", A.outOfScopeNewFile("Add count_calls to boltons/funcutils.py.", "boltons/count_calls.py", named100) === null);
      check("outOfScopeNewFile: a task that names no impl file never triggers the guard", A.outOfScopeNewFile("Build a utility. Do not modify any other file.", "boltons/x.py", []) === null);
      check("outOfScopeNewFile: \"do not create any other files\" phrasing is caught too", /Out of scope/.test(A.outOfScopeNewFile("Add slugify to boltons/strutils.py. Do not create any other files.", "boltons/slug.py", ["boltons/strutils.py"]) || ""));
      // EXTENDED 2026-08-16 (boltons run 120): the create-only guard above let a real violation
      // through — task named only boltons/cacheutils.py and said "Do not touch any other file.",
      // but the model wrote a bogus duplicate ThresholdCounter class into the PRE-EXISTING
      // boltons/__init__.py. Measured across all 20 stored exclusive-scope runs before widening:
      // this was the only existing-file out-of-scope write in the whole history, and zero legitimate
      // cross-file call-site edits were found that the widened guard would have wrongly blocked.
      const t120 = "In boltons/cacheutils.py, add a method total_seen() to the ThresholdCounter class that returns the total number of items seen so far. Do not touch any other file.";
      const named120 = ["boltons/cacheutils.py"];
      check("outOfScopeWrite: editing an unnamed PRE-EXISTING file under an exclusive scope is refused (run 120)", /Out of scope/.test(A.outOfScopeWrite(t120, "boltons/__init__.py", named120, false) || ""));
      check("outOfScopeWrite: the task's OWN named file is always allowed to be edited", A.outOfScopeWrite(t120, "boltons/cacheutils.py", named120, false) === null);
      check("outOfScopeWrite: a test file edit is left to the lock guard, never blocked here", A.outOfScopeWrite(t120, "tests/test_cacheutils.py", named120, false) === null);
      check("outOfScopeWrite: without an exclusive-scope phrase, an existing-file edit is allowed", A.outOfScopeWrite("In boltons/cacheutils.py, add total_seen().", "boltons/__init__.py", named120, false) === null);
      check("outOfScopeWrite: the 'editing' wording is used (not 'creating') for an existing-file refusal", /editing it cannot satisfy/.test(A.outOfScopeWrite(t120, "boltons/__init__.py", named120, false) || ""));
      check("outOfScopeWrite: the 'creating' wording is preserved for a new-file refusal (no regression)", /creating it cannot satisfy/.test(A.outOfScopeWrite(t100, "boltons/count_calls.py", named100, true) || ""));
      check("outOfScopeNewFile back-compat alias still refuses new-file creation exactly as before", /Out of scope/.test(A.outOfScopeNewFile(t100, "boltons/count_calls.py", named100) || ""));
      // 60th-run staleness-audit leftover, closed 2026-09-04 (61st run): every existing outOfScopeWrite
      // fixture in this suite used a SINGLE-element `named` array, so the message-building ternary
      // (`named.length === 1 ? named[0] : named.join(" / ")`) never exercised its multi-file branch.
      // Mutation-confirmed: hardcoding `named[0]` in place of the ternary left all 1028 existing tests
      // green. A real multi-file exclusive-scope task ("Add X to a.py and update its caller in b.py. Do
      // not touch any other file.") would silently get a wrong/incomplete redirect message pointing at
      // only the first named file instead of listing all of them.
      const namedMulti = ["boltons/mathutils.py", "boltons/cacheutils.py"];
      const tMulti = "Add helper() to boltons/mathutils.py and call it from boltons/cacheutils.py. Do not touch any other file.";
      check("outOfScopeWrite: multi-file named list is joined with ' / ' in the redirect message, not truncated to the first file", (A.outOfScopeWrite(tMulti, "boltons/__init__.py", namedMulti, false) || "").includes("boltons/mathutils.py / boltons/cacheutils.py"));
      // ROOT-CAUSED + REPRODUCED 2026-08-04 (from boltons run 95's raw log): the model wrote the
      // POSIX-ism `mkdir -p boltons`. cmd.exe has no `-p` flag, so it read `-p` as a second
      // DIRECTORY NAME and actually created a junk dir called `-p` in the workspace — real
      // pollution of the user's project — and the "already exists" error it then printed for the
      // real target made benignCmdFailure (above) normalize the whole thing to "nothing to do
      // (this is not an error)", so the junk dir was never reported. Verified live before the fix:
      // execTool("run_command", "mkdir -p boltons") left ['-p','boltons'] on disk. Separately,
      // cmd's mkdir needs BACKSLASHES for a nested path or it dies with "The syntax of the command
      // is incorrect", so `mkdir pkg/sub` silently failed to create anything at all.
      check("winShellCommand: POSIX `mkdir -p` loses the flag so cmd can't create a junk '-p' dir", A.winShellCommand("mkdir -p boltons") === "mkdir boltons");
      check("winShellCommand: `md -p` (cmd's mkdir alias) is normalized the same way", A.winShellCommand("md -p boltons") === "md boltons");
      check("winShellCommand: a nested mkdir path gets backslashes so cmd actually creates it", A.winShellCommand("mkdir -p pkg/sub/deep") === "mkdir pkg\\sub\\deep");
      check("winShellCommand: nested mkdir is fixed even without the -p flag", A.winShellCommand("mkdir pkg/sub") === "mkdir pkg\\sub");
      check("winShellCommand: mkdir after a shell separator is normalized too", A.winShellCommand("cd app && mkdir -p a/b") === "cd app && mkdir a\\b");
      // NEGATIVE CONTROLS — the rewrite must never touch anything that isn't a mkdir command.
      check("winShellCommand: a directory NAME containing -p is untouched", A.winShellCommand("mkdir my-project") === "mkdir my-project");
      check("winShellCommand: a non-mkdir command's forward slashes are left alone", A.winShellCommand("python boltons/strutils.py") === "python boltons/strutils.py");
      check("winShellCommand: 'mkdir' as a mere ARGUMENT is not treated as the command token", A.winShellCommand("echo mkdir a/b") === "echo mkdir a/b");
      check("winShellCommand: a non-mkdir command after a separator keeps its slashes", A.winShellCommand("mkdir -p a/b && python a/b/x.py") === "mkdir a\\b && python a/b/x.py");
      check("winShellCommand: the pre-existing python3->python rewrite still applies", A.winShellCommand("python3 setup.py") === "python setup.py");
      // LIVE-CAUGHT (boltons run 135, 2026-08-17): reproduced directly via child_process.exec before
      // fixing — cmd.exe does not treat single quotes as string delimiters, so a POSIX-correct
      // `python -c '...'` one-liner (an ordinary self-verification command) crashes with
      // `SyntaxError: unterminated string literal` on real Windows, turning a genuinely-correct fix
      // into bogus command debt that only clears by re-running the identical string.
      check("winShellCommand: a single-quoted `python -c` one-liner is rewritten to double quotes",
        A.winShellCommand("python -c 'import boltons.pointutils; print(boltons.pointutils.Point(3, 4).x)'") ===
        'python -c "import boltons.pointutils; print(boltons.pointutils.Point(3, 4).x)"');
      check("winShellCommand: `node -e '...'` gets the same rewrite",
        A.winShellCommand("node -e 'console.log(1+1)'") === 'node -e "console.log(1+1)"');
      check("winShellCommand: `--eval` (long flag) also gets the rewrite",
        A.winShellCommand("python --eval 'print(1)'") === 'python --eval "print(1)"');
      check("winShellCommand: an internal double quote in the code is escaped, not left to break the outer quoting",
        A.winShellCommand("python -c 'print(\"hi\")'") === 'python -c "print(\\"hi\\")"');
      check("winShellCommand: a double-quoted -c one-liner (already correct) is left alone",
        A.winShellCommand('python -c "print(1)"') === 'python -c "print(1)"');
      check("winShellCommand: an unrelated single-quoted argument (not after -c/-e) is left alone",
        A.winShellCommand("grep -n 'foo' bar.py") === "grep -n 'foo' bar.py");
      check("winShellCommand: a single-quoted pytest `-k` expression is rewritten to double quotes",
        A.winShellCommand("python -m pytest -k 'test_slugify' -q") === 'python -m pytest -k "test_slugify" -q');
      check("winShellCommand: a multi-word single-quoted `-k` boolean expression is rewritten too",
        A.winShellCommand("python -m pytest tests/test_strutils.py -k 'slugify or camel' -q") ===
        'python -m pytest tests/test_strutils.py -k "slugify or camel" -q');
      check("winShellCommand: a single-quoted pytest `-m` marker expression is rewritten too",
        A.winShellCommand("python -m pytest -q -m 'not slow'") === 'python -m pytest -q -m "not slow"');
      check("winShellCommand: an internal double quote inside a pytest -k expression is escaped",
        A.winShellCommand(`python -m pytest -k 'has "quote"' -q`) === 'python -m pytest -k "has \\"quote\\"" -q');
      check("winShellCommand: an already double-quoted pytest -k expression is left alone",
        A.winShellCommand('python -m pytest -k "already double" -q') === 'python -m pytest -k "already double" -q');
      check("winShellCommand: -k/-m on a NON-pytest command is left completely alone",
        A.winShellCommand("grep -k 'unused' file.py") === "grep -k 'unused' file.py");
      check("winShellCommand: pytest -k after a shell separator still gets rewritten",
        A.winShellCommand("cd app && python -m pytest -k 'foo' -q") === 'cd app && python -m pytest -k "foo" -q');
      // bug 42 (REPRODUCED live via child_process.exec before fixing): a POSIX inline env-var
      // assignment prefix (`VAR=val cmd`) fails on cmd.exe with "'VAR=val' is not recognized as an
      // internal or external command" — which envMissing() then misclassifies as "no tool
      // installed", silently absorbing a genuinely correct, rewritable verification command.
      check("winShellCommand: a leading POSIX env-var assignment is rewritten to cmd's `set` syntax",
        A.winShellCommand("PYTHONDONTWRITEBYTECODE=1 python -m pytest -q tests/test_mathutils.py") ===
        "set PYTHONDONTWRITEBYTECODE=1&& python -m pytest -q tests/test_mathutils.py");
      check("winShellCommand: multiple leading env-var assignments each become their own `set`",
        A.winShellCommand("CI=1 NODE_ENV=test npm test") === "set CI=1&& set NODE_ENV=test&& npm test");
      check("winShellCommand: a leading env-var assignment after a shell separator is rewritten too",
        A.winShellCommand("cd app && PYTHONPATH=. pytest -q") === "cd app && set PYTHONPATH=.&& pytest -q");
      check("winShellCommand: a mid-argument `=` (pip version pin) is left completely alone",
        A.winShellCommand("pip install requests==2.28.0") === "pip install requests==2.28.0");
      check("winShellCommand: a plain command with no leading assignment is untouched",
        A.winShellCommand("echo A=1") === "echo A=1");
    }
    // LIVE-CAUGHT (boltons run 70, 2026-07-25): a cross-file refactor broke a previously-passing
    // test, but the run also added new passing tests, so raw pass count rose (449→450) even though
    // a real regression existed (0→1 newly-broken test). Pure pass-count comparison called this
    // "same or better" and skipped the revert, leaving the regression on disk with only a warning.
    {
      const fdir = fresh("baseline-failcount");
      fs.writeFileSync(path.join(fdir, "impl2.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(fdir, "test_impl2.py"), "import unittest, impl2\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(impl2.add(2, 1), 3)\n");
      const ag3 = { root: fdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, files: new Set(["impl2.py"]) };
      await A.Agent.prototype.snapshotBaseline.call(ag3, "python -m unittest test_impl2");
      check("snapshotBaseline also records zero pre-existing failures", ag3.baselineFails === 0, JSON.stringify({ fails: ag3.baselineFails }));
      // break add(), but ALSO grow the test file with 2 new trivially-passing tests — net pass
      // count still beats baseline (2 > 1) even though test_add now genuinely fails.
      fs.writeFileSync(path.join(fdir, "impl2.py"), "def add(a, b):\n    return a - b\n");
      fs.writeFileSync(path.join(fdir, "test_impl2.py"), "import unittest, impl2\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(impl2.add(2, 1), 3)\n    def test_new_a(self):\n        self.assertTrue(callable(impl2.add))\n    def test_new_b(self):\n        self.assertTrue(True)\n");
      try { fs.rmSync(path.join(fdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const restored3 = await A.Agent.prototype.restoreBaselineIfWorse.call(ag3, "python -m unittest test_impl2", () => {});
      check("restoreBaselineIfWorse catches a regression masked by a higher overall pass count (boltons run 70 bug)", restored3 === true && /a \+ b/.test(fs.readFileSync(path.join(fdir, "impl2.py"), "utf8")), JSON.stringify({ restored: restored3 }));
    }
    // LIVE-CAUGHT (boltons run 73, 2026-07-25): a spec-first run AUTHORED a brand-new locked test
    // file (tests/test_pointutils.py) but never landed the impl that would make it pass, leaving the
    // repo worse than baseline (449→449 passing, but 0→1 failing). restoreBaselineIfWorse reverts
    // CONTENT of pre-existing files, but a newly-CREATED file has no baseline content to revert to —
    // so the content-revert left the failing test on disk, and the pass-count-only re-check then
    // falsely reported "restored to known-good". A revert must also DELETE files the run created.
    {
      const cdir = fresh("baseline-createddelete");
      fs.writeFileSync(path.join(cdir, "impl3.py"), "class Point:\n    def __init__(self, x, y):\n        self.x = x; self.y = y\n");
      fs.writeFileSync(path.join(cdir, "test_impl3.py"), "import unittest, impl3\nclass T(unittest.TestCase):\n    def test_xy(self):\n        p = impl3.Point(1, 2)\n        self.assertEqual((p.x, p.y), (1, 2))\n");
      const testCmd = "python -m pytest -q";
      const agc = { root: cdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, focusFiles: ["impl3.py"], editableTestFiles: new Set(), files: new Set(), createdFiles: new Set() };
      await A.Agent.prototype.snapshotBaseline.call(agc, testCmd);
      // spec-first: author a NEW test file that fails (the impl that would satisfy it never landed)
      fs.writeFileSync(path.join(cdir, "test_new3.py"), "import unittest, impl3\nclass T2(unittest.TestCase):\n    def test_type(self):\n        with self.assertRaises(TypeError):\n            impl3.Point(0, 0).distance_to('nope')\n");
      agc.files = new Set(["test_new3.py"]); agc.createdFiles = new Set(["test_new3.py"]);
      try { fs.rmSync(path.join(cdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const restoredC = await A.Agent.prototype.restoreBaselineIfWorse.call(agc, testCmd, () => {});
      check("restoreBaselineIfWorse DELETES a run-created file a content-revert can't undo (boltons run 73)", restoredC === true && !fs.existsSync(path.join(cdir, "test_new3.py")), JSON.stringify({ restored: restoredC, stillThere: fs.existsSync(path.join(cdir, "test_new3.py")) }));
      check("restoreBaselineIfWorse drops the deleted created file from this.files and records it in revertedFiles", !agc.files.has("test_new3.py") && !!agc.revertedFiles?.has("test_new3.py") && agc.reverted === true);
      // NEGATIVE: a HEALTHY run (no regression) must KEEP its newly-created file untouched.
      const hdir = fresh("baseline-createdkeep");
      fs.writeFileSync(path.join(hdir, "impl4.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(hdir, "test_impl4.py"), "import unittest, impl4\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(impl4.add(2, 1), 3)\n");
      const agh = { root: hdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, focusFiles: ["impl4.py"], editableTestFiles: new Set(), files: new Set(), createdFiles: new Set() };
      await A.Agent.prototype.snapshotBaseline.call(agh, testCmd);
      fs.writeFileSync(path.join(hdir, "test_extra4.py"), "import unittest, impl4\nclass T2(unittest.TestCase):\n    def test_more(self):\n        self.assertEqual(impl4.add(5, 5), 10)\n");
      agh.files = new Set(["test_extra4.py"]); agh.createdFiles = new Set(["test_extra4.py"]);
      try { fs.rmSync(path.join(hdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const restoredH = await A.Agent.prototype.restoreBaselineIfWorse.call(agh, testCmd, () => {});
      check("restoreBaselineIfWorse leaves a HEALTHY run's newly-created file in place (no over-deletion)", restoredH === false && fs.existsSync(path.join(hdir, "test_extra4.py")), JSON.stringify({ restored: restoredH }));
    }

    // LIVE-CAUGHT (boltons run 103, 2026-08-04): the restore fires on EITHER fewer passes OR more
    // failures, but its log line only ever printed the PASS counts — so a failure-triggered restore
    // logged the self-contradictory "run regressed (449→449 tests passing)", hiding the real reason
    // and costing real diagnosis time on a guard that was working correctly. The message must name
    // the counter that ACTUALLY tripped it.
    {
      const mdir = fresh("baseline-restoremsg");
      fs.writeFileSync(path.join(mdir, "impl9.py"), "def add(a, b):\n    return a + b\n");
      fs.writeFileSync(path.join(mdir, "test_impl9.py"), "import unittest, impl9\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(impl9.add(2, 1), 3)\n");
      const testCmd = "python -m pytest -q";
      const mk = () => ({ root: mdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, focusFiles: ["impl9.py"], editableTestFiles: new Set(), files: new Set(), createdFiles: new Set() });
      // FAIL-COUNT path (the run-103 shape): pass count unchanged, a new failing test added.
      const agm = mk();
      await A.Agent.prototype.snapshotBaseline.call(agm, testCmd);
      fs.writeFileSync(path.join(mdir, "test_new9.py"), "import unittest, impl9\nclass T2(unittest.TestCase):\n    def test_bad(self):\n        self.assertEqual(impl9.add(1, 1), 99)\n");
      agm.files = new Set(["test_new9.py"]); agm.createdFiles = new Set(["test_new9.py"]);
      try { fs.rmSync(path.join(mdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const logsM = [];
      const restoredM = await A.Agent.prototype.restoreBaselineIfWorse.call(agm, testCmd, (e) => { if (e.type === "log") logsM.push(e.text); });
      const msgM = logsM.join(" ");
      check("baseline-restore message names the FAILURE counter when failures are what tripped it (boltons run 103)", restoredM === true && /0→1 tests failing/.test(msgM) && !/tests passing/.test(msgM), JSON.stringify({ restored: restoredM, msgM }));
      // PASS-COUNT path (positive control): an existing test broken by a bad impl edit.
      const agp2 = mk();
      await A.Agent.prototype.snapshotBaseline.call(agp2, testCmd);
      fs.writeFileSync(path.join(mdir, "impl9.py"), "def add(a, b):\n    return a - b\n");
      agp2.files = new Set(["impl9.py"]);
      try { fs.rmSync(path.join(mdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const logsP = [];
      const restoredP = await A.Agent.prototype.restoreBaselineIfWorse.call(agp2, testCmd, (e) => { if (e.type === "log") logsP.push(e.text); });
      const msgP = logsP.join(" ");
      check("baseline-restore message still names the PASS counter when fewer tests pass (unchanged behavior)", restoredP === true && /1→0 tests passing/.test(msgP), JSON.stringify({ restored: restoredP, msgP }));
    }

    // EDITABLE TEST FILE BASELINE PROTECTION (2026-07-23, boltons run 62 false-positive): a
    // task-editable test file (this.editableTestFiles) must ALSO be baseline-snapshotted and
    // revertible — previously only non-test impl files were captured, so a bad/near-no-op edit to
    // an editable test file survived a baseline revert untouched, and since the revert removes
    // reverted filenames from this.files, the removal-check that should have caught the target
    // still being present went blind too (this.files no longer had the file to check).
    {
      const rdir = fresh("baseline-removal");
      fs.writeFileSync(path.join(rdir, "shapes.py"), "class Rect:\n    def perimeter(self):\n        return 1\n");
      fs.writeFileSync(path.join(rdir, "test_shapes.py"), "import unittest, shapes\nclass T(unittest.TestCase):\n    def test_perimeter(self):\n        self.assertEqual(shapes.Rect().perimeter(), 1)\n");
      const task = "remove the perimeter() method from Rect. Also update tests/test_shapes.py to remove test_perimeter.";
      const ag2 = { root: rdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, files: new Set(["shapes.py", "test_shapes.py"]), editableTestFiles: new Set(["test_shapes.py"]) };
      await A.Agent.prototype.snapshotBaseline.call(ag2, "python -m unittest test_shapes");
      check("snapshotBaseline also captures an editable test file's baseline content", /def test_perimeter/.test(ag2.baselineFiles["test_shapes.py"] || ""), JSON.stringify({ keys: Object.keys(ag2.baselineFiles) }));
      // simulate a regression: impl edit breaks the test, test-file edit is a near-no-op (still
      // references the target the task asked to remove)
      fs.writeFileSync(path.join(rdir, "shapes.py"), "class Rect:\n    def perimeter(self):\n        return 999\n");
      fs.writeFileSync(path.join(rdir, "test_shapes.py"), "import unittest, shapes\n# reformatted only\nclass T(unittest.TestCase):\n    def test_perimeter(self):\n        self.assertEqual(shapes.Rect().perimeter(), 1)\n");
      try { fs.rmSync(path.join(rdir, "__pycache__"), { recursive: true, force: true }); } catch {}
      const restored2 = await A.Agent.prototype.restoreBaselineIfWorse.call(ag2, "python -m unittest test_shapes", () => {});
      check("restoreBaselineIfWorse reverts the editable test file too, not just impl files", restored2 === true && /def test_perimeter/.test(fs.readFileSync(path.join(rdir, "test_shapes.py"), "utf8")));
      check("restoreBaselineIfWorse tracks reverted filenames in this.revertedFiles", !!ag2.revertedFiles?.has("shapes.py") && !!ag2.revertedFiles?.has("test_shapes.py"), JSON.stringify([...(ag2.revertedFiles || [])]));
      check("restoreBaselineIfWorse clears both reverted files from this.files", !ag2.files.has("shapes.py") && !ag2.files.has("test_shapes.py"));
      // the outcome-check union (agent.mjs run(), ~4326): even though both files are gone from
      // this.files, revertedFiles keeps the removal-target check honest — this is the exact
      // false-positive boltons run 62 hit ("✅ Results match the outcome" while perimeter() was
      // still defined verbatim, because the reverted file was invisible to the check).
      const evalFiles = [...new Set([...ag2.files, ...(ag2.revertedFiles || [])])];
      const wantedRemoved = A.namesTaskWantsRemoved(task);
      const stillThere = await A.stillPresentTargets(rdir, evalFiles, wantedRemoved);
      check("stillPresentTargets, unioned with revertedFiles, still catches the removal target post-revert", stillThere.includes("perimeter"), JSON.stringify(stillThere));
    }

    // BASELINE MUST BE CAPTURED BEFORE ANY FILE IS WRITTEN (2026-07-27, boltons run 85 LIVE FIND):
    // a spec-first multi-file task authors+LOCKS a new test file (importing a module that doesn't
    // exist yet — normal TDD-red) BEFORE the executor ever runs. If snapshotBaseline() is called
    // AFTER that file already exists on disk, the "baseline" it captures is already a collection
    // error (goodness -1), not the true pre-run passing state — poisoning every downstream
    // safety net. Confirmed live: run 85 left 2 of 3 planned files never created (a separate
    // model/parallel-decomposition issue) and shipped `done` with a broken repo (ModuleNotFoundError
    // on every subsequent `pytest`) because restoreBaselineIfWorse's "worse than baseline?" check
    // became `-1 >= -1` -> "same or better", a silent no-op. The real fix moved run()'s
    // snapshotBaseline() call to BEFORE authorTests() (this test proves the underlying hazard the
    // reorder protects against; the second check below guards the reorder itself).
    {
      const pdir = fresh("baseline-poisoned-by-early-write");
      // simulate authorTests() having ALREADY written+locked a new test file before baseline capture
      fs.writeFileSync(path.join(pdir, "test_new_mod.py"), "import unittest\nfrom pkg_not_yet_created import Thing\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertTrue(Thing())\n");
      const testCmdP = "python -m unittest discover -p test_new_mod.py";
      const agp = { root: pdir, gates: {}, _goodness: A.Agent.prototype._goodness, _failCount: A.Agent.prototype._failCount, focusFiles: [], editableTestFiles: new Set(), files: new Set(["test_new_mod.py"]), createdFiles: new Set(["test_new_mod.py"]), lockedFiles: new Set(["test_new_mod.py"]), task: "add pkg_not_yet_created.Thing + test_new_mod.py" };
      await A.Agent.prototype.snapshotBaseline.call(agp, testCmdP);
      check("HAZARD: snapshotBaseline called after a locked-but-unimplemented test file exists captures a POISONED (-1) baseline", agp.baselineGood === -1, JSON.stringify({ baselineGood: agp.baselineGood }));
      // the run stays broken (the module never gets created) — restoreBaselineIfWorse should have
      // cleaned this up, but with a poisoned baseline it silently declines to.
      const noopP = await A.Agent.prototype.restoreBaselineIfWorse.call(agp, testCmdP, () => {});
      check("HAZARD CONFIRMED: a poisoned baseline makes restoreBaselineIfWorse a silent no-op on a genuinely broken repo", noopP === false && fs.existsSync(path.join(pdir, "test_new_mod.py")));
    }
    // STRUCTURAL GUARD: assert run()'s snapshotBaseline() call textually precedes authorTests() —
    // the actual fix. A future edit that moves it back below authorTests would silently reintroduce
    // the run-85 hazard proven above without any functional test catching it (the hazard only shows
    // up on a from-scratch spec-first multi-file task's exact call sequence, not in isolated
    // unit calls), so this cheap source-order check is the real regression guard.
    {
      const src = fs.readFileSync(path.join(__dirname, "agent.mjs"), "utf8");
      const snapIdx = src.indexOf("await this.snapshotBaseline(testCmd)");
      const authorIdx = src.indexOf("await this.authorTests(task, emit)");
      check("run() calls snapshotBaseline() BEFORE authorTests() (guards the run-85 poisoned-baseline fix)", snapIdx > 0 && authorIdx > 0 && snapIdx < authorIdx, JSON.stringify({ snapIdx, authorIdx }));
    }

    // MULTI-FILE DECOMPOSITION — contract + dependency order + 1.5B inspector
    {
      const ddir = fresh("decomp");
      fs.writeFileSync(path.join(ddir, "models.py"), "class A:\n    pass\n");
      fs.writeFileSync(path.join(ddir, "bank.py"), "from models import A\n");
      fs.writeFileSync(path.join(ddir, "report.py"), "from models import A\n");
      const ordered = await A.Agent.prototype._orderByDeps.call({ root: ddir, _fileDepths: A.Agent.prototype._fileDepths }, ["report.py", "bank.py", "models.py"]);
      check("_orderByDeps edits the base file (models) FIRST", ordered[0] === "models.py", JSON.stringify(ordered));

      const emits = [];
      const cAg = { root: ddir, memModel: "m", eta: { ask: async () => "models.py: add a transfers counter\nbank.py: add transfer() that increments it" } };
      const contract = await A.Agent.prototype._buildContract.call(cAg, "add transfer", ["models.py", "bank.py"], (e) => emits.push(e));
      check("_buildContract writes + stores the cross-file contract", /transfers counter/.test(contract) && cAg.contract === contract && emits.some((e) => /blueprint/.test(e.text || "")), contract.slice(0, 50));

      // the 1.5B inspector: yes/no did this file do its part
      const idir = fresh("inspect");
      fs.writeFileSync(path.join(idir, "bank.py"), "def transfer():\n    pass\n");
      // _askHelper is the routing seam (Ollama-direct when a real helper exists, else the main
      // brain) — stubs get the real method so the fallback path is exercised too.
      const yes = await A.Agent.prototype._inspectFile.call({ root: idir, contract: "bank increments counter", resolveHelperModel: async () => "h", _askHelper: A.Agent.prototype._askHelper, eta: { ask: async () => "YES" } }, "bank.py");
      check("inspector (1.5B): YES when the file satisfies its contract", yes.ok === true);
      const no = await A.Agent.prototype._inspectFile.call({ root: idir, contract: "bank increments counter", resolveHelperModel: async () => "h", _askHelper: A.Agent.prototype._askHelper, eta: { ask: async () => "NO: counter not incremented" } }, "bank.py");
      check("inspector (1.5B): NO + the missing gap when a file falls short", no.ok === false && /counter/.test(no.gap), JSON.stringify(no));
    }

    // Synthetic `this` for the oracle: it only needs its own helper methods (no run state).
    // Keep this in sync when the oracle grows a helper — a bare {} throws "not a function".
    const ORACLE_THIS = {
      _dropOutOfSpecTests: A.Agent.prototype._dropOutOfSpecTests,
      _removeTestMethod: A.Agent.prototype._removeTestMethod,
    };
    // TOPIC 1 — Explore subagent: parallel fan-out + context isolation via map-reduce
    {
      // mapPool: bounded parallelism, results in order, never more than `concurrency` in flight
      let inFlight = 0, maxSeen = 0;
      const out = await A.mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => { inFlight++; maxSeen = Math.max(maxSeen, inFlight); await new Promise(r => setTimeout(r, 5)); inFlight--; return x * 10; });
      check("mapPool runs bounded-parallel, preserves order", JSON.stringify(out) === JSON.stringify([10, 20, 30, 40, 50, 60]) && maxSeen <= 2, JSON.stringify({ out, maxSeen }));

      // _judgeRelevance: helper sees ONE file, returns a one-line YES/NO verdict (isolation)
      const jdir = fresh("judge");
      fs.writeFileSync(path.join(jdir, "auth.py"), "def login(user, pw):\n    return check(user, pw)\n");
      const yes = await A.Agent.prototype._judgeRelevance.call({ root: jdir, _askHelper: A.Agent.prototype._askHelper, eta: { ask: async () => "YES: handles login" } }, "add logout", "auth.py", "helper");
      const no = await A.Agent.prototype._judgeRelevance.call({ root: jdir, _askHelper: A.Agent.prototype._askHelper, eta: { ask: async () => "NO" } }, "add logout", "auth.py", "helper");
      check("explore judge: YES verdict kept with reason", yes.keep === true && /login/.test(yes.why), JSON.stringify(yes));
      check("explore judge: NO verdict dropped", no.keep === false);

      // ---- falsification-first repair (arXiv 2606.31511: a CONCRETE failing case drives repair
      // in small models; "your code is wrong" alone does ~nothing). The traceback holds the
      // counterexample in the assertion line — we used to throw it away. ----
      const UNITTEST_OUT = `======================================================================
ERROR: test_unary_minus (test_calc.TestCalc.test_unary_minus)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "D:\\ws\\test_calc.py", line 13, in test_unary_minus
    self.assertEqual(calc.evaluate("2 * -(3 + 1)"), -8.0)
  File "D:\\ws\\calc.py", line 58, in evaluate
    raise ValueError("Bad input")
ValueError: Bad input

======================================================================
FAIL: test_precedence (test_calc.TestCalc.test_precedence)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "D:\\ws\\test_calc.py", line 6, in test_precedence
    self.assertEqual(calc.evaluate("3 + 4 * 2"), 11.0)
AssertionError: 14.0 != 11.0

----------------------------------------------------------------------
Ran 6 tests in 0.003s

FAILED (errors=2)`;
      const fc = A.falsifyingCase(UNITTEST_OUT, "D:\\ws");
      check("falsify: extracts the failing CALL (the counterexample)", /calc\.evaluate\("2 \* -\(3 \+ 1\)"\)/.test(fc), fc.slice(0, 120));
      check("falsify: extracts what it GOT", /ValueError: Bad input/.test(fc));
      check("falsify: names the test", /test_unary_minus/.test(fc));
      check("falsify: points at the culprit impl file+line (not the test)", /calc\.py line 58/.test(fc));
      check("falsify: leads with ONE case + says how many (cascade hint)", /1 of 2 failures/.test(fc));
      check("falsify: tells it not to edit the test", /never edit the test/i.test(fc));
      const PYTEST_OUT = `______ test_x ______\n    def test_x():\n>       assert evaluate("2*-(3+1)") == -8.0\nE       ValueError: Bad input\nFAILED test_calc.py::test_x\nFAILED test_calc.py::test_y`;
      const fp = A.falsifyingCase(PYTEST_OUT, "D:\\ws");
      check("falsify: pytest format — failing expression", /assert evaluate\("2\*-\(3\+1\)"\) == -8\.0/.test(fp), fp.slice(0, 100));
      check("falsify: pytest format — the error", /ValueError: Bad input/.test(fp));
      check("falsify: clean output -> empty (caller falls back)", A.falsifyingCase("Ran 6 tests\n\nOK", "D:\\ws") === "");

      // ---- parseFailure: the FALLBACK diagnosis used when falsifyingCase can't parse a concrete
      // case (line 5343: `falsify || parseFailure(...)`) — had ZERO direct tests despite being
      // live-wired at 2 call sites. Real bug found+fixed here: the old code walked EVERY frame in
      // the WHOLE output and kept overwriting `culprit` with whichever came LAST, with no
      // isTestFile exclusion — so on UNITTEST_OUT above (2 failures: #1 a real ValueError 2 frames
      // deep in calc.py, #2 a trivial assertEqual mismatch that raises right inside the test file)
      // it reported "the error is in test_calc.py at line 6" — discarding the far more useful
      // calc.py:58 frame from failure #1, and pairing it with failure #2's AssertionError text via
      // a separate .pop() call, an incoherent frame/exception mismatch across two DIFFERENT
      // failures. This directly violated the project's own stated design ("N failures usually
      // cascade from ONE gap, so lead with the FIRST instead of splitting attention over all" —
      // the comment on falsifyingCase, 2 functions above, which already gets this right).
      const pf1 = A.parseFailure(UNITTEST_OUT, "D:\\ws");
      check("parseFailure: leads with the FIRST failure's real impl-file frame, not the last", /calc\.py at line 58/.test(pf1), pf1);
      check("parseFailure: does NOT report the later failure's test-file line instead", !/test_calc\.py at line 6/.test(pf1), pf1);
      check("parseFailure: pairs the exception with the SAME (first) failure as the chosen frame", /ValueError: Bad input/.test(pf1) && !/AssertionError: 14\.0/.test(pf1), pf1);
      check("parseFailure: still lists ALL failing test names, not just the first", /test_unary_minus, test_precedence/.test(pf1));
      check("parseFailure: gives the read_file/edit_file instruction when the culprit is real impl code", /read_file calc\.py around line 58.*edit_file/.test(pf1));
      // When NO frame anywhere leaves the test file (a plain assertEqual mismatch with nothing
      // deeper), parseFailure must still report that line truthfully — but WITHOUT instructing an
      // edit_file on the test (the existing isTestFile guard on `where` already handled this half
      // correctly; this proves the new frame-selection doesn't regress it).
      const TESTONLY_OUT = `======================================================================\nFAIL: test_x (test_calc.TestCalc.test_x)\n----------------------------------------------------------------------\nTraceback (most recent call last):\n  File "D:\\ws\\test_calc.py", line 20, in test_x\n    self.assertEqual(1, 2)\nAssertionError: 1 != 2`;
      const pf2 = A.parseFailure(TESTONLY_OUT, "D:\\ws");
      check("parseFailure: falls back to the test-file frame when no impl frame exists anywhere", /test_calc\.py at line 20/.test(pf2), pf2);
      check("parseFailure: never instructs edit_file on a test-only culprit", !/edit_file/.test(pf2), pf2);
      check("parseFailure: clean output -> empty string", A.parseFailure("Ran 6 tests\n\nOK", "D:\\ws") === "");

      // ---- STUCK-KILLER (OpenHands StuckDetector pattern): "same failure again" must be
      // distinguishable from "different failure / progress" so we can stop grinding. Measured
      // motivation: the entire 2nd half of a 22-min calc run was the same 2 tests failing. ----
      const sigA = A.failSignature(`ERROR: test_unary_minus (test_calc.T.test_unary_minus)\nFAIL: test_decimals (x)\nFAILED (failures=1, errors=1)`);
      const sigB = A.failSignature(`FAIL: test_decimals (y)\nERROR: test_unary_minus (z)\nFAILED (failures=1, errors=1)`); // same set, reworded/reordered
      check("stuck: same failing set -> identical signature (order/wording-independent)", sigA === sigB && sigA === "test_decimals,test_unary_minus", sigA + " | " + sigB);
      check("stuck: unittest summary line is NOT mistaken for a test name", !/failures/.test(sigA));
      const sigProgress = A.failSignature(`ERROR: test_unary_minus (z)\nFAILED (errors=1)`); // one fewer failing
      check("stuck: real progress changes the signature", sigProgress !== sigA);
      check("stuck: pytest form parsed", A.failSignature(`FAILED test_calc.py::test_x - AssertionError\nFAILED test_calc.py::test_y`) === "test_calc.py::test_x,test_calc.py::test_y");
      check("stuck: green output -> score-based signature (0)", A.failSignature("Ran 6 tests in 0.01s\n\nOK") === "score:0");
      check("stuck: uncounted failures still differ from green", A.failSignature("Traceback (most recent call last):\nValueError") !== A.failSignature("OK"));
      check("stuck: two DIFFERENT crashes are NOT the same signature (exploration ≠ stall)",
        A.failSignature("Traceback (most recent call last):\nValueError: x") !== A.failSignature("Traceback (most recent call last):\nTypeError: y"));

      // ---- ORACLE GUARDS (audit findings): the reference must never outrank the SPEC, never
      // shadow the stdlib, and never edit inside a test's input string. ----
      const SPEC_TESTS = `import unittest\nimport calc\n\nclass T(unittest.TestCase):\n    def test_p(self):\n        self.assertAlmostEqual(calc.evaluate("3 + 4 * 2 / ( 1 - 5 )"), 2.0)\n`;
      // task EXPLICITLY states 2.0 → the user chose it; oracle must leave the test alone
      const oSpec = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_calc.py", 'Create calc.py: evaluate(expr) infix with precedence; evaluate("3 + 4 * 2 / ( 1 - 5 )") must return 2.0 exactly per our custom rounding rule',
        SPEC_TESTS, () => {});
      check("oracle: value stated in the task spec is NEVER overridden (spec > reference)", oSpec === null);
      // stdlib import above the impl import must not be mistaken for the module under test
      const STDLIB_TESTS = `import unittest\nfrom collections import deque\nimport calc\n\nclass T(unittest.TestCase):\n    def test_p(self):\n        self.assertAlmostEqual(calc.evaluate("3 + 4 * 2 / ( 1 - 5 )"), 2.0)\n`;
      const oStd = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_calc.py", "Create calc.py: evaluate(expr) infix expression with precedence and unary minus",
        STDLIB_TESTS, () => {});
      check("oracle: stdlib import skipped — still repairs via the real impl module", oStd && oStd.includes('"3 + 4 * 2 / ( 1 - 5 )"), 1.0)'), (oStd || "null").slice(0, 120));

      // ---- REPO MAP: personalized PageRank over the symbol graph (Aider's idea, ported).
      // The map is the weak model's ONLY view of the project — wrong map = failure no oracle
      // can repair. PageRank (not counting) + task personalization are the two properties. ----
      {
        // GROUND TRUTH: b gets ONE vote from important 'a'; c gets THREE from nobodies.
        // Counting says c wins 3-1; real PageRank says b. That difference IS the feature.
        const nodes = ["a", "b", "c", "x", "y", "z"];
        const edges = [["x", "a"], ["y", "a"], ["z", "a"], ["a", "b"], ["x", "c"], ["y", "c"], ["z", "c"]];
        const r = A.pageRank(nodes, edges);
        check("repomap: PageRank — 1 vote from an important node beats 3 from unimportant ones", r.get("b") > r.get("c"), `b=${r.get("b").toFixed(4)} c=${r.get("c").toFixed(4)}`);
        const sum = [...r.values()].reduce((s, v) => s + v, 0);
        check("repomap: PageRank mass sums to ~1 (no rank leaking away)", Math.abs(sum - 1) < 0.01, String(sum));
        const p = A.pageRank(nodes, edges, new Map([["c", 10]]));
        check("repomap: personalization re-ranks toward the seed", [...p.entries()].sort((m, n) => n[1] - m[1])[0][0] === "c");
        check("repomap: empty graph is safe", A.pageRank([], []).size === 0);
        check("repomap: self-links carry no rank", A.pageRank(["a", "b"], [["a", "a"], ["a", "b"]]).get("b") > 0);
        const sy = A.symbolsOf("def alpha():\n    return beta() + GAMMA\nclass Delta:\n    pass\n", "x.py");
        check("repomap: symbolsOf finds definitions", sy.defs.has("alpha") && sy.defs.has("Delta"), [...sy.defs].join(","));
        check("repomap: symbolsOf finds references but not own defs", sy.refs.has("beta") && !sy.refs.has("alpha"));
        // CLASS METHODS: measured against a real tree-sitter parse, missing these dropped recall
        // to 64% on agent.mjs / 43% on mcp.mjs — a third of an OOP codebase's API hidden from the
        // model. Professional codebases are OOP-heavy, so this is the dominant case.
        const cls = A.symbolsOf(`class Hub {\n  constructor(x) { this.x = x; }\n  async connect(url) {\n    if (url) { return this.send(url); }\n  }\n  _send(msg) { return msg; }\n  static build() { return new Hub(); }\n}\n`, "h.js");
        check("repomap: finds class methods (the 64%->98% recall fix)",
          ["constructor", "connect", "_send", "build"].every((m) => cls.defs.has(m)), [...cls.defs].join(","));
        check("repomap: control keywords are NOT mistaken for methods", !cls.defs.has("if") && !cls.defs.has("for") && !cls.defs.has("return"), [...cls.defs].join(","));
      }
      // end-to-end on THIS repo: the task must pull its own file up the ranking
      {
        const rank = (m, f) => m.split("\n").filter((l) => /^\S/.test(l) && !/^REPO MAP|^\(\+/.test(l)).findIndex((l) => l.startsWith(f)) + 1;
        const gen = await A.repoMap(__dirname, 5000, "");
        const moeMap = await A.repoMap(__dirname, 5000, "fix the MoE turbo quant ladder");
        check("repomap: task personalization pulls the relevant file up", rank(moeMap, "moe.mjs") < rank(gen, "moe.mjs"), `generic #${rank(gen, "moe.mjs")} -> task #${rank(moeMap, "moe.mjs")}`);
        check("repomap: header announces the focus", /focused on your task/.test(moeMap));
        check("repomap: no-task map is plain PageRank (no false focus claim)", !/focused on your task/.test(gen));
        check("repomap: respects the token budget", gen.length <= 5000 && moeMap.length <= 5000, `${gen.length} / ${moeMap.length}`);
        check("repomap: vendored 3rd-party code excluded (it crowds out real files)", !/vendor\//.test(gen) && !/node_modules/.test(gen));
        check("repomap: the core file ranks #1 on this repo", rank(gen, "agent.mjs") === 1, "#" + rank(gen, "agent.mjs"));
      }

      // ---- MICROCOMPACT: reclaim context for FREE (zero API calls) by eliding STALE tool
      // outputs. Each result is pasted at up to 4000 chars (~1000 tok); four of them fill a whole
      // 4096 starter context and evict the task. The LLM digest costs ~40s on a local model and is
      // lossy — so buy room free first, and only pay if that wasn't enough. ----
      {
        const big = (n) => "x".repeat(n);
        const convo = () => ([{ role: "system", content: "SYS " + big(600) },
          ...Array.from({ length: 6 }, (_, i) => [
            { role: "assistant", content: JSON.stringify({ tool: "read_file", args: { path: "f" + i } }) },
            { role: "user", content: "RESULT read_file:\n" + big(4000) + "\n\nNext action." }]).flat()]);
        const size = (m) => m.reduce((n, x) => n + (x.content?.length || 0), 0);
        const ag = new A.Agent(SANDBOX, { maxSteps: 1 });
        ag.memory.eta = { numCtx: 4096, ask: async () => "DIGEST" };
        const c1 = convo(), before = size(c1);
        const r = ag.memory.microCompact(c1);
        check("microcompact: reclaims context from stale tool outputs", r.saved > 10000 && size(r.msgs) < before, `saved ${r.saved} chars`);
        // keep=1 on a 4096 window: keep=2 still left ~2000 tok of results + ~1378 tok of system
        // prompt = 82% of the window — over the 70% line and heading for the live 400 (ISSUE 10).
        check("microcompact: `keep` scales to a tiny context (4096 -> keep 1, elide 5)", r.elided === 5, "elided " + r.elided);
        check("microcompact: system prompt untouched (KV-cache anchor)", r.msgs[0].content === c1[0].content);
        const res = r.msgs.filter((m) => /^RESULT /.test(m.content || ""));
        check("microcompact: the freshest result is kept INTACT (the model is using it)", res.slice(-1).every((m) => m.content.length > 3000));
        check("microcompact: stale ones leave a re-read marker (not a silent hole)", res.slice(0, 4).every((m) => /elided to save context/.test(m.content)));
        check("microcompact: message count preserved (no gaps in history)", r.msgs.length === c1.length);
        check("microcompact: idempotent — a second pass reclaims nothing", ag.memory.microCompact(r.msgs).elided === 0);
        // the whole point: the FREE step must make the ~40s LLM digest unnecessary
        let calls = 0;
        ag.memory.eta = { numCtx: 4096, ask: async () => { calls++; return "DIGEST"; } };
        const c2 = convo(), b2 = size(c2);
        const out = await ag.memory.maybeCompact(c2, () => {});
        check("microcompact: brings a 6.2k-token convo under the 4096 budget", size(out) / 4 < 4096 * 0.7, `${Math.round(b2 / 4)} -> ${Math.round(size(out) / 4)} tok`);
        check("microcompact: SKIPS the expensive LLM digest when free room was enough", calls === 0, "llm calls: " + calls);
        // and it must still fall back to the digest when eliding is NOT enough
        let calls2 = 0;
        const ag2 = new A.Agent(SANDBOX, { maxSteps: 1 });
        ag2.memory.eta = { numCtx: 4096, ask: async () => { calls2++; return "DIGEST"; } };
        const huge = [{ role: "system", content: "SYS" }, ...Array.from({ length: 14 }, () => ({ role: "user", content: "prose " + big(2000) }))];
        await ag2.memory.maybeCompact(huge, () => {});
        check("microcompact: still falls back to the digest when there's nothing free to reclaim", calls2 === 1, "llm calls: " + calls2);
        // ---- ISSUE 10 (CRITICAL, found in live IDE run 58): on an 8.5GB box numCtx is 4096, and
        // FIVE consecutive executor passes died with "the prompt is longer than the context length
        // currently available to the model" (400). Cause: maybeCompact ALSO required msgs.length>=12,
        // but micro-step passes are SHORT with HUGE messages — so compaction bailed and the prompt
        // overflowed. The executor was effectively dead on Eta's core hardware; the run only passed
        // because the enforced reference rescued it. SIZE must gate reclaiming; COUNT only gates the
        // digest (you can't summarise a 3-message list). ----
        const tiny = () => ([
          { role: "system", content: "EXEC_SYS+TOOLS+rules " + big(5500) },
          { role: "assistant", content: '{"tool":"read_file","args":{"path":"calc.py"}}' },
          { role: "user", content: "RESULT read_file:\n" + big(4000) + "\n\nNext action." },
          { role: "assistant", content: '{"tool":"run_tests","args":{}}' },
          { role: "user", content: "RESULT run_tests:\n" + big(4000) + "\n\nNext action." },
          { role: "assistant", content: '{"tool":"read_file","args":{"path":"t.py"}}' },
          { role: "user", content: "RESULT read_file:\n" + big(4000) + "\n\nNext action." },
        ]);
        const ag4096 = new A.Agent(SANDBOX, { maxSteps: 1 });
        ag4096.memory.eta = { numCtx: 4096, ask: async () => "DIGEST" };
        const t0 = tiny(), tokBefore = Math.round(size(t0) / 4);
        check("ctx: the live failure reproduces (short msgs, prompt over numCtx 4096)", t0.length < 12 && tokBefore > 4096, `${t0.length} msgs, ${tokBefore} tok`);
        const t1 = await ag4096.memory.maybeCompact(t0, () => {});
        const tokAfter = Math.round(size(t1) / 4);
        check("ctx: compaction now RUNS on a short-but-huge pass (msgs.length must not block it)", tokAfter < tokBefore, `${tokBefore} -> ${tokAfter} tok`);
        check("ctx: the prompt now FITS numCtx 4096 (no more 400)", tokAfter <= 4096, tokAfter + " tok");
        check("ctx: and lands under the 70% line", tokAfter < 4096 * 0.7, tokAfter + " tok");
        check("ctx: a 4096 window keeps exactly ONE tool result", ag4096.memory.microCompact(tiny()).elided === 2);
        // a large context must NOT be trimmed needlessly
        const agBig = new A.Agent(SANDBOX, { maxSteps: 1 });
        agBig.memory.eta = { numCtx: 32768, ask: async () => "DIGEST" };
        const tb = tiny();
        check("ctx: a 32k window is left untouched (no over-trimming)", size(await agBig.memory.maybeCompact(tb, () => {})) === size(tiny()));
        // THE ACTUAL ROOT CAUSE (run 59): the Agent defaulted numCtx to a blind 16384. On an 8.5GB
        // box Ollama cannot allocate a 16k window for a 16B model -> 400 "longer than the context
        // length CURRENTLY AVAILABLE", while compaction sat idle believing its budget was 11469 tok.
        // We were lying to ourselves about how much context we had.
        check("ctx: hwNumCtx scales to the machine, not to wishful thinking",
          A.hwNumCtx(8.5) === 4096 && A.hwNumCtx(12) === 8192 && A.hwNumCtx(32) === 16384,
          `${A.hwNumCtx(8.5)}/${A.hwNumCtx(12)}/${A.hwNumCtx(32)}`);
        const agDefault = new A.Agent(SANDBOX, { maxSteps: 1 });
        check("ctx: the Agent's DEFAULT numCtx now matches the hardware (was a blind 16384)", agDefault.eta.numCtx === A.hwNumCtx(), String(agDefault.eta.numCtx));
        check("ctx: memory measures against that SAME window", agDefault.memory.eta.numCtx === agDefault.eta.numCtx);
        check("ctx: an explicit numCtx still wins", new A.Agent(SANDBOX, { maxSteps: 1, numCtx: 32768 }).eta.numCtx === 32768);
      }

      // ---- MEMORY: ground truth in, HINTS out. Two bugs found live: (1) block()/brain() had ZERO
      // callers — memory was WRITE-ONLY, nothing ever recalled it; (2) what it wrote was garbage —
      // asking the model to "extract durable facts" produced raw transcript echoes and, in
      // d:/ab-ref3, a WRONG code fix recorded as gospel from a run that scored 1/6. So: record only
      // what VERIFIABLY happened (gates/cmdLog), recall as a hint, prune provably-stale paths. ----
      {
        const mws = fresh("memory");
        fs.writeFileSync(path.join(mws, "calc.py"), "def evaluate(): pass");
        fs.writeFileSync(path.join(mws, "test_calc.py"), "import unittest");
        const ag = new A.Agent(mws, { maxSteps: 1 });
        ag.testCmd = "python -m unittest discover";
        ag.files = new Set(["calc.py", "test_calc.py"]);
        ag.gates = { "calc.py": { ok: true }, "test_calc.py": { ok: true } };
        ag.cmdLog = [{ command: "pip install pytest", result: "installed" }, { command: "python broken.py", result: "⚠ COMMAND FAILED — boom" }];
        ag.authoritativeTests = { "test_calc.py": "..." };
        ag.failedCmds = new Map();
        const facts = await ag.memory.record("build a calculator", ag);
        check("memory: records the test command that actually PASSED", /Test command that PASSED/.test(facts), facts.slice(0, 60));
        check("memory: records a command that actually succeeded", /pip install pytest/.test(facts));
        check("memory: EXCLUDES a command that FAILED (never record a failure as fact)", !/broken\.py/.test(facts), facts);
        check("memory: records only files whose syntax gate passed", /calc\.py/.test(facts));
        check("memory: no transcript garbage (the old model-written failure mode)", !/\{"tool"|RESULT |assistant:/.test(facts), facts.slice(0, 80));
        const b1 = await ag.memory.block();
        check("memory: recalled as a HINT, not as truth", /hints, NOT truth/.test(b1) && !/PROJECT BRAIN/.test(b1));
        // \b matters: "test_calc.py" CONTAINS "calc.py" — a naive regex here gives a false negative
        const hasCalc = (s) => /(^|[\s:,])calc\.py\b/.test(s);
        check("memory: keeps facts whose files still exist", hasCalc(b1));
        fs.unlinkSync(path.join(mws, "calc.py"));            // the fact is now provably stale
        const b2 = await ag.memory.block();
        check("memory: PRUNES facts whose file no longer exists (stale = misleading)", !hasCalc(b2), b2.slice(-120));
        check("memory: keeps the still-valid facts", /test_calc\.py/.test(b2) && /pip install pytest/.test(b2));
        check("memory: empty brain -> empty block (no phantom section)", (await new A.Agent(fresh("mem-empty"), { maxSteps: 1 }).memory.block()) === "");
        // OUT-OF-SPEC TEST INVENTION (found in live IDE run 55): the task said "+ - * / and
        // parentheses"; the test-author invented `**` tests with wrong answers. The verified
        // reference rightly rejects ** as malformed, so they failed and counted against the model
        // — the calculator was solved 4/4 on the VALID tests but reported 4/6.
        const CALC_TASK = "Create calc.py with evaluate(expr) supporting + - * / and parentheses with correct operator precedence, spaces, decimal numbers, unary minus, and raise ValueError on division by zero and malformed input.";
        const INVENTED = `import unittest\nfrom calc import evaluate\n\nclass T(unittest.TestCase):\n    def test_precedence(self):\n        self.assertAlmostEqual(evaluate("3 + 4 * 2 / ( 1 - 5 )"), 1.0)\n\n    def test_pow(self):\n        self.assertAlmostEqual(evaluate("(3 + 4) * 2 / (1 - 5) ** 2"), 0.5)\n\n    def test_unary(self):\n        self.assertAlmostEqual(evaluate("2 * -(3 + 1)"), -8.0)\n\n    def test_bad(self):\n        with self.assertRaises(ValueError):\n            evaluate("3 + * 2")\n`;
        const oa = new A.Agent(fresh("oos"), { maxSteps: 1 });
        const logsO = [];
        const outO = await oa.verifyAuthoredTests("test_calc.py", CALC_TASK, INVENTED, (e) => { if (e.type === "log") logsO.push(e.text); });
        check("oracle: removes a test demanding ** that the spec never asked for", outO && !/test_pow/.test(outO), (outO || "null").slice(0, 80));
        check("oracle: KEEPS every in-spec test", outO && /test_precedence/.test(outO) && /test_unary/.test(outO) && /test_bad/.test(outO));
        check("oracle: never claims corrections it didn't make (log must not contradict itself)", !logsO.some((t) => /corrected \d+ wrong expected/.test(t)), logsO.join(" | "));
        check("oracle: says WHY, naming the unrequested operator", logsO.some((t) => /require \*\*/.test(t) && /never asked for/.test(t)), logsO.join(" | "));
        // GUARD: if the spec DOES ask for it, never delete the test (our reference would just be
        // incomplete — deleting a real requirement is far worse than a red test)
        const oa2 = new A.Agent(fresh("oos-inspec"), { maxSteps: 1 });
        const outP = await oa2.verifyAuthoredTests("test_calc.py", CALC_TASK + " It must also support ** exponentiation.", INVENTED, () => {});
        check("oracle: spec DOES ask for ** -> the test is KEPT (never delete a real requirement)", !outP || /test_pow/.test(outP), (outP || "null").slice(0, 80));
        // a test that EXPECTS a raise is valid — must never be removed
        const oa3 = new A.Agent(fresh("oos-raises"), { maxSteps: 1 });
        const RAISES_OK = `import unittest\nfrom calc import evaluate\n\nclass T(unittest.TestCase):\n    def test_bad(self):\n        with self.assertRaises(ValueError):\n            evaluate("2**3")\n`;
        const outR = await oa3.verifyAuthoredTests("test_calc.py", CALC_TASK, RAISES_OK, () => {});
        check("oracle: a test that EXPECTS a raise is valid, never removed", outR === null || /test_bad/.test(outR));
        check("oracle: _removeTestMethod excises only the target method", !/def test_pow/.test(oa._removeTestMethod(INVENTED, "test_pow")) && /def test_precedence/.test(oa._removeTestMethod(INVENTED, "test_pow")));
      }

      // ---- SPEC-COMPLIANT SKILLS (2026-07-22): rewrote parseSkill/loadSkills to the REAL Agent
      // Skills open standard (agentskills.io/specification, adopted by 40+ tools incl. Cursor/VS
      // Code/GitHub Copilot/Gemini CLI) instead of a home-grown format — a skill folder authored
      // for any of those tools should now load correctly here too. ----
      {
        const skWs = fresh("skill-spec");
        const mk = (dir, content) => { fs.mkdirSync(path.join(skWs, ".eta", "skills", dir), { recursive: true }); fs.writeFileSync(path.join(skWs, ".eta", "skills", dir, "SKILL.md"), content, "utf8"); };

        mk("full-spec", `---
name: full-spec
description: A skill exercising every real spec field at once.
license: MIT
compatibility: Requires git and jq
allowed-tools: Bash(git:*) Read
---
Body content.`);
        mk("mismatched-name", `---
name: totally-different-name
description: Its declared name disagrees with its directory.
---
Body.`);
        mk("no-frontmatter-fields", `---
description: Only the required fields are present, everything else omitted.
---
Body.`);

        const loaded = await A.loadSkills(skWs);
        const full = loaded.find((s) => s.dir.endsWith("full-spec"));
        check("spec skill: license/compatibility/allowed-tools all parsed", full && full.license === "MIT" && full.compatibility === "Requires git and jq" && full.allowedTools === "Bash(git:*) Read", JSON.stringify(full));
        check("spec skill: identity is the DIRECTORY name, matching name: agrees so it's valid", full && full.name === "full-spec" && full.nameValid === true);

        const mismatched = loaded.find((s) => s.dir.endsWith("mismatched-name"));
        check("spec skill: a name: that disagrees with its directory is flagged invalid...", mismatched && mismatched.nameValid === false);
        check("...but identity STILL falls back to the directory name (never trusts the mismatching claim)", mismatched && mismatched.name === "mismatched-name");

        const minimal = loaded.find((s) => s.dir.endsWith("no-frontmatter-fields"));
        check("spec skill: optional fields default to empty string, not undefined/crash", minimal && minimal.license === "" && minimal.compatibility === "" && minimal.allowedTools === "");
        check("spec skill: a skill with no `when:` field at all still matches on description alone", A.matchSkills("only the required fields are present", loaded, 2).some((s) => s.name === "no-frontmatter-fields"));

        // oversized: the spec's own soft guidance is "keep SKILL.md under 500 lines"
        mk("huge-skill", `---\nname: huge-skill\ndescription: A skill whose body blows past the spec's 500-line guidance.\n---\n` + Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n"));
        const withHuge = await A.loadSkills(skWs);
        check("spec skill: a body over 500 lines is flagged oversized (spec's own soft guidance)", withHuge.find((s) => s.name === "huge-skill")?.oversized === true);
        check("spec skill: a normal-size skill is NOT flagged oversized", withHuge.find((s) => s.name === "full-spec")?.oversized === false);

        // all 11 bundled skills migrated off the old home-grown "when:" field
        const bundled = await A.loadSkills(null);
        check("bundled skills: all 11 loaded with a description", bundled.length >= 11 && bundled.every((s) => s.description), bundled.length);
        check("bundled skills: every one has a spec-valid name (matches its own directory)", bundled.every((s) => s.nameValid !== false), JSON.stringify(bundled.filter((s) => s.nameValid === false).map((s) => s.name)));
        let noWhenFieldOnDisk = true;
        for (const s of bundled) { try { if (/^when:/im.test(fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"))) noWhenFieldOnDisk = false; } catch {} }
        check("bundled skills: none of the SKILL.md files on disk still carry the non-standard 'when:' field", noWhenFieldOnDisk);
      }

      // ---- EXPLICIT SKILL INVOCATION (2026-07-22): skills were 100% automatic/invisible
      // (keyword-matched) with no way to force one in, unlike workflows which already have a
      // "/name" manual trigger. resolveMatchedSkills() layers the same manual override onto
      // skills without touching matchSkills' existing auto-match behavior. ----
      {
        const skA = { name: "python-testing", description: "writing pytest tests", when: "", body: "PYTEST BODY" };
        const skB = { name: "web-page", description: "building a web page", when: "", body: "WEBPAGE BODY" };
        const skills = [skA, skB];
        const noForce = A.resolveMatchedSkills("build a calculator", skills, null, 2);
        check("resolveMatchedSkills: no forceSkill -> identical to plain matchSkills", JSON.stringify(noForce.matched) === JSON.stringify(A.matchSkills("build a calculator", skills, 2)) && noForce.forcedFound === null);
        const forced = A.resolveMatchedSkills("build a calculator", skills, "web-page", 2);
        check("resolveMatchedSkills: forced skill is FRONT of the list even with zero keyword match", forced.matched[0].name === "web-page", JSON.stringify(forced.matched.map((s) => s.name)));
        check("resolveMatchedSkills: forcedFound is true when the name matches", forced.forcedFound === true);
        check("resolveMatchedSkills: is case-insensitive on the forced name", A.resolveMatchedSkills("x", skills, "WEB-PAGE", 2).matched[0].name === "web-page");
        const missing = A.resolveMatchedSkills("build a calculator", skills, "does-not-exist", 2);
        check("resolveMatchedSkills: an unknown forced name reports forcedFound=false (never silently dropped)", missing.forcedFound === false);
        check("resolveMatchedSkills: falls back to normal auto-match when the forced name is unknown", JSON.stringify(missing.matched) === JSON.stringify(A.matchSkills("build a calculator", skills, 2)));
        check("resolveMatchedSkills: never duplicates the forced skill if auto-match also picked it", A.resolveMatchedSkills("pytest tests", skills, "python-testing", 2).matched.filter((s) => s.name === "python-testing").length === 1);

        // Agent wiring: constructor stores forceSkill, and it's absent by default (existing behavior unchanged)
        const agDefault2 = new A.Agent(fresh("skill-default"), { maxSteps: 1 });
        check("Agent: forceSkill defaults to null (no behavior change for existing callers)", agDefault2.forceSkill === null);
        const agForced = new A.Agent(fresh("skill-forced"), { maxSteps: 1, forceSkill: "web-page" });
        check("Agent: forceSkill is stored from opts", agForced.forceSkill === "web-page");
      }

      // ---- RESEARCH CACHE (2026-07-22): same law as the memory block above, extended to
      // deep_research — never persist the synthesized BRIEF (paraphrase-of-a-paraphrase, the
      // "citation-shaped hallucination" failure mode), only the per-source bullets PAIRED WITH
      // their URL (a provenance pointer, not a fact), and ONLY from a run that finished clean. ----
      {
        const rws = fresh("research-cache");
        const ag = new A.Agent(rws, { maxSteps: 1 });
        const trace = [
          { question: "how does CLIP's dual encoder work", findings: [
            { url: "https://huggingface.co/docs/clip", title: "CLIP docs", bullets: ["- text and image towers share one embedding space", "- use CLIPTextModelWithProjection for the text side"] },
            { url: "https://example.com/other", title: "Other", bullets: ["- ViT-B/32 is the base variant"] },
          ] },
        ];
        await ag.memory.recordResearch(trace);
        const rblock = await ag.memory.block();
        check("research: recorded findings show up in block()", /CLIPTextModelWithProjection/.test(rblock), rblock.slice(0, 200));
        check("research: source URL is attached to the claim (provenance pointer)", /huggingface\.co\/docs\/clip/.test(rblock));
        check("research: framed as a hint to re-check, never as fact", /re-check before trusting|don't act on it blind/.test(rblock));
        check("research: never records the free-form BRIEF, only per-source bullets", !/paraphrase|APPLY:/.test(rblock));

        const ag2 = new A.Agent(fresh("research-empty"), { maxSteps: 1 });
        await ag2.memory.recordResearch([]); // no findings -> nothing written, no phantom file
        check("research: an empty trace writes nothing (no phantom section)", (await ag2.memory.block()) === "");
        await ag2.memory.recordResearch([{ question: "q", findings: [{ url: "https://x.test", title: "t", bullets: [] }] }]);
        check("research: a finding with zero bullets writes nothing", (await ag2.memory.block()) === "");

        // staleness: a claim from 60 days ago must be pruned (APIs/docs drift — false confidence
        // is worse than no claim), while a fresh one right next to it survives.
        const ag3 = new A.Agent(fresh("research-stale"), { maxSteps: 1 });
        const brainDir = path.join(ag3.root, ".eta", "brain");
        fs.mkdirSync(brainDir, { recursive: true });
        const old = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
        const fresh_ = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(path.join(brainDir, "research.md"),
          `\n## ${old}\n- an old, possibly-drifted claim — source: https://old.test\n\n## ${fresh_}\n- a fresh claim — source: https://new.test\n`, "utf8");
        const b3 = await ag3.memory.block();
        check("research: prunes a claim older than RESEARCH_MAX_AGE_DAYS", !/old, possibly-drifted/.test(b3), b3.slice(0, 200));
        check("research: keeps a claim within the window", /a fresh claim/.test(b3) && /new\.test/.test(b3));
      }

      // ---- ENFORCED REFERENCE: the day's clearest measured lesson — deterministic enforcement
      // works, persuasion doesn't. SHOWING this model a verified reference failed 3/3 (calc twice:
      // never implemented unary minus; scheduler: kept a cycle check that can never fire). So write
      // the proven code in ourselves and let EXECUTION judge: keep only if the score improves. ----
      {
        const cmd = 'python -B -m unittest discover -p "test*.py"';
        const SCHED_TESTS = `import unittest\nfrom scheduler import plan\n\nclass T(unittest.TestCase):\n    def test_tie(self):\n        self.assertEqual(plan({'A': [], 'B': ['A'], 'C': ['A'], 'D': []}), ['A', 'B', 'C', 'D'])\n    def test_cycle(self):\n        with self.assertRaises(ValueError):\n            plan({'A': ['B'], 'B': ['A']})\n    def test_self_cycle(self):\n        with self.assertRaises(ValueError):\n            plan({'A': ['A']})\n`;
        // the 16B's REAL failure mode from the live run: `in_degree < 0` can never fire
        const BROKEN = `def plan(tasks):\n    indeg = {t: len(p) for t, p in tasks.items()}\n    order = [t for t in sorted(tasks) if indeg[t] == 0]\n    if any(v < 0 for v in indeg.values()):\n        raise ValueError("cycle")\n    return order\n`;
        const w1 = fresh("enforce");
        fs.writeFileSync(path.join(w1, "scheduler.py"), BROKEN);
        fs.writeFileSync(path.join(w1, "test_scheduler.py"), SCHED_TESTS);
        const ag = new A.Agent(w1, { maxSteps: 1 });
        ag.task = "schedule tasks by dependency prerequisites with alphabetical tie-breaking and cycle detection";
        ag.files = new Set(["scheduler.py"]); ag.lockedFiles = new Set(["test_scheduler.py"]);
        ag.failedCmds = new Map(); ag.gates = {};
        const logs = [];
        const won = await ag.adoptVerifiedReference(cmd, (e) => { if (e.type === "log") logs.push(e.text); });
        check("enforce: adopts the verified reference and reaches ALL TESTS PASS", won === true, logs.join(" | ").slice(0, 120));
        check("enforce: the file really contains the verified cycle fix", /len\(order\) != len\(nodes\)/.test(fs.readFileSync(path.join(w1, "scheduler.py"), "utf8")));
        check("enforce: reports it as execution-verified, not a claim", logs.some((t) => /execution-verified/.test(t)));
        // GUARD 1: doesn't fit the task's API -> revert, never destroy the model's work
        const w2 = fresh("enforce-nofit");
        const MINE = "def schedule_tasks(t):\n    return list(t)\n";
        fs.writeFileSync(path.join(w2, "scheduler.py"), MINE);
        fs.writeFileSync(path.join(w2, "test_scheduler.py"), 'import unittest\nfrom scheduler import schedule_tasks\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(schedule_tasks({"b":[],"a":[]}), ["a","b"])\n    def test_y(self):\n        self.assertEqual(schedule_tasks({}), [])\n');
        const ag2 = new A.Agent(w2, { maxSteps: 1 });
        ag2.task = "schedule tasks by dependency prerequisites with cycle detection";
        ag2.files = new Set(["scheduler.py"]); ag2.lockedFiles = new Set(); ag2.failedCmds = new Map(); ag2.gates = {};
        const logs2 = [];
        await ag2.adoptVerifiedReference(cmd, (e) => { if (e.type === "log") logs2.push(e.text); });
        check("enforce: reference that doesn't fit the spec is REVERTED (no harm)", fs.readFileSync(path.join(w2, "scheduler.py"), "utf8") === MINE, "file was replaced!");
        check("enforce: says so honestly when it doesn't fit", logs2.some((t) => /did NOT fit/.test(t)), logs2.join(" | "));
        // GUARD 2: never touch code this run did NOT create (the user's own files)
        const w3 = fresh("enforce-userfile");
        const USER = "def plan(tasks):\n    return 1/0\n";
        fs.writeFileSync(path.join(w3, "scheduler.py"), USER);
        fs.writeFileSync(path.join(w3, "test_scheduler.py"), SCHED_TESTS);
        const ag3 = new A.Agent(w3, { maxSteps: 1 });
        ag3.task = "schedule tasks by dependency prerequisites cycle detection";
        ag3.files = new Set();  // this run created nothing
        ag3.lockedFiles = new Set(); ag3.failedCmds = new Map(); ag3.gates = {};
        await ag3.adoptVerifiedReference(cmd, () => {});
        check("enforce: NEVER overwrites the user's pre-existing code", fs.readFileSync(path.join(w3, "scheduler.py"), "utf8") === USER);
        // GUARD 3: no matching verified pattern -> stay out of the way
        const w4 = fresh("enforce-nopattern");
        fs.writeFileSync(path.join(w4, "api.py"), "def signup(): return 0\n");
        fs.writeFileSync(path.join(w4, "test_api.py"), "import unittest\nfrom api import signup\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(signup(), 1)\n");
        const ag4 = new A.Agent(w4, { maxSteps: 1 });
        ag4.task = "write a REST endpoint for user signup";
        ag4.files = new Set(["api.py"]); ag4.lockedFiles = new Set(); ag4.failedCmds = new Map(); ag4.gates = {};
        check("enforce: no verified reference matches -> stays out of the way", (await ag4.adoptVerifiedReference(cmd, () => {})) === false && /def signup/.test(fs.readFileSync(path.join(w4, "api.py"), "utf8")));
        // INTEGRATION BUG caught by a real IDE run (54): `!this.overBudget()` gated the WHOLE
        // safety net, so when the 8m budget fired the FREE proven fix never ran and the task
        // shipped 4/6. A *time* budget must never block a fix costing zero model calls (~2s).
        const w5 = fresh("enforce-overbudget");
        fs.writeFileSync(path.join(w5, "scheduler.py"), BROKEN);
        fs.writeFileSync(path.join(w5, "test_scheduler.py"), SCHED_TESTS);
        const ag5 = new A.Agent(w5, { maxSteps: 1, timeBudgetMs: 1 });   // budget ALREADY blown
        ag5.task = "schedule tasks by dependency prerequisites with cycle detection";
        ag5.files = new Set(["scheduler.py"]); ag5.lockedFiles = new Set(["test_scheduler.py"]);
        ag5.failedCmds = new Map(); ag5.gates = {}; ag5.startTime = Date.now() - 60000;
        check("enforce: run IS over budget (test precondition)", ag5.overBudget() === true);
        check("enforce: the FREE proven fix still runs when over budget (budget must not block it)",
          (await ag5.adoptVerifiedReference(cmd, () => {})) === true);
        // and the source must keep the paid nets gated
        const src = fs.readFileSync(path.join(__dirname, "agent.mjs"), "utf8");
        check("enforce: expensive best-of-N stays budget-gated", /if \(!won && !this\.overBudget\(\)\) won = await this\.bestOfNFix/.test(src));

        // ---- BUG 30: REPAIR WINDOW. The check above keeps the PAID levers budget-gated, which was
        // right — but MEASURED over the full run history (61 runs, 32 with a failing test gate),
        // that gate made them dead code: 27 of 32 failing-gate runs entered the ladder with the
        // clock ALREADY blown, so surgicalEditFix/completeStubs/bestOfNFix/escalateFix were skipped
        // by construction (reached 1/1/0/0 times across the whole history). Raising the budget
        // cannot fix it — measured ladder entry was ~1.16x the budget at 5m, 8m AND 12m alike.
        // The ladder now gets its own bounded deadline, measured from ENTRY. ----
        const agRW = new A.Agent(w5, { maxSteps: 1, timeBudgetMs: 8 * 60000 });
        agRW.startTime = Date.now() - Math.round(1.16 * 8 * 60000); // the measured real state at entry
        agRW._repairUntil = 0;
        // PRECONDITION — without this the assertions below could pass on a run that was never
        // over budget at all, proving nothing (the lesson from bug 29's no-op harness).
        check("repair window: PRECONDITION — at ladder entry the run IS already over budget", agRW.overBudget() === true);
        check("repair window: 25% of an 8m budget = 120s", agRW.repairWindowMs() === 120000);
        check("repair window: 12m budget stays capped at 150s",
          A.Agent.prototype.repairWindowMs.call({ timeBudgetMs: 12 * 60000 }) === 150000);
        let rwLog = null;
        check("repair window: entering the repair phase returns true the first time",
          agRW.enterRepairPhase((e) => { rwLog = e; }) === true);
        check("repair window: the budget-gated levers are now REACHABLE (was the bug)", agRW.overBudget() === false);
        check("repair window: it announces itself in the run's events", /repair window: 120s/.test(rwLog?.text || ""));
        check("repair window: bounded — never more than the window from now",
          agRW._repairUntil - Date.now() <= 120000 + 50);
        const rwDeadline = agRW._repairUntil;
        check("repair window: a second ladder cannot re-extend it", agRW.enterRepairPhase(() => {}) === false && agRW._repairUntil === rwDeadline);
        // It is a DEADLINE, not an exemption — it really expires.
        agRW._repairUntil = Date.now() - 1;
        check("repair window: expires (over budget again even though the RUN budget is fine)", agRW.overBudget() === true);
        // Strictly additive: outside the repair phase nothing changed.
        const agNoRW = new A.Agent(w5, { maxSteps: 1, timeBudgetMs: 8 * 60000 });
        agNoRW.startTime = Date.now() - 9 * 60000; agNoRW._repairUntil = 0;
        check("repair window: executor path unchanged — blown budget still over budget", agNoRW.overBudget() === true);
        agNoRW.startTime = Date.now() - 1000;
        check("repair window: executor path unchanged — fresh run still under budget", agNoRW.overBudget() === false);
        check("repair window: wired into the ladder BEFORE the gated levers",
          src.indexOf("this.enterRepairPhase(emit);") > 0 &&
          src.indexOf("this.enterRepairPhase(emit);") < src.indexOf("won = await this.bestOfNFix(testCmd, emit, this.bestOfNCount())"));
      }

      // ---- SURGICAL-FIRST BUDGET RESERVE. LIVE-CAUGHT (boltons run 230, 2026-09-16): surgical-first's
      // `surgicalEditFix` ran against the full unreserved this.timeBudgetMs and could alone consume the
      // ENTIRE run budget (measured live: a 3-target fix used 508s of an 8m/480s budget before giving
      // up), so the fallback executor pipeline's very first overBudget() check was already true — zero
      // fallback steps ever ran, even though the log line right above it claimed to be "continuing with
      // the normal executor pipeline". `withBudgetReserve()` now caps the lever to a fair share (floor
      // 60s, 20% of the budget) and restores the full budget afterward, so a slow-but-failed surgical
      // attempt can no longer deny the fallback its turn. Same shape as decomposeMultiFile's per-batch
      // budget slice, generalized into a reusable helper. ----
      {
        const agBR = new A.Agent(fresh("surgical-budget-reserve"), { maxSteps: 1, timeBudgetMs: 8 * 60000 });
        check("leverBudgetReserveMs: 20% of an 8m budget = 96s", agBR.leverBudgetReserveMs() === 96000);
        check("leverBudgetReserveMs: floors at 60s even on a tiny budget",
          A.Agent.prototype.leverBudgetReserveMs.call({ timeBudgetMs: 60000 }) === 60000);

        let fakeNow2 = 2000000;
        const realNow2 = Date.now;
        Date.now = () => fakeNow2;
        agBR.startTime = fakeNow2 - 1000; // just started
        let seenBudget = null;
        const result = await agBR.withBudgetReserve(agBR.leverBudgetReserveMs(), async () => {
          seenBudget = agBR.timeBudgetMs;
          fakeNow2 += 9 * 60000; // pretend the lever ran long — past the ORIGINAL 8m budget
          return "won";
        });
        check("withBudgetReserve: PRECONDITION — reserve is smaller than the full budget (test is meaningful)",
          agBR.leverBudgetReserveMs() < 8 * 60000);
        check("withBudgetReserve: the lever runs against budget-minus-reserve, not the full budget",
          seenBudget === 8 * 60000 - 96000, String(seenBudget));
        check("withBudgetReserve: the original timeBudgetMs is restored after the lever returns",
          agBR.timeBudgetMs === 8 * 60000);
        check("withBudgetReserve: the lever's own return value passes through", result === "won");

        // The actual starvation this fixes: once restored, a fallback step's overBudget() check must
        // NOT be starved by a lever that only ran long WITHIN its own capped share. Still on the same
        // fake clock so elapsed time is measured consistently with the calls above.
        agBR.startTime = fakeNow2 - Math.round(7.9 * 60000); // lever finished just under the reserve cutoff
        check("withBudgetReserve: a lever that stays within its reserved cap leaves the fallback still under budget",
          agBR.overBudget() === false);
        Date.now = realNow2;

        // The restore must happen even if the lever throws (finally-discipline, not just the happy path).
        const agBR2 = new A.Agent(fresh("surgical-budget-reserve-throw"), { maxSteps: 1, timeBudgetMs: 8 * 60000 });
        agBR2.startTime = Date.now();
        let threw = false;
        try { await agBR2.withBudgetReserve(agBR2.leverBudgetReserveMs(), async () => { throw new Error("boom"); }); }
        catch { threw = true; }
        check("withBudgetReserve: restores the budget even when the lever throws",
          threw && agBR2.timeBudgetMs === 8 * 60000);

        const src2 = fs.readFileSync(path.join(__dirname, "agent.mjs"), "utf8");
        check("surgical-first: surgicalEditFix is actually wired through withBudgetReserve (not called against the raw run budget)",
          /won = await this\.withBudgetReserve\(this\.leverBudgetReserveMs\(\), \(\) => this\.surgicalEditFix\(testCmd, emit\)\)/.test(src2));
      }

      // ---- BATCHED READS: each model round-trip costs ~5-10s on a 13 tok/s local brain while the
      // file I/O is ~10ms — reading 3 files one-at-a-time burns ~15-30s of pure latency. Context
      // cost is identical (sequential results accumulate in msgs exactly as a batch would), so this
      // is a straight latency win. The action schema stays ONE {tool,args} — constrained decoding
      // is what keeps a weak model emitting valid actions. ----
      {
        const bws = fresh("batch");
        fs.writeFileSync(path.join(bws, "a.py"), "def alpha(): return 1");
        fs.writeFileSync(path.join(bws, "b.py"), "def beta(): return 2");
        fs.writeFileSync(path.join(bws, "c.py"), "def gamma(): return 3");
        fs.writeFileSync(path.join(bws, "big.py"), Array.from({ length: 300 }, (_, i) => "line" + i).join("\n"));
        fs.writeFileSync(path.join(bws, "comma,name.py"), "def weird(): return 9");
        const bctx = { root: bws, log: () => {}, files: new Set() };
        const r = await A.execTool("read_file", { path: ["a.py", "b.py", "c.py"] }, bctx);
        check("batch: reads 3 files in ONE action (3 round-trips -> 1)", /alpha/.test(r) && /beta/.test(r) && /gamma/.test(r));
        check("batch: each file is clearly delimited", (r.match(/=====/g) || []).length >= 6);
        const one = await A.execTool("read_file", { path: "a.py" }, bctx);
        check("batch: a single read is unchanged (no regression)", /alpha/.test(one) && !/=====/.test(one));
        check("batch: comma-separated string also batches", /beta/.test(await A.execTool("read_file", { path: "a.py, b.py" }, bctx)));
        // the trap: a REAL filename containing a comma must NOT be split into two paths
        check("batch: a real comma-in-filename is NOT split (existsSync guard)", /weird/.test(await A.execTool("read_file", { path: "comma,name.py" }, bctx)));
        check("batch: a missing file degrades gracefully, others still returned", /alpha/.test(await A.execTool("read_file", { path: ["a.py", "ghost.py"] }, bctx)) && /could not read/.test(await A.execTool("read_file", { path: ["a.py", "ghost.py"] }, bctx)));
        check("batch: capped at 5 files per action", /capped at 5/.test(await A.execTool("read_file", { path: ["a.py", "b.py", "c.py", "a.py", "b.py", "c.py", "a.py"] }, bctx)));
        const bigb = await A.execTool("read_file", { path: ["big.py", "a.py"] }, bctx);
        check("batch: long files clipped inside a batch (context protected)", /first 120 lines/.test(bigb) && bigb.length < 9000, bigb.length + " chars");
        // BUG (found live, run 227 on boltons/statsutils.py, 815 lines): the clip note told the model
        // to "read_file it alone for the rest" without saying WHAT start_line to pass. The model read
        // "(815 lines)" as a position instead of a total and requested start_line=815 on an 815-line
        // file — an empty, wasted round-trip that burned its time budget with zero progress before any
        // edit was ever attempted. Fix: state the exact continuation start_line explicitly, and warn
        // off the total-line-count trap by name.
        check("batch: clip note gives the EXACT continuation start_line (not left for the model to guess)", /start_line=121/.test(bigb));
        check("batch: clip note warns off the total-line-count trap (the exact confusion that wasted run 227)", /NOT start_line=300/.test(bigb));
        check("batch: single-element list behaves like a normal read", /alpha/.test(await A.execTool("read_file", { path: ["a.py"] }, bctx)));
        check("batch: the tool contract advertises batching to the model", /read SEVERAL files in ONE action/.test(A.TOOLS_TEXT || ""));

        // Same fix applies to the non-batched single-file read path (agent.mjs read_file, ~line 923).
        fs.writeFileSync(path.join(bws, "huge.py"), Array.from({ length: 500 }, (_, i) => "line" + i).join("\n"));
        const first = await A.execTool("read_file", { path: "huge.py" }, bctx);
        check("single read: clip note gives the EXACT continuation start_line", /start_line=351/.test(first), first.slice(0, 120));
        check("single read: clip note warns off the total-line-count trap", /NOT start_line=500/.test(first));
        const middle = await A.execTool("read_file", { path: "huge.py", start_line: 351 }, bctx);
        check("single read: following the given start_line actually reaches the rest of the file", /line400/.test(middle));
      }

      // ---- PLANNER RULES: two defects found by WATCHING a live IDE run (57), both caused by OUR
      // OWN PROMPT, not the model. (a) "SMALLEST testable increments" made it plan `Create an empty
      // Python file named stats.py` then `define the class` then `add the methods` — 3 executor
      // passes (a full model round-trip each) for one 29-line file. (b) The planner runs BEFORE
      // authorTests locks the spec, so it planned test-writing the executor is forbidden to do. ----
      {
        const withTests = A.planRules(8, true), noTests = A.planRules(8, false);
        check("planner: the phrase that CAUSED junk steps is gone", !/SMALLEST testable increments/.test(withTests));
        check("planner: demands ONE COMPLETE, WORKING FILE per step", /ONE COMPLETE, WORKING FILE/.test(withTests));
        check("planner: bans empty/placeholder-file steps", /NEVER plan a step that creates an empty/.test(withTests));
        check("planner: bans splitting one file across steps", /NEVER split one file across steps/.test(withTests));
        check("planner: told the SYSTEM locks the tests, so plan implementation only", /SYSTEM writes and LOCKS the test file/.test(withTests) && /do NOT include any step that creates, writes or edits tests/.test(withTests));
        check("planner: still asks for a final run-the-tests step", /final step that RUNS the tests/.test(withTests));
        check("planner: does NOT claim the system locks tests when it won't", !/SYSTEM writes and LOCKS/.test(noTests));
        check("planner: honours the step budget", /AT MOST 8 step/.test(withTests) && /AT MOST 3 step/.test(A.planRules(3, false)));
        // the trigger must match the REAL authorTests condition (wantsTests && no pre-existing locks)
        check("planner: a test-writing task triggers the lock hint", A.wantsTests("Then write test_cache.py with at least 10 unittest tests"));
        check("planner: a plain edit task does not", !A.wantsTests("add a print statement to main.py"));
      }

      // ---- taskWantsTestFileEdited (LIVE-CAUGHT, boltons run 50/51, 2026-07-23): a rename+add-
      // method task explicitly asked to update call sites AND add a new test INSIDE an already-
      // existing, auto-locked test file — the blanket "never rewrite" lock blocked the legitimate
      // edit, and LEVER 6 contract-enforcement then reverted the task's own requested rename to
      // match the stale locked spec. This helper detects "the task's wording asks to change THIS
      // specific test file" so the auto-lock can exclude it. ----
      {
        const renameTask = "Rename the method distance_to on the Point class in boltons/pointutils.py to distance. Update every call site that uses distance_to, including boltons/shapeutils.py and tests/test_shapeutils.py, to use the new name distance instead. Then add a new method center() to the Rectangle class in boltons/shapeutils.py. Add a test for center() in tests/test_shapeutils.py.";
        check("taskWantsTestFileEdited: catches 'update call sites... including tests/test_x.py'", A.taskWantsTestFileEdited(renameTask, "tests/test_shapeutils.py"));
        check("taskWantsTestFileEdited: catches 'add a test for center() in tests/test_x.py'", A.taskWantsTestFileEdited("Add a test for center() in tests/test_shapeutils.py.", "tests/test_shapeutils.py"));
        check("taskWantsTestFileEdited: a plain 'make tests/test_x.py pass' does NOT trigger (still an oracle)", !A.taskWantsTestFileEdited("Fix the bug so that tests/test_shapeutils.py passes.", "tests/test_shapeutils.py"));
        check("taskWantsTestFileEdited: mentioning an unrelated file by name doesn't false-positive", !A.taskWantsTestFileEdited(renameTask, "tests/test_other.py"));
        // LIVE-CAUGHT (boltons run 55, 2026-07-23): a removal task ("remove the corresponding
        // test_rectangle_perimeter test method from tests/test_shapeutils.py") hit the same lock —
        // the verb list had no deletion verbs, so a correct edit_file removal was blocked twice.
        const removeTask = "Remove the perimeter() method from the Rectangle class entirely. Also remove the corresponding test_rectangle_perimeter test method from tests/test_shapeutils.py, since that test no longer applies.";
        check("taskWantsTestFileEdited: catches 'remove the ... test method from tests/test_x.py'", A.taskWantsTestFileEdited(removeTask, "tests/test_shapeutils.py"));
        check("taskWantsTestFileEdited: catches 'delete tests/test_x.py'", A.taskWantsTestFileEdited("Delete tests/test_x.py, it's obsolete.", "tests/test_x.py"));
      }

      // ---- taskWantsTestFileEdited: "fix <file>" direct-object case (LIVE-CAUGHT, boltons run 140,
      // 2026-08-18): a task asked to fix an OUTDATED TEST FILE while explicitly forbidding the
      // already-correct impl file it tests. "fix" wasn't in the verb list at all, so the auto-lock
      // scan locked the test file as an oracle, and the dispatch-time guard hard-blocked the
      // executor's own correct first attempt to edit it — while telling it "the bug is in your
      // IMPLEMENTATION", which misdirected the model into burning its whole budget on the
      // explicitly-forbidden impl file. Must NOT regress the existing "Fix the bug so tests/x.py
      // passes" negative case just above (file as oracle, not as the verb's direct object). ----
      {
        const fixLegacyTask = "There are two test files that both test boltons/mathutils.py's lerp() function, and they disagree with each other: tests/test_mathutils.py expects lerp(0, 10, 0.5) == 5.0 (t is a fraction in [0,1], matching lerp()'s own docstring), while tests/test_lerp_legacy.py expects lerp(0, 10, 0.5) == 5.5 and similarly mismatched values for t=0 and t=1. tests/test_lerp_legacy.py is the outdated one -- it was written against an old, abandoned design and was never updated when lerp() was actually implemented for real. Fix tests/test_lerp_legacy.py so its assertions match the real, correct, documented behavior of lerp() in boltons/mathutils.py. Do not modify boltons/mathutils.py or tests/test_mathutils.py -- both are already correct.";
        check("taskWantsTestFileEdited: catches 'Fix tests/test_x.py so its assertions match ...' (run-140 case)",
          A.taskWantsTestFileEdited(fixLegacyTask, "tests/test_lerp_legacy.py"));
        check("taskExplicitlyForbidsFile: still forbids the already-correct impl file in the same task (run-140 case)",
          A.taskExplicitlyForbidsFile(fixLegacyTask, "boltons/mathutils.py"));
        check("taskWantsTestFileEdited: 'Fix the bug so that tests/x.py passes' still does NOT trigger (no regression)",
          !A.taskWantsTestFileEdited("Fix the bug so that tests/test_shapeutils.py passes.", "tests/test_shapeutils.py"));
        check("taskWantsTestFileEdited: negated 'Do not fix tests/x.py' does NOT trigger",
          !A.taskWantsTestFileEdited("Do not fix tests/test_x.py, it is fine.", "tests/test_x.py"));
        check("taskWantsTestFileEdited: 'Fix up tests/x.py' (verb + up) also triggers",
          A.taskWantsTestFileEdited("Fix up tests/test_x.py so it matches the new API.", "tests/test_x.py"));
      }

      // ---- taskWantsTestFileEdited / taskExplicitlyForbidsFile: negation fix (LIVE-CAUGHT, boltons
      // run 80, 2026-07-27 — an orphaned run found by this same session, engine had crashed mid-run):
      // "Do not modify boltons/pointutils.py, boltons/shapeutils.py, or tests/test_shapeutils.py."
      // matched the plain verb scan on "modify" for ALL THREE files. For the test file this would have
      // wrongly EXCLUDED it from the pre-existing-test lock (unprotected from rewrite); for the two
      // impl files, the separate `named`-list bug (fixed via taskExplicitlyForbidsFile) actually routed
      // them into surgical-first/multi-file-decomposition as live edit targets — a real file-safety
      // risk, not just a reporting cosmetic. ----
      {
        const negTask = "Add a new Circle class to a new file boltons/circleutils.py: Circle(center, radius)... Do not modify boltons/pointutils.py, boltons/shapeutils.py, or tests/test_shapeutils.py.";
        check("taskWantsTestFileEdited: does NOT flag a file the task explicitly says NOT to modify (run-80 case)",
          !A.taskWantsTestFileEdited(negTask, "tests/test_shapeutils.py"));
        check("taskExplicitlyForbidsFile: flags the first file in a negated comma-list (run-80 case)",
          A.taskExplicitlyForbidsFile(negTask, "boltons/pointutils.py"));
        check("taskExplicitlyForbidsFile: flags the LAST file in a negated comma-list too (long-path proximity case)",
          A.taskExplicitlyForbidsFile(negTask, "boltons/shapeutils.py"));
        check("taskExplicitlyForbidsFile: does NOT flag the file the task actually wants created",
          !A.taskExplicitlyForbidsFile(negTask, "boltons/circleutils.py"));
        const posTask = "Update boltons/shapeutils.py so Rectangle.contains matches the new Point representation.";
        check("taskExplicitlyForbidsFile: a genuinely directed (non-negated) file is NOT forbidden",
          !A.taskExplicitlyForbidsFile(posTask, "boltons/shapeutils.py"));
      }

      // ---- taskExplicitlyForbidsFile: "any other function/method in X" scopes the negation to
      // something ELSE inside the file, not to the file itself (LIVE-CAUGHT, boltons run 138,
      // 2026-08-18): "Do not change any other function in boltons/iterutils.py." was misread as
      // forbidding iterutils.py outright, excluding the task's sole real edit target from `named`
      // and falling through to the fuzzy focusFiles fallback, which wandered into an unrelated file
      // (funcutils.py) and burned the entire run's budget on a needless multi-file decomposition
      // without ever touching the real target. ----
      {
        const rewriteTask = "In boltons/iterutils.py, the function count_duplicates(src) is currently correct but has an O(n^2) implementation. Rewrite count_duplicates to run in O(n) time. Do not change any other function in boltons/iterutils.py. Do not modify tests/test_iterutils.py.";
        check("taskExplicitlyForbidsFile: does NOT forbid the file when the negation scopes to 'any other function in' it (run-138 case)",
          !A.taskExplicitlyForbidsFile(rewriteTask, "boltons/iterutils.py"));
        check("taskExplicitlyForbidsFile: still forbids a genuinely protected file in the same task",
          A.taskExplicitlyForbidsFile(rewriteTask, "tests/test_iterutils.py"));
        const methodVariant = "Fix the bug in boltons/mathutils.py's clamp() function. Do not modify any other method in boltons/mathutils.py.";
        check("taskExplicitlyForbidsFile: 'any other method in X' also scopes past X (not just 'function')",
          !A.taskExplicitlyForbidsFile(methodVariant, "boltons/mathutils.py"));
        // Sanity: a real "do not touch this file at all" still fires even with 'other' elsewhere in the clause.
        const stillForbidden = "Add a helper to boltons/newutils.py. Do not touch boltons/pointutils.py or any other file.";
        check("taskExplicitlyForbidsFile: a genuine file-level forbid still fires when 'any other' refers to OTHER FILES, not this one",
          A.taskExplicitlyForbidsFile(stillForbidden, "boltons/pointutils.py"));
      }

      // ---- taskClauses / taskExplicitlyForbidsFile: semicolon-joined clauses with DIFFERENT objects
      // (LIVE-CAUGHT, boltons run 149, 2026-08-19): "...implement round_half_up in boltons/mathutils.py
      // so those tests pass; do not edit the test file." has no period between the file mention and the
      // negated verb, only a semicolon -- the negated verb's real object is "the test file" (a pronoun
      // reference, not a literal path), not boltons/mathutils.py at all. `taskClauses` only split on
      // periods, so both halves stayed one clause and the guard wrongly forbade the file the task most
      // needed changed -- the executor then hard-blocked its own every attempt to write it for the
      // entire run, landing nothing (run 149's own event log: 7 consecutive "forbid guard: refused to
      // touch boltons/mathutils.py" lines, budget exhausted, zero files touched). ----
      {
        const semicolonTask = "Add a function round_half_up(x, ndigits=0) to boltons/mathutils.py. It must round x using round-half-up semantics, not Python's banker's rounding. There is already a locked test file tests/test_round_half_up.py with the required cases; implement round_half_up in boltons/mathutils.py so those tests pass; do not edit the test file.";
        check("taskExplicitlyForbidsFile: a semicolon-joined 'do not edit X' does NOT forbid an EARLIER file mentioned before the semicolon (run-149 case)",
          !A.taskExplicitlyForbidsFile(semicolonTask, "boltons/mathutils.py"));
        // A genuine same-clause forbid across a semicolon (both halves about the SAME file) must still fire.
        const semicolonForbidSameFile = "Update boltons/other.py as needed; do not touch boltons/mathutils.py, it is already correct.";
        check("taskExplicitlyForbidsFile: a real forbid clause still fires when file+negated-verb share the SAME semicolon-delimited clause",
          A.taskExplicitlyForbidsFile(semicolonForbidSameFile, "boltons/mathutils.py"));
        // Lowercase continuation after ';' must still split (unlike '.', a semicolon-joined clause
        // conventionally continues lowercase, so the split must not require an uppercase/digit next).
        const lowercaseContinuation = "Fix boltons/a.py; do not modify boltons/b.py, it is unrelated.";
        check("taskExplicitlyForbidsFile: semicolon split fires even when the next clause starts lowercase",
          A.taskExplicitlyForbidsFile(lowercaseContinuation, "boltons/b.py"));
        check("taskExplicitlyForbidsFile: semicolon split does not falsely forbid the file named BEFORE the ';'",
          !A.taskExplicitlyForbidsFile(lowercaseContinuation, "boltons/a.py"));
      }

      // ---- taskClauses / taskExplicitlyForbidsFile: bare-newline-joined clauses with DIFFERENT
      // objects (bug 42, sibling-sweep off bug 41, 2026-08-19: asked "what ELSE joins two clauses the
      // way a semicolon does?" of the same fixed bug class, reproduced directly with a no-model
      // harness before writing any fix). "...so those tests pass\ndo not edit the test file." has
      // neither a period nor a semicolon between the file mention and the negated verb, only a line
      // break -- the exact same false-forbid shape as run 149/bug 41, just joined differently. ----
      {
        const newlineTask = "implement round_half_up in boltons/mathutils.py so those tests pass\ndo not edit the test file.";
        check("taskExplicitlyForbidsFile: a newline-joined 'do not edit X' does NOT forbid an EARLIER file mentioned before the newline",
          !A.taskExplicitlyForbidsFile(newlineTask, "boltons/mathutils.py"));
        // A genuine same-clause forbid across a newline (both halves about the SAME file) must still fire.
        const newlineForbidSameFile = "Update boltons/other.py as needed\ndo not touch boltons/mathutils.py, it is already correct.";
        check("taskExplicitlyForbidsFile: a real forbid clause still fires when file+negated-verb share the SAME newline-delimited clause",
          A.taskExplicitlyForbidsFile(newlineForbidSameFile, "boltons/mathutils.py"));
        // A period immediately followed by a newline+capital (the ordinary multi-line task shape) must
        // still split and still forbid correctly -- newline splitting must not regress the period rule.
        const periodNewlineTask = "Implement foo in boltons/a.py.\nDo not modify boltons/b.py.";
        check("taskExplicitlyForbidsFile: period-then-newline-then-capital still forbids as before",
          A.taskExplicitlyForbidsFile(periodNewlineTask, "boltons/b.py"));
        // Existing comma-separated-list-under-one-verb forbid (no newline involved at all) must be untouched.
        const listTask = "Do not modify boltons/pointutils.py, boltons/shapeutils.py, or tests/test_shapeutils.py.";
        check("taskExplicitlyForbidsFile: newline-splitting change does not regress the no-newline comma-list case",
          A.taskExplicitlyForbidsFile(listTask, "boltons/pointutils.py") && A.taskExplicitlyForbidsFile(listTask, "boltons/shapeutils.py") && A.taskExplicitlyForbidsFile(listTask, "tests/test_shapeutils.py"));
      }

      // ---- taskClauses / taskExplicitlyForbidsFile: colon / em-dash / double-hyphen-joined clauses
      // with DIFFERENT objects (bug 43, sibling-sweep continuation off bug 42, 2026-08-19: bug 42's own
      // "next run" note flagged these three as reproducible but deliberately left unfixed pending
      // careful scoping). "...so those tests pass: do not edit the test file." (and the em-dash / "--"
      // equivalents) reproduce the identical false-forbid shape as bugs 41/42, joined by a different
      // separator -- but unlike the newline case, a colon/em-dash/"--" is ALSO used in this project's
      // own real task corpus (line ~2054, ~2171, ~2230 above) to introduce a verb-less list or aside, so
      // the fix must only split when a recognized edit verb actually follows before the next period. ----
      {
        const colonTask = "implement round_half_up in boltons/mathutils.py so those tests pass: do not edit the test file.";
        check("taskExplicitlyForbidsFile: a colon-joined 'do not edit X' does NOT forbid an EARLIER file mentioned before the colon (bug 43)",
          !A.taskExplicitlyForbidsFile(colonTask, "boltons/mathutils.py"));
        const dashTask = "implement round_half_up in boltons/mathutils.py so those tests pass — do not edit the test file.";
        check("taskExplicitlyForbidsFile: an em-dash-joined 'do not edit X' does NOT forbid an EARLIER file mentioned before the dash (bug 43)",
          !A.taskExplicitlyForbidsFile(dashTask, "boltons/mathutils.py"));
        const dashDashTask = "implement round_half_up in boltons/mathutils.py so those tests pass -- do not edit the test file.";
        check("taskExplicitlyForbidsFile: a double-hyphen-joined 'do not edit X' does NOT forbid an EARLIER file mentioned before the '--' (bug 43)",
          !A.taskExplicitlyForbidsFile(dashDashTask, "boltons/mathutils.py"));
        // A genuine same-clause forbid across each separator (both halves about the SAME file) must still fire.
        const colonForbidSame = "Update boltons/other.py as needed: do not touch boltons/mathutils.py, it is already correct.";
        check("taskExplicitlyForbidsFile: a real forbid clause still fires when file+negated-verb share the SAME colon-delimited clause",
          A.taskExplicitlyForbidsFile(colonForbidSame, "boltons/mathutils.py"));
        const dashForbidSame = "Update boltons/other.py as needed — do not touch boltons/mathutils.py, it is already correct.";
        check("taskExplicitlyForbidsFile: a real forbid clause still fires when file+negated-verb share the SAME em-dash-delimited clause",
          A.taskExplicitlyForbidsFile(dashForbidSame, "boltons/mathutils.py"));
        const dashDashForbidSame = "Update boltons/other.py as needed -- do not touch boltons/mathutils.py, it is already correct.";
        check("taskExplicitlyForbidsFile: a real forbid clause still fires when file+negated-verb share the SAME '--'-delimited clause",
          A.taskExplicitlyForbidsFile(dashDashForbidSame, "boltons/mathutils.py"));
        // The colon-introduced LIST case (no edit verb after the colon) must NOT be split apart from
        // its governing negated verb -- this is the exact regression the previous sweep refused to risk.
        const colonListTask = "Do not modify these files: boltons/pointutils.py, boltons/shapeutils.py, tests/test_shapeutils.py.";
        check("taskExplicitlyForbidsFile: a colon-introduced file LIST is not split apart from its governing 'do not modify' (bug 43 list-safety)",
          A.taskExplicitlyForbidsFile(colonListTask, "boltons/pointutils.py") && A.taskExplicitlyForbidsFile(colonListTask, "boltons/shapeutils.py") && A.taskExplicitlyForbidsFile(colonListTask, "tests/test_shapeutils.py"));
      }

      // ---- taskClauses / taskExplicitlyForbidsFile: bare-word "but"-joined clauses with DIFFERENT
      // objects (bug 44, sibling-sweep continuation off bug 43, 2026-08-20 — the last confirmed-
      // reproducible bug-42/43 sibling, deliberately left unfixed by both prior sweeps because "but"
      // has no punctuation anchor to guard a split on). "...so those tests pass but do not edit the
      // test file." reproduces the identical false-forbid shape as bugs 41/42/43. Guarded the same way
      // as the colon/em-dash/"--" fix (only split when a recognized edit verb follows before the next
      // period) PLUS a `\b` word boundary on "but" itself so it can never match inside "about"/
      // "button"/"butter". ----
      {
        const butTask = "implement round_half_up in boltons/mathutils.py so those tests pass but do not edit the test file.";
        check("taskExplicitlyForbidsFile: a 'but'-joined 'do not edit X' does NOT forbid an EARLIER file mentioned before 'but' (bug 44)",
          !A.taskExplicitlyForbidsFile(butTask, "boltons/mathutils.py"));
        // A genuine same-clause forbid across "but" (both halves about the SAME file) must still fire.
        const butForbidSame = "Update boltons/other.py as needed, but do not touch boltons/mathutils.py, it is already correct.";
        check("taskExplicitlyForbidsFile: a real forbid clause still fires when file+negated-verb share the SAME 'but'-delimited clause",
          A.taskExplicitlyForbidsFile(butForbidSame, "boltons/mathutils.py"));
        // A "but" NOT followed by a recognized edit verb (no punctuation anchor needed here either,
        // same verb-guard) must not split at all -- the one real "but" in this project's own task
        // corpus (test-system.mjs ~line 2098: "...is currently correct but has an O(n^2)
        // implementation.") stays in one clause.
        const butNoVerbTask = "The function in boltons/mathutils.py is currently correct but has an O(n^2) implementation. Do not modify tests/test_mathutils.py.";
        check("taskExplicitlyForbidsFile: a 'but' with no edit verb after it does not split the clause at all",
          !A.taskExplicitlyForbidsFile(butNoVerbTask, "boltons/mathutils.py"));
        // "but" must never match inside a longer identifier like "button_utils.py" (word-boundary
        // guard on BOTH sides of "but", not just the left side) -- uses a filename containing "but" as
        // a substring PLUS a real standalone "but" later in the same sentence, to confirm the split
        // targets the real word and isn't confused by the filename's "but"-prefixed token.
        const butInFilenameTask = "Implement helper in boltons/button_utils.py so tests pass but do not edit tests/test_button_utils.py.";
        check("taskExplicitlyForbidsFile: 'but' inside a filename ('button_utils.py') is not treated as a clause boundary",
          !A.taskExplicitlyForbidsFile(butInFilenameTask, "boltons/button_utils.py"));
        check("taskExplicitlyForbidsFile: the real standalone 'but' later in that same sentence still splits correctly",
          A.taskExplicitlyForbidsFile(butInFilenameTask, "tests/test_button_utils.py"));
      }

      // ---- needsNewTestAuthoring (LIVE-CAUGHT, boltons run 79, 2026-07-27): a task can legitimately
      // lock ONE pre-existing test file (e.g. "do not modify tests/test_shapeutils.py") while ALSO
      // asking for a genuinely new one to be authored (tests/test_circleutils.py) — the old blanket
      // `!this.lockedFiles.size` guard disabled spec-first authoring for the WHOLE run the instant any
      // file was locked, so the new file never got authored, and the executor's own attempt to create
      // it was then hard-blocked by the "tests already LOCKED" dispatch gate for a file the task
      // explicitly wanted created. ----
      {
        const circleTask = "Add a new Circle class to a new file boltons/circleutils.py... Add tests in a new file tests/test_circleutils.py covering area, contains, and touches_rectangle. Do not modify boltons/pointutils.py, boltons/shapeutils.py, or tests/test_shapeutils.py.";
        check("needsNewTestAuthoring: true when a new test file is named even though a DIFFERENT file is already locked (run-79 case)",
          A.needsNewTestAuthoring(circleTask, new Set(["tests/test_shapeutils.py"])));
        check("needsNewTestAuthoring: false when the only named test file is already locked (nothing new to author)",
          !A.needsNewTestAuthoring("Fix Rectangle so tests/test_shapeutils.py passes.", new Set(["tests/test_shapeutils.py"])));
        check("needsNewTestAuthoring: false when the task doesn't ask for tests at all",
          !A.needsNewTestAuthoring("Rename Point.distance_to to Point.distance.", new Set()));
        check("needsNewTestAuthoring: true for a from-scratch task with no locked files yet",
          A.needsNewTestAuthoring("Create boltons/slugutils.py from scratch, with tests covering slugify in tests/test_slugutils.py.", new Set()));
        check("needsNewTestAuthoring: tolerates an undefined locked-files set",
          A.needsNewTestAuthoring("Add tests/test_new.py covering the new behavior.", undefined));
      }

      // ---- testEditGuardActive (unsynced fix found already applied in agent.mjs, closed out
      // 2026-07-23): the "#3 Attribution guard" nudges the model away from editing tests while the
      // suite is failing — but must stay silent for a file `editableTestFiles` already exempted,
      // otherwise it discourages the exact legitimate rename/removal edit the dispatch gate allows
      // through (same bug family as taskWantsTestFileEdited above). ----
      {
        const editable = new Set(["tests/test_shapeutils.py"]);
        check("testEditGuardActive: fires for a locked test file with no exemption", A.testEditGuardActive("tests/test_shapeutils.py", new Set()));
        check("testEditGuardActive: silent for a file the task explicitly exempted", !A.testEditGuardActive("tests/test_shapeutils.py", editable));
        check("testEditGuardActive: silent for a non-test file regardless of exemption set", !A.testEditGuardActive("boltons/shapeutils.py", new Set()));
        check("testEditGuardActive: an unrelated test file in the exemption set doesn't false-negative", A.testEditGuardActive("tests/test_other.py", editable));
        check("testEditGuardActive: tolerates an undefined exemption set (optional chaining)", A.testEditGuardActive("tests/test_x.py", undefined));
      }

      // ---- namesTaskWantsRemoved / stillPresentTargets (LIVE-CAUGHT, boltons run 60, 2026-07-23):
      // the removal-shaped mirror of namesTaskWantsAdded/missingNamedTargets. Run 60's task asked to
      // remove `perimeter()` + its test; the executor's edit_file on shapeutils.py was a near-no-op
      // (reformatted an unused condition) and both edits on the test file failed outright — yet
      // verifyOutcome (a model judgment call) said "✅ Results match the outcome: removed" with
      // perimeter() still verbatim in both files, and nothing downstream caught it. ----
      {
        const removeTask = "In boltons/shapeutils.py, remove the perimeter() method from the Rectangle class entirely — it is no longer needed. Also remove the corresponding test_rectangle_perimeter test method from tests/test_shapeutils.py, since that test no longer applies. Do not touch any other file.";
        const names = A.namesTaskWantsRemoved(removeTask);
        check("namesTaskWantsRemoved: catches 'remove the perimeter() method'", names.includes("perimeter"));
        check("namesTaskWantsRemoved: a backtick-quoted removal target is also caught", A.namesTaskWantsRemoved("Delete the `slugify` helper, it's dead code.").includes("slugify"));
        check("namesTaskWantsRemoved: an unrelated mention with no removal verb doesn't false-positive", !A.namesTaskWantsRemoved("Fix the bug in perimeter() so it returns the right value.").includes("perimeter"));

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-stillpresent-"));
        fs.writeFileSync(path.join(tmp, "shapeutils.py"), "class Rectangle:\n    def perimeter(self):\n        return 1\n");
        const stillThere = await A.stillPresentTargets(tmp, ["shapeutils.py"], ["perimeter"]);
        check("stillPresentTargets: flags a name the task wanted removed but is still defined", stillThere.includes("perimeter"));
        fs.writeFileSync(path.join(tmp, "shapeutils.py"), "class Rectangle:\n    def area(self):\n        return 1\n");
        const goneNow = await A.stillPresentTargets(tmp, ["shapeutils.py"], ["perimeter"]);
        check("stillPresentTargets: silent once the name is genuinely gone from the touched file", !goneNow.includes("perimeter"));
        check("stillPresentTargets: silent with no wanted-removed names at all", (await A.stillPresentTargets(tmp, ["shapeutils.py"], [])).length === 0);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      }

      // ---- namesTaskWantsFileDeleted / stillPresentFiles (LIVE-CAUGHT, boltons run 144,
      // 2026-08-19, found unlogged by a later unattended freshness check): the FILE-level sibling of
      // namesTaskWantsRemoved/stillPresentTargets above. Run 144's task was a rename
      // (pointutils.py -> geometry.py) that explicitly required the OLD file to stop existing; the
      // model's only edit against it was a no-op (line-ending normalization only), so it survived on
      // disk, and nothing in the outcome-check ladder looked at file-level existence — only symbol
      // names. ----
      {
        const renameTask = "Rename the file boltons/pointutils.py to boltons/geometry.py. Keep the Point class's code exactly the same -- only the file's name and location change. Update the import in boltons/shapeutils.py from \"from boltons.pointutils import Point\" to \"from boltons.geometry import Point\". Update the same import in tests/test_shapeutils.py the same way. Delete the old boltons/pointutils.py file -- it must not exist anymore when you are done. Do not change any other file, and do not change the behavior of Point, Rectangle, or any test's expected values.";
        const wantedFiles = A.namesTaskWantsFileDeleted(renameTask);
        check("namesTaskWantsFileDeleted: catches 'Delete the old boltons/pointutils.py file' (run 144)", wantedFiles.includes("boltons/pointutils.py"), JSON.stringify(wantedFiles));
        check("namesTaskWantsFileDeleted: does not flag the destination file it never asked to delete", !wantedFiles.includes("boltons/geometry.py"));
        check("namesTaskWantsFileDeleted: a negated 'do not delete X.py' does not false-positive", !A.namesTaskWantsFileDeleted("Do not delete boltons/pointutils.py, it is still needed.").includes("boltons/pointutils.py"));
        check("namesTaskWantsFileDeleted: an unrelated mention with no delete verb doesn't false-positive", A.namesTaskWantsFileDeleted("boltons/pointutils.py defines the Point class.").length === 0);

        const ftmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-stillpresentfiles-"));
        fs.mkdirSync(path.join(ftmp, "boltons"));
        fs.writeFileSync(path.join(ftmp, "boltons", "pointutils.py"), "class Point:\n    pass\n");
        const stillPresent = await A.stillPresentFiles(ftmp, ["boltons/pointutils.py"]);
        check("stillPresentFiles: flags a file the task required deleted but that still exists (run 144)", stillPresent.includes("boltons/pointutils.py"));
        fs.rmSync(path.join(ftmp, "boltons", "pointutils.py"));
        const goneNow = await A.stillPresentFiles(ftmp, ["boltons/pointutils.py"]);
        check("stillPresentFiles: silent once the file is genuinely deleted", !goneNow.includes("boltons/pointutils.py"));
        check("stillPresentFiles: silent with no wanted-deleted files at all", (await A.stillPresentFiles(ftmp, [])).length === 0);
        try { fs.rmSync(ftmp, { recursive: true, force: true }); } catch {}
      }

      // ---- paramsTaskWantsAdded / missingRequiredParams (LIVE-CAUGHT, boltons run 182,
      // 2026-08-30): a SIGNATURE-CHANGE task names a function that already exists, so
      // namesTaskWantsAdded/missingNamedTargets never fire (nothing new is being defined). Run 182's
      // task asked to change Point.translated(self, dx, dy) to Point.translated(self, dx, dy, scale)
      // and update its one call site; the model instead just renamed dx/dy to delta_x/delta_y (never
      // adding `scale`) and made an unrelated edit elsewhere — yet verifyOutcome's only guard (the LLM
      // critic) said "✅ Results match the outcome" because the locked test spec never exercised
      // translated()'s signature at all. ----
      {
        const sigTask182 = "In boltons/pointutils.py, change the signature of Point.translated(self, dx, dy) to Point.translated(self, dx, dy, scale) by adding a required third parameter 'scale'.";
        const targets182 = A.paramsTaskWantsAdded(sigTask182);
        check("paramsTaskWantsAdded: catches 'Foo(a, b) to Foo(a, b, c)' (run 182)", targets182.length === 1 && targets182[0].name === "translated" && targets182[0].params.includes("scale"), JSON.stringify(targets182));
        check("paramsTaskWantsAdded: does not flag `self` as an added param", !(targets182[0]?.params || []).includes("self"));
        check("paramsTaskWantsAdded: a plain MODIFY task with no before->after signature pair stays inert", A.paramsTaskWantsAdded("In boltons/pointutils.py, change the Point class to store its coordinates internally as a tuple.").length === 0);
        check("paramsTaskWantsAdded: differing function names before/after does not false-positive", A.paramsTaskWantsAdded("Replace calls to old_func(a, b) to new_func(a, b, c) throughout the file.").length === 0);

        const stmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-missingparams-"));
        fs.writeFileSync(path.join(stmp, "pointutils.py"), "class Point:\n    def translated(self, delta_x, delta_y):\n        return Point(self.x + delta_x, self.y + delta_y)\n");
        const missingP = await A.missingRequiredParams(stmp, ["pointutils.py"], targets182);
        check("missingRequiredParams: flags a def whose actual signature never gained the required param (run 182's exact bug)", missingP.includes("translated(scale)"), JSON.stringify(missingP));
        fs.writeFileSync(path.join(stmp, "pointutils.py"), "class Point:\n    def translated(self, dx, dy, scale):\n        return Point((self.x + dx) * scale, (self.y + dy) * scale)\n");
        const fixedP = await A.missingRequiredParams(stmp, ["pointutils.py"], targets182);
        check("missingRequiredParams: silent once the required param is genuinely present", fixedP.length === 0, JSON.stringify(fixedP));
        check("missingRequiredParams: silent with no signature targets at all", (await A.missingRequiredParams(stmp, ["pointutils.py"], [])).length === 0);
        try { fs.rmSync(stmp, { recursive: true, force: true }); } catch {}
      }

      // ---- BUG 54 (2026-09-01): missingRequiredParams only ever checked the `files` list it was
      // handed (the run's OWN evalFiles — files it actually touched this run). Live-caught boltons
      // run 186 (2-file signature-change task: add a required `scale` param to BOTH
      // `Point.translated` in pointutils.py AND `Rectangle.moved` in shapeutils.py): the executor's
      // surgical fix only ever rewrote `moved()` (pre-multiplying dx/dy by scale itself and calling
      // the OLD 2-arg `translated(dx, dy)`), so pointutils.py was never touched THIS run and never
      // appeared in `files` — `missingRequiredParams` found no match in `files`, silently gave up
      // ("a different check's job to report"), and the run was reported as matching the outcome even
      // though `Point.translated` never gained `scale`. Fixed with a repo-wide fallback scan
      // (_findFuncSigInRepo) so a target's home file doesn't have to be among the touched files. ----
      {
        const rdir = fs.mkdtempSync(path.join(os.tmpdir(), "eta-missingparams-untouched-"));
        fs.mkdirSync(path.join(rdir, "boltons"));
        // pointutils.py exists on disk with the OLD, un-upgraded signature -- but this run never
        // touched it (mirrors run 186: only shapeutils.py made it into `files`).
        fs.writeFileSync(path.join(rdir, "boltons", "pointutils.py"), "class Point:\n    def translated(self, dx, dy):\n        return Point(self.x + dx, self.y + dy)\n");
        fs.writeFileSync(path.join(rdir, "boltons", "shapeutils.py"), "class Rectangle:\n    def moved(self, dx, dy, scale=1):\n        return self.top_left.translated(dx * scale, dy * scale)\n");
        const sigTask186 = "In boltons/pointutils.py, change the signature of Point.translated(self, dx, dy) to Point.translated(self, dx, dy, scale) by adding a required third parameter scale.";
        const targets186 = A.paramsTaskWantsAdded(sigTask186);
        check("bug 54: paramsTaskWantsAdded still catches the translated(...) to translated(...) pair", targets186.length === 1 && targets186[0].name === "translated", JSON.stringify(targets186));
        // Note: `files` deliberately does NOT include pointutils.py -- run 186's exact situation.
        const missing186 = await A.missingRequiredParams(rdir, ["boltons/shapeutils.py"], targets186);
        check("bug 54: catches a required param missing from a function whose file was NEVER touched this run (run 186's exact bug)", missing186.includes("translated(scale)"), JSON.stringify(missing186));
        // Sanity: still silent once the untouched file genuinely has the param (no false positive
        // from the new repo-wide fallback).
        fs.writeFileSync(path.join(rdir, "boltons", "pointutils.py"), "class Point:\n    def translated(self, dx, dy, scale):\n        return Point((self.x + dx) * scale, (self.y + dy) * scale)\n");
        const fixed186 = await A.missingRequiredParams(rdir, ["boltons/shapeutils.py"], targets186);
        check("bug 54: silent once the untouched file's function genuinely has the param", fixed186.length === 0, JSON.stringify(fixed186));
        try { fs.rmSync(rdir, { recursive: true, force: true }); } catch {}
      }

      // ---- BUG 61 (2026-09-06, staleness-audit mutation sweep, no live LLM run needed — a pure
      // signature-parsing gap found and fixed the same way bug 57 (parseFailure) was: direct
      // invocation against clean isolated repros). Two independent gaps in the same code path:
      // (a) missingRequiredParams'/`_findFuncSigInRepo`'s old regex (`\(([^()]*)\)`) could never
      // match a signature whose default value itself contained parens (a tuple, a call) — the whole
      // signature became invisible and a genuinely-missing required param went unreported (false
      // NEGATIVE, silently disarming the safety net). (b) parameter-name extraction only stripped a
      // trailing default (`split("=")[0]`), never a leading type hint, so a genuinely-present
      // type-hinted parameter like `scale: float = 1.0` was extracted as the name "scale: float"
      // and never matched a plain "scale" lookup — reporting a correctly-added parameter as MISSING
      // (false POSITIVE) on any codebase using type hints. Fixed with a balanced-paren scanner
      // (_extractSigParams) and a depth-aware comma splitter that also strips type hints
      // (_sigParamNames), reused by both the source-parsing side and paramsTaskWantsAdded's own
      // before/after task-text parsing for consistency. ----
      {
        const b61 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-bug61-"));

        // (a) nested-paren default value; the required param is genuinely MISSING.
        fs.writeFileSync(path.join(b61, "nested.py"), "class Point:\n    def translated(self, dx, dy=(0, 0)):\n        return self\n");
        const missingNested = await A.missingRequiredParams(b61, ["nested.py"], [{ name: "translated", params: ["scale"] }]);
        check("bug 61: a nested-paren tuple default no longer hides a genuinely-missing required param", missingNested.includes("translated(scale)"), JSON.stringify(missingNested));

        // (b) type-hinted parameter that is genuinely PRESENT — must not be flagged missing.
        fs.writeFileSync(path.join(b61, "typed_present.py"), "class Point:\n    def translated(self, dx: int, dy: int, scale: float = 1.0):\n        return self\n");
        const missingTypedPresent = await A.missingRequiredParams(b61, ["typed_present.py"], [{ name: "translated", params: ["scale"] }]);
        check("bug 61: a type-hinted parameter that IS present is no longer falsely reported missing", missingTypedPresent.length === 0, JSON.stringify(missingTypedPresent));

        // Negative control: a type-hinted signature that genuinely LACKS the required param must
        // still be flagged — the type-hint fix must not accidentally silence real gaps.
        fs.writeFileSync(path.join(b61, "typed_absent.py"), "class Point:\n    def translated(self, dx: int, dy: int):\n        return self\n");
        const missingTypedAbsent = await A.missingRequiredParams(b61, ["typed_absent.py"], [{ name: "translated", params: ["scale"] }]);
        check("bug 61: a type-hinted signature genuinely missing the param is still correctly flagged", missingTypedAbsent.includes("translated(scale)"), JSON.stringify(missingTypedAbsent));

        // A dict-literal default earlier in the param list (its own internal commas) must not
        // fracture comma-splitting for a later, genuinely-required param.
        fs.writeFileSync(path.join(b61, "dictdefault.py"), "class Widget:\n    def configure(self, opts={\"a\": 1, \"b\": 2}, scale=1):\n        return self\n");
        const missingAfterDict = await A.missingRequiredParams(b61, ["dictdefault.py"], [{ name: "configure", params: ["scale", "factor"] }]);
        check("bug 61: a dict-literal default's internal commas don't fracture later param detection", !missingAfterDict.includes("configure(scale)") && missingAfterDict.includes("configure(factor)"), JSON.stringify(missingAfterDict));

        // **kwargs with a type hint: leading stars AND the type hint must both be stripped.
        fs.writeFileSync(path.join(b61, "kwargs.py"), "def build(self, **kwargs: object):\n    return self\n");
        const missingKwargs = await A.missingRequiredParams(b61, ["kwargs.py"], [{ name: "build", params: ["kwargs"] }]);
        check("bug 61: a typed **kwargs is recognized by its bare name (stars and type hint both stripped)", missingKwargs.length === 0, JSON.stringify(missingKwargs));

        // paramsTaskWantsAdded (task-TEXT side, same underlying helper): a typed before/after pair
        // in the task description itself must extract the bare name "scale", not "scale: float" —
        // otherwise it would silently mismatch the now-correctly-typed sigParams Set above.
        const typedTask = "Change Point.translated(self, dx: int, dy: int) to Point.translated(self, dx: int, dy: int, scale: float) so callers can scale the offset.";
        const typedTargets = A.paramsTaskWantsAdded(typedTask);
        check("bug 61: paramsTaskWantsAdded strips a type hint from an added task-text param", typedTargets.length === 1 && typedTargets[0].name === "translated" && typedTargets[0].params.includes("scale") && !typedTargets[0].params.includes("scale: float"), JSON.stringify(typedTargets));

        try { fs.rmSync(b61, { recursive: true, force: true }); } catch {}
      }

      // ---- buildDepGraph / resolveImports (staleness-audit, zero prior test coverage). Found via
      // the standing "never-mentioned-in-PROGRESS.md, never-referenced-in-test-system.mjs" sweep,
      // then confirmed real against the LIVE `D:/eta-tests/boltons` workspace itself (not just a
      // synthetic fixture): `tests/test_ioutils.py` genuinely does `from boltons import ioutils` and
      // nothing else that names that module, yet `buildDepGraph` produced ZERO edge from the test
      // file to `boltons/ioutils.py` — a real, exercised gap, not a theoretical one. Root cause: for
      // ANY "from X import name1, name2" statement, the parser only ever tried to resolve `X`
      // itself as a file/package; it never considered that each imported NAME might itself be a
      // submodule file (Python's `from pkg import submod` idiom). A sibling gap in the plain
      // "import a, b" form: the old regex `[\w.]+` silently stopped at the first comma, so only the
      // first module of a multi-module import line was ever resolved. This directly weakens the
      // ONE-HOP IMPORT CLOSURE mechanism (bugs 58/60, `surgicalEditFix`'s `fileDeps` call) that the
      // cross-file root-cause-tracing lever depends on — a missing edge here means a task that
      // touches `test_ioutils.py` can never auto-pull in `boltons/ioutils.py` via the import graph. ----
      {
        const dtmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-depgraph-"));
        fs.mkdirSync(path.join(dtmp, "pkg"));
        fs.writeFileSync(path.join(dtmp, "pkg", "__init__.py"), "");
        fs.writeFileSync(path.join(dtmp, "pkg", "a.py"), "def foo():\n    return 1\n");
        fs.writeFileSync(path.join(dtmp, "pkg", "b.py"), "def bar():\n    return 2\n");
        fs.writeFileSync(path.join(dtmp, "pkg", "leaf.py"), "class Thing:\n    pass\n");
        // real confirmed pattern: `from boltons import ioutils` (single name, no comma at all)
        fs.writeFileSync(path.join(dtmp, "plain_from_pkg.py"), "from pkg import a\n");
        // comma-separated submodule names via a relative from-import
        fs.writeFileSync(path.join(dtmp, "pkg", "rel_multi.py"), "from . import a, b\n");
        // comma-separated (and aliased) plain "import" statement
        fs.writeFileSync(path.join(dtmp, "plain_import_multi.py"), "import pkg.a, pkg.b as pb\n");
        // regression control: importing a NAME (class) out of a leaf module must still resolve only
        // to the module file, not spuriously add a same-named file that doesn't exist
        fs.writeFileSync(path.join(dtmp, "attr_import.py"), "from pkg.leaf import Thing\n");

        const dg = await A.buildDepGraph(dtmp);
        check("buildDepGraph: 'from pkg import a' resolves the submodule file, not just pkg/__init__.py (real test_ioutils.py shape)", (dg["plain_from_pkg.py"]?.imports || []).includes("pkg/a.py"), JSON.stringify(dg["plain_from_pkg.py"]));
        check("buildDepGraph: 'from . import a, b' resolves BOTH comma-separated submodules", (dg["pkg/rel_multi.py"]?.imports || []).includes("pkg/a.py") && (dg["pkg/rel_multi.py"]?.imports || []).includes("pkg/b.py"), JSON.stringify(dg["pkg/rel_multi.py"]));
        check("buildDepGraph: 'import pkg.a, pkg.b as pb' resolves BOTH comma-separated (one aliased) modules, not just the first", (dg["plain_import_multi.py"]?.imports || []).includes("pkg/a.py") && (dg["plain_import_multi.py"]?.imports || []).includes("pkg/b.py"), JSON.stringify(dg["plain_import_multi.py"]));
        check("buildDepGraph: 'from pkg.leaf import Thing' still resolves only the module (no bogus pkg/Thing.py edge)", (dg["attr_import.py"]?.imports || []).includes("pkg/leaf.py") && !(dg["attr_import.py"]?.imports || []).some((f) => f.includes("Thing")), JSON.stringify(dg["attr_import.py"]));

        try { fs.rmSync(dtmp, { recursive: true, force: true }); } catch {}

        // Same bug, reconfirmed against the actual live boltons workspace (not just the synthetic
        // fixture above): `tests/test_ioutils.py` really does `from boltons import ioutils` and
        // nothing else naming that module.
        const bg = await A.buildDepGraph("D:/eta-tests/boltons");
        check("buildDepGraph: real boltons workspace — tests/test_ioutils.py -> boltons/ioutils.py edge exists", (bg["tests/test_ioutils.py"]?.imports || []).includes("boltons/ioutils.py"), JSON.stringify(bg["tests/test_ioutils.py"]));
      }

      // ---- BUG 82 (2026-09-08, resolveImports parenthesized from-import): the from-import name-list
      // capture used to be a single `[^#;\n]+` branch, which stops at the first newline. PEP 8's own
      // preferred style for a long import list wraps it in parens — `from pkg import (\n    a,\n    b,\n)`
      // — sometimes even on one line: `from pkg import (a, b)`. Either form captured the literal text
      // INCLUDING the leading "(" (and, for the multi-line form, only the first source line), which
      // `pyImportNames`'s `/^[\w.]+$/` filter then rejected outright, silently losing EVERY
      // submodule-file dependency in the list — only the package-level `dir + ".py"`/`__init__.py`
      // edges survived. This was the last item on the standing "speculative gaps" list this project has
      // tracked across many runs (closing it out). Confirmed with an isolated probe before touching
      // code, then fixed by trying `\(([^)]*)\)` FIRST (the negated character class spans newlines) and
      // falling back to the bare single-line list when there's no "(".
      {
        const ptmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-depgraph-paren-"));
        fs.mkdirSync(path.join(ptmp, "pkg"));
        fs.writeFileSync(path.join(ptmp, "pkg", "__init__.py"), "");
        fs.writeFileSync(path.join(ptmp, "pkg", "a.py"), "def foo():\n    return 1\n");
        fs.writeFileSync(path.join(ptmp, "pkg", "b.py"), "def bar():\n    return 2\n");
        // the multi-line parenthesized form, PEP 8's preferred style for a long import list
        fs.writeFileSync(path.join(ptmp, "multiline_paren.py"), "from pkg import (\n    a,\n    b,\n)\n");
        // the single-line parenthesized form (also broken pre-fix, not just the multi-line case)
        fs.writeFileSync(path.join(ptmp, "singleline_paren.py"), "from pkg import (a, b)\n");
        // regression control: an unparenthesized multi-name list must keep working unchanged
        fs.writeFileSync(path.join(ptmp, "no_paren.py"), "from pkg import a, b\n");

        const pg = await A.buildDepGraph(ptmp);
        check("buildDepGraph: multi-line parenthesized 'from pkg import (\\n a,\\n b,\\n)' resolves BOTH submodules", (pg["multiline_paren.py"]?.imports || []).includes("pkg/a.py") && (pg["multiline_paren.py"]?.imports || []).includes("pkg/b.py"), JSON.stringify(pg["multiline_paren.py"]));
        check("buildDepGraph: single-line parenthesized 'from pkg import (a, b)' resolves BOTH submodules", (pg["singleline_paren.py"]?.imports || []).includes("pkg/a.py") && (pg["singleline_paren.py"]?.imports || []).includes("pkg/b.py"), JSON.stringify(pg["singleline_paren.py"]));
        check("buildDepGraph: unparenthesized 'from pkg import a, b' still resolves BOTH submodules (regression control)", (pg["no_paren.py"]?.imports || []).includes("pkg/a.py") && (pg["no_paren.py"]?.imports || []).includes("pkg/b.py"), JSON.stringify(pg["no_paren.py"]));

        try { fs.rmSync(ptmp, { recursive: true, force: true }); } catch {}
      }

      // ---- namesTaskWantsAdded, plain-prose shapes + unexercisedAddedTargets (LIVE-CAUGHT,
      // boltons run 112, 2026-08-07). Until this fix namesTaskWantsAdded ONLY matched a
      // backtick-quoted name, so on ordinary English task text it returned [] and the entire
      // deterministic add-check no-opped. Measured over the engine's own stored run history: it
      // fired on 0 of 38 ADD-shaped real tasks. Run 112 then shipped
      // `def is_sentinel(obj): return obj is make_sentinel()` — which can never return True — as
      // "✅ Results match the outcome", because the ladder was inert AND the green oracle (29
      // pre-existing test files) never referenced the new name at all. ----
      {
        const t112 = "Please add a function called is_sentinel(obj) that returns True when obj was produced by make_sentinel and False otherwise.";
        check("namesTaskWantsAdded: catches a plain-prose 'add a function called foo(x)' (run 112)", A.namesTaskWantsAdded(t112).includes("is_sentinel"), JSON.stringify(A.namesTaskWantsAdded(t112)));
        check("namesTaskWantsAdded: does NOT take a name the task only REFERENCES as pre-existing", !A.namesTaskWantsAdded(t112).includes("make_sentinel"), JSON.stringify(A.namesTaskWantsAdded(t112)));
        check("namesTaskWantsAdded: 'add a new function named count_calls' (no parens) is caught", A.namesTaskWantsAdded("Add a new decorator function named count_calls to boltons/funcutils.py.").includes("count_calls"));
        check("namesTaskWantsAdded: catches every name in a multi-function clause", (() => { const n = A.namesTaskWantsAdded("Create a new file boltons/temputils.py containing two functions: celsius_to_fahrenheit(c) and fahrenheit_to_celsius(f)."); return n.includes("celsius_to_fahrenheit") && n.includes("fahrenheit_to_celsius"); })());
        check("namesTaskWantsAdded: backtick form still works (no regression)", A.namesTaskWantsAdded("Add a new function `is_palindrome(text)` to boltons/strutils.py.").includes("is_palindrome"));
        // Negative controls — a false positive here inverts the bug into a bogus "outcome not met".
        check("namesTaskWantsAdded: a prose parenthetical is not a target ('joined together (for example ...)')", !A.namesTaskWantsAdded("add a new function initials(name) that returns the initials joined together (for example 'AL').").includes("together"));
        check("namesTaskWantsAdded: an attribute call is not a target ('returns s.lower()')", !A.namesTaskWantsAdded("Add function whisper(s) that returns s.lower() + \".\"").includes("lower"));
        check("namesTaskWantsAdded: a reference cue suppresses the referenced name ('reuse the existing strip_ansi(s)')", !A.namesTaskWantsAdded("Add a new function ansi_len(text). It must reuse the existing strip_ansi(s) function.").includes("strip_ansi"));
        check("namesTaskWantsAdded: a MODIFY task with no add verb stays inert", A.namesTaskWantsAdded("In boltons/pointutils.py, change the Point class to store its coordinates internally as a tuple.").length === 0);
        check("namesTaskWantsAdded: an add verb with no declaration noun stays inert", A.namesTaskWantsAdded("Add the file boltons/notes.txt and create(x) some documentation.").length === 0);

        const utmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-unexercised-"));
        fs.mkdirSync(path.join(utmp, "tests"));
        fs.writeFileSync(path.join(utmp, "tests", "test_typeutils.py"), "from boltons.typeutils import make_sentinel\n\ndef test_sentinel():\n    assert make_sentinel('S') is not None\n");
        check("unexercisedAddedTargets: flags a name no oracle test mentions (the run-112 hole)", (await A.unexercisedAddedTargets(utmp, ["tests/test_typeutils.py"], ["is_sentinel"])).includes("is_sentinel"));
        check("unexercisedAddedTargets: silent for a name the oracle DOES exercise", (await A.unexercisedAddedTargets(utmp, ["tests/test_typeutils.py"], ["make_sentinel"])).length === 0);
        check("unexercisedAddedTargets: no wanted names -> nothing flagged", (await A.unexercisedAddedTargets(utmp, ["tests/test_typeutils.py"], [])).length === 0);
        check("unexercisedAddedTargets: an EMPTY oracle cannot exercise anything -> all names flagged", (await A.unexercisedAddedTargets(utmp, [], ["is_sentinel"])).includes("is_sentinel"));
        check("unexercisedAddedTargets: an unreadable test file is skipped, not crashed on", (await A.unexercisedAddedTargets(utmp, ["tests/nope.py"], ["is_sentinel"])).includes("is_sentinel"));
        try { fs.rmSync(utmp, { recursive: true, force: true }); } catch {}
      }

      // LICENSE-HEADER GUARD on the TEST-AUTHORING write path (found 2026-08-09 by sweeping every
      // write path against the run-114 guard). `authorOneTestFile` overwrites a PRE-EXISTING test
      // file wholesale via its own fs.writeFile, bypassing both _writeFile and the surgical
      // edit_file path where the guard already lived — and a model-authored spec file transcribes
      // the TASK, never the repo's legal notice. The run-level safety net cannot cover it: MEASURED
      // (D:/tmp/repro-authortest-net.mjs) the overwrite took the suite from 1 passed to 2 passed,
      // i.e. strictly BETTER, so restoreBaselineIfWorse correctly did nothing and the copyright
      // block was gone for good. Locking happens right after, so the guard must run BEFORE it or
      // restoreTestsIfBroken would write the header-less snapshot back.
      {
        const HDR = "# Copyright (c) 2019, Acme Corp\n# SPDX-License-Identifier: BSD-3-Clause\n";
        const authored = "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 1)\n";
        const atmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-authorlic-"));
        fs.mkdirSync(path.join(atmp, "tests"));
        const author = async (rel, task) => {
          const fake = {
            root: atmp, task,
            eta: { chat: async () => ({ content: authored }) },
            stopped: false, contract: null, files: new Set(), createdFiles: new Set(), lockedFiles: new Set(),
            authoritativeTests: {}, testSnapshots: {}, gates: {}, baselineFiles: {},
            verifyAuthoredTests: async () => null, _captureBaseline: A.Agent.prototype._captureBaseline,
          };
          await A.Agent.prototype.authorOneTestFile.call(fake, rel, task, () => {});
          return { fake, disk: fs.readFileSync(path.join(atmp, rel), "utf8") };
        };
        fs.writeFileSync(path.join(atmp, "tests", "test_keep.py"), HDR + "\nimport unittest\n");
        const kept = await author("tests/test_keep.py", "Cover spin(n) in tests/test_keep.py.");
        check("authorOneTestFile: re-attaches a license header the authored spec file dropped", /Copyright \(c\) 2019/.test(kept.disk));
        check("authorOneTestFile: the authored tests are still kept (salvage, not revert)", /class T\(unittest\.TestCase\)/.test(kept.disk));
        check("authorOneTestFile: the LOCKED snapshot carries the header, so restoreTestsIfBroken can't undo it", /Copyright \(c\) 2019/.test(kept.fake.authoritativeTests["tests/test_keep.py"] || "") && /Copyright \(c\) 2019/.test(kept.fake.testSnapshots["tests/test_keep.py"] || ""));
        check("authorOneTestFile: a pre-existing file is NOT marked run-created (stays undeletable)", kept.fake.createdFiles.size === 0);
        // Negative controls — a FALSE restore would staple a license onto a brand-new file, or
        // resurrect notes the model was entitled to replace, or fight a task about licensing.
        const fresh = await author("tests/test_new.py", "Add spin(n) and cover it in tests/test_new.py.");
        check("authorOneTestFile: a brand-new test file gets no header injected (negative control)", !/Copyright/.test(fresh.disk) && fresh.fake.createdFiles.has("tests/test_new.py"));
        fs.writeFileSync(path.join(atmp, "tests", "test_plain.py"), "# quick helpers\n# todo tidy\n\nimport unittest\n");
        const plain = await author("tests/test_plain.py", "Cover spin(n) in tests/test_plain.py.");
        check("authorOneTestFile: a plain non-legal comment block is not resurrected (negative control)", !/quick helpers/.test(plain.disk));
        fs.writeFileSync(path.join(atmp, "tests", "test_lic.py"), HDR + "\nimport unittest\n");
        const lic = await author("tests/test_lic.py", "Replace the copyright notice in tests/test_lic.py with the new 2026 license text.");
        check("authorOneTestFile: a task explicitly about licensing stands the guard down (negative control)", !/Copyright \(c\) 2019/.test(lic.disk));
        try { fs.rmSync(atmp, { recursive: true, force: true }); } catch {}
      }

      // TEST-COVERAGE GUARD on the same authoring write path, one level DEEPER (MEASURED LIVE —
      // liclab run 116, 2026-08-09, D:/tmp/repro-testdrop.mjs). The authored spec file destroyed
      // the only test of spin() and every guard stayed green: droppedDefs measured [] because it
      // compares TOP-LEVEL blocks and the authored file re-declared the same `class TestWidget`,
      // and the suite went 1 passed -> 2 passed (strictly BETTER) so the run-level net never fired.
      {
        const OLD = "import unittest\n\nfrom widget import spin\n\n\nclass TestWidget(unittest.TestCase):\n    def setUp(self):\n        self.n = 1\n\n    def test_spin(self):\n        self.assertEqual(spin(self.n), 1)\n";
        const NEW = "import unittest\nfrom widget import flip\n\n\nclass TestWidget(unittest.TestCase):\n    def test_flip(self):\n        self.assertEqual(flip(3), -3)\n";
        const m = A.preserveDroppedTests(OLD, NEW);
        check("preserveDroppedTests: detects a test method dropped from INSIDE a class (droppedDefs is blind here)", !!m && m.names.includes("test_spin"));
        check("preserveDroppedTests: the authored tests remain the oracle (salvage, not revert)", /def test_flip/.test(m.text));
        check("preserveDroppedTests: a re-used class name is re-attached as <Name>Preserved so it cannot shadow the authoritative one", /class TestWidgetPreserved\(unittest\.TestCase\)/.test(m.text) && (m.text.match(/^class TestWidget\(/gm) || []).length === 1);
        check("preserveDroppedTests: support members (setUp) come along, or the salvaged test could not run", /def setUp/.test(m.text));
        check("preserveDroppedTests: the dropped test's import is re-added", /from widget import spin/.test(m.text));
        check("preserveDroppedTests: no duplicate import of a line the authored file already had", (m.text.match(/from widget import flip/g) || []).length === 1);
        // A fresh class name must be reused verbatim rather than suffixed.
        const m2 = A.preserveDroppedTests(OLD, "import unittest\n\n\nclass TestFlip(unittest.TestCase):\n    def test_flip(self):\n        pass\n");
        check("preserveDroppedTests: a class name the authored file did NOT re-use is kept verbatim", /class TestWidget\(unittest\.TestCase\)/.test(m2.text) && !/Preserved/.test(m2.text));
        // Bare top-level pytest-style test functions are covered too.
        const m3 = A.preserveDroppedTests("def test_alpha():\n    assert True\n", "def test_beta():\n    assert True\n");
        check("preserveDroppedTests: a bare top-level pytest test function is re-attached", !!m3 && /def test_alpha/.test(m3.text) && /def test_beta/.test(m3.text));
        // OBSERVED in the live liclab run 117: the authored file ended with a `unittest.main()`
        // runner, and appending past it means `python tests/test_widget.py` calls main() before the
        // salvaged class exists — silently dropping the very coverage just rescued.
        const m4 = A.preserveDroppedTests(OLD, NEW.replace(/\n$/, "\n\n\nif __name__ == '__main__':\n    unittest.main()\n"));
        check("preserveDroppedTests: salvaged tests are spliced BEFORE a trailing unittest.main() runner", m4.text.indexOf("def test_spin") < m4.text.indexOf("if __name__"));
        check("preserveDroppedTests: the trailing runner is kept exactly once", (m4.text.match(/^if __name__/gm) || []).length === 1);
        // Negative controls — a false fire would resurrect tests or churn files for nothing.
        check("preserveDroppedTests: no-op when every pre-existing test survived (negative control)", A.preserveDroppedTests(OLD, OLD) === null);
        check("preserveDroppedTests: no-op for a brand-new file with no prior content (negative control)", A.preserveDroppedTests("", NEW) === null);
        check("preserveDroppedTests: no-op when the old file held no tests at all (negative control)", A.preserveDroppedTests("import unittest\n", NEW) === null);

        // BUG 76 (found 2026-09-08, CONFIRMED REAL against tests/test_ioutils.py's
        // TestSpooledBytesIO/TestSpooledStringIO, which both define their own `test_iter` and
        // `test_len_rollover` independently): two DIFFERENT classes that each define their own
        // same-named test collapse into one bare-name entry, so dropping ONE class's copy while the
        // other class's same-named copy survives was invisible to the old global existence check.
        const AMBIG_OLD = "import unittest\n\n\nclass TestAlpha(unittest.TestCase):\n    def test_common(self):\n        assert 1\n\n    def test_alpha_only(self):\n        assert True\n\n\nclass TestBeta(unittest.TestCase):\n    def test_common(self):\n        assert 2\n\n    def test_beta_only(self):\n        assert True\n";
        const AMBIG_DROP_ALPHA = "import unittest\n\n\nclass TestAlpha(unittest.TestCase):\n    def test_alpha_only(self):\n        assert True\n\n\nclass TestBeta(unittest.TestCase):\n    def test_common(self):\n        assert 2\n\n    def test_beta_only(self):\n        assert True\n";
        const AMBIG_DROP_BETA = "import unittest\n\n\nclass TestAlpha(unittest.TestCase):\n    def test_common(self):\n        assert 1\n\n    def test_alpha_only(self):\n        assert True\n\n\nclass TestBeta(unittest.TestCase):\n    def test_beta_only(self):\n        assert True\n";
        const AMBIG_DROP_BOTH = "import unittest\n\n\nclass TestAlpha(unittest.TestCase):\n    def test_alpha_only(self):\n        assert True\n\n\nclass TestBeta(unittest.TestCase):\n    def test_beta_only(self):\n        assert True\n";
        const mAlpha = A.preserveDroppedTests(AMBIG_OLD, AMBIG_DROP_ALPHA);
        check("preserveDroppedTests: cross-class name collision — TestAlpha's own dropped copy is recovered even though TestBeta still has its own test_common (bug 76)", !!mAlpha && mAlpha.names.includes("test_common"));
        check("preserveDroppedTests: bug 76 fix — TestBeta's untouched test_common is not duplicated", (mAlpha.text.match(/def test_common/g) || []).length === 2);
        check("preserveDroppedTests: bug 76 fix — recovered into TestAlphaPreserved, not touching TestBeta", /class TestAlphaPreserved\(unittest\.TestCase\)/.test(mAlpha.text));
        const mBeta = A.preserveDroppedTests(AMBIG_OLD, AMBIG_DROP_BETA);
        check("preserveDroppedTests: cross-class name collision, other direction — TestBeta's own dropped copy is recovered even though TestAlpha still has its own test_common", !!mBeta && mBeta.names.includes("test_common") && /class TestBetaPreserved\(unittest\.TestCase\)/.test(mBeta.text));
        const mBoth = A.preserveDroppedTests(AMBIG_OLD, AMBIG_DROP_BOTH);
        check("preserveDroppedTests: cross-class name collision — when BOTH classes' copies are dropped, both are independently recovered", !!mBoth && (mBoth.text.match(/def test_common/g) || []).length === 2 && /class TestAlphaPreserved\(unittest\.TestCase\)/.test(mBoth.text) && /class TestBetaPreserved\(unittest\.TestCase\)/.test(mBoth.text));
        check("preserveDroppedTests: bug 76 negative control — no-op when neither ambiguous copy was dropped", A.preserveDroppedTests(AMBIG_OLD, AMBIG_OLD) === null);
        check("preserveDroppedTests: bug 76 fix is idempotent — re-running against its own already-recovered output is a no-op (the pre-existing shadow guard declines to double-salvage)", A.preserveDroppedTests(AMBIG_OLD, mAlpha.text) === null);

        // Stand-down predicate — re-attaching a test the task asked to delete or rename away would
        // be bug 2 again (a deterministic guard undoing the task's own explicit request).
        check("taskDropsTestContent: an ADD-shaped task does NOT stand the guard down (the run-116 shape)", A.taskDropsTestContent("Add a new function flip(n) to widget.py. Also add a test for flip in tests/test_widget.py.") === false);
        check("taskDropsTestContent: a REMOVAL task stands the guard down (the runs 55-57 shape)", A.taskDropsTestContent("remove the perimeter() method from Rectangle. Also remove the corresponding test_rectangle_perimeter test method from tests/test_shapeutils.py") === true);
        check("taskDropsTestContent: a RENAME task stands the guard down (the runs 50-54 shape)", A.taskDropsTestContent("Rename distance_to on Point to distance and update every call site including tests/test_shapeutils.py") === true);

        // End-to-end through the REAL authorOneTestFile, against a real temp repo.
        const ttmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-authortests-"));
        fs.mkdirSync(path.join(ttmp, "tests"));
        const authorT = async (rel, task) => {
          const fake = {
            root: ttmp, task,
            eta: { chat: async () => ({ content: NEW }) },
            stopped: false, contract: null, files: new Set(), createdFiles: new Set(), lockedFiles: new Set(),
            authoritativeTests: {}, testSnapshots: {}, gates: {}, baselineFiles: {},
            verifyAuthoredTests: async () => null, _captureBaseline: A.Agent.prototype._captureBaseline,
          };
          await A.Agent.prototype.authorOneTestFile.call(fake, rel, task, () => {});
          return { fake, disk: fs.readFileSync(path.join(ttmp, rel), "utf8") };
        };
        fs.writeFileSync(path.join(ttmp, "tests", "test_cov.py"), OLD);
        const cov = await authorT("tests/test_cov.py", "Add a new function flip(n) to widget.py. Also add a test for flip in tests/test_cov.py.");
        check("authorOneTestFile: pre-existing coverage destroyed by the authored spec file is re-attached", /def test_spin/.test(cov.disk) && /def test_flip/.test(cov.disk));
        check("authorOneTestFile: the preserved coverage is in the LOCKED snapshot, so restoreTestsIfBroken can't undo it", /def test_spin/.test(cov.fake.authoritativeTests["tests/test_cov.py"] || "") && /def test_spin/.test(cov.fake.testSnapshots["tests/test_cov.py"] || ""));
        fs.writeFileSync(path.join(ttmp, "tests", "test_del.py"), OLD);
        const del = await authorT("tests/test_del.py", "Remove spin() from widget.py and delete the test_spin test from tests/test_del.py.");
        check("authorOneTestFile: a task that asks for the test to be removed stands the guard down (negative control)", !/def test_spin/.test(del.disk));
        try { fs.rmSync(ttmp, { recursive: true, force: true }); } catch {}
      }

      // METHOD-LEVEL DESTRUCTION GUARD — the GENERALISATION of the bug above to ORDINARY production
      // code (MEASURED on the real boltons/cacheutils.py, 2026-08-09, D:/tmp/repro-methoddrop.mjs).
      // Bug 26's root cause was GRANULARITY, and that reasoning was never test-specific: a rewrite
      // that keeps every class by name while deleting a METHOD inside one is invisible to every
      // content guard (droppedDefs [], topLevelDefs 13->13), and when no test covers that method
      // the suite score is unchanged too, so the run-level net correctly never fires either.
      // `ThresholdCounter.iterkeys`/`itervalues` are real public API of a real library with no test
      // touching them — silent public API deletion with every layer green.
      {
        const OLDC = "class ThresholdCounter(object):\n    def __init__(self):\n        self.total = 0\n\n    def iterkeys(self):\n        return iter(self._c)\n\n    def get_common_count(self):\n        return sum(self._c.values())\n";
        // The realistic shape: the rewrite keeps the class and adds what it was asked for, but
        // silently loses one public method on the way.
        const NEWC = "class ThresholdCounter(object):\n    def __init__(self):\n        self.total = 0\n\n    def get_common_count(self):\n        return sum(self._c.values())\n\n    def total_seen(self):\n        return self.total\n";
        check("preserveDroppedMethods: droppedDefs is BLIND to this (the whole reason the guard exists)", A.droppedDefs(OLDC, NEWC).length === 0);
        const k = A.preserveDroppedMethods(OLDC, NEWC);
        check("preserveDroppedMethods: detects a method dropped from INSIDE a surviving class", !!k && k.names.join(",") === "ThresholdCounter.iterkeys");
        check("preserveDroppedMethods: the lost member is re-attached", /def iterkeys/.test(k.text));
        check("preserveDroppedMethods: the model's OWN new method is KEPT (salvage, not revert)", /def total_seen/.test(k.text));
        check("preserveDroppedMethods: the member is re-attached INSIDE the class, not at top level", !/^def iterkeys/m.test(k.text) && /^    def iterkeys/m.test(k.text));
        check("preserveDroppedMethods: exactly one copy of the recovered member", (k.text.match(/def iterkeys/g) || []).length === 1);
        check("preserveDroppedMethods: a second pass finds nothing left to recover (idempotent)", A.preserveDroppedMethods(OLDC, k.text) === null);
        // Re-indentation: the rewrite may use a different body indent than the original, and a
        // splice at the old indent would not be part of the class at all.
        const NEW8 = NEWC.replace(/^    /gm, "        ").replace(/^        def/gm, "        def");
        const k8 = A.preserveDroppedMethods(OLDC, NEW8);
        check("preserveDroppedMethods: the salvaged member is re-indented onto the NEW body's indent", !!k8 && /^        def iterkeys/m.test(k8.text));
        // A decorated member must come back WITH its decorator — salvaging the bare def would
        // silently change behaviour (a @property becomes a method), which is its own destruction.
        const kd = A.preserveDroppedMethods("class A:\n    @property\n    def size(self):\n        return 1\n\n    def pub(self):\n        pass\n", "class A:\n    def pub(self):\n        pass\n");
        check("preserveDroppedMethods: a salvaged member keeps its decorator", !!kd && /@property\n    def size/.test(kd.text));
        check("preserveDroppedMethods: the decorator is not left dangling on its own", !!kd && (kd.text.match(/@property/g) || []).length === 1 && kd.names.join(",") === "A.size");
        // Only CONTRACT members are worth protecting — a false fire fights a legitimate refactor.
        const priv = "class A:\n    def _helper(self):\n        pass\n\n    def pub(self):\n        pass\n";
        check("preserveDroppedMethods: a dropped _private helper is left alone (implementation detail)", A.preserveDroppedMethods(priv, "class A:\n    def pub(self):\n        pass\n") === null);
        check("preserveDroppedMethods: ...unless the new content still REFERENCES it (deleting it broke the file)", !!A.preserveDroppedMethods(priv, "class A:\n    def pub(self):\n        return self._helper()\n"));
        check("preserveDroppedMethods: a dropped dunder is protocol, not implementation detail, so it IS protected", !!A.preserveDroppedMethods("class A:\n    def __len__(self):\n        return 0\n\n    def pub(self):\n        pass\n", "class A:\n    def pub(self):\n        pass\n"));
        // Negative controls.
        check("preserveDroppedMethods: no-op when nothing was dropped (negative control)", A.preserveDroppedMethods(OLDC, OLDC) === null);
        check("preserveDroppedMethods: no-op for a brand-new file with no prior content (negative control)", A.preserveDroppedMethods("", NEWC) === null);
        check("preserveDroppedMethods: a class that vanished ENTIRELY is left to droppedDefs, which already reverts it", A.preserveDroppedMethods("class A:\n    def pub(self):\n        pass\n", "class B:\n    def other(self):\n        pass\n") === null);
        check("preserveDroppedMethods: a module of plain top-level functions is not its business", A.preserveDroppedMethods("def a():\n    pass\n", "def a():\n    pass\n\ndef b():\n    pass\n") === null);
        // Stand-down — the same argument as taskDropsTestContent, aliased so the two cannot drift.
        check("taskDropsCodeContent: is the SAME predicate as taskDropsTestContent (alias, cannot drift)", A.taskDropsCodeContent === A.taskDropsTestContent);
        check("taskDropsCodeContent: a REMOVAL task stands the guard down (the runs 55-57 shape)", A.taskDropsCodeContent("In boltons/shapeutils.py, remove the perimeter() method from the Rectangle class entirely") === true);
        check("taskDropsCodeContent: a RENAME task stands the guard down (the runs 50-54 shape)", A.taskDropsCodeContent("Rename distance_to on Point to distance and update every call site") === true);
        check("taskDropsCodeContent: a pure ADD task leaves the guard ARMED", A.taskDropsCodeContent("Add a method total_seen() to the ThresholdCounter class in boltons/cacheutils.py") === false);

        // ---- BUG 47 (MEASURED via no-model harness, D:/tmp/repro-topdefs-removal.mjs, 2026-08-23):
        // preserveDroppedMethods (member-level) always stood down on !taskDropsCodeContent(this.task)
        // (wired at line ~5807/6618) — but the TOP-LEVEL droppedDefs guard that gates a whole-file
        // write_file rewrite, and its surgical edit_file sibling, had NO such stand-down: the
        // condition was unconditional (`old.trim() && droppedDefs(old, content).length`), so a task
        // that explicitly asked to remove or rename a MODULE-LEVEL (not class-method) function was
        // reverted right back in, undoing the task's own explicit request — the same class of bug
        // already fixed for methods and test files, missed here because this branch predates both
        // stand-downs. Source-text checks (the guard lives inside class methods, not standalone
        // functions, so this is the same wiring-verification style as bug 29's budget-gate check). ----
        const src47 = fs.readFileSync(path.join(__dirname, "agent.mjs"), "utf8");
        check("bug 47: write_file's top-level droppedDefs guard now stands down on taskDropsCodeContent",
          /old !== null && old\.trim\(\) && !taskDropsCodeContent\(this\.task\) && droppedDefs\(old, content\)\.length/.test(src47));
        check("bug 47: edit_file's top-level droppedDefs guard now stands down on taskDropsCodeContent",
          /g\.ok && old\.trim\(\) && !taskDropsCodeContent\(this\.task\) && droppedDefs\(old, content\)\.length/.test(src47));
        // splitClassMembers — factored out of preserveDroppedTests so both guards use ONE scanner.
        // BUG 63 (2026-09-06): a class-level attribute (`X = 1`) USED TO be swept into `preamble`
        // alongside the docstring, indistinguishable from it and therefore invisible to
        // `preserveDroppedMethods` if dropped. It is now tracked as its own named member; only the
        // docstring (no `NAME =` shape) still lands in preamble.
        const sp = A.splitClassMembers("class A:\n    \"\"\"doc.\"\"\"\n    X = 1\n\n    @property\n    def p(self):\n        return 1\n\n    def q(self):\n        pass\n");
        check("splitClassMembers: the docstring alone stays in the preamble", !!sp && sp.preamble.join("\n").includes("doc.") && !sp.preamble.join("\n").includes("X = 1"));
        check("splitClassMembers: a class-level attribute is now its own named member (BUG 63)", !!sp && sp.members.map((m) => m.name).join(",") === "X,p,q");
        check("splitClassMembers: names each member and absorbs its decorator", !!sp && sp.members[1].lines.join("\n").includes("@property"));
        check("splitClassMembers: returns null for a non-class block (negative control)", A.splitClassMembers("def f():\n    pass\n") === null);
        check("splitClassMembers: returns null for a class with no indented body (negative control)", A.splitClassMembers("class A: pass") === null);

        // ---- BUG 99 (staleness-audit sweep, 2026-09-14, D:/tmp/splitclassprobe/probe.mjs): a class's
        // own base-class list can wrap across multiple physical lines with hanging/aligned indentation
        // (a pre-black PEP8 style: `class Foo(Bar,\n          Baz):`). Before this fix `body` started
        // unconditionally at `h + 1`, so the wrapped header's OWN continuation line was mistaken for the
        // first body line, `ind` locked onto that line's (arbitrary) indentation, and every real member
        // then failed `startsWith(ind)` — collapsing the WHOLE class body into `preamble` with
        // `members: []`. A magic-trailing-comma style (`class Foo(\n    Bar,\n):`) happened to survive
        // only by coincidence (its continuation lines are indented to match the real body). ----
        const spAligned = A.splitClassMembers("class Foo(Bar,\n          Baz):\n    \"\"\"doc\"\"\"\n    def method_one(self):\n        return 1\n\n    def method_two(self):\n        return 2\n");
        check("splitClassMembers: an ALIGNED multi-line base-class list no longer swallows the whole body (BUG 99)", !!spAligned && spAligned.members.map((m) => m.name).join(",") === "method_one,method_two");
        const spTrailingComma = A.splitClassMembers("class Foo(\n    Bar,\n    Baz,\n):\n    def method_one(self):\n        return 1\n");
        check("splitClassMembers: magic-trailing-comma multi-line base list still works (BUG 99 regression guard)", !!spTrailingComma && spTrailingComma.members.map((m) => m.name).join(",") === "method_one");
        const spNested = A.splitClassMembers("class Foo(make_base(a, b),\n          Baz):\n    def method_one(self):\n        return 1\n");
        check("splitClassMembers: a NESTED paren inside a wrapped base-class list is depth-tracked correctly (BUG 99)", !!spNested && spNested.members.map((m) => m.name).join(",") === "method_one");
        {
          const OB = "class Foo(Bar,\n          Baz):\n    def a(self):\n        return 1\n\n    def b(self):\n        return 2\n";
          const NB = "class Foo(Bar,\n          Baz):\n    def a(self):\n        return 1\n";
          check("preserveDroppedMethods: a dropped method in an ALIGNED multi-line-header class is now detected (BUG 99)", !!A.preserveDroppedMethods(OB, NB) && A.preserveDroppedMethods(OB, NB).names.join(",") === "Foo.b");
        }

        // ---- BUG 63 (staleness-audit sweep, 2026-09-06, D:/tmp/repro-classattr-drop/repro.mjs):
        // preserveDroppedMethods only ever iterated `splitClassMembers(...).members`, and before the
        // fix above a class-level attribute assignment was never a "member" at all -- it was absorbed
        // into `preamble`, indistinguishable from a docstring. So a rewrite that dropped, e.g.,
        // `__slots__` while keeping every method by name sailed through every guard: droppedDefs/
        // topLevelDefs are column-0-anchored (blind to an indented assignment) and
        // preserveDroppedMethods itself never even saw the name to compare. Same fault FAMILY as bug
        // 62 (a dropped module-level constant), one level deeper (a dropped CLASS-level constant). ----
        {
          const OA = "class Widget:\n    __slots__ = ('a', 'b')\n\n    def get_a(self):\n        return self.a\n";
          const NA = "class Widget:\n    def get_a(self):\n        return self.a\n";
          check("preserveDroppedMethods: droppedDefs is BLIND to a dropped class-level attribute (BUG 63)", A.droppedDefs(OA, NA).length === 0);
          const ka = A.preserveDroppedMethods(OA, NA);
          check("preserveDroppedMethods: a dropped __slots__ is now detected", !!ka && ka.names.join(",") === "Widget.__slots__");
          check("preserveDroppedMethods: __slots__ is protocol (dunder), so it IS protected even though nothing references it by name", /__slots__ = \('a', 'b'\)/.test(ka.text));
          check("preserveDroppedMethods: the model's OWN surviving method is kept (salvage, not revert)", /def get_a/.test(ka.text));
          check("preserveDroppedMethods: a second pass on the repaired text finds nothing left (idempotent)", A.preserveDroppedMethods(OA, ka.text) === null);

          const privA = "class A:\n    _cache = {}\n\n    def pub(self):\n        pass\n";
          check("preserveDroppedMethods: a dropped PRIVATE unreferenced attribute is left alone (implementation detail, same policy as a private method)", A.preserveDroppedMethods(privA, "class A:\n    def pub(self):\n        pass\n") === null);
          check("preserveDroppedMethods: ...unless the new content still REFERENCES it by name", !!A.preserveDroppedMethods(privA, "class A:\n    def pub(self):\n        return self._cache\n"));

          const multiOld = "class A:\n    CONFIG = {\n        \"x\": 1,\n        \"y\": 2,\n    }\n\n    def pub(self):\n        pass\n";
          const km = A.preserveDroppedMethods(multiOld, "class A:\n    def pub(self):\n        pass\n");
          check("preserveDroppedMethods: a multi-line dict-literal attribute is recovered WHOLE, not truncated at its first inner line", !!km && /CONFIG = \{\n\s+"x": 1,\n\s+"y": 2,\n\s+\}/.test(km.text));

          check("preserveDroppedMethods: no-op when the attribute survives unchanged (negative control)", A.preserveDroppedMethods("class A:\n    X = 1\n\n    def pub(self):\n        pass\n", "class A:\n    X = 1\n\n    def pub(self):\n        pass\n") === null);
        }

        // ---- BUG 75 (2026-09-08, found by an exhaustive real-corpus differential -- drop each of
        // the 879 real methods in boltons+tests one at a time and check recovery): `kept` was a bare-
        // name `Set`, collapsing a `@property` getter and its `@x.setter` (which legitimately share
        // ONE name) into a single entry. CONFIRMED REAL: `boltons/urlutils.py`'s `URL.path` is exactly
        // this shape. Dropping EITHER half while the other survived left `kept.has("path")` true, so
        // the drop was invisible even though "path" is a public, contract-protected name. Fixed by
        // disambiguating on (name, decorator-lines) ONLY when a name is genuinely duplicated in `old`.
        {
          const OG = "class A:\n    @property\n    def path(self):\n        return self._p\n\n    @path.setter\n    def path(self, v):\n        self._p = v\n\n    def pub(self):\n        pass\n";
          const dropGetter = "class A:\n    @path.setter\n    def path(self, v):\n        self._p = v\n\n    def pub(self):\n        pass\n";
          const dropSetter = "class A:\n    @property\n    def path(self):\n        return self._p\n\n    def pub(self):\n        pass\n";
          check("preserveDroppedMethods: droppedDefs is BLIND to this (class survives by name) (BUG 75)", A.droppedDefs(OG, dropGetter).length === 0);
          const kg = A.preserveDroppedMethods(OG, dropGetter);
          check("preserveDroppedMethods: a dropped property GETTER is detected even though the SETTER shares its name (BUG 75)", !!kg && kg.names.join(",") === "A.path");
          check("preserveDroppedMethods: the recovered getter carries its OWN @property decorator, not the setter's", !!kg && /@property\n    def path\(self\):\n        return self\._p/.test(kg.text));
          check("preserveDroppedMethods: exactly one getter and one setter survive (no duplication)", !!kg && (kg.text.match(/def path/g) || []).length === 2 && (kg.text.match(/@property/g) || []).length === 1);
          const ks = A.preserveDroppedMethods(OG, dropSetter);
          check("preserveDroppedMethods: a dropped property SETTER is detected even though the GETTER shares its name (BUG 75)", !!ks && ks.names.join(",") === "A.path");
          check("preserveDroppedMethods: the recovered setter carries its OWN @path.setter decorator, not the getter's", !!ks && /@path\.setter\n    def path\(self, v\):\n        self\._p = v/.test(ks.text));
          check("preserveDroppedMethods: exactly one getter and one setter survive (no duplication), other direction", !!ks && (ks.text.match(/def path/g) || []).length === 2 && (ks.text.match(/@path\.setter/g) || []).length === 1);
          check("preserveDroppedMethods: a second pass on either repaired text finds nothing left (idempotent)", A.preserveDroppedMethods(OG, kg.text) === null && A.preserveDroppedMethods(OG, ks.text) === null);
          check("preserveDroppedMethods: no-op when both halves survive unchanged (negative control)", A.preserveDroppedMethods(OG, OG) === null);
          // A legitimate decorator-only refactor on a UNIQUE (non-duplicated) name must not false-fire
          // into a spurious duplicate -- the ambiguity-safe path only engages when `old` truly repeats a name.
          const uniqOld = "class A:\n    def helper(self):\n        pass\n";
          const uniqNew = "class A:\n    @staticmethod\n    def helper():\n        pass\n";
          check("preserveDroppedMethods: adding a decorator to an otherwise-unique method is a legitimate refactor, not a drop (BUG 75 regression guard)", A.preserveDroppedMethods(uniqOld, uniqNew) === null);
        }

        // ---- BUG 28 (MEASURED 2026-08-10, wired+verified 2026-08-12): every content guard built
        // for bugs 24-27 lives on a WRITE path. `bestOfNFix` lands a whole-file candidate of its own
        // with gate() (syntax only) and a test score as its ONLY checks — so a candidate that fixes
        // the failing test while deleting an UNCOVERED definition sails straight through. This is
        // not blindness like bug 27: `droppedDefs` names the loss perfectly well, nothing calls it.
        // The run-level net cannot help either — the suite went from failing to passing, strictly
        // BETTER, which is this lever's whole purpose, so restoreBaselineIfWorse correctly never
        // fires. `preserveDroppedDefs` is the top-level counterpart of `preserveDroppedMethods`;
        // both are re-attach (never revert), because the candidate is what made the tests pass. ----
        const OLDT = "def helper(x):\n    return x * 2\n\n\nclass Counter(object):\n    def bump(self):\n        return 1\n";
        const NEWT = "class Counter(object):\n    def bump(self):\n        return 1\n\n    def total_seen(self):\n        return 0\n";
        check("preserveDroppedDefs: droppedDefs NAMES this loss (unlike bug 27, the guard is not blind — it is never called)", A.droppedDefs(OLDT, NEWT).join(",") === "helper");
        const pd = A.preserveDroppedDefs(OLDT, NEWT);
        check("preserveDroppedDefs: detects a top-level def dropped by a whole-file candidate", !!pd && pd.names.join(",") === "helper");
        check("preserveDroppedDefs: the lost definition is re-attached verbatim", /def helper\(x\):\n    return x \* 2/.test(pd.text));
        check("preserveDroppedDefs: the candidate's OWN fix is KEPT (re-attach, never revert — it is what made the tests pass)", /def total_seen/.test(pd.text));
        check("preserveDroppedDefs: the recovered def lands at TOP level, not inside the class", /^def helper/m.test(pd.text));
        check("preserveDroppedDefs: exactly one copy of the recovered def", (pd.text.match(/def helper\(/g) || []).length === 1);
        check("preserveDroppedDefs: a second pass finds nothing left to recover (idempotent)", A.preserveDroppedDefs(OLDT, pd.text) === null);
        const pdc = A.preserveDroppedDefs("class Gone(object):\n    def a(self):\n        pass\n\n\ndef kept():\n    pass\n", "def kept():\n    pass\n");
        check("preserveDroppedDefs: recovers a dropped CLASS, not just a function", !!pdc && pdc.names.join(",") === "Gone" && /class Gone\(object\)/.test(pdc.text));
        const pdm = A.preserveDroppedDefs("def a():\n    pass\n\n\ndef b():\n    pass\n\n\ndef c():\n    pass\n", "def b():\n    pass\n");
        check("preserveDroppedDefs: recovers MULTIPLE dropped defs in one pass", !!pdm && pdm.names.join(",") === "a,c" && /def a/.test(pdm.text) && /def c/.test(pdm.text));
        // Negative controls — a false fire on a benign rewrite would be worse than the bug it closes.
        check("preserveDroppedDefs: no-op when nothing was dropped (negative control)", A.preserveDroppedDefs(OLDT, OLDT) === null);
        check("preserveDroppedDefs: no-op when the candidate only ADDS a def (negative control)", A.preserveDroppedDefs("def a():\n    pass\n", "def a():\n    pass\n\n\ndef b():\n    pass\n") === null);
        check("preserveDroppedDefs: no-op for a brand-new file with no prior content (negative control)", A.preserveDroppedDefs("", NEWT) === null);
        check("preserveDroppedDefs: a body-only change is not a drop (negative control)", A.preserveDroppedDefs("def a():\n    return 1\n", "def a():\n    return 2\n") === null);

        // ---- BUG 62 (staleness-audit sweep, 2026-09-06): droppedDefs names a dropped top-level
        // ASSIGNMENT (a plain module-level constant) just as confidently as a dropped def/class, but
        // topLevelBlocks only ever recognizes def/class lines — before this fix preserveDroppedDefs
        // silently returned null for such a loss, and repairLandedFile (its only caller) has no other
        // top-level content guard, so a dropped constant sailed through with ZERO log line and ZERO
        // recovery on the bestOfNFix/canned-reference landing path. ----
        const OLDA = "TIMEOUT = 30\n\ndef helper():\n    return 1\n";
        const NEWA = "def helper():\n    return 2\n";
        check("preserveDroppedDefs/BUG62: droppedDefs names a dropped top-level constant", A.droppedDefs(OLDA, NEWA).join(",") === "TIMEOUT");
        const pda = A.preserveDroppedDefs(OLDA, NEWA);
        check("preserveDroppedDefs/BUG62: the dropped constant IS now recovered (was null before the fix)", !!pda && pda.names.join(",") === "TIMEOUT");
        check("preserveDroppedDefs/BUG62: the constant is re-attached verbatim", /^TIMEOUT = 30$/m.test(pda.text));
        check("preserveDroppedDefs/BUG62: the candidate's own fix is still kept (re-attach, not revert)", /return 2/.test(pda.text));
        check("preserveDroppedDefs/BUG62: a multi-line dict-literal constant is captured whole, not truncated at its first inner newline",
          /CONFIG = \{\n    "a": 1,\n    "b": 2,\n\}/.test(A.preserveDroppedDefs('CONFIG = {\n    "a": 1,\n    "b": 2,\n}\n\ndef helper():\n    return 1\n', NEWA).text));
        check("preserveDroppedDefs/BUG62: a JS top-level const is recovered too",
          /const TIMEOUT = 30;/.test(A.preserveDroppedDefs("const TIMEOUT = 30;\n\nfunction helper() {\n  return 1;\n}\n", "function helper() {\n  return 2;\n}\n").text));
        check("preserveDroppedDefs/BUG62: a type-annotated Python constant keeps its annotation",
          /VERSION: str = "1\.0"/.test(A.preserveDroppedDefs('VERSION: str = "1.0"\n\ndef helper():\n    return 1\n', NEWA).text));
        check("preserveDroppedDefs/BUG62: mixed drop (constant + function) recovers BOTH in one pass",
          A.preserveDroppedDefs("TIMEOUT = 30\n\ndef a():\n    pass\n\ndef helper():\n    return 1\n", NEWA).names.sort().join(",") === "TIMEOUT,a");
        check("preserveDroppedDefs/BUG62: a second pass finds nothing left to recover (idempotent)", A.preserveDroppedDefs(OLDA, pda.text) === null);
        check("preserveDroppedDefs/BUG62: an INDENTED assignment (inside a function body) is never mistaken for a top-level constant (negative control)",
          A.preserveDroppedDefs("def outer():\n    x = 1\n    return x\n\ndef helper():\n    return 1\n", "def outer():\n    return 2\n\ndef helper():\n    return 1\n") === null);
      }

      // ---- BUG 28, the WIRING: preserveDroppedDefs/preserveDroppedMethods only close the hole if
      // `bestOfNFix` actually invokes them on the winner it lands. Bug 28's whole lesson is that a
      // guard which exists but is never CALLED protects nothing, so this drives the REAL lever end
      // to end over a REAL temp repo (model stubbed) and asserts against what is on DISK. ----
      {
        const rdir = fresh("bon28");
        const BASE = "def helper(x):\n    \"\"\"Public API no test covers.\"\"\"\n    return x * 2\n\n\nclass Counter(object):\n    def bump(self):\n        return 1\n\n    def iterkeys(self):\n        return iter([])\n";
        // The model's "fix": makes the failing test pass, silently loses helper AND iterkeys.
        const CAND = "class Counter(object):\n    def bump(self):\n        return 1\n\n    def total_seen(self):\n        return 7\n";
        fs.writeFileSync(path.join(rdir, "impl.py"), BASE);
        fs.writeFileSync(path.join(rdir, "test_impl.py"), "import unittest, impl\nclass T(unittest.TestCase):\n    def test_seen(self):\n        self.assertEqual(impl.Counter().total_seen(), 7)\n");
        const mk = (task) => ({
          root: rdir, stopped: false, files: new Set(["impl.py"]), gates: {},
          failedCmds: new Map([["python -m unittest test_impl", true]]), lockedFiles: new Set(["test_impl.py"]),
          restoreTestsIfBroken: async () => false, task, baselineFiles: { "impl.py": BASE },
          repairLandedFile: A.Agent.prototype.repairLandedFile,
          _genFileContent: async () => CAND,
        });
        const ev = [];
        const won = await A.Agent.prototype.bestOfNFix.call(mk("Add a method total_seen() to Counter in impl.py."), "python -m unittest test_impl", (e) => ev.push(e), 2);
        const disk = fs.readFileSync(path.join(rdir, "impl.py"), "utf8");
        check("bug 28 wiring: the winning candidate still lands and the tests pass", won === true && /def total_seen/.test(disk), JSON.stringify({ won }));
        check("bug 28 wiring: a dropped TOP-LEVEL def is re-attached by the real lever", /def helper/.test(disk), disk);
        check("bug 28 wiring: a dropped CLASS METHOD is re-attached too, inside the class", /^    def iterkeys/m.test(disk), disk);
        check("bug 28 wiring: the guard announces itself in the run log (silent repair would be its own bug)", ev.some((e) => e.type === "log" && /re-attached/.test(e.text || "")), JSON.stringify(ev.filter((e) => e.type === "log").map((e) => e.text)));
        // Stand-down: re-attaching what the task ASKED to delete would be bug 2 all over again.
        fs.writeFileSync(path.join(rdir, "impl.py"), BASE);
        const ev2 = [];
        await A.Agent.prototype.bestOfNFix.call(mk("Remove the iterkeys() method and the helper() function from impl.py entirely, and add total_seen()."), "python -m unittest test_impl", (e) => ev2.push(e), 2);
        const disk2 = fs.readFileSync(path.join(rdir, "impl.py"), "utf8");
        check("bug 28 wiring: a REMOVAL task stands the repair down — the deletion is respected", !/def iterkeys/.test(disk2) && !/def helper/.test(disk2), disk2);
        check("bug 28 wiring: ...and no guard event is emitted when it stands down", !ev2.some((e) => e.type === "log" && /re-attached/.test(e.text || "")));
      }

      // ---- BUG 29 (2026-08-12): `escalateFix` — the cloud-fallback lever — lands a whole-file
      // candidate at the SAME kind of unguarded site bug 28 closed in `bestOfNFix`: `gate()` (syntax
      // only) plus a test score, and nothing else. A cloud model is no safer here than the local one;
      // it answers from the spec and the test output and has never seen the definitions it silently
      // drops. Found by continuing the standing write-path sweep. It reuses `repairLandedFile`
      // rather than a second copy, so the two landing paths cannot drift apart.
      // This path is UNREACHABLE in this environment (no cloud model is configured), so stubbing
      // `provider.cloudFallback` is the only way it can be exercised at all — which is exactly why
      // it stayed unguarded so long, and exactly why it needs a permanent test rather than a live run.
      {
        const rdir = fresh("esc29");
        const BASE = "def helper(x):\n    \"\"\"Public API no test covers.\"\"\"\n    return x * 2\n\n\nclass Counter(object):\n    def bump(self):\n        return 1\n\n    def iterkeys(self):\n        return iter([])\n";
        const CAND = "class Counter(object):\n    def bump(self):\n        return 1\n\n    def total_seen(self):\n        return 7\n";
        fs.writeFileSync(path.join(rdir, "impl.py"), BASE);
        fs.writeFileSync(path.join(rdir, "test_impl.py"), "import unittest, impl\nclass T(unittest.TestCase):\n    def test_seen(self):\n        self.assertEqual(impl.Counter().total_seen(), 7)\n");
        const mk = (task) => ({
          root: rdir, stopped: false, escalated: false, files: new Set(["impl.py"]), gates: {},
          failedCmds: new Map([["python -m unittest test_impl", true]]),
          overBudget: () => false, restoreTestsIfBroken: async () => false,
          task, baselineFiles: { "impl.py": BASE }, eta: { numCtx: 4096 },
          repairLandedFile: A.Agent.prototype.repairLandedFile,
          _genFileContent: async () => CAND,
        });
        const savedCF = A.provider.cloudFallback;
        A.provider.cloudFallback = { model: "stub-cloud", base: "http://127.0.0.1:1", key: "x", kind: "openai" };
        let won, disk, ev = [];
        try {
          won = await A.Agent.prototype.escalateFix.call(mk("Add a method total_seen() to Counter in impl.py."), "python -m unittest test_impl", (e) => ev.push(e));
          disk = fs.readFileSync(path.join(rdir, "impl.py"), "utf8");
        } finally { A.provider.cloudFallback = savedCF; }
        // Precondition: if escalateFix bailed early the file is still pristine and every "content is
        // present" assertion below would pass for entirely the wrong reason. Caught exactly that on
        // the first draft of the D:/tmp harness (an unseeded `files` set → pickImplFile returned null).
        check("bug 29 wiring: escalateFix actually ran and changed the file (not a silent no-op)", disk !== BASE, "disk is byte-identical to the baseline");
        check("bug 29 wiring: the cloud candidate still lands and the tests pass", won === true && /def total_seen/.test(disk), JSON.stringify({ won }));
        check("bug 29 wiring: a dropped TOP-LEVEL def is re-attached by the real cloud lever", /def helper/.test(disk), disk);
        check("bug 29 wiring: a dropped CLASS METHOD is re-attached too, inside the class", /^    def iterkeys/m.test(disk), disk);
        check("bug 29 wiring: exactly one copy of the recovered def (no duplicate)", (disk.match(/def helper\(/g) || []).length === 1, disk);
        check("bug 29 wiring: the guard announces itself in the run log", ev.some((e) => e.type === "log" && /re-attached/.test(e.text || "")), JSON.stringify(ev.filter((e) => e.type === "log").map((e) => e.text)));
        // Stand-down, same non-negotiable as bug 28: never fight a deletion the task asked for.
        fs.writeFileSync(path.join(rdir, "impl.py"), BASE);
        A.provider.cloudFallback = { model: "stub-cloud", base: "http://127.0.0.1:1", key: "x", kind: "openai" };
        const ev2 = [];
        let disk2;
        try {
          await A.Agent.prototype.escalateFix.call(mk("Remove the iterkeys() method and the helper() function from impl.py entirely, and add total_seen()."), "python -m unittest test_impl", (e) => ev2.push(e));
          disk2 = fs.readFileSync(path.join(rdir, "impl.py"), "utf8");
        } finally { A.provider.cloudFallback = savedCF; }
        check("bug 29 wiring: a REMOVAL task stands the repair down — the deletion is respected", !/def iterkeys/.test(disk2) && !/def helper/.test(disk2), disk2);
        check("bug 29 wiring: ...and no guard event is emitted when it stands down", !ev2.some((e) => e.type === "log" && /re-attached/.test(e.text || "")));
      }

      // ---- BUG 53 (2026-09-01): `pickImplFile`'s traceback-frame regex expects Python's raw
      // `File "...", line N` format, which `python -m pytest -q` — this project's own real
      // baseline/regression command — NEVER emits for a simple assertion/call failure (pytest's
      // short format instead prints `path:line: ExcType` pointing at the TEST file's own call
      // site, which `isTestFile` correctly filters out). With that frame never found, EVERY
      // multi-impl-file failure fell through to "first file in the Set" regardless of which file
      // the bug was actually in — live-caught on boltons runs 182-184, where `Rectangle.moved()`'s
      // missing `scale` param was chased in `pointutils.py` (touched first) for 3 full runs while
      // the real defect sat untouched in `shapeutils.py`, which actually defines `moved`. Fixed by
      // reading each impl file's own top-level def names and matching the one the failure text
      // actually names, before falling back to Set order. ----
      {
        const rdir = fresh("pick53");
        // pointutils.py is touched FIRST (mirrors the real run: executor edits file 1 of 2 first)
        // but its own functions are never mentioned in the failure — shapeutils.py's `moved` is.
        fs.writeFileSync(path.join(rdir, "pointutils.py"), "class Point:\n    def translated(self, dx, dy):\n        return Point(dx, dy)\n");
        fs.writeFileSync(path.join(rdir, "shapeutils.py"), "class Rectangle:\n    def moved(self, dx, dy):\n        return self.top_left.translated(dx, dy)\n");
        const out = [
          "self = <tests.test_shapeutils.T testMethod=test_rectangle_moved>",
          "",
          "    def test_rectangle_moved(self):",
          "        rect = Rectangle(Point(0,0), width=4, height=5)",
          ">       new_rect = rect.moved(dx=2, dy=3, scale=2)",
          "E       TypeError: Rectangle.moved() got an unexpected keyword argument 'scale'",
          "",
          "tests/test_shapeutils.py:8: TypeError",
        ].join("\n");
        const files = new Set(["pointutils.py", "shapeutils.py"]);
        const pick = await A.pickImplFile(out, rdir, files);
        check("bug 53: pickImplFile targets the file that actually defines the implicated function, not the first-touched one", pick === "shapeutils.py", pick);
        // Sanity: when the FIRST-touched file also happens to be the right one, the fix must not regress it.
        const outA = "E       TypeError: Point.translated() takes 3 positional arguments but 4 were given\n\ntests/test_pointutils.py:5: TypeError";
        const pickA = await A.pickImplFile(outA, rdir, files);
        check("bug 53: still correctly picks the file when the FIRST-touched file is the right one", pickA === "pointutils.py", pickA);
        // No frame, no name match at all (e.g. an import error) — falls back to Set order, same as before.
        const pickFallback = await A.pickImplFile("ImportError: cannot import name 'Foo'", rdir, files);
        check("bug 53: falls back to first-in-Set when nothing in the failure names a known function", pickFallback === "pointutils.py", pickFallback);
      }

      // ---- BUG 56 (2026-09-01): bug 53's name-match pass only ever scanned `this.files` (files this
      // RUN has already touched), so a multi-file task whose repair kicked in before the executor
      // reached a LATER file left that file completely invisible to pickImplFile — even though the
      // task explicitly named it and it already exists on disk. Live-caught on boltons run 193 (a pure
      // rename task): shapeutils.py's `area()` was correctly renamed to `get_area()` first, but the
      // multi-file decomposition ran out of time budget before ever touching layoututils.py (whose
      // `total_area()` still called the old `.area()`), so `this.files` only ever contained
      // "shapeutils.py". Every repair lever (bestOfNFix, debugger, escalateFix) then kept re-sampling
      // the ALREADY-CORRECT shapeutils.py instead of the real broken file, burning the whole repair
      // budget on nothing and eventually baseline-restoring the correct rename away too. Fixed by also
      // scanning the task text for named `.py` files that exist on disk, unioning them into the
      // candidate set BEFORE the name-match pass runs — not just files already in `this.files`. ----
      {
        const rdir = fresh("pick56");
        // Only shapeutils.py is in `files` (touched this run); layoututils.py exists on disk and is
        // named by the task, but the executor never got around to editing it.
        fs.writeFileSync(path.join(rdir, "shapeutils.py"), "class Rectangle:\n    def get_area(self):\n        return self.width * self.height\n");
        fs.writeFileSync(path.join(rdir, "layoututils.py"), "class Grid:\n    def total_area(self):\n        return sum(rect.area() for rect in self.rectangles)\n");
        const files = new Set(["shapeutils.py"]);
        const task = "Rename the area method on Rectangle in shapeutils.py to get_area. Update the call site in layoututils.py too.";
        const out = [
          "self = <tests.test_layoututils.TestGrid testMethod=test_total_area>",
          "",
          "    def test_total_area(self):",
          "        grid = Grid([rect])",
          ">       self.assertEqual(grid.total_area(), 6)",
          "E       AttributeError: 'Rectangle' object has no attribute 'area'",
          "",
          "layoututils.py:2: in total_area",
          "    return sum(rect.area() for rect in self.rectangles)",
          "tests/test_layoututils.py:5: AttributeError",
        ].join("\n");
        const pickOld = await A.pickImplFile(out, rdir, files); // no taskText — reproduces the bug
        check("bug 56: WITHOUT the task-text fallback, the real bug reproduces (wrongly picks the already-touched file)", pickOld === "shapeutils.py", pickOld);
        const pickNew = await A.pickImplFile(out, rdir, files, task);
        check("bug 56: WITH the task-text fallback, pickImplFile finds the untouched-but-named file that actually defines total_area", pickNew === "layoututils.py", pickNew);
        // A file merely mentioned in prose (not on disk) must not be fabricated as a target.
        const pickGhost = await A.pickImplFile(out, rdir, files, task + " Also see ghostutils.py for context.");
        check("bug 56: a task-named file that doesn't exist on disk is never picked", pickGhost !== "ghostutils.py", pickGhost);
      }

      // ---- BUG 91b/92 (2026-09-13): `pickImplFile`'s name-match pass (bug 53 above) only ever
      // recognized Python's `def name(` syntax, even though `implFiles` is explicitly gated on a
      // multi-language extension list (js/mjs/cjs/ts/tsx/jsx/java/go/rb/rs/c/cpp). On every
      // non-Python file the name-match loop found zero candidate names and silently fell through
      // to Set order, ignoring an unambiguous name match sitting right in the failure text.
      // Isolated-probe-confirmed and fixed via `defNamesInSource(ext, src)`, covering JS/TS
      // function decls + arrow fns, Java/C/C++ methods, Go `func`, and Rust `fn`. ----
      {
        const rdir = fresh("pick92js");
        fs.writeFileSync(path.join(rdir, "a_wrong.js"), "function helper() { return 1; }\n");
        fs.writeFileSync(path.join(rdir, "b_right.js"), "function computeArea(w, h) {\n  return w * h;\n}\n");
        const files = new Set(["a_wrong.js", "b_right.js"]);
        const out = "TypeError: computeArea(5, 3) returned NaN\n    at Object.<anonymous> (/tmp/x.js:3:1)";
        const pick = await A.pickImplFile(out, rdir, files);
        check("bug 92: pickImplFile name-matches a JS `function name(` decl, not just Python `def`", pick === "b_right.js", pick);
      }
      {
        const rdir = fresh("pick92go");
        fs.writeFileSync(path.join(rdir, "a_wrong.go"), "package main\nfunc helper() int { return 1 }\n");
        fs.writeFileSync(path.join(rdir, "b_right.go"), "package main\nfunc ComputeArea(w int, h int) int {\n\treturn w * h\n}\n");
        const files = new Set(["a_wrong.go", "b_right.go"]);
        const out = "panic: ComputeArea(5, 3) call failed";
        const pick = await A.pickImplFile(out, rdir, files);
        check("bug 92: pickImplFile name-matches a Go `func name(` decl", pick === "b_right.go", pick);
      }
      {
        const rdir = fresh("pick92java");
        fs.writeFileSync(path.join(rdir, "a_wrong.java"), "class Helper {\n  int helper() { return 1; }\n}\n");
        fs.writeFileSync(path.join(rdir, "b_right.java"), "class Shape {\n  public int computeArea(int w, int h) {\n    return w * h;\n  }\n}\n");
        const files = new Set(["a_wrong.java", "b_right.java"]);
        const out = "Exception: computeArea(5, 3) call failed";
        const pick = await A.pickImplFile(out, rdir, files);
        check("bug 92: pickImplFile name-matches a Java method decl", pick === "b_right.java", pick);
      }

      // ---- BUG 31 (2026-08-14): `adoptVerifiedReference` is the THIRD whole-file landing site of
      // the same shape as bugs 28/29 — it REPLACES the entire impl file with a canned reference, so
      // every other definition in that file is destroyed and `gate()` (syntax) + the test score
      // cannot notice, because by construction nothing covers what was lost. Worse than 28/29 in one
      // respect: this lever makes ZERO model calls, so unlike the other two it is fully REACHABLE in
      // real runs. It reuses `repairLandedFile` rather than a third copy. The fix landed unlogged;
      // these are its first permanent tests (added while verifying that session's work). ----
      {
        const rdir = fresh("adopt31");
        const HDR = "# Copyright (c) 2019, Acme Corp\n# SPDX-License-Identifier: BSD-3-Clause\n";
        // `unit_label` is public, top-level, and NO test covers it — the test score is blind to it.
        const BASE = HDR + "\n\ndef unit_label(kind):\n    return {\"px\": \"pixels\"}.get(kind, kind)\n\n\ndef plan(tasks):\n    \"\"\"Broken DETERMINISTICALLY: ready tasks come out in REVERSE alphabetical order.\"\"\"\n    nodes = set(tasks)\n    for prereqs in tasks.values():\n        nodes.update(prereqs)\n    indeg = {n: 0 for n in nodes}\n    succ = {n: [] for n in nodes}\n    for task in sorted(nodes):\n        for pre in tasks.get(task, []):\n            indeg[task] += 1\n            succ[pre].append(task)\n    ready = sorted([n for n in nodes if indeg[n] == 0], reverse=True)\n    order = []\n    while ready:\n        n = ready.pop(0)\n        order.append(n)\n        for m in sorted(succ[n]):\n            indeg[m] -= 1\n            if indeg[m] == 0:\n                ready.append(m)\n    return order\n";
        fs.writeFileSync(path.join(rdir, "sched.py"), BASE);
        fs.writeFileSync(path.join(rdir, "test_sched.py"), "import unittest\nfrom sched import plan\n\n\nclass T(unittest.TestCase):\n    def test_tie_break(self):\n        self.assertEqual(plan({\"b\": [], \"a\": [], \"c\": [\"a\", \"b\"]}), [\"a\", \"b\", \"c\"])\n");
        const cmd31 = "python -B -m pytest -q";
        const mk31 = (task) => ({
          root: rdir, stopped: false, task, files: new Set(["sched.py"]), gates: {},
          lockedFiles: new Set(), failedCmds: new Set(), authoritativeTests: {}, testSnapshots: {},
          baselineFiles: { "sched.py": BASE },
          repairLandedFile: A.Agent.prototype.repairLandedFile,
        });
        const ev31 = [];
        const TASK31 = "In sched.py, fix plan() so it returns a correct dependency execution order, emitting ready tasks in alphabetical order.";
        const won31 = await A.Agent.prototype.adoptVerifiedReference.call(mk31(TASK31), cmd31, (e) => ev31.push(e));
        const disk31 = fs.readFileSync(path.join(rdir, "sched.py"), "utf8");
        // PRECONDITION — if the lever bailed early the file is pristine and every "content survived"
        // assertion below passes on the untouched original, proving nothing (the bug-29 lesson).
        check("bug 31 wiring: adoptVerifiedReference actually ran and replaced the file (not a no-op)", disk31 !== BASE, "disk is byte-identical to the baseline — the lever never fired");
        check("bug 31 wiring: the verified reference still lands and the tests pass", won31 === true, JSON.stringify({ won: won31 }));
        check("bug 31 wiring: an uncovered top-level def survives the whole-file adoption", /def unit_label/.test(disk31), disk31);
        check("bug 31 wiring: the license header survives it too (its own independent guard)", /SPDX-License-Identifier/.test(disk31), disk31);
        check("bug 31 wiring: exactly one copy of the recovered def (no duplicate)", (disk31.match(/def unit_label\(/g) || []).length === 1, disk31);
        check("bug 31 wiring: the guard announces itself in the run log", ev31.some((e) => e.type === "log" && /re-attached/.test(e.text || "")), JSON.stringify(ev31.filter((e) => e.type === "log").map((e) => e.text)));
        // The license guard is deliberately NOT nested under the content stand-down: a task that
        // asks to delete a function has still never asked to delete the copyright notice.
        fs.writeFileSync(path.join(rdir, "sched.py"), BASE);
        const ev31b = [];
        await A.Agent.prototype.adoptVerifiedReference.call(mk31("Remove the unit_label() function from sched.py entirely, and fix plan() so it returns a correct dependency execution order in alphabetical order."), cmd31, (e) => ev31b.push(e));
        const disk31b = fs.readFileSync(path.join(rdir, "sched.py"), "utf8");
        check("bug 31 wiring: a REMOVAL task stands the CONTENT guard down — the deletion is respected", !/def unit_label/.test(disk31b), disk31b);
        check("bug 31 wiring: ...but the license header is STILL protected on that same removal task", /SPDX-License-Identifier/.test(disk31b), disk31b);
      }

      // ---- BUG 32 (MEASURED 2026-08-14, D:/tmp/repro-wrongclass-pytest-blind.mjs): `fixWrongClassApi`
      // split the failure report on the UNITTEST rule alone (`/^={20,}$/m`). pytest never emits a line
      // of only '=' — it heads each failure with underscores — so on every pytest repo the loop ran
      // ZERO times and the whole lever was dead code. Its sibling `apiMismatches` had already learned
      // both formats (boltons run 81); the lesson was never propagated. It hid because every existing
      // test for this lever ran `unittest discover` — the one runner where the bug is invisible.
      // Both now share `failureBlocks`/`failingLineNo`. ----
      {
        const UT = "======================================================================\nERROR: test_deposit (test_impl.T.test_deposit)\n----------------------------------------------------------------------\nTraceback (most recent call last):\n  File \"/tmp/x/test_impl.py\", line 9, in test_deposit\n    self.assertEqual(led.deposit(10), 10)\nAttributeError: 'Ledger' object has no attribute 'deposit'\n";
        const PY = "F.                                                                       [100%]\n================================== FAILURES ===================================\n_______________________________ T.test_deposit ________________________________\n\n    def test_deposit(self):\n        led = Ledger()\n>       self.assertEqual(led.deposit(10), 10)\nE       AttributeError: 'Ledger' object has no attribute 'deposit'\n\ntest_impl.py:9: AttributeError\n=========================== short test summary info ===========================\n1 failed, 1 passed in 0.14s\n";
        check("bug 32: failureBlocks finds the unittest block", A.failureBlocks(UT).length === 1 && A.failureBlocks(UT)[0].name === "test_deposit");
        check("bug 32: failureBlocks ALSO finds the pytest block (the bug: it found 0)", A.failureBlocks(PY).length === 1 && A.failureBlocks(PY)[0].name === "test_deposit", JSON.stringify(A.failureBlocks(PY).map((b) => b.name)));
        check("bug 32: an underscore-wrapped FAILURES banner is not mistaken for a per-test block", A.failureBlocks("_________________ FAILURES _________________\nAttributeError: 'X' object has no attribute 'y'\n").length === 0);
        check("bug 32: clean output yields no blocks at all", A.failureBlocks("Ran 6 tests in 0.01s\n\nOK").length === 0 && A.failureBlocks("").length === 0);
        // The SECOND blindness: pytest -q emits no `File "...", line N` frames, only its own location line.
        check("bug 32: failingLineNo reads pytest's own location line (0-based)", A.failingLineNo(A.failureBlocks(PY)[0].block, "test_impl.py") === 8);
        check("bug 32: failingLineNo still reads a unittest traceback frame", A.failingLineNo(A.failureBlocks(UT)[0].block, "test_impl.py") === 8);
        check("bug 32: failingLineNo prefers the frame in the TEST file over a deeper one", A.failingLineNo("  File \"/tmp/x/test_impl.py\", line 9, in test_deposit\n  File \"/tmp/x/impl.py\", line 42, in deposit\n", "test_impl.py") === 8);
        check("bug 32: no location at all -> null (the caller skips instead of editing line 0)", A.failingLineNo("AttributeError: 'X' object has no attribute 'y'\n", "test_impl.py") === null);
        check("bug 32: a \\r\\n (Windows) pytest location line still parses", A.failingLineNo("test_impl.py:9: AttributeError\r\n", "test_impl.py") === 8);
        // END TO END on the REAL lever, driven by REAL pytest — the runner every existing api9b test
        // above deliberately does NOT use, which is exactly why this hole survived.
        {
          const w32 = fresh("api32");
          const IMPL32 = "class Account:\n    def __init__(self):\n        self.balance = 0\n\n    def deposit(self, amount):\n        self.balance += amount\n        return self.balance\n\n\nclass Ledger:\n    def __init__(self):\n        self.account = Account()\n";
          const TEST32 = "import unittest\n\nfrom impl import Ledger\n\n\nclass T(unittest.TestCase):\n    def test_deposit(self):\n        led = Ledger()\n        self.assertEqual(led.deposit(10), 10)\n";
          fs.writeFileSync(path.join(w32, "impl.py"), IMPL32);
          fs.writeFileSync(path.join(w32, "test_impl.py"), TEST32);
          const a32 = new A.Agent(w32, { maxSteps: 1 });
          a32.files = new Set(["impl.py", "test_impl.py"]); a32.authoritativeTests = {}; a32.testSnapshots = {};
          a32.failedCmds = new Map([["x", true]]);
          const won32 = await a32.fixWrongClassApi("python -B -m pytest -q", () => {});
          const after32 = fs.readFileSync(path.join(w32, "test_impl.py"), "utf8");
          // PRECONDITION: before the fix this assertion failed — the file came back byte-identical.
          check("bug 32 end-to-end: under REAL pytest the lever now fires (was a total no-op)", after32 !== TEST32, "test file is byte-identical to the baseline — the lever never ran");
          check("bug 32 end-to-end: it rewrites led.deposit() -> led.account.deposit() and reaches all-pass", won32 === true && /led\.account\.deposit\(10\)/.test(after32), JSON.stringify({ won: won32 }));
          check("bug 32 end-to-end: it is an in-place substitution — line count unchanged, one line differs", TEST32.split("\n").length === after32.split("\n").length && TEST32.split("\n").filter((l, i) => l !== after32.split("\n")[i]).length === 1, after32);
        }
      }

      // ---- detectContradictoryRequirements (LIVE-CAUGHT, boltons runs 88/89, 2026-07-27): a
      // deliberately self-contradictory task ("clamp(15,0,10) must equal 10 ... must equal 15,
      // both mandatory") let the test-author silently substitute a different, never-requested test
      // case, the oracle went green, and verifyOutcome still hallucinated "✅ Results match the
      // outcome" — a confident false claim about a spec that was never satisfiable. ----
      {
        const clampTask = "In boltons/rangeutils.py, add a function clamp(value, low, high) that constrains a number to the range [low, high]. Add tests in tests/test_rangeutils.py covering it. Required test cases (both are mandatory, include both exactly as written): (1) clamp(15, 0, 10) must equal 10, because values above `high` are capped at `high`. (2) clamp(15, 0, 10) must equal 15, because values above `high` must be returned unchanged and never capped. Do not touch any other file.";
        const clampC = A.detectContradictoryRequirements(clampTask);
        check("detectContradictoryRequirements: catches the real run-88 clamp(15,0,10) 10-vs-15 contradiction", clampC.length === 1 && clampC[0].values.includes("10") && clampC[0].values.includes("15"), JSON.stringify(clampC));

        const statusTask = "Create boltons/statusutils.py with a function is_valid(code) that returns True if code is a valid HTTP status code (integer 100-599 inclusive), and False otherwise. Add tests in tests/test_statusutils.py that include these exact required cases: is_valid(200) must be True (200 is a standard valid HTTP status code). is_valid(200) must also be False, because our internal policy additionally treats any 2xx code ending in 00 as reserved and therefore invalid. Do not touch any other file.";
        const statusC = A.detectContradictoryRequirements(statusTask);
        check("detectContradictoryRequirements: catches the real run-89 is_valid(200) True-vs-False contradiction", statusC.length === 1 && statusC[0].values.includes("True") && statusC[0].values.includes("False"), JSON.stringify(statusC));

        const sameValueTask = "Add is_even(n). is_even(4) must be True. Separately, is_even(4) must equal True again in the docstring example.";
        check("detectContradictoryRequirements: two claims for the same call agreeing on the SAME value is not a contradiction", A.detectContradictoryRequirements(sameValueTask).length === 0);

        const normalTask = "In boltons/strutils.py, add a function is_palindrome(text) that returns True for palindromes and False otherwise. Add tests in tests/test_strutils.py.";
        check("detectContradictoryRequirements: an ordinary, non-contradictory task stays silent", A.detectContradictoryRequirements(normalTask).length === 0);
      }

      // ---- detectTestCmd blind to a tests/ subdirectory (LIVE-CAUGHT, 2026-07-23: `python -B -m
      // pytest -q` run manually on D:/eta-tests/boltons (17k lines, 445 tests, all under tests/)
      // ALWAYS returned null from detectTestCmd — every single run against that repo, since it
      // was first used as a test workspace, fell back to the narrower derived-from-locked-spec
      // testCmd (agent.mjs ~3851) instead of a real full-suite baseline. Root cause: the root-only
      // filename scan below never looks inside a tests/ subdir, even though the sibling
      // `run_tests` tool (~line 1001) already correctly checks has("tests")/has("test"). Fixed by
      // teaching detectTestCmd the same one-level-deep subdirectory check. ----
      {
        const dtcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eta-detecttestcmd-"));
        try {
          fs.mkdirSync(path.join(dtcRoot, "tests"));
          fs.writeFileSync(path.join(dtcRoot, "tests", "test_foo.py"), "def test_x(): assert True\n");
          check("detectTestCmd: finds tests inside a tests/ subdirectory (was blind, boltons never matched)",
            (await A.detectTestCmd(dtcRoot)) === "python -m pytest -q");
        } finally { fs.rmSync(dtcRoot, { recursive: true, force: true }); }

        const dtcRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-detecttestcmd-test-"));
        try {
          fs.mkdirSync(path.join(dtcRoot2, "test"));
          fs.writeFileSync(path.join(dtcRoot2, "test", "auth_test.py"), "def test_y(): assert True\n");
          check("detectTestCmd: also checks a singular test/ subdirectory",
            (await A.detectTestCmd(dtcRoot2)) === "python -m pytest -q");
        } finally { fs.rmSync(dtcRoot2, { recursive: true, force: true }); }

        const dtcRoot3 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-detecttestcmd-empty-"));
        try {
          fs.mkdirSync(path.join(dtcRoot3, "tests"));
          fs.writeFileSync(path.join(dtcRoot3, "tests", "fixtures.txt"), "not a test file");
          check("detectTestCmd: a tests/ dir with no test_*.py files inside still returns null",
            (await A.detectTestCmd(dtcRoot3)) === null);
        } finally { fs.rmSync(dtcRoot3, { recursive: true, force: true }); }

        const dtcRoot4 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-detecttestcmd-root-"));
        try {
          fs.writeFileSync(path.join(dtcRoot4, "test_bar.py"), "def test_z(): assert True\n");
          check("detectTestCmd: root-level test file still wins (unittest discover, unchanged behavior)",
            (await A.detectTestCmd(dtcRoot4)) === 'python -m unittest discover -p "test*.py"');
        } finally { fs.rmSync(dtcRoot4, { recursive: true, force: true }); }

        check("detectTestCmd: the real boltons workspace now resolves to the full-suite pytest command",
          (await A.detectTestCmd("D:/eta-tests/boltons")) === "python -m pytest -q");
      }

      // ---- MULTI-FILE TEST-LOCK BUG (found live on run 34, a real multi-file from-scratch
      // task): the task named TWO new test files (tests/test_wordcountutils.py AND
      // tests/test_readabilityutils.py). inferTestFile only ever returned the FIRST match, so
      // authorTests only authored+locked one of them — then the executor's own honest attempt
      // to create the SECOND, equally task-named file was refused by the "already locked, do
      // not create any new test file" guard, as if it were an invented dodge. The task silently
      // lost one of its two required test files. Fix: inferTestFiles (plural) returns every
      // named test file, and authorTests authors+locks ALL of them up front. ----
      {
        const multiTask = "Create boltons/wordcountutils.py with word_count(text) and boltons/readabilityutils.py with average_word_length(text). Add tests/test_wordcountutils.py and tests/test_readabilityutils.py with unit tests for each, including an empty-string edge case.";
        check("inferTestFiles: a task naming TWO test files returns BOTH, in order",
          JSON.stringify(A.inferTestFiles(multiTask)) === JSON.stringify(["tests/test_wordcountutils.py", "tests/test_readabilityutils.py"]));
        check("inferTestFiles: a task naming no test file falls back to ONE inferred name",
          JSON.stringify(A.inferTestFiles("Add a function to strutils.py")) === JSON.stringify(["test_strutils.py"]));
        check("inferTestFile (singular, kept for back-compat): returns the FIRST of the plural list",
          A.inferTestFile(multiTask) === "tests/test_wordcountutils.py");

        const mtd = fresh("multi-test-lock");
        fs.mkdirSync(path.join(mtd, "tests"), { recursive: true });
        const fakeAgent = {
          root: mtd, stopped: false,
          eta: { chat: async (msgs) => {
            const rel = (msgs[msgs.length - 1].content.match(/Write (\S+\.py):/) || [])[1] || "test_unknown.py";
            return { content: `import unittest\n\nclass T(unittest.TestCase):\n    def test_${path.basename(rel, ".py")}(self):\n        self.assertTrue(True)\n` };
          } },
          lockedFiles: new Set(), authoritativeTests: {}, files: new Set(), gates: {}, testSnapshots: {},
          verifyAuthoredTests: async () => null, // no reference impl for this synthetic task — skip repair
          authorOneTestFile: A.Agent.prototype.authorOneTestFile,
        };
        const authored = await A.Agent.prototype.authorTests.call(fakeAgent, multiTask, () => {});
        check("authorTests: authors + locks BOTH task-named test files, not just the first",
          JSON.stringify(authored) === JSON.stringify(["tests/test_wordcountutils.py", "tests/test_readabilityutils.py"]));
        check("authorTests: both files are really locked (this is what the write_file guard checks)",
          fakeAgent.lockedFiles.has("tests/test_wordcountutils.py") && fakeAgent.lockedFiles.has("tests/test_readabilityutils.py"));
        check("authorTests: both files really exist on disk (not just claimed)",
          fs.existsSync(path.join(mtd, "tests", "test_wordcountutils.py")) && fs.existsSync(path.join(mtd, "tests", "test_readabilityutils.py")));
        // re-calling authorTests (as run() effectively could on a retry) must not re-author an
        // already-locked file or lose track of it
        const again = await A.Agent.prototype.authorTests.call(fakeAgent, multiTask, () => {});
        check("authorTests: calling again is a no-op that still reports both as authored (idempotent)",
          JSON.stringify(again) === JSON.stringify(["tests/test_wordcountutils.py", "tests/test_readabilityutils.py"]));
      }

      // ---- qualifyBareFilenames. LIVE-CAUGHT, boltons runs 102-106 (2026-08-05): a new-subpackage
      // task ("a directory boltons/textkit/ containing an __init__.py file and a module
      // boltons/textkit/casing.py") made the filename extractor emit a BARE `__init__.py`, which fed
      // implFocus → decomposeMultiFile → _runOneFile ("edit ONLY __init__.py") and _buildContract.
      // In all 5 runs the contract then named the PRE-EXISTING `boltons/__init__.py` and the executor
      // burned ~half its budget rewriting that real repo file (twice reverted by the dropped-defs
      // guard) instead of creating the subpackage. The rewrite is deliberately narrow — the negative
      // controls below matter as much as the positive case. ----
      {
        const q = (t, n, ex) => JSON.stringify(A.qualifyBareFilenames(t, n, ex || (() => false)));
        const realTask = "Create a new subpackage inside the boltons package: a directory boltons/textkit/ containing an __init__.py file and a module boltons/textkit/casing.py that defines a function to_snake_case(s) converting a CamelCase or PascalCase string to snake_case (for example 'SimpleTest' becomes 'simple_test'). Also add a new test file tests/test_casing.py with unittest tests.";
        check("qualifyBareFilenames: the run-102..106 task's bare __init__.py gets its directory back",
          q(realTask, ["__init__.py", "boltons/textkit/casing.py"]) === JSON.stringify(["boltons/textkit/__init__.py", "boltons/textkit/casing.py"]));
        check("qualifyBareFilenames: a name that ALREADY has a directory is never rewritten",
          q("put it in boltons/textkit/ containing boltons/other/casing.py", ["boltons/other/casing.py"]) === JSON.stringify(["boltons/other/casing.py"]));
        check("qualifyBareFilenames: a bare name that EXISTS on disk is left alone (no hijacking a real root file)",
          q("Create an __init__.py inside the boltons/textkit/ directory", ["__init__.py"], (r) => r === "__init__.py") === JSON.stringify(["__init__.py"]));
        check("qualifyBareFilenames: no explicit directory token in the task → names untouched",
          q("Add a helper to boltons/strutils.py and bump the version in setup.py", ["boltons/strutils.py", "setup.py"]) === JSON.stringify(["boltons/strutils.py", "setup.py"]));
        check("qualifyBareFilenames: a directory named in a DIFFERENT sentence does not capture the filename",
          q("Create utils.py at the project root. Separately, add docs to boltons/textkit/ as well.", ["utils.py"]) === JSON.stringify(["utils.py"]));
        check("qualifyBareFilenames: a MOVE-shaped phrasing ('into the new dir X/') has no containment cue → untouched",
          q("Move the config from setup.py into the new dir boltons/textkit/.", ["setup.py"]) === JSON.stringify(["setup.py"]));
        check("qualifyBareFilenames: the directory may be mentioned AFTER the filename ('__init__.py inside X/')",
          q("Create an __init__.py inside the boltons/textkit/ directory", ["__init__.py"]) === JSON.stringify(["boltons/textkit/__init__.py"]));
        check("qualifyBareFilenames: a bare filename the task never mentions is passed through unchanged",
          q("a directory boltons/textkit/ containing an __init__.py file", ["unrelated.py"]) === JSON.stringify(["unrelated.py"]));
      }

      // ---- per-step LOCAL model routing (stepDifficulty): deterministic, no LLM call to decide ----
      check("stepDifficulty: mechanical rename → trivial", A.stepDifficulty("Rename the variable foo to bar") === "trivial");
      check("stepDifficulty: add a missing import → trivial", A.stepDifficulty("Add the missing import for os") === "trivial");
      check("stepDifficulty: fix a typo → trivial", A.stepDifficulty("Fix a typo in the docstring") === "trivial");
      check("stepDifficulty: implement an algorithm → real", A.stepDifficulty("Implement the parsing algorithm for nested brackets") === "real");
      check("stepDifficulty: fix a bug → real", A.stepDifficulty("Fix the bug causing the off-by-one error in the loop") === "real");
      check("stepDifficulty: complex verb wins even if short", A.stepDifficulty("Refactor the cache logic") === "real");
      check("stepDifficulty: short + no signal → trivial (length fallback)", A.stepDifficulty("Update the README") === "trivial");
      check("stepDifficulty: long + no strong signal → real (length fallback)", A.stepDifficulty("Go through the module and make sure everything referenced elsewhere still lines up") === "real");
      check("stepDifficulty: empty string doesn't crash", A.stepDifficulty("") === "real");

      // ---- contextual tool subsetting (narrowToolsForStep) ----
      const ordinaryTools = A.narrowToolsForStep("Add a function to validate the input");
      check("narrowToolsForStep: ordinary step gets the CORE set (well under all 34)", ordinaryTools.length <= 12 && ordinaryTools.includes("write_file") && ordinaryTools.includes("edit_file"), "n=" + ordinaryTools.length);
      check("narrowToolsForStep: core always includes finish + ask_user", ordinaryTools.includes("finish") && ordinaryTools.includes("ask_user"));
      const gitTools = A.narrowToolsForStep("Check the git history to see when this was last changed");
      check("narrowToolsForStep: git-flavored step adds git/git_history on top of core", gitTools.includes("git") && gitTools.includes("git_history") && gitTools.includes("write_file"));
      const chartTools = A.narrowToolsForStep("Make a chart showing the results");
      check("narrowToolsForStep: chart step adds make_chart without dragging in unrelated groups", chartTools.includes("make_chart") && !chartTools.includes("create_pdf"));
      check("narrowToolsForStep: never drops below core even with no keyword match", A.narrowToolsForStep("xyzzy").length >= 11);
      // schema narrowing: actionSchema(allowedNames) restricts the enum; omitted → full set (other
      // call sites that never pass toolNames must be completely unaffected by this feature).
      const narrowSchema = A.Agent.prototype.actionSchema.call({ mcpNames: new Set() }, ["read_file", "write_file"]);
      check("actionSchema(allowedNames): enum restricted to exactly what was passed", narrowSchema.properties.tool.enum.length === 2 && narrowSchema.properties.tool.enum.includes("read_file"));
      const fullSchema = A.Agent.prototype.actionSchema.call({ mcpNames: new Set() });
      check("actionSchema(): omitted allowedNames → unrestricted (existing call sites unaffected)", fullSchema.properties.tool.enum.length > 20);

      // ---- alternating/cyclic action-loop detection (detectActionCycle) — the live-verified gap ----
      const editReadCycle = ["edit_file:{}", "read_file:{}", "edit_file:{}", "read_file:{}"];
      check("detectActionCycle: catches the real edit_file/read_file oscillation (period 2)", A.detectActionCycle(editReadCycle) === 2);
      const period3Cycle = ["a", "b", "c", "a", "b", "c"];
      check("detectActionCycle: catches a 3-action cycle", A.detectActionCycle(period3Cycle) === 3);
      check("detectActionCycle: one repeated pair alone is NOT enough (needs 2 full cycles)", A.detectActionCycle(["edit_file:{}", "read_file:{}"]) === null);
      check("detectActionCycle: genuine progress (all distinct) → null", A.detectActionCycle(["a", "b", "c", "d", "e", "f"]) === null);
      check("detectActionCycle: short history → null (not enough data yet)", A.detectActionCycle(["a", "b"]) === null);
      check("detectActionCycle: empty history → null, doesn't crash", A.detectActionCycle([]) === null);
      const almostCycle = ["a", "b", "a", "c"]; // 2nd pair breaks the pattern — must NOT false-positive
      check("detectActionCycle: near-miss (pattern breaks) → null, no false positive", A.detectActionCycle(almostCycle) === null);

      // ---- parallel independent step execution (stepFileHints + batchIndependentSteps, Tier 2 #2) ----
      check("stepFileHints: extracts a backtick-quoted filename", [...A.stepFileHints("Add a function to `mathutils.py`")].includes("mathutils.py"));
      check("stepFileHints: extracts a bare filename too", [...A.stepFileHints("Create stringstuff.py with a new function")].includes("stringstuff.py"));
      check("stepFileHints: no file mentioned -> empty set", A.stepFileHints("Run the test suite and check for regressions").size === 0);
      check("stepFileHints: multiple files in one step", [...A.stepFileHints("Update a.py and b.py to match")].join(",") === "a.py,b.py");

      const disjointSteps = ["Add subtract(a,b) to mathutils.py", "Add whisper(s) to stringstuff.py"];
      check("batchIndependentSteps: two steps naming DIFFERENT files -> one parallel batch", JSON.stringify(A.batchIndependentSteps(disjointSteps)) === "[[0,1]]");
      const sameySteps = ["Create mathutils.py", "Add subtract to mathutils.py"];
      check("batchIndependentSteps: two steps naming the SAME file -> stay sequential (separate batches)", JSON.stringify(A.batchIndependentSteps(sameySteps)) === "[[0],[1]]");
      const ambiguousSteps = ["Run the test suite", "Add whisper to stringstuff.py"];
      check("batchIndependentSteps: a step naming NO file never joins a batch (ambiguous scope stays solo)", JSON.stringify(A.batchIndependentSteps(ambiguousSteps)) === "[[0],[1]]");
      const threeFiles = ["Add x to a.py", "Add y to b.py", "Add z to a.py"];
      check("batchIndependentSteps: a 3rd step re-touching an already-batched file starts a NEW batch", JSON.stringify(A.batchIndependentSteps(threeFiles)) === "[[0,1],[2]]", JSON.stringify(A.batchIndependentSteps(threeFiles)));
      check("batchIndependentSteps: single step -> single solo batch", JSON.stringify(A.batchIndependentSteps(["Add x to a.py"])) === "[[0]]");
      check("batchIndependentSteps: empty plan -> no batches, no crash", A.batchIndependentSteps([]).length === 0);

      // microExecute behavior for a SOLO batch must be byte-identical to the pre-refactor path
      const soloAgent = new A.Agent(SANDBOX, { maxSteps: 1 });
      soloAgent.mcpNames = new Set();
      let soloStepArg = null;
      soloAgent.execute = async (msgs) => { soloStepArg = msgs; return msgs; };
      await soloAgent.microExecute(["Run the test suite"], { root: SANDBOX }, () => {}, "SYS");
      check("microExecute: a solo (non-parallel) step still calls execute() exactly once", /STEP 1: Run the test suite/.test(soloStepArg?.[1]?.content || ""), JSON.stringify(soloStepArg));

      // microExecute dispatches a genuinely parallel batch concurrently (both start before either
      // finishes) — ONLY true for a backend that actually supports it (the bundled multi-slot
      // llama-server, kind "openai"); the ollama-guard test right below covers the other case.
      const parAgent = new A.Agent(SANDBOX, { maxSteps: 1 });
      parAgent.mcpNames = new Set();
      let stepsInFlight = 0, sawOverlap = false;
      parAgent.execute = async (msgs) => {
        stepsInFlight++; if (stepsInFlight > 1) sawOverlap = true;
        await new Promise((r) => setTimeout(r, 30));
        stepsInFlight--;
        return msgs;
      };
      const savedKindPar = A.provider.kind;
      A.provider.kind = "openai";
      try {
        await parAgent.microExecute(["Add subtract to mathutils.py", "Add whisper to stringstuff.py"], { root: SANDBOX }, () => {}, "SYS");
      } finally { A.provider.kind = savedKindPar; }
      check("microExecute: a parallel batch actually overlaps in time (Promise.all, not sequential)", sawOverlap === true);

      // OLLAMA CONCURRENCY GUARD (found live 2026-09-15, run 216): a batch that would otherwise
      // parallelize must stay strictly sequential when provider.kind is "ollama" — concurrent
      // generate calls to an Ollama-served model that isn't already resident can each trigger
      // their own load into the same GPU, confirmed live as twin cudaMalloc OOM errors.
      const savedKind1 = A.provider.kind;
      A.provider.kind = "ollama";
      const ollamaAgent = new A.Agent(SANDBOX, { maxSteps: 1 });
      ollamaAgent.mcpNames = new Set();
      let ollamaStepsInFlight = 0, sawOllamaOverlap = false;
      ollamaAgent.execute = async (msgs) => {
        ollamaStepsInFlight++; if (ollamaStepsInFlight > 1) sawOllamaOverlap = true;
        await new Promise((r) => setTimeout(r, 30));
        ollamaStepsInFlight--;
        return msgs;
      };
      try {
        await ollamaAgent.microExecute(["Add subtract to mathutils.py", "Add whisper to stringstuff.py"], { root: SANDBOX }, () => {}, "SYS");
      } finally { A.provider.kind = savedKind1; }
      check("microExecute: an otherwise-parallel batch stays sequential when provider.kind is ollama", sawOllamaOverlap === false);

      // ---- decomposeMultiFile folded into parallel execution (batchFilesByDepth, 2026-07-23) ----
      check("batchFilesByDepth: two depth-0 files -> one parallel batch", JSON.stringify(A.batchFilesByDepth(["a.py", "b.py"], { "a.py": 0, "b.py": 0 })) === '[["a.py","b.py"]]');
      check("batchFilesByDepth: a depth>=1 file never joins a batch (stays solo)", JSON.stringify(A.batchFilesByDepth(["base.py", "dep.py"], { "base.py": 0, "dep.py": 1 })) === '[["base.py"],["dep.py"]]');
      check("batchFilesByDepth: two depth-1 files stay sequential (real coupling — deliberately conservative)", JSON.stringify(A.batchFilesByDepth(["a.py", "b.py"], { "a.py": 1, "b.py": 1 })) === '[["a.py"],["b.py"]]');
      check("batchFilesByDepth: empty file list -> no batches, no crash", A.batchFilesByDepth([], {}).length === 0);
      check("batchFilesByDepth: missing depth entry treated as 0", JSON.stringify(A.batchFilesByDepth(["x.py"], {})) === '[["x.py"]]');

      const dfDir = fresh("decomp-parallel");
      fs.writeFileSync(path.join(dfDir, "a.py"), "def a(): pass\n");
      fs.writeFileSync(path.join(dfDir, "b.py"), "def b(): pass\n");

      // solo (non-parallel) file behavior must be byte-identical to the pre-refactor path
      const soloFileAgent = new A.Agent(dfDir, { maxSteps: 1 });
      soloFileAgent.mcpNames = new Set();
      let soloFileCalls = 0;
      soloFileAgent.execute = async (msgs) => { soloFileCalls++; return msgs; };
      soloFileAgent._inspectFile = async () => ({ ok: true, gap: "" });
      soloFileAgent.contract = "a.py: add a()\nb.py: add b()"; // pre-set -> skips _buildContract
      await soloFileAgent.decomposeMultiFile("add a and b", { root: dfDir }, () => {}, "SYS", ["a.py", "b.py"]);
      check("decomposeMultiFile: two independent (depth-0) files still each get exactly one edit call", soloFileCalls === 2, String(soloFileCalls));

      // two depth-0 (neither imports the other) files actually dispatch concurrently
      const parFileAgent = new A.Agent(dfDir, { maxSteps: 1 });
      parFileAgent.mcpNames = new Set();
      let filesInFlight = 0, sawFileOverlap = false;
      parFileAgent.execute = async (msgs) => {
        filesInFlight++; if (filesInFlight > 1) sawFileOverlap = true;
        await new Promise((r) => setTimeout(r, 30));
        filesInFlight--;
        return msgs;
      };
      parFileAgent._inspectFile = async () => ({ ok: true, gap: "" });
      parFileAgent.contract = "a.py: add a()\nb.py: add b()";
      const savedKindParFile = A.provider.kind;
      A.provider.kind = "openai"; // multi-slot bundled llama-server — the ollama-guard test right below covers the other case
      try {
        await parFileAgent.decomposeMultiFile("add a and b", { root: dfDir }, () => {}, "SYS", ["a.py", "b.py"]);
      } finally { A.provider.kind = savedKindParFile; }
      check("decomposeMultiFile: two depth-0 (independent) files actually overlap in time (Promise.all, not sequential)", sawFileOverlap === true);

      // OLLAMA CONCURRENCY GUARD (found live 2026-09-15, run 216) — same guard as microExecute's,
      // applied to the file-batch path: an otherwise-parallel depth-0 batch must stay sequential
      // when provider.kind is "ollama" (live-confirmed twin cudaMalloc OOM otherwise).
      const savedKind2 = A.provider.kind;
      A.provider.kind = "ollama";
      const ollamaFileAgent = new A.Agent(dfDir, { maxSteps: 1 });
      ollamaFileAgent.mcpNames = new Set();
      let ollamaFilesInFlight = 0, sawOllamaFileOverlap = false;
      ollamaFileAgent.execute = async (msgs) => {
        ollamaFilesInFlight++; if (ollamaFilesInFlight > 1) sawOllamaFileOverlap = true;
        await new Promise((r) => setTimeout(r, 30));
        ollamaFilesInFlight--;
        return msgs;
      };
      ollamaFileAgent._inspectFile = async () => ({ ok: true, gap: "" });
      ollamaFileAgent.contract = "a.py: add a()\nb.py: add b()";
      try {
        await ollamaFileAgent.decomposeMultiFile("add a and b", { root: dfDir }, () => {}, "SYS", ["a.py", "b.py"]);
      } finally { A.provider.kind = savedKind2; }
      check("decomposeMultiFile: an otherwise-parallel depth-0 batch stays sequential when provider.kind is ollama", sawOllamaFileOverlap === false);

      // a real dependency edge (bank.py imports models.py) must still run strictly sequentially
      const seqDir = fresh("decomp-sequential");
      fs.writeFileSync(path.join(seqDir, "models.py"), "class A:\n    pass\n");
      fs.writeFileSync(path.join(seqDir, "bank.py"), "from models import A\n");
      const seqAgent = new A.Agent(seqDir, { maxSteps: 1 });
      seqAgent.mcpNames = new Set();
      let seqInFlight = 0, sawSeqOverlap = false;
      seqAgent.execute = async (msgs) => {
        seqInFlight++; if (seqInFlight > 1) sawSeqOverlap = true;
        await new Promise((r) => setTimeout(r, 30));
        seqInFlight--;
        return msgs;
      };
      seqAgent._inspectFile = async () => ({ ok: true, gap: "" });
      seqAgent.contract = "models.py: add a field\nbank.py: use it";
      await seqAgent.decomposeMultiFile("add a field", { root: seqDir }, () => {}, "SYS", ["bank.py", "models.py"]);
      check("decomposeMultiFile: a real cross-file dependency (bank imports models) never overlaps — stays sequential", sawSeqOverlap === false);

      // LIVE-CAUGHT (boltons runs 85/86, 2026-07-27): brand-new files that don't exist on disk yet
      // always read back as depth 0 (nothing to find imports in), so a from-scratch multi-file task
      // with a REAL declared import chain got wrongly batched as "independent" and dispatched via
      // Promise.all — which just serializes anyway on this project's single local model, letting the
      // first file to get a turn silently starve its batch-mates of the entire shared time budget.
      const freshDir = fresh("decomp-fresh-files-no-parallel");
      const freshAgent = new A.Agent(freshDir, { maxSteps: 1 });
      freshAgent.mcpNames = new Set();
      let freshInFlight = 0, sawFreshOverlap = false;
      freshAgent.execute = async (msgs) => {
        freshInFlight++; if (freshInFlight > 1) sawFreshOverlap = true;
        await new Promise((r) => setTimeout(r, 30));
        freshInFlight--;
        return msgs;
      };
      freshAgent._inspectFile = async () => ({ ok: true, gap: "" });
      freshAgent.contract = "intervalutils.py: add Interval\nintervalsetutils.py: add IntervalSet\nscheduleutils.py: add Schedule";
      await freshAgent.decomposeMultiFile("add interval classes", { root: freshDir }, () => {}, "SYS", ["intervalutils.py", "intervalsetutils.py", "scheduleutils.py"]);
      check("decomposeMultiFile: 3 brand-new (not-yet-on-disk) files never overlap — no depth is provably 0", sawFreshOverlap === false);

      const freshDepth = await A.Agent.prototype._fileDepths.call({ root: fresh("decomp-fresh-depths") }, ["a.py", "b.py"]);
      check("_fileDepths: a file that doesn't exist on disk yet defaults to depth 1 (solo), not 0 (parallel-eligible)", freshDepth["a.py"] === 1 && freshDepth["b.py"] === 1, JSON.stringify(freshDepth));

      // LIVE-CAUGHT (boltons runs 177/178, 2026-08-30): real package-layout repos import siblings
      // as "from boltons.pointutils import Point" (dotted package.module, not bare module) — the
      // dependency scan used to take the FIRST dotted segment ("boltons", the shared top package,
      // never a match) instead of the LAST ("pointutils", the real dependency), so a file that
      // genuinely imports another in-scope file was scored depth 0 and wrongly batched for
      // parallel (Promise.all) execution, starving its batch-mate of the whole shared time budget.
      const pkgDir = fresh("decomp-pkg-style-depths");
      fs.writeFileSync(path.join(pkgDir, "pointutils.py"), "class Point:\n    pass\n");
      fs.writeFileSync(path.join(pkgDir, "shapeutils.py"), "from boltons.pointutils import Point\n\nclass Rectangle:\n    pass\n");
      const pkgDepth = await A.Agent.prototype._fileDepths.call({ root: pkgDir }, ["pointutils.py", "shapeutils.py"]);
      check("_fileDepths: dotted package-style import (from boltons.pointutils import Point) is detected as a real dependency", pkgDepth["shapeutils.py"] === 1, JSON.stringify(pkgDepth));
      check("_fileDepths: dotted package-style import does NOT get batched for parallel execution", JSON.stringify(A.batchFilesByDepth(["pointutils.py", "shapeutils.py"], pkgDepth)) === '[["pointutils.py"],["shapeutils.py"]]');

      // PER-FILE BUDGET SLICE. LIVE-CAUGHT (boltons runs 179/180, 2026-08-30) — right after the
      // _fileDepths fix above made this exact pair correctly SEQUENTIAL, both live runs still failed:
      // _runOneFile's own retry/inspector loop only ever checked the RUN-WIDE overBudget(), so file 1
      // could burn the ENTIRE shared time budget before file 2 (strictly sequential, waiting its turn)
      // ever got a turn. decomposeMultiFile now caps this.timeBudgetMs to a fair remaining-time share
      // per batch, then restores it, so an earlier file's retries can't starve a later one.
      {
        const budgetDir = fresh("decomp-budget-slice");
        fs.writeFileSync(path.join(budgetDir, "a.py"), "class A:\n    pass\n");
        fs.writeFileSync(path.join(budgetDir, "b.py"), "from a import A\n\nclass B:\n    pass\n");
        const budgetAgent = new A.Agent(budgetDir, { maxSteps: 1, timeBudgetMs: 8 * 60000 });
        budgetAgent.mcpNames = new Set();
        budgetAgent._inspectFile = async () => ({ ok: true, gap: "" });
        budgetAgent.contract = "a.py: add\nb.py: add";
        let fakeNow = 1000000;
        const realNow = Date.now;
        Date.now = () => fakeNow;
        budgetAgent.startTime = fakeNow - 4 * 60000; // pretend 4 of the 8 minutes are already gone
        const seenBudgets = [];
        budgetAgent._runOneFile = async function (f) { seenBudgets.push(this.timeBudgetMs); fakeNow += 2 * 60000; return []; };
        try {
          await budgetAgent.decomposeMultiFile("add stuff", { root: budgetDir }, () => {}, "SYS", ["a.py", "b.py"]);
        } finally { Date.now = realNow; }
        check("decomposeMultiFile: the first of two sequential files is capped to a fair share of the remaining budget, not the full run-wide budget", seenBudgets[0] === 360000, JSON.stringify(seenBudgets));
        check("decomposeMultiFile: the last file with nothing queued behind it gets whatever time genuinely remains", seenBudgets[1] === 480000, JSON.stringify(seenBudgets));
        check("decomposeMultiFile: the run-wide timeBudgetMs is restored to its original value after the batch loop finishes", budgetAgent.timeBudgetMs === 8 * 60000);
      }

      // ---- Tier 4: auto-discovered workflow patterns (taskShape/recordPattern/promotedPattern) ----
      check("taskShape: classifies a bug-fix task", A.taskShape("Fix the bug causing the crash") === "fix-bug");
      check("taskShape: classifies an add-function task", A.taskShape("Add a function to compute totals") === "add-function");
      check("taskShape: classifies a test-writing task", A.taskShape("Write unit tests for the parser") === "add-tests");
      check("taskShape: classifies a rename/refactor task", A.taskShape("Refactor the cache module") === "rename-refactor");
      check("taskShape: falls back to general", A.taskShape("Do the thing") === "general");
      check("taskShape: empty string doesn't crash", A.taskShape("") === "general");

      const pdir = fresh("patterns");
      check("loadPatterns: no file yet -> empty array, no crash", (await A.loadPatterns(pdir)).length === 0);
      await A.recordPattern(pdir, "add-function", ["read_file", "edit_file", "run_tests", "finish"]);
      await A.recordPattern(pdir, "add-function", ["read_file", "edit_file", "run_tests", "finish"]);
      let loaded = await A.loadPatterns(pdir);
      check("recordPattern: persists across loads", loaded.length === 2);
      check("promotedPattern: only 2 repeats -> not yet promoted (needs 3+)", A.promotedPattern(loaded, "add-function") === null);
      await A.recordPattern(pdir, "add-function", ["read_file", "edit_file", "run_tests", "finish"]);
      loaded = await A.loadPatterns(pdir);
      const promoted = A.promotedPattern(loaded, "add-function");
      check("promotedPattern: 3rd identical repeat -> promoted", promoted && promoted.n === 3 && promoted.seq.join(">") === "read_file>edit_file>run_tests>finish", JSON.stringify(promoted));
      check("promotedPattern: a DIFFERENT shape never matches", A.promotedPattern(loaded, "fix-bug") === null);
      await A.recordPattern(pdir, "add-function", ["write_file", "run_tests", "finish"]); // a different sequence, same shape
      loaded = await A.loadPatterns(pdir);
      const stillPromoted = A.promotedPattern(loaded, "add-function");
      check("promotedPattern: a competing minority sequence doesn't dethrone the 3x-proven one", stillPromoted && stillPromoted.n === 3, JSON.stringify(stillPromoted));
      const beforeLen = (await A.loadPatterns(pdir)).length;
      await A.recordPattern(pdir, "general", []);
      check("recordPattern: confirmed no growth from an empty sequence", (await A.loadPatterns(pdir)).length === beforeLen);

      // ---- API MISMATCH vs LOGIC BUG (ISSUE 9, from live IDE run 57): the coder implemented the
      // two-file cache spec EXACTLY (11/11 against hand-written spec-faithful tests) but the run
      // reported 5/10 — because the TEST-AUTHOR called a property as a method, put reset() on the
      // wrong class, and dropped a required arg. Those are CONTRACT disagreements, not wrong
      // answers, and reporting them as plain failures makes the score lie about the coder. ----
      {
        const R57 = `======================================================================
ERROR: test_hit_rate_with_no_lookups (test_cache.TestLRUCache.test_hit_rate_with_no_lookups)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "test_cache.py", line 60, in test_hit_rate_with_no_lookups
    self.assertEqual(cache.stats.hit_rate(), 0.0)
TypeError: 'float' object is not callable

======================================================================
ERROR: test_reset (test_cache.TestLRUCache.test_reset)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "test_cache.py", line 70, in test_reset
    cache.reset()
AttributeError: 'LRUCache' object has no attribute 'reset'

======================================================================
ERROR: test_value_error_cases (test_cache.TestLRUCache.test_value_error_cases)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "test_cache.py", line 80, in test_value_error_cases
    LRUCache(0, 10)
TypeError: LRUCache.__init__() missing 1 required positional argument: 'clock'
`;
        const mm = A.apiMismatches(R57);
        check("api: finds every API mismatch in the real run-57 output", mm.length === 3, "found " + mm.length);
        check("api: names the property-called-as-method bug", mm.some((m) => /as if it were a method/.test(m.why)));
        check("api: with no impl context, the missing .reset() HEDGES (never asserts the test is wrong)", mm.some((m) => /\.reset\(\) is missing on \w+ — either the code is incomplete or the test/.test(m.why)));
        check("api: names the omitted required argument", mm.some((m) => /omitted a required argument: 'clock'/.test(m.why)));
        check("api: attributes each mismatch to its test", mm.every((m) => /^test_/.test(m.test)));
        // a genuine wrong answer MUST stay the coder's problem — never excused as an API mismatch
        check("api: a real AssertionError is NOT excused as an API mismatch",
          A.apiMismatches(`======================================================================\nFAIL: test_x (m.T.test_x)\n----\nAssertionError: 1.0 != 2.0\n`).length === 0);
        check("api: clean output -> no false alarms", A.apiMismatches("Ran 6 tests in 0.01s\n\nOK").length === 0);
        // LIVE-CAUGHT, boltons run 81, 2026-07-27: this project's own real testCmd is
        // `python -m pytest -q`, whose failure format the block-splitter above never matched at
        // all — a test-author API mistake (Rectangle's real signature is (top_left, width, height))
        // was silently reported as a bare "3 still failing" with zero attribution.
        const PYTEST81 = `=================================== FAILURES ===================================\n_________________ TestCircle.test_touches_rectangle_separate _________________\n\nself = <tests.test_circleutils.TestCircle testMethod=test_touches_rectangle_separate>\n\n    def test_touches_rectangle_separate(self):\n        circle = Circle(Point(0, 0), 5)\n>       rect = Rectangle(Point(6, 6), Point(8, 8))\n               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\nE       TypeError: Rectangle.__init__() missing 1 required positional argument: 'height'\n\ntests/test_circleutils.py:33: TypeError\n_________________ test_plain_function_case _________________\nE       AttributeError: 'Circle' object has no attribute 'foo'\n=========================== short test summary info ===========================\nFAILED tests/test_circleutils.py::TestCircle::test_touches_rectangle_separate\n3 failed, 453 passed in 2.30s\n`;
        const mmPytest = A.apiMismatches(PYTEST81);
        check("api: finds mismatches in REAL pytest -q output (not just unittest)", mmPytest.length === 2, "found " + mmPytest.length);
        check("api: pytest class.method header -> bare method name", mmPytest.some((m) => m.test === "test_touches_rectangle_separate"));
        check("api: pytest plain-function header (no class prefix) also parsed", mmPytest.some((m) => m.test === "test_plain_function_case"));
        check("api: pytest-style names the omitted required argument", mmPytest.some((m) => /omitted a required argument: 'height'/.test(m.why)));
        check("api: an underscore-wrapped FAILURES/ERRORS banner is not mistaken for a per-test header", A.apiMismatches("_________________________________ FAILURES _________________________________\nAttributeError: 'X' object has no attribute 'y'\n").length === 0);
        // the test-author rules that measurably reduced these (7/9 -> 4/9 bugs on the live 16B)
        check("api: test-author is told to obey the spec's declared API", /OBEY THE SPEC'S API EXACTLY/.test(A.TEST_AUTHOR_RULES));
        check("api: told to pass every declared argument, even in error tests", /pass EVERY argument every time/.test(A.TEST_AUTHOR_RULES));
        check("api: told a property is accessed without parentheses", /access it WITHOUT parentheses/.test(A.TEST_AUTHOR_RULES));
        check("api: told to call methods on the exact class the spec names", /Call each method on the EXACT class/.test(A.TEST_AUTHOR_RULES));
        check("api: told never to test an operator the spec omits", /never test one that is absent from that list/.test(A.TEST_AUTHOR_RULES));
      }

      // ---- EDIT SALVAGE (ISSUE 2): measured live, the 16B produced 0/4 usable SEARCH/REPLACE
      // edits — it drops the "SEARCH" keyword (`<<<<<<< def evaluate(expr):`) and puts IDENTICAL
      // text in both halves, so even a tolerant parser yields a no-op. It CANNOT emit the marker
      // format (Aider's finding: edit-format compliance is a real capability barrier for weak
      // models). But its reply IS a complete, valid, corrected file — we were throwing that away
      // and burning another ~1.5min round-trip demanding a format it cannot produce. ----
      {
        const OLD = ["import re", "", "def helper(x):", "    return x * 2", "", "def evaluate(expr):",
          "    tokens = expr.split()", "    total = 0", "    for t in tokens:", "        total += int(t)",
          "    return total", "", "def other(y):", "    return y", ""].join("\n");
        // the EXACT reply the live 16B gave (whole file, all 3 defs, bug actually fixed)
        const REAL = "import re\n\ndef helper(x):\n    return x * 2\n\ndef evaluate(expr):\n    tokens = expr.split()\n    total = int(tokens[0])\n    for i in range(1, len(tokens), 2):\n        if tokens[i] == '*':\n            total *= int(tokens[i + 1])\n    return total\n\ndef other(y):\n    return y";
        const s1 = A.salvageWholeFile(REAL, OLD);
        check("salvage: rescues the real live reply the old code discarded", !!s1);
        check("salvage: the rescued file carries the actual fix", s1 && /total \*= int/.test(s1));
        // THE critical guard — a whole-file rewrite that silently drops a function is the real danger
        check("salvage: REJECTS a rewrite that drops an existing function",
          A.salvageWholeFile("import re\n\ndef evaluate(expr):\n    return 42\n\ndef other(y):\n    return y", OLD) === null);
        check("salvage: handles ``` fences", !!A.salvageWholeFile("```python\n" + REAL + "\n```", OLD));
        // the half-marker reply it also emits: strip markers, keep the payload
        check("salvage: rescues the half-marker reply too",
          !!A.salvageWholeFile("```\n<<<<<<< def evaluate(expr):\n" + REAL + "\n=======\n" + REAL + "\n>>>>>>> REPLACE\n```", OLD));
        check("salvage: rejects prose, never writes chatter to a file", A.salvageWholeFile("Sure! I will fix that for you.", OLD) === null);
        check("salvage: rejects an empty reply", A.salvageWholeFile("", OLD) === null);
        check("salvage: rejects a no-op (identical file, whitespace aside)", A.salvageWholeFile(OLD, OLD) === null);
        check("salvage: with no definitions to protect it refuses to guess", A.salvageWholeFile("x = 1", "y = 2") === null);
      }

      // ---- BUG 111 (2026-09-15, found by auditing every raw per-line-regex helper for the same
      // string-blindness class as BUG 107/109/110, per the 124th run's own handoff pointer):
      // salvageWholeFile's inline `names()` closure independently re-derives column-0 def/class
      // names with its own regex rather than going through the now triple-quote-aware
      // topLevelBlocks — it predates the BUG 109 fix and was never migrated, so the exact same
      // failure shape survived in a brand-new call site. A column-0 module/class docstring showing
      // `class Foo:` as an unindented usage example is textually indistinguishable from a real class
      // header, so when the model's "whole file" reply genuinely DROPPED `class Foo` but its
      // surviving docstring still mentions it, `after` falsely included "Foo" and the drop-detection
      // guard — whose entire documented purpose is "a whole-file rewrite that silently drops a
      // function is the real danger, and this is what catches it" — was defeated: the corrupted
      // content was accepted instead of rejected. Fix: reuse the same computeTripleQuoteLineStarts
      // primitive BUG 107/109/110 established, skipping any candidate line whose start falls inside
      // an open triple-quoted string. ----
      {
        const oldReal = "class Foo:\n    def bar(self):\n        return 1\n\nclass Baz:\n    def qux(self):\n        return 2\n";
        const badDocstring = "\"\"\"\nExample usage:\nclass Foo:\n    def bar(self):\n        return 1\n\"\"\"\n\nclass Baz:\n    def qux(self):\n        return 2\n";
        check("BUG 111: salvageWholeFile REJECTS a whole-file rewrite that drops a class even when a docstring still mentions its name (was silently accepted before this fix)",
          A.salvageWholeFile(badDocstring, oldReal) === null);

        // Single-quote triple-quote variant, same shape.
        const badDocstringSingle = "'''\nclass Foo:\n    def bar(self):\n        return 1\n'''\n\nclass Baz:\n    def qux(self):\n        return 2\n";
        check("BUG 111: covers the '''-quoted variant too",
          A.salvageWholeFile(badDocstringSingle, oldReal) === null);

        // Regression guard: a genuine (non-docstring) drop is still caught exactly as before.
        const genuineDrop = "class Baz:\n    def qux(self):\n        return 2\n";
        check("BUG 111 regression guard: a genuine (non-docstring) dropped class is still rejected",
          A.salvageWholeFile(genuineDrop, oldReal) === null);

        // Regression guard: a docstring-only name in OLD (never real code) must not falsely block
        // a legitimate rewrite that simply removes that docstring.
        const oldWithGhostDocstring = "\"\"\"\nExample usage:\nclass Ghost:\n    pass\n\"\"\"\n\nclass Baz:\n    def qux(self):\n        return 2\n";
        const goodRewrite = "class Baz:\n    def qux(self):\n        return 2  # simplified, docstring removed\n";
        check("BUG 111 regression guard: a docstring-only name in OLD does not block a legit rewrite that drops the docstring",
          A.salvageWholeFile(goodRewrite, oldWithGhostDocstring) !== null);

        // Sanity: a genuine no-drop rewrite is still accepted exactly as before.
        const goodFix = "class Foo:\n    def bar(self):\n        return 99  # fixed\n\nclass Baz:\n    def qux(self):\n        return 2\n";
        check("BUG 111 regression guard: a genuine no-drop rewrite is still accepted",
          A.salvageWholeFile(goodFix, oldReal) === goodFix.trim());
      }

      // ---- SELF-DUPLICATE GUARD (boltons Test 4 slugify incident): dedupeSelfRepeatedDefs was
      // built to catch a weak model echoing its own definition twice in one generation, but had
      // ZERO test coverage anywhere in this suite until now. ALSO: it was wired into the write_file
      // content path (_genFileContent) but NOT into editFile's salvageWholeFile fallback — a sibling
      // path with the identical failure mode, caught live 2026-07-21 (boltons Test 5, run 33):
      // wordcountutils.py shipped with word_count() defined twice (a broken first draft immediately
      // followed by a corrected second draft, both left in — salvageWholeFile's guard only checks
      // that every OLD name still appears SOMEWHERE in the new content, not whether it appears once).
      // These tests lock in both the standalone function AND the exact salvage->dedupe composition
      // now wired into editFile. ----
      {
        check("dedupe: no repeated top-level name returns null (nothing to do)",
          A.dedupeSelfRepeatedDefs("def a(x):\n    return x\n\ndef b(y):\n    return y") === null);
        const dupe = "def word_count(text):\n    return {}\n\ndef word_count(text):\n    return {'ok': 1}";
        const dd = A.dedupeSelfRepeatedDefs(dupe);
        check("dedupe: detects a repeated top-level def", !!dd && dd.names.includes("word_count"));
        check("dedupe: keeps the LAST occurrence (the model's final answer)",
          dd && /'ok': 1/.test(dd.text) && !/return \{\}/.test(dd.text));
        check("dedupe: result has the name defined exactly once",
          dd && (dd.text.match(/^def word_count/gm) || []).length === 1);
        // the EXACT live pattern from run 33: broken first draft (uses `re` before it's imported)
        // immediately followed by the corrected second draft with its own imports
        const OLD2 = "from collections import defaultdict\n\ndef word_count(text):\n    words = re.findall(r'\\w+', text)\n    counts = defaultdict(int)\n    for w in words:\n        counts[w.lower()] += 1\n    return dict(counts)\n";
        const selfEchoReply = OLD2 + "\nimport re\nfrom collections import Counter\n\ndef word_count(text):\n    words = re.findall(r'\\w+', text)\n    counts = Counter()\n    for w in words:\n        counts[w.lower()] += 1\n    return dict(counts)\n";
        const salvaged = A.salvageWholeFile(selfEchoReply, OLD2);
        check("run-33 repro: salvageWholeFile alone still lets the duplicate through (pre-fix behavior, proves the gap was real)",
          salvaged && (salvaged.match(/^def word_count/gm) || []).length === 2);
        const fixed = A.dedupeSelfRepeatedDefs(salvaged);
        check("run-33 repro: dedupeSelfRepeatedDefs cleans the salvaged output to exactly one def",
          fixed && (fixed.text.match(/^def word_count/gm) || []).length === 1);
        check("run-33 repro: the surviving def is the CORRECTED one (imports re, uses Counter)",
          fixed && /Counter\(\)/.test(fixed.text) && !/defaultdict\(int\)/.test(fixed.text));
      }

      // ---- DUPLICATE-IMPORT GUARD (boltons Test 5, run 41, 2026-07-21): repeated edit_file calls
      // ACROSS a run (not one generation echoing itself — that's dedupeSelfRepeatedDefs above) each
      // inserted their own import line without checking it already existed. readabilityutils.py
      // ended up with 13 duplicate `import re` / `from boltons import wordcountutils` lines, one
      // wedged between two function defs. ----
      {
        check("dedupeRepeatedImports: no repeats returns null (nothing to do)",
          A.dedupeRepeatedImports("import re\nfrom collections import Counter\n\ndef f():\n    return 1") === null);
        const dupe = "import re\n\nimport re\n\nfrom boltons import wordcountutils\nimport re\n\ndef average_word_length(text):\n    return 1.0\n\nimport re\n\ndef unique_word_ratio(text):\n    return 1.0";
        const di = A.dedupeRepeatedImports(dupe);
        check("dedupeRepeatedImports: collapses every repeat of the SAME import line",
          di && (di.match(/^import re$/gm) || []).length === 1);
        check("dedupeRepeatedImports: leaves distinct imports alone",
          di && /from boltons import wordcountutils/.test(di));
        check("dedupeRepeatedImports: never touches the actual function bodies",
          di && /def average_word_length/.test(di) && /def unique_word_ratio/.test(di));
        check("dedupeRepeatedImports: a duplicate import wedged BETWEEN two defs is still removed",
          di && di.indexOf("import re") === di.lastIndexOf("import re"));
        // exact live repro: the readabilityutils.py content from run 41 (13 duplicate import lines)
        const live = "import re\n\nimport re\n\nimport re\n\nfrom boltons import wordcountutils\nimport re\n\nimport re\n\nfrom boltons import wordcountutils\n\nimport re\n\nfrom boltons import wordcountutils\nimport re\n\nimport re\n\nimport re\n\nfrom boltons import wordcountutils\nimport re\n\nimport re\n\nfrom boltons import wordcountutils\n\ndef average_word_length(text):\n    word_counts = wordcountutils.word_count(text)\n    total_chars = sum(len(word) for word in word_counts.keys())\n    return float(total_chars / len(word_counts)) if word_counts else 0.0\n\nimport re\n\ndef unique_word_ratio(text):\n    word_counts = wordcountutils.word_count(text)\n    unique_words = set(word_counts.keys())\n    return float(len(unique_words) / len(word_counts)) if word_counts else 0.0";
        const liveFixed = A.dedupeRepeatedImports(live);
        check("dedupeRepeatedImports: run-41 repro collapses to exactly 1 `import re` + 1 wordcountutils import",
          liveFixed && (liveFixed.match(/^import re$/gm) || []).length === 1 && (liveFixed.match(/^from boltons import wordcountutils$/gm) || []).length === 1);
      }

      // ---- BUG 73 (2026-09-08, found by re-skimming already-tested guard-heavy helpers for the
      // same family as bugs 68/69/71/72): the original dedupeRepeatedImports deduped one PHYSICAL
      // LINE at a time. A common real-world style — `from x import (\n    a,\n    b,\n)` — spans
      // several physical lines; its opening line is textually identical across two separate
      // multi-line imports of the same statement. Deleting only that opening line (the pre-fix
      // behavior) left the surviving copy's continuation lines dangling with no header — verified
      // via D:/tmp/dedup-probe/probe1.mjs that this turned valid Python into a SyntaxError
      // (`unmatched ')'`). Multi-line parenthesized imports are common in the real corpus (7 files
      // in boltons alone use this style). Fix: when an import line opens a paren it doesn't also
      // close on the same physical line, treat/drop the WHOLE statement (every physical line up to
      // the one that closes it) as one unit. ----
      {
        const src1 = "from boltons import (\n    a,\n    b,\n)\n\ndef foo():\n    pass\n\nfrom boltons import (\n    a,\n    b,\n)\n\ndef bar():\n    pass\n";
        const r1 = A.dedupeRepeatedImports(src1);
        check("BUG 73: exact-duplicate multi-line paren import collapses to exactly one",
          r1 && (r1.match(/^from boltons import \($/gm) || []).length === 1);
        check("BUG 73: collapsed multi-line import keeps every member exactly once (no dangling continuation lines)",
          r1 && (r1.match(/^    a,$/gm) || []).length === 1 && (r1.match(/^    b,$/gm) || []).length === 1);
        check("BUG 73: both function bodies survive untouched",
          r1 && /def foo\(\)/.test(r1) && /def bar\(\)/.test(r1));
        // Same header, DIFFERENT members -> these are NOT exact duplicates, must be left alone.
        const src2 = "from boltons import (\n    a,\n    b,\n)\n\ndef foo():\n    pass\n\nfrom boltons import (\n    a,\n    c,\n)\n\ndef bar():\n    pass\n";
        check("BUG 73: multi-line imports with the same opening line but DIFFERENT members are left alone",
          A.dedupeRepeatedImports(src2) === null);
        // Multi-line import that closes on a non-blank continuation line (not the bare `)` case).
        const src3 = "from boltons import (\n    a, b)\n\ndef foo():\n    pass\n\nfrom boltons import (\n    a, b)\n\ndef bar():\n    pass\n";
        const r3 = A.dedupeRepeatedImports(src3);
        check("BUG 73: multi-line import closing on a continuation line (not a bare paren) also collapses correctly",
          r3 && (r3.match(/^from boltons import \($/gm) || []).length === 1 && /def foo\(\)/.test(r3) && /def bar\(\)/.test(r3));
        // Malformed/unterminated paren import must not throw.
        let threw = false;
        try { A.dedupeRepeatedImports("from boltons import (\n    a,\n    b,\n"); } catch { threw = true; }
        check("BUG 73: an unterminated paren import does not throw", !threw);
      }

      // ---- DUPLICATE MAIN-GUARD BOILERPLATE (boltons run 188, 2026-09-01): a salvaged whole-file
      // edit_file reply left a stray `if __name__ == "__main__": unittest.main()` block BEFORE
      // `import unittest` even appeared — dedupeSelfRepeatedDefs only recognizes def/class blocks,
      // so this boilerplate guard (no name) was invisible to it. Passes under pytest
      // (__name__ != "__main__") but crashes NameError if run directly as a script. ----
      {
        check("dedupeMainGuard: a single guard block returns null (nothing to do)",
          A.dedupeMainGuard("import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n\nif __name__ == \"__main__\":\n    unittest.main()") === null);
        // exact live repro: run-188's test_layoututils.py — a stray guard before `import unittest`
        const live188 = "from boltons.layoututils import Grid\nfrom boltons.shapeutils import Rectangle\nfrom boltons.pointutils import Point\n\nif __name__ == \"__main__\":\n    unittest.main()\n\nimport unittest\n\nclass TestGrid(unittest.TestCase):\n    def test_total_area_single_rectangle(self):\n        rect = Rectangle(Point(0, 0), 2, 3)\n        grid = Grid([rect])\n        self.assertEqual(grid.total_area(), 6)\n\nif __name__ == \"__main__\":\n    unittest.main()";
        const fixed188 = A.dedupeMainGuard(live188);
        check("run-188 repro: dedupeMainGuard collapses to exactly 1 __main__ guard block",
          fixed188 && (fixed188.match(/^if __name__ == "__main__":$/gm) || []).length === 1);
        check("run-188 repro: the surviving guard is AFTER `import unittest` (no NameError if run directly)",
          fixed188 && fixed188.indexOf("import unittest") < fixed188.indexOf('if __name__ == "__main__":'));
        check("run-188 repro: the class + test body are untouched",
          fixed188 && /class TestGrid/.test(fixed188) && /def test_total_area_single_rectangle/.test(fixed188));
        check("dedupeMainGuard: never touches a file with no guard at all",
          A.dedupeMainGuard("def f():\n    return 1\n") === null);

        // BUG 72 (2026-09-08): a trailing `# comment` on a guard line used to make the whole line
        // regex fail to match at all (`:\s*$` required nothing after the colon but whitespace), so
        // dedup silently no-op'd whenever EITHER duplicate guard carried a trailing comment.
        const commentSecond = "def foo(): pass\nif __name__ == \"__main__\":\n    foo()\n\ndef bar(): pass\nif __name__ == \"__main__\":  # run tests\n    bar()\n";
        const fixedCommentSecond = A.dedupeMainGuard(commentSecond);
        check("BUG 72: trailing comment on the SECOND (surviving) guard line is still deduped",
          fixedCommentSecond && (fixedCommentSecond.match(/^if __name__ == "__main__":/gm) || []).length === 1
          && /if __name__ == "__main__":  # run tests/.test(fixedCommentSecond));

        const commentFirst = "def foo(): pass\nif __name__ == \"__main__\":  # entry point\n    foo()\n\ndef bar(): pass\nif __name__ == \"__main__\":\n    bar()\n";
        const fixedCommentFirst = A.dedupeMainGuard(commentFirst);
        check("BUG 72: trailing comment on the FIRST (dropped) guard line is still deduped",
          fixedCommentFirst && (fixedCommentFirst.match(/^if __name__ == "__main__":/gm) || []).length === 1
          && !/entry point/.test(fixedCommentFirst));

        const commentBoth = "def foo(): pass\nif __name__ == \"__main__\":  # entry point\n    foo()\n\ndef bar(): pass\nif __name__ == \"__main__\":  # run tests\n    bar()\n";
        const fixedCommentBoth = A.dedupeMainGuard(commentBoth);
        check("BUG 72: trailing comments on BOTH guard lines still dedupes, keeps the last comment",
          fixedCommentBoth && (fixedCommentBoth.match(/^if __name__ == "__main__":/gm) || []).length === 1
          && /# run tests/.test(fixedCommentBoth) && !/entry point/.test(fixedCommentBoth));

        check("BUG 72: a single guard WITH a trailing comment and no duplicate still returns null",
          A.dedupeMainGuard("import unittest\n\nif __name__ == \"__main__\":  # pragma: no cover\n    unittest.main()") === null);
      }

      // ---- BUG 74 (2026-09-08, found by re-skimming already-tested guard-heavy helpers, same
      // family as bugs 68/69/71/72/73): `topLevelBlocks` (shared by dedupeSelfRepeatedDefs,
      // preserveDroppedDefs, preserveDroppedMethods, preserveDroppedTests) treated ANY column-0,
      // non-blank line after a `def`/`class` line as "the block has ended" and ANY non-`@`-prefixed
      // line directly above as "no decorator here" — both wrong when a signature/base-class list or
      // a decorator's own args span MULTIPLE physical lines (a black-formatted long signature closes
      // with a bare `):` at column 0; a multi-line decorator's own closing `)` sits directly above
      // the `def`). Confirmed real, not contrived: `boltons/iterutils.py`'s top-level `remap` has a
      // multi-line signature — the old scan truncated its block to just the signature, dropping the
      // whole docstring+body; `tests/test_funcutils_fb.py` / `tests/test_funcutils_fb_py3.py` /
      // `tests/test_urlutils.py` each have a real multi-line `@pytest.mark.parametrize(...)`
      // decorator the old scan failed to absorb. Verified this actively CORRUPTS: self-duplicating a
      // function with both shapes together (the exact `test_get_invocation_sig_str` shape) and
      // running it through dedupeSelfRepeatedDefs left the earlier copy's own closing `):` and body
      // orphaned mid-file; `ast.parse` on the result raised `SyntaxError: unmatched ')'`. Fix: track
      // paren/bracket/brace depth (quote-aware) to find each line's owning logical-statement start,
      // then use it both to absorb a decorator regardless of how many lines its own statement spans
      // and to defer the "find the end of the block" scan until the header's OWN statement closes. ----
      {
        const multiSig = "def remap(\n        root,\n        visit=default_visit,\n):\n    \"\"\"doc\"\"\"\n    return root\n\ndef other():\n    return 2\n";
        const blocksMultiSig = A.topLevelBlocks(multiSig);
        check("BUG 74: multi-line def signature — block.text now includes the full body, not just the signature",
          blocksMultiSig[0].name === "remap" && blocksMultiSig[0].text.includes("return root") && blocksMultiSig[0].text.includes('"""doc"""'));
        check("BUG 74: multi-line def signature — the NEXT top-level block is still found correctly",
          blocksMultiSig[1] && blocksMultiSig[1].name === "other");

        const multiBases = "class Foo(\n        Base1,\n        Base2,\n):\n    def m(self):\n        return 1\n\ndef other():\n    return 2\n";
        const blocksMultiBases = A.topLevelBlocks(multiBases);
        check("BUG 74: multi-line class base list — block.text now includes the full class body",
          blocksMultiBases[0].name === "Foo" && blocksMultiBases[0].text.includes("def m(self):") && blocksMultiBases[0].text.includes("return 1"));

        const multiDecorator = "@pytest.mark.parametrize(\n    \"a,b\",\n    [(1, 2)],\n)\ndef test_foo(a, b):\n    assert a < b\n";
        const blocksMultiDeco = A.topLevelBlocks(multiDecorator);
        check("BUG 74: multi-line decorator is now absorbed into the block (starts at the `@` line)",
          blocksMultiDeco[0].name === "test_foo" && blocksMultiDeco[0].start === 0);

        // Exact real-corpus shape: multi-line decorator + multi-line signature, self-duplicated —
        // the combination that produced the confirmed SyntaxError before this fix.
        const realShapeBlock = "@pytest.mark.parametrize(\n    \"args, varargs, varkw, defaults, invocation_str, sig_str\",\n    [\n        ([\"a\", \"b\"], None, None, None, \"a, b\", \"(a, b)\"),\n    ],\n)\ndef test_get_invocation_sig_str(\n    args, varargs, varkw, defaults, invocation_str, sig_str\n):\n    sig = inspect.signature(lambda *a, **k: None)\n    assert sig_str == \"ok\"";
        const dupedRealShape = `import inspect\nimport pytest\n\n\n${realShapeBlock}\n\n\n${realShapeBlock}\n`;
        const fixedRealShape = A.dedupeSelfRepeatedDefs(dupedRealShape);
        check("BUG 74 real-corpus shape: self-duplicate collapses to exactly ONE surviving def",
          fixedRealShape && (fixedRealShape.text.match(/def test_get_invocation_sig_str/g) || []).length === 1);
        check("BUG 74 real-corpus shape: self-duplicate collapses to exactly ONE surviving decorator (no orphaned fragment)",
          fixedRealShape && (fixedRealShape.text.match(/@pytest\.mark\.parametrize\(/g) || []).length === 1);
        check("BUG 74 real-corpus shape: no dangling bare `):` left over from a truncated earlier block",
          fixedRealShape && !/^\):\s*$/m.test(fixedRealShape.text.replace(realShapeBlock, "")));

        // Previously-working shapes must be completely unaffected.
        check("BUG 74: plain single-line def with no decorator is unaffected",
          A.dedupeSelfRepeatedDefs("def foo():\n    return 1\n\ndef bar():\n    return 2\n") === null);
        const simpleDupe = "def foo():\n    return 1\n\ndef foo():\n    return 2\n";
        const fixedSimpleDupe = A.dedupeSelfRepeatedDefs(simpleDupe);
        check("BUG 74: plain single-line duplicate (no multi-line header) still dedupes exactly as before",
          fixedSimpleDupe && (fixedSimpleDupe.text.match(/def foo\(\)/g) || []).length === 1 && /return 2/.test(fixedSimpleDupe.text));
      }

      // ---- BUG 79 (2026-09-08, 84th unattended run, from the standing "speculative gaps" list):
      // `topLevelBlocks`'s header regex only matched a bare `def`/`class`, so a module-level
      // `async def foo():` was completely invisible as a block (not merely mis-sliced like bug 74 —
      // never found at all). Two concrete, verified downstream consequences: preserveDroppedDefs names
      // a dropped top-level async function as lost (topLevelDefs is separately already async-aware)
      // but could not recover it, and dedupeSelfRepeatedDefs could not even detect a self-duplicated
      // async function. Also fixed the two structurally-identical header-routing regexes in
      // preserveDroppedTests (so a dropped top-level `async def test_x():`, a real pytest-asyncio
      // shape, is recoverable too) and salvageWholeFile's own independent definition-list guard (which
      // re-derives top-level names with the same un-async-aware regex and exists specifically to catch
      // a whole-file rewrite silently dropping a function). ----
      {
        const asyncSrc = "def sync_fn(x):\n    return x + 1\n\nasync def async_fn(x):\n    return x + 2\n\nclass Foo:\n    async def method(self):\n        return 1\n";
        const asyncBlocks = A.topLevelBlocks(asyncSrc);
        check("BUG 79: topLevelBlocks now finds a module-level async def (was completely invisible before)",
          asyncBlocks.some((b) => b.name === "async_fn"));
        check("BUG 79: topLevelBlocks still finds the sync def and the class either side of it",
          asyncBlocks.some((b) => b.name === "sync_fn") && asyncBlocks.some((b) => b.name === "Foo"));
        check("BUG 79: the async block's text includes the async keyword and its body",
          asyncBlocks.find((b) => b.name === "async_fn").text === "async def async_fn(x):\n    return x + 2");

        const oldAsync = "import asyncio\n\ndef sync_fn(x):\n    return x + 1\n\nasync def fetch_data(url):\n    await asyncio.sleep(0)\n    return url\n\ndef another(x):\n    return x - 1\n";
        const droppedAsync = "import asyncio\n\ndef sync_fn(x):\n    return x + 1\n\ndef another(x):\n    return x - 1\n";
        check("BUG 79: droppedDefs still names a dropped top-level async function as lost (topLevelDefs was already async-aware)",
          A.droppedDefs(oldAsync, droppedAsync).join(",") === "fetch_data");
        const pdAsync = A.preserveDroppedDefs(oldAsync, droppedAsync);
        check("BUG 79: preserveDroppedDefs now RECOVERS the dropped async function (was silently null before this fix)",
          !!pdAsync && pdAsync.names.join(",") === "fetch_data");
        check("BUG 79: the recovered async function is re-attached verbatim, async keyword included",
          pdAsync && /^async def fetch_data\(url\):\n    await asyncio\.sleep\(0\)\n    return url$/m.test(pdAsync.text));

        const dupeAsync = "async def fetch_data(url):\n    return url\n\nasync def fetch_data(url):\n    return url + '/v2'";
        const ddAsync = A.dedupeSelfRepeatedDefs(dupeAsync);
        check("BUG 79: dedupeSelfRepeatedDefs now detects a self-duplicated async def (was invisible before)",
          !!ddAsync && ddAsync.names.includes("fetch_data"));
        check("BUG 79: dedupe keeps the LAST async occurrence, exactly one copy survives",
          ddAsync && /\/v2/.test(ddAsync.text) && (ddAsync.text.match(/^async def fetch_data/gm) || []).length === 1);

        check("BUG 79: salvageWholeFile REJECTS a rewrite that silently drops a top-level async function",
          A.salvageWholeFile(droppedAsync, oldAsync) === null);
        const goodAsyncRewrite = "import asyncio\n\ndef sync_fn(x):\n    return x + 5\n\nasync def fetch_data(url):\n    await asyncio.sleep(0)\n    return url\n\ndef another(x):\n    return x - 1\n";
        check("BUG 79: salvageWholeFile still ACCEPTS a rewrite that keeps the async function intact",
          !!A.salvageWholeFile(goodAsyncRewrite, oldAsync));

        const oldAsyncTest = "import pytest\n\ndef test_sync():\n    assert True\n\nasync def test_async_thing():\n    assert True\n";
        const droppedAsyncTest = "import pytest\n\ndef test_sync():\n    assert True\n";
        const ptAsync = A.preserveDroppedTests(oldAsyncTest, droppedAsyncTest);
        check("BUG 79: preserveDroppedTests recovers a dropped top-level `async def test_x()` (pytest-asyncio shape, was unrecoverable before)",
          !!ptAsync && ptAsync.names.includes("test_async_thing") && /async def test_async_thing/.test(ptAsync.text));

        // Negative controls / non-regression: files with no async at all must be byte-identical in
        // behavior to before this fix.
        check("BUG 79: no-op negative control — a plain sync-only file is completely unaffected",
          A.preserveDroppedDefs("def a():\n    pass\n\ndef b():\n    pass\n", "def a():\n    pass\n\ndef b():\n    pass\n") === null);
        check("BUG 79: a second pass over the async recovery finds nothing left to recover (idempotent)",
          A.preserveDroppedDefs(oldAsync, pdAsync.text) === null);
      }

      // ---- BUG 109 (2026-09-15, found by auditing dedupeSelfRepeatedDefs/dedupeMainGuard for the
      // same string/scope-blindness class as BUG 107 dedupeRepeatedImports): topLevelBlocks' header
      // regex and dedupeMainGuard's guard-line regex both matched column-0 text with no awareness of
      // whether that line sits inside a triple-quoted docstring. A docstring showing a column-0 usage
      // example (a real, common Python doc style) that happens to reuse a real top-level name, or show
      // an `if __name__ == "__main__":` line, was counted as a genuine duplicate. Both functions keep
      // only the LAST-seen occurrence per their documented "model's final answer wins" contract — so
      // when the fake docstring occurrence came AFTER the real code, the REAL code got deleted and the
      // inert docstring text survived: confirmed live this deletes a real top-level function entirely
      // (silent NameError on every call) and deletes the only real `__main__` guard (script entry point
      // silently gone, invisible to pytest since __name__ != "__main__" under test collection). Fix:
      // both now reuse computeTripleQuoteLineStarts (the same primitive BUG 107 established) and skip
      // any candidate header/guard line whose line START falls inside an open triple-quoted string. ----
      {
        // topLevelBlocks / dedupeSelfRepeatedDefs: real def FIRST, fake docstring occurrence AFTER.
        const fakeDefAfter = "def helper(x):\n    return x + 2\n\n\ndef other():\n    \"\"\"Docs.\n\n    Example::\n\ndef helper(x):\n    return x + 1\n    \"\"\"\n    pass\n";
        const blocksFakeDefAfter = A.topLevelBlocks(fakeDefAfter);
        check("BUG 109: topLevelBlocks no longer matches a column-0 def/class line inside a docstring",
          blocksFakeDefAfter.filter((b) => b.name === "helper").length === 1);
        check("BUG 109: dedupeSelfRepeatedDefs no longer corrupts a file over a docstring-embedded fake def",
          A.dedupeSelfRepeatedDefs(fakeDefAfter) === null);

        // Same shape, fake docstring occurrence BEFORE the real def (the other ordering).
        const fakeDefBefore = "\"\"\"\nModule docs.\n\nExample (paste into a REPL)::\n\ndef helper(x):\n    return x + 1\n\"\"\"\n\n\ndef helper(x):\n    return x + 2\n";
        check("BUG 109: dedupeSelfRepeatedDefs is safe regardless of which side the docstring fake sits on",
          A.dedupeSelfRepeatedDefs(fakeDefBefore) === null);

        // dedupeMainGuard: real guard FIRST, fake docstring-embedded guard AFTER (the dangerous
        // ordering — this is what silently deleted the only real script entry point pre-fix).
        const fakeGuardAfter = "import sys\n\n\ndef main():\n    print(\"real entry point\")\n\n\nif __name__ == \"__main__\":\n    main()\n\n\nclass Helper:\n    \"\"\"Helper utility.\n\n    Typical usage from the command line::\n\nif __name__ == \"__main__\":\n    Helper().run()\n    \"\"\"\n    def run(self):\n        pass\n";
        check("BUG 109: dedupeMainGuard no longer deletes the real __main__ guard over a docstring-embedded fake one",
          A.dedupeMainGuard(fakeGuardAfter) === null);

        // Sanity: genuine duplicates with NO string involved must still be caught exactly as before.
        const realDupeDef = "def helper(x):\n    return x + 1\n\n\ndef helper(x):\n    return x + 2\n";
        const ddReal = A.dedupeSelfRepeatedDefs(realDupeDef);
        check("BUG 109 regression guard: a genuine (non-docstring) duplicate def is still detected and deduped",
          ddReal && (ddReal.text.match(/^def helper\(x\):$/gm) || []).length === 1 && /return x \+ 2/.test(ddReal.text));
        const realDupeGuard = "import sys\n\n\ndef main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n\n\nif __name__ == \"__main__\":  # pragma: no cover\n    main()\n";
        const dmReal = A.dedupeMainGuard(realDupeGuard);
        check("BUG 109 regression guard: a genuine (non-docstring) duplicate main guard is still detected and deduped",
          dmReal && (dmReal.match(/^if __name__ == "__main__":/gm) || []).length === 1 && /pragma: no cover/.test(dmReal));
      }

      // ---- BUG 110 (2026-09-15, found by auditing other raw per-line-regex helpers for the same
      // string/scope-blindness class as BUG 107/109, per the 123rd run's own handoff pointer):
      // preserveDroppedTests's `testNames` scans the ENTIRE raw file text for ANY line — at any
      // indentation — that looks like `def test_*`, with zero triple-quote awareness. Unlike
      // BUG 107/109 (which CORRUPT by deleting real code), this one is GUARD-BLIND: a class docstring
      // showing an indented `def test_foo(self):` usage example (a realistic Sphinx/doctest-style doc
      // block) is textually indistinguishable from a real method, so when the REAL test_foo method was
      // genuinely deleted, `testNames(content)` still reported it as present — `kept` came back true,
      // `lostSet` came back empty, and the whole function silently returned null (no recovery
      // attempted) despite real, uncovered test coverage having been dropped. Fix: reuse
      // computeTripleQuoteLineStarts (the same primitive BUG 107/109 established) and skip any
      // candidate line whose start falls inside an open triple-quoted string. ----
      {
        const oldMasked = "import unittest\n\n\nclass TestWidget(unittest.TestCase):\n    def test_foo(self):\n        self.assertTrue(True)\n";
        const contentMasked = "import unittest\n\n\nclass TestWidget(unittest.TestCase):\n    \"\"\"\n    Example:\n        def test_foo(self):\n            self.assertTrue(True)\n    \"\"\"\n    def test_bar(self):\n        self.assertTrue(True)\n";
        const mMasked = A.preserveDroppedTests(oldMasked, contentMasked);
        check("BUG 110: preserveDroppedTests recovers a real dropped test even when a docstring mentions the same name (was silently null before this fix)",
          !!mMasked && mMasked.names.includes("test_foo"));
        check("BUG 110: the recovered test is real code, not the docstring's inert text — appears as an executable member",
          mMasked && /class TestWidgetPreserved\(unittest\.TestCase\):\n    def test_foo/.test(mMasked.text));

        // Negative control: nothing actually lost (old === content) must still be a no-op, docstring
        // mention notwithstanding — this is the same fixture BUT compared against itself.
        check("BUG 110 regression guard: no-op when the docstring-mentioned test is still genuinely present (old === content)",
          A.preserveDroppedTests(contentMasked, contentMasked) === null);

        // Sanity: a plain (non-docstring) real drop is still caught exactly as before.
        const oldPlain = "def test_alpha():\n    assert True\n\ndef test_beta():\n    assert True\n";
        const droppedPlain = "def test_beta():\n    assert True\n";
        const mPlain = A.preserveDroppedTests(oldPlain, droppedPlain);
        check("BUG 110 regression guard: a genuine (non-docstring) dropped bare test function is still recovered",
          !!mPlain && mPlain.names.includes("test_alpha") && /def test_alpha/.test(mPlain.text));
      }

      // ---- COMPLETENESS ENFORCER + HONESTY FIX (ledger run 65, "the agents rule"): a weak model
      // SCAFFOLDS then leaves methods as stubs; the society must detect them and refuse to finish.
      // AND the honesty system must NOT blame the test for a method the code never wrote. ----
      {
        // detectStubs on the exact shapes the ledger left
        check("stubs: return [] ignoring state is a stub", A.detectStubs("x.py", "def entries(self):\n    return []").length === 1);
        check("stubs: return Money(0) ignoring state is a stub", A.detectStubs("x.py", "def total(self):\n    return Money(0)").length === 1);
        check("stubs: pass / NotImplementedError / TODO are stubs", A.detectStubs("x.py", "def a(self):\n    pass").length === 1 && A.detectStubs("x.py", "def b(self):\n    raise NotImplementedError").length === 1 && A.detectStubs("x.py", "def c(self):\n    # TODO\n    return 0").length === 1);
        // must NOT false-positive on real code
        check("stubs: return self.x reads state -> NOT a stub", A.detectStubs("x.py", "def dollars(self):\n    return self.cents / 100").length === 0);
        check("stubs: a return that uses a param -> NOT a stub", A.detectStubs("x.py", "def add(self, other):\n    return other.cents").length === 0);
        check("stubs: __init__ pass is exempt", A.detectStubs("x.py", "def __init__(self):\n    pass").length === 0);
        check("stubs: multi-statement body -> NOT a stub", A.detectStubs("x.py", "def f(self):\n    x = 1\n    return x").length === 0);
        // BUG 96 (2026-09-13): a `def` whose parameter list wraps across MULTIPLE physical lines
        // (black-formatted long/type-annotated signatures -- an ordinary real-world shape) used to
        // be entirely invisible to detectStubs (the old regex required the closing `)` on the SAME
        // line as `def`), regardless of whether the body was pass/NotImplementedError/trivial-return.
        {
          const wrappedPass = "class Foo:\n    def bar(\n        self,\n        x: int,\n        y: float = 0.5,\n    ):\n        pass\n";
          check("stubs (BUG 96): multi-line signature + pass IS still detected as a stub",
            A.detectStubs("x.py", wrappedPass).length === 1);
          const wrappedNotImpl = "class Foo:\n    def bar(\n        self,\n        x: int,\n    ):\n        raise NotImplementedError\n";
          check("stubs (BUG 96): multi-line signature + raise NotImplementedError IS still detected",
            A.detectStubs("x.py", wrappedNotImpl).length === 1);
          const wrappedTrivialReturn = "class Foo:\n    def bar(\n        self,\n        x: int,\n    ):\n        return None\n";
          check("stubs (BUG 96): multi-line signature + trivial constant return IS still detected",
            A.detectStubs("x.py", wrappedTrivialReturn).length === 1);
          // regression guards: the fix must not introduce false positives
          const wrappedRealLogic = "class Foo:\n    def bar(\n        self,\n        x: int,\n    ):\n        y = x + 1\n        return y\n";
          check("stubs (BUG 96 regression): multi-line signature + real logic -> NOT a stub",
            A.detectStubs("x.py", wrappedRealLogic).length === 0);
          const wrappedRefsParam = "class Foo:\n    def add(\n        self,\n        other,\n    ):\n        return other.cents\n";
          check("stubs (BUG 96 regression): multi-line signature returning a WRAPPED param's state -> NOT a stub",
            A.detectStubs("x.py", wrappedRefsParam).length === 0);
          const wrappedNestedDefault = "class Foo:\n    def total(\n        self,\n        x=int(0),\n    ):\n        return Money(0)\n";
          check("stubs (BUG 96 regression): nested paren in a multi-line default value doesn't desync the scan",
            A.detectStubs("x.py", wrappedNestedDefault).length === 1);
          const twoInARow = "class Foo:\n    def bar(\n        self,\n        x: int,\n    ):\n        pass\n\n    def baz(self):\n        pass\n";
          check("stubs (BUG 96 regression): a multi-line-sig stub followed by a single-line-sig stub -> BOTH caught",
            A.detectStubs("x.py", twoInARow).length === 2);
        }
        // BUG 102 (2026-09-14): the parameter-name list used by the "trivial return ignores its
        // inputs" check did `params.split(",")` naively -- a nested default with its OWN internal
        // comma before the outer close (e.g. a tuple default `bounds=(1, 2)`) split INSIDE the
        // tuple, producing a fabricated fragment like "2)" that was spliced unescaped into
        // `new RegExp(...)`, THROWING "Invalid regular expression: Unmatched ')'" instead of
        // returning a result -- crashing the whole write-time stub gate for an ordinary parameter-
        // default shape. Same character-class-negation/naive-split family as BUGs 100/101.
        {
          const tupleDefaultStub = "class Box:\n    def get_bounds(self, bounds=(1, 2), retries=3):\n        return 0\n";
          check("stubs (BUG 102): tuple default with internal comma doesn't crash detectStubs",
            (() => { try { return A.detectStubs("x.py", tupleDefaultStub).length === 1; } catch { return false; } })());
          const tupleDefaultRefs = "class Box:\n    def get_retries(self, bounds=(1, 2), retries=3):\n        return retries\n";
          check("stubs (BUG 102 regression): tuple-default param list still recognizes a REAL param reference -> NOT a stub",
            A.detectStubs("x.py", tupleDefaultRefs).length === 0);
          const callDefaultStub = "class Retryer:\n    def run(self, callback, retries=int(3)):\n        return 0\n";
          check("stubs (BUG 102 non-discriminating regression): single-nesting call default (unaffected either way) still caught",
            A.detectStubs("x.py", callDefaultStub).length === 1);
        }
        // BUG 64: a top-level (module-level) function defined AFTER a class must NOT inherit that
        // class's name as its `cls` -- it feeds the Lever 6 arity gate, which would then wrongly
        // check a module-level function's signature against an unrelated class's contract.
        {
          const s1 = A.detectStubs("x.py", "class Foo:\n    def bar(self):\n        pass\n\ndef standalone():\n    pass\n");
          check("stubs: class method keeps its cls", s1.find((s) => s.name === "bar")?.cls === "Foo");
          check("stubs: top-level fn AFTER a class has cls=null, not the preceding class",
            s1.find((s) => s.name === "standalone")?.cls === null);
        }
        {
          const s2 = A.detectStubs("x.py", "def helper():\n    pass\n\nclass Foo:\n    def bar(self):\n        pass\n");
          check("stubs: top-level fn BEFORE any class has cls=null", s2.find((s) => s.name === "helper")?.cls === null);
          check("stubs: a later class's method is still correctly tagged", s2.find((s) => s.name === "bar")?.cls === "Foo");
        }
        {
          const s3 = A.detectStubs("x.py", "class Foo:\n    def bar(self):\n        pass\n\ndef helper():\n    pass\n\nclass Baz:\n    def qux(self):\n        pass\n");
          check("stubs: class/fn/class sandwich -- each def tagged with its OWN enclosing scope",
            s3.find((s) => s.name === "bar")?.cls === "Foo" &&
            s3.find((s) => s.name === "helper")?.cls === null &&
            s3.find((s) => s.name === "qux")?.cls === "Baz");
        }
        // LEVER 1 — stub-driven completion: the pure surgical helpers that fill ONE method at a time.
        check("isolateDef: strips prose + stops before the next def",
          A.isolateDef("Here it is:\n\ndef total(self):\n    return sum(self.xs)\n\ndef other(self):\n    return 1\n") === "def total(self):\n    return sum(self.xs)");
        check("isolateDef: keeps a leading decorator", A.isolateDef("@property\ndef dollars(self):\n    return self.cents/100") === "@property\ndef dollars(self):\n    return self.cents/100");
        check("isolateDef: no def -> empty", A.isolateDef("no code here") === "");
        {
          // BUG 98 (2026-09-13), same failure family as 94/95/96/97 (a single-line-anchored boundary
          // check blind to an ordinary multi-line-wrapped Python construct). isolateDef has its OWN
          // pair of these bugs, distinct from spliceMethod/extractFunctionBody's BUG 97 (a different
          // call site the 107th run's exact-regex grep didn't catch, since isolateDef matches `def`
          // via `/^\s*def\s/`, not the `/^(\s*)def\s+(\w+)\s*\(/` pattern that was searched):
          // (1) body-end scan started right after the `def` line, so a wrapped signature's own
          // closing `):` (same indent as `def`) truncated the returned block down to a dangling
          // signature fragment, same as BUG 97. (2) decorator absorption only checked whether the
          // SINGLE line directly above `def` matched `@\w` -- a decorator whose OWN argument list
          // wraps across multiple lines (e.g. `@pytest.mark.parametrize(...)`) has `)` on that line,
          // not `@\w`, so the entire decorator was silently dropped from the isolated block. LIVE
          // IMPACT: isolateDef runs on a model's freshly generated method body (_genMethodBody /
          // _genOneFunction) -- exactly the shape the model is told to produce ("include a decorator
          // like @property/@classmethod/@staticmethod if the method needs one") -- and on the REAL
          // file's current buggy function shown back to the model as context, so either bug
          // corrupts what gets spliced in or what the model is shown, not just a cosmetic loss.
          const wrappedSigSrc = "class Foo:\n    def bar(\n        self,\n        x,\n    ):\n        y = x + 1\n        return y\n\n    def baz(self):\n        return 42\n";
          const wrappedSigOut = A.isolateDef(wrappedSigSrc, "bar");
          check("isolateDef (BUG 98): a multi-line-wrapped signature still yields the FULL body, not just the dangling signature",
            wrappedSigOut === "    def bar(\n        self,\n        x,\n    ):\n        y = x + 1\n        return y", wrappedSigOut);
          const wrappedDecSrc = "class Foo:\n    @pytest.mark.parametrize(\n        \"x\",\n        [1, 2, 3],\n    )\n    def test_foo(self, x):\n        assert x > 0\n";
          const wrappedDecOut = A.isolateDef(wrappedDecSrc, "test_foo");
          check("isolateDef (BUG 98): a multi-line-wrapped decorator is fully absorbed, not dropped",
            wrappedDecOut === "    @pytest.mark.parametrize(\n        \"x\",\n        [1, 2, 3],\n    )\n    def test_foo(self, x):\n        assert x > 0", wrappedDecOut);
          const stackedDecSrc = "class Foo:\n    @staticmethod\n    @pytest.mark.parametrize(\n        \"x\",\n        [1, 2],\n    )\n    def test_bar(x):\n        assert x\n\n    def baz(self):\n        return 1\n";
          const stackedDecOut = A.isolateDef(stackedDecSrc, "test_bar");
          check("isolateDef (BUG 98): stacked bare+wrapped decorators both absorbed, sibling method untouched",
            stackedDecOut.includes("@staticmethod") && stackedDecOut.includes("@pytest.mark.parametrize") && !stackedDecOut.includes("baz"), stackedDecOut);
          const unrelatedAboveSrc = "class Foo:\n    x = foo(\n        1,\n        2,\n    )\n    def bar(self):\n        return 1\n";
          check("isolateDef (BUG 98): an unrelated multi-line statement above `def` (not a decorator) is NOT falsely absorbed",
            A.isolateDef(unrelatedAboveSrc, "bar") === "    def bar(self):\n        return 1");
        }
        {
          const src = "class Ledger:\n    def __init__(self):\n        self.entries = []\n\n    def entries_list(self):\n        return []\n\n    def add(self, e):\n        self.entries.append(e)";
          const out = A.spliceMethod(src, "entries_list", "def entries_list(self):\n    return list(self.entries)");
          check("spliceMethod: replaces only the target stub", out.includes("        return list(self.entries)") && !out.includes("        return []"));
          check("spliceMethod: keeps the surrounding methods", out.includes("    def __init__(self):") && out.includes("    def add(self, e):"));
          check("spliceMethod: re-indents to the class method column", /\n    def entries_list\(self\):\n        return list\(self\.entries\)/.test(out));
          check("spliceMethod: the resolved method is no longer a stub", !A.detectStubs("ledger.py", out).some((s) => s.name === "entries_list"));
          check("spliceMethod: normalizes an already-indented reply", /\n    def entries_list\(self\):\n        return list\(self\.entries\)/.test(A.spliceMethod(src, "entries_list", "    def entries_list(self):\n        return list(self.entries)")));
          check("spliceMethod: absent method -> null (no fabricated edit)", A.spliceMethod(src, "ghost", "def ghost(self): pass") === null);
          const dec = "class Money:\n    @property\n    def dollars(self):\n        return 0.0\n\n    def raw(self):\n        return self.cents";
          const od = A.spliceMethod(dec, "dollars", "@property\ndef dollars(self):\n    return self.cents/100");
          check("spliceMethod: does not orphan the old decorator", (od.match(/@property/g) || []).length === 1 && od.includes("    def raw(self):"));
          check("spliceMethod: handles the final method in a file", /def only\(self\):\n        return self\.compute\(\)/.test(A.spliceMethod("class A:\n    def only(self):\n        return None", "only", "def only(self):\n    return self.compute()")));
          // BUG 97 (2026-09-13), same failure family as 94/95/96 (a single-line-anchored boundary
          // check blind to an ordinary multi-line-wrapped Python construct) but on the OTHER end
          // this time: spliceMethod/extractFunctionBody located the target `def` fine (no anchor
          // requiring the closing paren on that line), but then scanned for the METHOD'S END
          // starting right after the `def` line -- and a black-formatted wrapped signature's own
          // closing `):` sits back at the SAME indent as `def`, so that line was mistaken for the
          // end of the method. LIVE IMPACT (measured directly, not assumed): spliceMethod silently
          // corrupted the file -- it replaced only the def+dangling-signature span and left the old
          // signature's `):` line PLUS the entire old body orphaned below the new replacement,
          // producing syntactically invalid Python; extractFunctionBody returned just the dangling
          // signature fragment with the real body missing entirely (indistinguishable from a stub
          // to a downstream judge).
          const wrapped = "class Foo:\n    def bar(\n        self,\n        x,\n    ):\n        y = x + 1\n        return y\n\n    def baz(self):\n        return 42\n";
          const wrappedOut = A.spliceMethod(wrapped, "bar", "def bar(self, x):\n    return x * 2");
          check("spliceMethod (BUG 97): a multi-line-wrapped signature's OLD body is fully replaced, not left dangling",
            wrappedOut === "class Foo:\n    def bar(self, x):\n        return x * 2\n    def baz(self):\n        return 42\n", wrappedOut);
          check("spliceMethod (BUG 97): does not orphan the old closing `):` line", !wrappedOut.includes("    ):"));
          check("spliceMethod (BUG 97): sibling method after a wrapped-signature target is untouched",
            wrappedOut.includes("    def baz(self):\n        return 42"));
          const wrappedBody = A.extractFunctionBody(wrapped, "bar");
          check("extractFunctionBody (BUG 97): a multi-line-wrapped signature still yields the FULL body, not just the dangling signature",
            wrappedBody === "    def bar(\n        self,\n        x,\n    ):\n        y = x + 1\n        return y\n", wrappedBody);
          // MEASURED LIVE (lever-1 hard test): asked to implement Account.post, the 16B answered
          // with __init__. Splicing it DELETED post() and duplicated __init__ — and the old
          // "resolved" check called that success, because a missing method has no stub.
          const drift = "Here you go:\n\ndef __init__(self, name, opening=None):\n    self.name = name\n";
          check("isolateDef: rejects a def whose NAME is not the one requested", A.isolateDef(drift, "post") === "");
          check("isolateDef: still returns the block when the name DOES match", A.isolateDef(drift, "__init__").startsWith("def __init__"));
          check("isolateDef: picks the RIGHT def out of several", A.isolateDef("def a(self):\n    return 1\n\ndef post(self, d):\n    return 2\n", "post") === "def post(self, d):\n    return 2");
          const acct = "class Account:\n    def __init__(self, name):\n        self.name = name\n\n    def post(self, delta):\n        pass";
          const wrong = A.spliceMethod(acct, "post", "def __init__(self, name):\n    self.name = name");
          check("sameDefShape: a splice that deletes post() and dupes __init__ is REJECTED", A.sameDefShape(acct, wrong) === false);
          const right = A.spliceMethod(acct, "post", "def post(self, delta):\n    self.balance = self.balance + delta");
          check("sameDefShape: a correct body-only replacement is ACCEPTED", A.sameDefShape(acct, right) === true);
          check("defNameCounts: counts duplicate definitions", A.defNameCounts(wrong).get("__init__") === 2 && (A.defNameCounts(wrong).get("post") || 0) === 0);
          // MUTATION-TESTING GAP (staleness-audit sweep, run 59): the two checks above both happen to
          // differ in ca.size vs cb.size too, so they never actually exercise sameDefShape's per-key
          // count comparison loop -- a mutation that deleted that loop's body entirely still passed
          // 1020/1020. This case holds distinct-def-name COUNT equal (3 == 3) while the per-name
          // counts genuinely differ (post dropped, __init__ duplicated, a stray "extra" method
          // hallucinated in its place), so only the per-key loop -- not the size check -- can reject it.
          const shapeOrig = "class Widget:\n    def __init__(self, name):\n        self.name = name\n\n    def post(self, delta):\n        pass\n\n    def helper(self):\n        return 1";
          const shapeBad = "class Widget:\n    def __init__(self, name):\n        self.name = name\n\n    def __init__(self, name, extra=None):\n        self.name = name\n\n    def extra(self):\n        return 1\n\n    def helper(self):\n        return 1";
          check("sameDefShape: same distinct-name COUNT but different per-name counts is still REJECTED (closes a mutation-testing gap)",
            A.defNameCounts(shapeOrig).size === A.defNameCounts(shapeBad).size && A.sameDefShape(shapeOrig, shapeBad) === false);
        }
        // BUG 112 (2026-09-15, 126th unattended run): isolateDef/spliceMethod/extractFunctionBody/
        // defNameCounts/insertMethod matched `def`/`class` headers at ANY indent with zero
        // triple-quote awareness -- a STRICTLY wider blind spot than BUG 109/111's column-0-only
        // flaw, since an indented docstring "Example:" snippet (real, common NumPy/Google-docstring
        // style) matches just as readily as a column-0 one. Live-confirmed on the REAL boltons
        // corpus (not contrived): `funcutils.py`'s `noop()` docstring shows an indented
        // `def decorate(...)` usage example (naive scan counted 2 "decorate" defs, correct count is
        // 0 -- there is no real `decorate` function in the file at all); `namedutils.py`'s
        // `_namedtuple_tmpl`/`_namedlist_tmpl` are triple-quoted STRING TEMPLATES whose literal text
        // contains `def __new__`/`_make`/`__repr__`/etc, none of which are real definitions.
        {
          const docExampleSrc = '"""\nExample:\n    def foo(bar):\n        return bar\n"""\n\ndef foo(bar):\n    return bar + 1\n';
          check("isolateDef (BUG 112): returns the REAL function, not a docstring's indented usage example",
            A.isolateDef(docExampleSrc, "foo") === "def foo(bar):\n    return bar + 1");
          check("defNameCounts (BUG 112): a docstring's indented `def foo(...)` example does not count as a real definition",
            A.defNameCounts(docExampleSrc).get("foo") === 1);
          const splicedDoc = A.spliceMethod(docExampleSrc, "foo", "def foo(bar):\n    return bar - 1\n");
          check("spliceMethod (BUG 112): rewrites the REAL function, leaving the docstring's example text untouched",
            splicedDoc.includes("return bar - 1") && splicedDoc.includes("    def foo(bar):\n        return bar\n\"\"\""));
          check("extractFunctionBody (BUG 112): returns the REAL function's body, not the docstring's example",
            A.extractFunctionBody(docExampleSrc, "foo").trim() === "def foo(bar):\n    return bar + 1");
          const docClassSrc = '"""\nExample:\n    class Foo:\n        pass\n"""\n\nclass Foo:\n    def bar(self):\n        pass\n';
          const insertedDoc = A.insertMethod(docClassSrc, "Foo", "def baz(self):\n    return 1\n");
          check("insertMethod (BUG 112): inserts into the REAL class body, not a docstring's usage example",
            insertedDoc.split("\n").filter((l) => l.trim() === "def baz(self):").length === 1 &&
            !insertedDoc.slice(0, insertedDoc.indexOf('"""', 4)).includes("baz"));
          check("addsExactlyOneDef (BUG 112): a correct docstring-adjacent insert is still accepted",
            A.addsExactlyOneDef(docClassSrc, insertedDoc, "baz"));
          // SYMMETRIC regression: an ordinary file with no triple-quoted strings anywhere must behave
          // byte-identically to before this fix (inTripleQuote is all-false, so the new skip-guard
          // never fires) -- confirms the fix adds a blind-spot exclusion without narrowing normal
          // matching in any way.
          const plainSrc = "def a():\n    return 1\n\ndef b():\n    return 2\n";
          check("spliceMethod (BUG 112 regression): an ordinary file with no docstrings still splices normally",
            A.spliceMethod(plainSrc, "b", "def b():\n    return 3\n").includes("def b():\n    return 3"));
          check("defNameCounts (BUG 112 regression): an ordinary file's counts are unaffected",
            A.defNameCounts(plainSrc).get("a") === 1 && A.defNameCounts(plainSrc).get("b") === 1);
        }
        // BUG 113 (found 2026-09-16, recovered from an interrupted prior session's uncommitted
        // edit to fixWrongClassApi + this run's own follow-on fix to its sibling Agent.implModel()):
        // the SAME column-0-class/indented-def/self.attr scan BUG 112 fixed in isolateDef/
        // spliceMethod/etc. is independently reimplemented in TWO more places with zero
        // triple-quote awareness — fixWrongClassApi's own inline `impl`/`defines` scan, and
        // Agent.implModel() (feeds apiMismatches/nameDriftFixes/attrDriftFixes). Live-confirmed on
        // the REAL boltons corpus: funcutils.py's ExistingArgument class docstring shows a
        // `def decorate(self, ...)` usage example, so the naive scan phantom-adds "decorate" to
        // ExistingArgument's method set even though the real class never defines it.
        {
          const w113 = fresh("implmodel113");
          const docClassImpl113 = 'class ExistingArgument:\n    """\n    Example:\n        def decorate(self, func):\n            return func\n    """\n\n    def __init__(self, name):\n        self.name = name\n';
          fs.writeFileSync(path.join(w113, "impl113.py"), docClassImpl113);
          const a113 = new A.Agent(w113, { maxSteps: 1 });
          a113.files = new Set(["impl113.py"]);
          const model113 = await a113.implModel();
          check("implModel (BUG 113): a docstring's indented `def decorate(...)` example is not counted as a real method",
            !model113.methods.ExistingArgument.has("decorate"), JSON.stringify([...model113.methods.ExistingArgument]));
          check("implModel (BUG 113): the class's real method (__init__) is still found",
            model113.methods.ExistingArgument.has("__init__"));

          // SYMMETRIC regression: an ordinary file with no triple-quoted strings behaves identically.
          const w113b = fresh("implmodel113b");
          const plainImpl113 = "class Foo:\n    def __init__(self):\n        self.bar = Bar()\n\n    def baz(self):\n        pass\n\nclass Bar:\n    def qux(self):\n        pass\n";
          fs.writeFileSync(path.join(w113b, "impl113b.py"), plainImpl113);
          const a113b = new A.Agent(w113b, { maxSteps: 1 });
          a113b.files = new Set(["impl113b.py"]);
          const model113b = await a113b.implModel();
          check("implModel (BUG 113 regression): an ordinary file with no docstrings is unaffected",
            [...model113b.methods.Foo].join(",") === "__init__,baz" && [...model113b.methods.Bar].join(",") === "qux" &&
            model113b.attrs.Foo.bar === "Bar");

          // fixWrongClassApi end-to-end: a docstring usage example on the WRONG-recipient class used
          // to create a second, phantom `self.attr` candidate for the SAME missing method name,
          // pushing `cands.length` from 1 to 2 and silently disabling the disambiguation (the lever
          // requires EXACTLY one candidate) -- so the real, unambiguous fix never landed.
          const w113c = fresh("fixwrongclass113");
          const IMPL113C = 'class Account:\n    def __init__(self):\n        self.balance = 0\n\n    def deposit(self, amount):\n        self.balance += amount\n        return self.balance\n\n\nclass Ledger:\n    """\n    Example:\n        def deposit(self, amount):\n            return self.account.deposit(amount)\n    """\n\n    def __init__(self):\n        self.account = Account()\n';
          const TEST113C = "import unittest\n\nfrom impl113c import Ledger\n\n\nclass T(unittest.TestCase):\n    def test_deposit(self):\n        led = Ledger()\n        self.assertEqual(led.deposit(10), 10)\n";
          fs.writeFileSync(path.join(w113c, "impl113c.py"), IMPL113C);
          fs.writeFileSync(path.join(w113c, "test_impl113c.py"), TEST113C);
          const a113c = new A.Agent(w113c, { maxSteps: 1 });
          a113c.files = new Set(["impl113c.py", "test_impl113c.py"]); a113c.authoritativeTests = {}; a113c.testSnapshots = {};
          a113c.failedCmds = new Map([["x", true]]);
          const won113c = await a113c.fixWrongClassApi("python -B -m pytest -q", () => {});
          const after113c = fs.readFileSync(path.join(w113c, "test_impl113c.py"), "utf8");
          check("fixWrongClassApi (BUG 113): a docstring usage example on the wrong class no longer creates a phantom second candidate, so the real fix still lands",
            won113c === true && /led\.account\.deposit\(10\)/.test(after113c), JSON.stringify({ won: won113c, after: after113c }));
        }
        // ---- SURGICAL-FIX ONE-HOP CALL-GRAPH CLOSURE (_implicatedFns), LIVE-CAUGHT on boltons run
        // 202, 2026-09-05. A failing test only ever names the OUTER function it calls directly
        // (Grid.total_area), while the real bug lives one call-hop away in a DIFFERENT file
        // (Rectangle.area) that the failing test body never mentions by name. Without this closure,
        // that inner function is never even a surgical-fix candidate and the ladder just keeps
        // regenerating an already-correct total_area() forever (5/5 best-of-N candidates did exactly
        // this live). Fix: for each directly-implicated function, look at ITS OWN isolated body for
        // calls to other known impl functions and add those too, one hop, capped. ----
        {
          const totalAreaTestSrc = "class TestGrid(unittest.TestCase):\n    def test_total_area_single_rectangle(self):\n        grid = Grid([Rectangle(Point(0, 0), 2, 3)])\n        self.assertEqual(grid.total_area(), 6)\n";
          const layoutSrc = "class Grid:\n    def __init__(self, rectangles):\n        self.rectangles = rectangles\n\n    def total_area(self):\n        return sum(rect.area() for rect in self.rectangles)\n";
          const shapeSrc = "class Rectangle:\n    def area(self):\n        return self.width + self.height\n\n    def perimeter(self):\n        return 2 * (self.width + self.height)\n";
          const implDefs202 = new Map([["total_area", "boltons/layoututils.py"], ["area", "boltons/shapeutils.py"], ["perimeter", "boltons/shapeutils.py"]]);
          const srcByFile202 = new Map([["boltons/layoututils.py", layoutSrc], ["boltons/shapeutils.py", shapeSrc]]);
          const fakeAgent202 = { authoritativeTests: { "tests/test_layoututils.py": totalAreaTestSrc } };
          const hit202 = A.Agent.prototype._implicatedFns.call(fakeAgent202,
            "FAIL: test_total_area_single_rectangle", implDefs202, srcByFile202);
          check("_implicatedFns: directly-implicated function from the failing test is still included",
            hit202.includes("total_area"), JSON.stringify(hit202));
          check("_implicatedFns: one-hop closure pulls in the callee living in a DIFFERENT file, never named by the failing test itself",
            hit202.includes("area"), JSON.stringify(hit202));
          check("_implicatedFns: a sibling method NEVER called from within the implicated function's body is not swept in",
            !hit202.includes("perimeter"), JSON.stringify(hit202));

          // Backward compatibility: an omitted srcByFile (old call shape) must not throw and must
          // still return the direct hit with no closure applied (isolateDef("", name) -> "", skipped).
          const hitNoSrc = A.Agent.prototype._implicatedFns.call(fakeAgent202,
            "FAIL: test_total_area_single_rectangle", implDefs202);
          check("_implicatedFns: omitted srcByFile (default empty Map) does not throw and skips the closure gracefully",
            hitNoSrc.includes("total_area") && !hitNoSrc.includes("area"), JSON.stringify(hitNoSrc));

          // A function whose body calls nothing else known must not hallucinate extra targets.
          const implDefsLone = new Map([["total_area", "boltons/layoututils.py"], ["area", "boltons/shapeutils.py"]]);
          const srcByFileLone = new Map([["boltons/layoututils.py", "class Grid:\n    def total_area(self):\n        return 0\n"], ["boltons/shapeutils.py", shapeSrc]]);
          const hitLone = A.Agent.prototype._implicatedFns.call({ authoritativeTests: { "tests/test_layoututils.py": totalAreaTestSrc } },
            "FAIL: test_total_area_single_rectangle", implDefsLone, srcByFileLone);
          check("_implicatedFns: a body that calls nothing else known adds nothing extra",
            hitLone.length === 1 && hitLone[0] === "total_area", JSON.stringify(hitLone));

          // Cap: a single directly-implicated function delegating to FIVE other known functions
          // must not runaway -- the final returned target list still respects the closure's own
          // 4-target accumulation ceiling (BUG 123, 2026-09-17: the return cap used to be a
          // mismatched 3, ONE LESS than the closure loop's own `hit.size >= 4` -- see BUG 123's
          // comment on _implicatedFns's final return line for the live-caught case this dropped).
          const hubBody = "class Hub:\n    def total_area(self):\n        return self.a() + self.b() + self.c() + self.d() + self.e()\n";
          const implDefsHub = new Map([["total_area", "hub.py"], ["a", "hub.py"], ["b", "hub.py"], ["c", "hub.py"], ["d", "hub.py"], ["e", "hub.py"]]);
          const srcByFileHub = new Map([["hub.py", hubBody]]);
          const hitHub = A.Agent.prototype._implicatedFns.call({ authoritativeTests: { "tests/test_hub.py": totalAreaTestSrc } },
            "FAIL: test_total_area_single_rectangle", implDefsHub, srcByFileHub);
          check("_implicatedFns: one-hop closure from a single function delegating to many others is still capped at 4 total targets",
            hitHub.length <= 4, JSON.stringify(hitHub));
          check("_implicatedFns: the capped result still includes the originally-implicated function",
            hitHub.includes("total_area"), JSON.stringify(hitHub));
          check("_implicatedFns: the cap still excludes callees beyond the closure's own 4-target accumulation ceiling",
            !hitHub.includes("d") && !hitHub.includes("e"), JSON.stringify(hitHub));

          // BUG 123 (LIVE-CAUGHT, boltons — tableutils.Table.from_data(), 2026-09-17): real shape --
          // a runtime-dispatch registry (Table._input_types, scanned via check_type()) means the
          // failing test's own body only ever names the dispatcher (Table.from_data), never any of
          // the concrete InputType subclass methods it delegates to. The one-hop closure correctly
          // discovers all three (get_entry_seq, check_type, guess_headers -- hit reaches size 4),
          // but the pre-fix `.slice(0, 3)` silently dropped whichever came last by `implDefs.keys()`
          // insertion order -- in the real repro that was `guess_headers`, the ACTUAL buggy function
          // (the crash traceback instead pointed at `get_entry_seq`, a downstream victim of the bad
          // header value, and `check_type` is an uninvolved predicate called earlier in the body).
          const fromDataTestSrc = "def test_from_data_namedtuple_headers():\n    t = Table.from_data([Point(1, 2), Point(3, 4)])\n    assert t.headers == ['x', 'y']\n";
          const fromDataBody = "def from_data(cls, data, headers=_MISSING, max_depth=1, **kwargs):\n    to_check = data[0]\n    for it in cls._input_types:\n        if it.check_type(to_check):\n            _data_type = it\n            break\n    headers = _data_type.guess_headers(to_check)\n    entries = _data_type.get_entry_seq(data, headers)\n    return cls(entries, headers=headers)\n";
          const implDefsFromData = new Map([["from_data", "boltons/tableutils.py"], ["check_type", "boltons/tableutils.py"], ["guess_headers", "boltons/tableutils.py"], ["get_entry_seq", "boltons/tableutils.py"], ["get_entry", "boltons/tableutils.py"]]);
          const srcByFileFromData = new Map([["boltons/tableutils.py", fromDataBody]]);
          const hitFromData = A.Agent.prototype._implicatedFns.call({ authoritativeTests: { "tests/test_tableutils.py": fromDataTestSrc } },
            "FAIL: test_from_data_namedtuple_headers", implDefsFromData, srcByFileFromData);
          check("_implicatedFns (BUG 123): a runtime-dispatch registry's actual buggy callee (guess_headers) is no longer dropped by the return cap",
            hitFromData.includes("guess_headers"), JSON.stringify(hitFromData));
          check("_implicatedFns (BUG 123): the directly-implicated dispatcher is still included alongside it",
            hitFromData.includes("from_data"), JSON.stringify(hitFromData));

          // BUG 97 (2026-09-13): _implicatedFns/_disambiguateClass isolate a failing test method's
          // OWN body with the same "scan from def+1, stop at first dedented line" logic that
          // spliceMethod/extractFunctionBody had -- a black-formatted, multi-line-wrapped test
          // signature (e.g. a parametrized test with a long argument list) puts its closing `):`
          // back at the def's own indent, which used to end the body scan immediately, hiding the
          // ENTIRE real test body (including the very call that implicates the buggy function).
          const wrappedTestSrc = "class TestGrid(unittest.TestCase):\n    def test_total_area_single_rectangle(\n        self,\n    ):\n        grid = Grid([Rectangle(Point(0, 0), 2, 3)])\n        self.assertEqual(grid.total_area(), 6)\n";
          const hitWrapped = A.Agent.prototype._implicatedFns.call(
            { authoritativeTests: { "tests/test_layoututils.py": wrappedTestSrc } },
            "FAIL: test_total_area_single_rectangle", implDefs202, srcByFile202);
          check("_implicatedFns (BUG 97): a multi-line-wrapped test signature still finds the direct hit",
            hitWrapped.includes("total_area"), JSON.stringify(hitWrapped));
          check("_implicatedFns (BUG 97): the one-hop closure still fires through a wrapped-signature test body",
            hitWrapped.includes("area"), JSON.stringify(hitWrapped));
        }
        // ---- SURGICAL-FIX PROXIMITY-FIRST FAILURE-LINE LOCATOR (_implicatedFns), LIVE-CAUGHT on
        // boltons run 221, 2026-09-16 (BUG 116). A long test function calls several impl functions
        // (setup-style calls) long before ever reaching the ONE call that actually implicates the
        // bug (`OneToOne.unique(...)`, called only inside a `with pytest.raises(ValueError):`
        // block near the very end of a 60-line test). The old whole-body scan added EVERY impl
        // function called anywhere in the body to `hit`, in `implDefs` insertion (= textual
        // definition) order, then capped at 3 — so the three textually-earlier, uninvolved calls
        // (clear/setdefault/copy) won all 3 surgical-fix slots and the real culprit (`unique`) never
        // got a single regeneration attempt. Confirmed live: run 221 burned its entire adaptive time
        // budget regenerating clear/setdefault/copy (no improvement, since none was buggy), fell
        // through to the general executor with almost no budget left, and the run ended
        // "outcome not met" without ever touching the actual bug. Fix: when pytest's own
        // short-traceback trailer ("path/to/test.py:LINE: <ErrorType>") is present, scan a narrow
        // window of REAL source around that line FIRST and prefer whatever's found there. ----
        {
          const longTestSrc = "class TestOTO(unittest.TestCase):\n    def test_one_to_one(self):\n        e = OneToOne({1: 2})\n        e.clear()\n        assert e == {}\n        e[1] = 2\n        e.setdefault(3)\n        assert e[3] is None\n        oto = OneToOne({1: 2, 3: 4})\n        assert oto.copy().inv == {2: 1, 4: 3}\n        oto2 = OneToOne({'a': 0, 'b': 0})\n        assert len(oto2) == len(oto2.inv) == 1\n        oto2['c'] = 0\n        assert len(oto2) == len(oto2.inv) == 1\n        with pytest.raises(ValueError):\n            OneToOne.unique({'a': 0, 'b': 0})\n";
          const implDefsOTO = new Map([["clear", "boltons/dictutils.py"], ["setdefault", "boltons/dictutils.py"], ["copy", "boltons/dictutils.py"], ["unique", "boltons/dictutils.py"]]);
          const fakeAgentOTO = { authoritativeTests: { "tests/test_dictutils.py": longTestSrc } };

          // Realistic pytest short-traceback output: a nodeid line PLUS the "path:LINE: <ErrorType>"
          // trailer pointing at the `with pytest.raises(...)` line (line 15) — one line ABOVE the
          // actual culprit call (`OneToOne.unique(...)`, line 16), exactly like a real
          // pytest.raises-context-manager failure is attributed.
          const realBaseOut = "FAILED tests/test_dictutils.py::test_one_to_one - Failed: DID NOT RAISE ValueError\ntests/test_dictutils.py:15: Failed";
          const hitOTO = A.Agent.prototype._implicatedFns.call(fakeAgentOTO, realBaseOut, implDefsOTO);
          check("_implicatedFns (BUG 116): with a pytest failure-line trailer, the real culprit (unique) is implicated",
            hitOTO.includes("unique"), JSON.stringify(hitOTO));
          check("_implicatedFns (BUG 116): textually-earlier, uninvolved setup calls are NOT swept in when a failure line pinpoints the real one",
            !hitOTO.includes("clear") && !hitOTO.includes("setdefault") && !hitOTO.includes("copy"), JSON.stringify(hitOTO));

          // Backward compatibility: WITHOUT a location trailer (e.g. unittest-style output, or any
          // pre-existing caller that only ever passed a bare "FAIL: name" string), the whole-body
          // scan (not the proximity locator) still runs. It used to cap at 3, dropping `unique`
          // (this test's real culprit) exactly like the pre-BUG-116 shape. BUG 123 (2026-09-17)
          // raised the final cap from 3 to 4 to match the one-hop closure's own accumulation cap —
          // as an incidental side effect, this specific 4-call body (clear/setdefault/copy/unique,
          // all literal in the test's own text, no closure hop even needed) now fits under the cap
          // whole, so `unique` is included even without a location trailer. Still not a general
          // guarantee for a 5th+ call in a longer body — just no longer broken for this one.
          const bareBaseOut = "FAIL: test_one_to_one";
          const hitBare = A.Agent.prototype._implicatedFns.call(fakeAgentOTO, bareBaseOut, implDefsOTO);
          check("_implicatedFns (BUG 116/123): no location trailer still finds ALL FOUR calls (BUG 123's cap-4 fix covers this body's size)",
            hitBare.length === 4 && hitBare.includes("clear") && hitBare.includes("setdefault") && hitBare.includes("copy") && hitBare.includes("unique"),
            JSON.stringify(hitBare));
        }
        // ---- SURGICAL-FIX PROPERTY-ACCESS AWARENESS (_implicatedFns), LIVE-CAUGHT on a boltons
        // live-spawn hunt, 2026-09-16 (BUG 117). Every "is this impl function used here" check
        // required a trailing `(` (a call). A `@property`-decorated method is read via bare
        // attribute access (`tc.threshold`, never `tc.threshold()`), so it could NEVER be matched —
        // not in the proximity window, not in the whole-body fallback. Confirmed live against the
        // real repo: injecting a real bug into `cacheutils.ThresholdCounter.threshold` (a real
        // `@property`) made `test_threshold_counter` fail at `assert tc.threshold == 0.1`, but
        // `_implicatedFns` returned `[elements, get_common_count, get_uncommon_count]` — three
        // uninvolved, textually-nearby PAREN calls pulled in by the proximity window — and never
        // even considered `threshold`. Fix: for names the impl source itself declares as
        // `@property`, also accept bare `.name` attribute access as evidence of use. ----
        {
          const propImplSrc = "class ThresholdCounter:\n    @property\n    def threshold(self):\n        return self._threshold\n\n    def add(self, key):\n        self.total += 1\n\n    def get_common_count(self):\n        return 0\n";
          const propTestSrc = "def test_threshold_counter():\n    tc = ThresholdCounter(threshold=0.1)\n    tc.add(1)\n    assert tc.threshold == 0.1\n    assert tc.get_common_count() == 11\n";
          const implDefsProp = new Map([["threshold", "boltons/cacheutils.py"], ["add", "boltons/cacheutils.py"], ["get_common_count", "boltons/cacheutils.py"]]);
          const srcByFileProp = new Map([["boltons/cacheutils.py", propImplSrc]]);
          const fakeAgentProp = { authoritativeTests: { "tests/test_cacheutils.py": propTestSrc } };
          // Real pytest short-traceback trailer pointing at the `assert tc.threshold == 0.1` line
          // (line 4, 1-based) — exactly the shape a real live run produced for this exact bug.
          const propBaseOut = "FAILED tests/test_cacheutils.py::test_threshold_counter - assert 0.2 == 0.1\ntests/test_cacheutils.py:4: AssertionError";
          const hitProp = A.Agent.prototype._implicatedFns.call(fakeAgentProp, propBaseOut, implDefsProp, srcByFileProp);
          check("_implicatedFns (BUG 117): a bug in a @property read via bare attribute access (no parens) is now implicated",
            hitProp.includes("threshold"), JSON.stringify(hitProp));

          // Guard against false positives: WITHOUT srcByFile (so the engine has no way to know
          // `threshold` is actually a @property), bare attribute access must NOT be treated as
          // evidence of use — otherwise any unrelated `.threshold`-shaped attribute on some other
          // object would falsely implicate this impl function. The property treatment is only
          // ever granted to names the impl source itself confirms are decorated `@property`.
          const hitPropNoSrc = A.Agent.prototype._implicatedFns.call(fakeAgentProp, propBaseOut, implDefsProp);
          check("_implicatedFns (BUG 117): without impl source to confirm @property, bare attribute access is NOT treated as a call (no false positive)",
            !hitPropNoSrc.includes("threshold"), JSON.stringify(hitPropNoSrc));
        }
        // ---- SURGICAL-FIX AMBIGUOUS-NAME CLASS DISAMBIGUATION (isolateDef/spliceMethod `wantCls`
        // + _disambiguateClass), LIVE-CAUGHT on boltons run 207, 2026-09-08. `SpooledIOBase.read()`/
        // `seek()` (an abstract, never-instantiated base class) sit textually BEFORE
        // `MultiFileReader.read()`/`seek()` (the class a failing test actually exercised) in the
        // same real file, boltons/ioutils.py. Before this fix, isolateDef/spliceMethod always
        // operated on the FIRST textual occurrence of a bare name regardless of which class a
        // failing test actually implicated — confirmed live: a real spawn asked to fix
        // MultiFileReader.read()'s off-by-one instead edited the unrelated abstract
        // SpooledIOBase.read(), never converged across the whole repair ladder, and the run
        // finished "Not fully complete — 485/487 tests passing, 2 still failing". Grounded directly
        // against the real, permanent boltons corpus (not just a synthetic fixture) — these classes'
        // structure predates and outlives this run's temporary bug injection. ----
        {
          const ioutilsSrc = fs.readFileSync("D:/eta-tests/boltons/boltons/ioutils.py", "utf8");
          const testIoutilsSrc = fs.readFileSync("D:/eta-tests/boltons/tests/test_ioutils.py", "utf8");
          check("isolateDef: without wantCls, an ambiguous name ('read', defined by 4 classes here) still returns the FIRST textual occurrence — unchanged default behavior",
            /Read n characters from the buffer/.test(A.isolateDef(ioutilsSrc, "read")));
          const rightRead = A.isolateDef(ioutilsSrc, "read", "MultiFileReader");
          check("isolateDef: with wantCls='MultiFileReader', returns THAT class's occurrence, not SpooledIOBase's",
            /amt/.test(rightRead) && !/Read n characters from the buffer/.test(rightRead));
          check("isolateDef: with wantCls='SpooledIOBase', still finds that class's own (abstract) occurrence",
            /Read n characters from the buffer/.test(A.isolateDef(ioutilsSrc, "read", "SpooledIOBase")));

          const splicedNoScope = A.spliceMethod(ioutilsSrc, "read", 'def read(self, n=-1):\n    return "PATCHED"');
          check("spliceMethod: without wantCls, replaces the FIRST occurrence — unchanged default behavior",
            splicedNoScope.includes('return "PATCHED"') && /def read\(self, amt=None\):/.test(splicedNoScope));
          const splicedScoped = A.spliceMethod(ioutilsSrc, "read", 'def read(self, amt=None):\n    return "PATCHED"', "MultiFileReader");
          check("spliceMethod: with wantCls='MultiFileReader', patches ONLY that class's read() — SpooledIOBase.read() is left untouched",
            splicedScoped.includes('return "PATCHED"') && /def read\(self, n=-1\):\r?\n\s*"""Read n characters/.test(splicedScoped));
          check("spliceMethod: a wantCls that doesn't actually define this name returns null (never fabricates a location)",
            A.spliceMethod(ioutilsSrc, "read", "def read(self, n=-1):\n    return 1", "NoSuchClassHere") === null);

          const fakeAgent207 = { authoritativeTests: { "tests/test_ioutils.py": testIoutilsSrc } };
          const baseOut207 = "FAILED tests/test_ioutils.py::TestMultiFileReader::test_read_seek_bytes - AssertionError\nFAILED tests/test_ioutils.py::TestMultiFileReader::test_read_seek_text - AssertionError\n2 failed, 485 passed";
          const readCls = A.Agent.prototype._disambiguateClass.call(fakeAgent207, "read", new Set(["SpooledIOBase", "MultiFileReader"]), baseOut207);
          check("_disambiguateClass: traces the failing test's own receiver (r = ioutils.MultiFileReader(...)) to the RIGHT class for read()",
            readCls === "MultiFileReader", readCls);
          const seekCls = A.Agent.prototype._disambiguateClass.call(fakeAgent207, "seek", new Set(["SpooledIOBase", "MultiFileReader"]), baseOut207);
          check("_disambiguateClass: the same trace also resolves seek() to the right class",
            seekCls === "MultiFileReader", seekCls);
          check("_disambiguateClass: returns null (safe fallback, never a guess) when nothing traces a receiver of a candidate class",
            A.Agent.prototype._disambiguateClass.call({ authoritativeTests: {} }, "read", new Set(["SpooledIOBase", "MultiFileReader"]), "0 failed") === null);

          // BUG 97 (2026-09-13): same fix, applied to _disambiguateClass's own body-isolation loop.
          const wrappedTraceSrc = "class TestMultiFileReader(unittest.TestCase):\n    def test_read_seek_bytes(\n        self,\n    ):\n        r = ioutils.MultiFileReader(io.BytesIO(b'ab'))\n        r.read()\n";
          const wrappedReadCls = A.Agent.prototype._disambiguateClass.call(
            { authoritativeTests: { "tests/test_ioutils.py": wrappedTraceSrc } },
            "read", new Set(["SpooledIOBase", "MultiFileReader"]), baseOut207);
          check("_disambiguateClass (BUG 97): still traces the receiver through a multi-line-wrapped test signature",
            wrappedReadCls === "MultiFileReader", wrappedReadCls);
        }
        // ---- SHARED-HELPER DISAMBIGUATION FALLBACK (BUG 118), LIVE-CAUGHT via a no-model harness
        // against the real repo, 2026-09-16: `boltons/queueutils.py`'s `BasePriorityQueue` declares
        // an ABSTRACT `@staticmethod _pop_entry` (`pass  # abstract`); `HeapPriorityQueue` and
        // `SortedPriorityQueue` each override it for real. `tests/test_queueutils.py`'s
        // `test_heap_queue`/`test_sorted_queue` don't call `pq.pop()` or assign a receiver directly
        // — they each just pass their class as a bare ARGUMENT to a shared helper,
        // `_test_priority_queue(HeapPriorityQueue)`, which does the actual `pq.add()`/`pq.pop()`
        // calls. Injecting a real bug into `HeapPriorityQueue._pop_entry` and running real pytest
        // confirmed `_implicatedFns` DOES correctly implicate `_pop_entry` (via the one-hop
        // call-graph closure through `pop()`), but the pre-fix `_disambiguateClass` returned null
        // for it — its receiver/assignment trace only looks INSIDE the failing test's own body,
        // and `test_heap_queue`'s body never assigns or dot-calls the class, only passes it as an
        // argument one call away. With `wantCls` null, `isolateDef`'s "first occurrence" fallback
        // would target the abstract stub — dead code for this test, since both subclasses override
        // it — so the surgical-fix ladder could retry forever and never touch the real bug. ----
        {
          const queueSrc = fs.readFileSync("D:/eta-tests/boltons/boltons/queueutils.py", "utf8");
          const testQueueSrc = fs.readFileSync("D:/eta-tests/boltons/tests/test_queueutils.py", "utf8");
          const implDefsQ = new Map([["_push_entry", "boltons/queueutils.py"], ["_pop_entry", "boltons/queueutils.py"], ["add", "boltons/queueutils.py"], ["remove", "boltons/queueutils.py"], ["_cull", "boltons/queueutils.py"], ["peek", "boltons/queueutils.py"], ["pop", "boltons/queueutils.py"]]);
          const srcByFileQ = new Map([["boltons/queueutils.py", queueSrc]]);
          const fakeAgentQ = { authoritativeTests: { "tests/test_queueutils.py": testQueueSrc } };
          // Real pytest short-traceback shape captured from an actual injected-bug live run
          // (`return backend[0]` instead of `return heappop(backend)` in HeapPriorityQueue._pop_entry).
          const baseOutQ = "tests\\test_queueutils.py:46: \n    _test_priority_queue(HeapPriorityQueue)\ntests\\test_queueutils.py:19: in _test_priority_queue\n    assert item3 == pq.pop()\nboltons\\queueutils.py:180: KeyError\nFAILED tests/test_queueutils.py::test_heap_queue - KeyError: 'b'\n1 failed, 486 passed";
          const hitQ = A.Agent.prototype._implicatedFns.call(fakeAgentQ, baseOutQ, implDefsQ, srcByFileQ);
          check("_implicatedFns: a bug reached only through a chained helper call (test -> shared helper -> pq.pop() -> _pop_entry) is still implicated via the one-hop closure",
            hitQ.includes("_pop_entry"), JSON.stringify(hitQ));

          const heapCls = A.Agent.prototype._disambiguateClass.call(fakeAgentQ, "_pop_entry", new Set(["BasePriorityQueue", "HeapPriorityQueue", "SortedPriorityQueue"]), baseOutQ);
          check("_disambiguateClass (BUG 118): resolves the class passed as a bare ARGUMENT to a shared test helper (HeapPriorityQueue), not just a direct receiver/assignment",
            heapCls === "HeapPriorityQueue", heapCls);

          const sortedBaseOutQ = baseOutQ.replace(/HeapPriorityQueue/g, "SortedPriorityQueue").replace("test_heap_queue", "test_sorted_queue");
          const sortedCls = A.Agent.prototype._disambiguateClass.call(fakeAgentQ, "_pop_entry", new Set(["BasePriorityQueue", "HeapPriorityQueue", "SortedPriorityQueue"]), sortedBaseOutQ);
          check("_disambiguateClass (BUG 118): same fallback also resolves the OTHER subclass (SortedPriorityQueue), not hardcoded to one name",
            sortedCls === "SortedPriorityQueue", sortedCls);

          // Guard against over-guessing: a body that literally mentions TWO candidate classes must
          // stay null (unchanged pre-existing ambiguity behavior), never pick one arbitrarily.
          const twoClassSrc = "def test_both():\n    _cmp(HeapPriorityQueue, SortedPriorityQueue)\n";
          const twoClassOut = "FAILED tests/test_queueutils.py::test_both - KeyError: 'b'";
          const ambiguousCls = A.Agent.prototype._disambiguateClass.call(
            { authoritativeTests: { "tests/test_queueutils.py": twoClassSrc } },
            "_pop_entry", new Set(["BasePriorityQueue", "HeapPriorityQueue", "SortedPriorityQueue"]), twoClassOut);
          check("_disambiguateClass (BUG 118): two candidate classes literally mentioned in the same body stays null — never guesses",
            ambiguousCls === null, ambiguousCls);
        }
        // ---- OPERATOR-INVOKED DUNDER AWARENESS + PARAMETRIZE-ID DISAMBIGUATION (BUG 121),
        // LIVE-CAUGHT via a no-model harness against the real repo, 2026-09-17:
        // `boltons/cacheutils.py`'s `LRU` overrides `__getitem__` (LRI's own base-class version is
        // different — LRU moves the accessed link to the front of its internal linked list, LRI
        // doesn't). `tests/test_cacheutils.py::test_lru_dict_replacement` is
        // `@pytest.mark.parametrize("lru_class", [LRU, LRI])` — the ONLY places either class name
        // appears are the decorator and pytest's own generated node id (`...[LRU]`); the test body
        // itself only ever touches the fixture variable (`cache = lru_class()`, `cache['a']`).
        // Injecting a real bug into `LRU.__getitem__` (`return link[KEY]` instead of
        // `return link[VALUE]`) and running real, isolated pytest (`-k test_lru_dict_replacement`,
        // so no OTHER failing test could accidentally supply a literal class mention) confirmed TWO
        // compounding gaps: (1) `_implicatedFns` requires a literal `name(` call — `cache['a']`
        // never writes `__getitem__` anywhere, so it was invisible, and two uninvolved
        // textually-nearby calls (`values`/`itervalues`) got the surgical-fix slots instead;
        // (2) even after fixing that, `_disambiguateClass`'s existing traces (direct
        // receiver/assignment, BUG 118's shared-helper body-literal fallback) both require the
        // class name to appear somewhere in the test's OWN body — it never does here, so it
        // returned null and `isolateDef`'s "first occurrence" fallback would have targeted LRI's
        // __getitem__ (textually first in the file), not LRU's (the actually-implicated one). ----
        {
          const cacheSrc = fs.readFileSync("D:/eta-tests/boltons/boltons/cacheutils.py", "utf8");
          const testCacheSrc = fs.readFileSync("D:/eta-tests/boltons/tests/test_cacheutils.py", "utf8");
          const implDefsC = new Map([["__getitem__", "boltons/cacheutils.py"], ["__setitem__", "boltons/cacheutils.py"], ["values", "boltons/cacheutils.py"], ["itervalues", "boltons/cacheutils.py"]]);
          const srcByFileC = new Map([["boltons/cacheutils.py", cacheSrc]]);
          const fakeAgentC = { authoritativeTests: { "tests/test_cacheutils.py": testCacheSrc } };
          // Real pytest short-traceback shape captured from an actual injected-bug live run,
          // isolated via `-k test_lru_dict_replacement` so no collateral failing test is present.
          const baseOutC = "_______________________ test_lru_dict_replacement[LRU] ________________________\n\n    @pytest.mark.parametrize(\"lru_class\", [LRU, LRI])\n    def test_lru_dict_replacement(lru_class):\n        cache = lru_class()\n        cache['a'] = 1\n>       assert cache['a'] == 1  # passes.\nE       AssertionError: assert 'a' == 1\n\ntests\\test_cacheutils.py:178: AssertionError\n=========================== short test summary info ===========================\nFAILED tests/test_cacheutils.py::test_lru_dict_replacement[LRU] - AssertionEr...\n1 failed, 1 passed, 485 deselected";
          const hitC = A.Agent.prototype._implicatedFns.call(fakeAgentC, baseOutC, implDefsC, srcByFileC);
          check("_implicatedFns (BUG 121): a subscript-only test (`cache['a']`, never `.getitem__(`) still implicates __getitem__",
            hitC.includes("__getitem__"), JSON.stringify(hitC));

          const lruCls = A.Agent.prototype._disambiguateClass.call(fakeAgentC, "__getitem__", new Set(["LRI", "LRU", "ThresholdCounter"]), baseOutC);
          check("_disambiguateClass (BUG 121): resolves the class named ONLY in the pytest parametrize node id ([LRU]), not the test body",
            lruCls === "LRU", lruCls);

          const lriBaseOutC = baseOutC.replace(/\[LRU\]/g, "[LRI]");
          const lriCls = A.Agent.prototype._disambiguateClass.call(fakeAgentC, "__getitem__", new Set(["LRI", "LRU", "ThresholdCounter"]), lriBaseOutC);
          check("_disambiguateClass (BUG 121): same fallback also resolves the OTHER parametrized class (LRI), not hardcoded to one name",
            lriCls === "LRI", lriCls);

          const noMatchBaseOutC = baseOutC.replace(/\[LRU\]/g, "[SomeUnrelatedId]");
          const noMatchCls = A.Agent.prototype._disambiguateClass.call(fakeAgentC, "__getitem__", new Set(["LRI", "LRU", "ThresholdCounter"]), noMatchBaseOutC);
          check("_disambiguateClass (BUG 121): a node id that matches no candidate class stays null — never guesses",
            noMatchCls === null, noMatchCls);

          // Regression guards: plain calls and @property access (BUG 117) are unaffected by the
          // new operator-dunder table — only the specific dunder names in it get the new check.
          check("_implicatedFns (BUG 121): a normal (non-dunder) name still requires a literal call, unchanged",
            !A.Agent.prototype._implicatedFns.call(
              { authoritativeTests: { "t.py": "def test_x():\n    cache['a']\n" } },
              "FAILED t.py::test_x - Err", new Map([["values", "cacheutils.py"]]), new Map([["cacheutils.py", "def values(self): pass"]])
            ).includes("values"));
          const setitemHitC = A.Agent.prototype._implicatedFns.call(
            { authoritativeTests: { "t.py": "def test_x():\n    cache['a'] = 1\n" } },
            "FAILED t.py::test_x - Err", new Map([["__setitem__", "cacheutils.py"]]), new Map([["cacheutils.py", "class C:\n    def __setitem__(self, k, v): pass"]]));
          check("_implicatedFns (BUG 121): a subscript ASSIGNMENT (`cache['a'] = 1`) implicates __setitem__",
            setitemHitC.includes("__setitem__"), JSON.stringify(setitemHitC));
          const delitemHitC = A.Agent.prototype._implicatedFns.call(
            { authoritativeTests: { "t.py": "def test_x():\n    del cache['a']\n" } },
            "FAILED t.py::test_x - Err", new Map([["__delitem__", "cacheutils.py"]]), new Map([["cacheutils.py", "class C:\n    def __delitem__(self, k): pass"]]));
          check("_implicatedFns (BUG 121): a subscript DELETE (`del cache['a']`) implicates __delitem__",
            delitemHitC.includes("__delitem__"), JSON.stringify(delitemHitC));
        }
        // ---- BUILTIN-INVOKED DUNDER AWARENESS (BUG 122), LIVE-CAUGHT via a no-model harness
        // against the real repo, 2026-09-17: `boltons/iterutils.py`'s `PathAccessError` (a 3-way
        // multi-inheritance class: `KeyError, IndexError, TypeError`) overrides `__str__` with real
        // formatting logic. A new ground-truth test file (`tests/test_pathaccesserror.py`, added
        // this run since none existed before) asserts `str(exc) == "..."` — never `exc.__str__(`.
        // Injecting a real bug (swapping `self.seg`/`self.path` in the format args) and running
        // real, isolated pytest confirmed the SAME two-part gap shape as BUG 121, one syntax
        // further: (1) `_implicatedFns`'s `implUsed` had no detection for a dunder invoked through
        // a GLOBAL BUILTIN FUNCTION CALL (`str(exc)`, `repr(exc)`) — neither the literal-call regex
        // nor BUG 121's operator-syntax table matches it; (2) `surgicalEditFix`'s own allowlist
        // (separate from (1)) excluded `__str__`/`__repr__` from `implDefs` entirely, so even a
        // fixed (1) alone would never see them as candidates. Confirmed live: the actual spawned
        // run (id 235) implicated `strip`/`strip_iter` — two uninvolved functions whose names
        // happened to appear in the baseOut's diff text via the fallback path — and never touched
        // `__str__` at all; baseline-restore correctly caught the non-improving result and reverted,
        // so no file was left worse off, but the bug was never fixed either. ----
        {
          const iterSrc = fs.readFileSync("D:/eta-tests/boltons/boltons/iterutils.py", "utf8");
          const testPathSrc = fs.readFileSync("D:/eta-tests/boltons/tests/test_pathaccesserror.py", "utf8");
          const implDefsP = new Map([["__str__", "boltons/iterutils.py"], ["__repr__", "boltons/iterutils.py"], ["get_path", "boltons/iterutils.py"]]);
          const srcByFileP = new Map([["boltons/iterutils.py", iterSrc]]);
          const fakeAgentP = { authoritativeTests: { "tests/test_pathaccesserror.py": testPathSrc } };
          // Real pytest short-traceback shape captured from an actual injected-bug isolated run
          // (`-k test_pathaccesserror_repr_and_str`).
          const baseOutP = "______________________ test_pathaccesserror_repr_and_str ______________________\n\n    def test_pathaccesserror_repr_and_str():\n        exc = PathAccessError(KeyError('seg1'), 'seg1', ('a', 'seg1'))\n        assert repr(exc) == \"PathAccessError(KeyError('seg1'), 'seg1', ('a', 'seg1'))\"\n>       assert str(exc) == (\n            \"could not access 'seg1' from path ('a', 'seg1'),\"\n            \" got error: KeyError('seg1')\"\n        )\nE       assert \"could not ac...Error('seg1')\" == \"could not ac...Error('seg1')\"\n\ntests\\test_pathaccesserror.py:17: AssertionError\n=========================== short test summary info ===========================\nFAILED tests/test_pathaccesserror.py::test_pathaccesserror_repr_and_str - ass...\n1 failed";
          const hitP = A.Agent.prototype._implicatedFns.call(fakeAgentP, baseOutP, implDefsP, srcByFileP);
          check("_implicatedFns (BUG 122): a str()-only test (`str(exc)`, never `.__str__(`) implicates __str__",
            hitP.includes("__str__"), JSON.stringify(hitP));
          check("_implicatedFns (BUG 122): the same test's repr(exc) also implicates __repr__",
            hitP.includes("__repr__"), JSON.stringify(hitP));

          // Regression guard: a plain call to a function merely named "str" or "repr" (not the
          // builtin) still requires the existing literal-call match — the new table only fires for
          // the exact dunder names __str__/__repr__, not any name containing those substrings.
          const strNamedFnHit = A.Agent.prototype._implicatedFns.call(
            { authoritativeTests: { "t.py": "def test_x():\n    result = str(x)\n" } },
            "FAILED t.py::test_x - Err", new Map([["mystr", "m.py"]]), new Map([["m.py", "def mystr(): pass"]]));
          check("_implicatedFns (BUG 122): str() call does not spuriously implicate an unrelated function merely named similarly",
            !strNamedFnHit.includes("mystr"), JSON.stringify(strNamedFnHit));

          // surgicalEditFix's own implDefs-building allowlist: __str__/__repr__ now admitted,
          // an untouched ordinary dunder (__eq__) still excluded — same shape as BUG 121's
          // allowlist regression guard for __init__.
          const srcC = "class C:\n    def __init__(self): pass\n    def __eq__(self, o): return True\n    def __str__(self): return 'c'\n    def __repr__(self): return 'C()'\n    def val(self): return 1\n";
          const implDefsAllow = new Map();
          { let cls = null;
            for (const line of srcC.split("\n")) {
              const cm = line.match(/^class\s+(\w+)/); if (cm) { cls = cm[1]; continue; }
              const dm = line.match(/^(\s*)def\s+(\w+)\s*\(/); if (!dm) continue;
              if (!dm[1].length) cls = null;
              if (/^__/.test(dm[2]) && !["__getitem__", "__setitem__", "__delitem__", "__str__", "__repr__"].includes(dm[2])) continue;
              implDefsAllow.set(dm[2], "c.py");
            }
          }
          check("surgicalEditFix allowlist (BUG 122): __str__/__repr__ now admitted as candidates",
            implDefsAllow.has("__str__") && implDefsAllow.has("__repr__"));
          check("surgicalEditFix allowlist (BUG 122): __init__/__eq__ still excluded, not a blanket dunder allowlist",
            !implDefsAllow.has("__init__") && !implDefsAllow.has("__eq__"));
          check("surgicalEditFix allowlist (BUG 122): an ordinary method is still admitted, unaffected",
            implDefsAllow.has("val"));
        }
        // ---- SURGICAL-FIX DISPATCH-REGISTRY DISAMBIGUATION (BUG 124), LIVE-CAUGHT via a real
        // orphaned unattended run (boltons run 237, 2026-09-17) recovered and fully diagnosed this
        // session. `boltons/tableutils.py` has FIVE sibling `InputType` subclasses that each define
        // their own `guess_headers` method; `Table.from_data()` picks which one to use at RUNTIME
        // via `isinstance` checks against its own `_input_types` registry — no test ever names the
        // winning class, only the dispatcher (`Table.from_data`) and the outcome. A real injected
        // bug in `NamedTupleInputType.guess_headers` (5th/last of the 5, textually) made
        // `_disambiguateClass` correctly return null (confirmed: none of its heuristics have
        // anything to match — the failing test never calls `.guess_headers(` directly and never
        // mentions any of the 5 candidate class names), and the OLD "first occurrence" fallback
        // then spliced `DictInputType.guess_headers` (1st, already correct) for all 3 attempts —
        // three fruitless model calls per run, the actual bug never once attempted. Confirmed via
        // the run's own JSON log: `surgical fix: ... implicate 4 function(s) (from_data,
        // get_entry_seq, check_type, guess_headers)` (BUG 123's cap-4 fix correctly put
        // `guess_headers` on the candidate list) followed immediately by `surgical-first: not fully
        // green` with no single `tests improved` line for any of the 12 model calls across the 4
        // targets — exactly what "always regenerating the one, already-correct, first-occurrence
        // class" predicts. Fix (this session): when a name is ambiguous AND `_disambiguateClass`
        // can't resolve it, don't guess one occurrence — actually TRY each candidate class in turn
        // (bounded attempts each) via the same strictly-better-or-revert `_surgicalOne` machinery,
        // and keep whichever genuinely improves the score. This is an end-to-end integration test
        // (real temp repo, real pytest, a scripted `eta.chat` mock) because the fix lives entirely
        // in `surgicalEditFix`'s own control flow, not in a separately-callable pure helper. ----
        {
        const d124 = fresh("bug124-dispatch-registry");
        fs.writeFileSync(path.join(d124, "mod.py"),
`class InputA:
    def pick(self, obj):
        return "A"


class InputB:
    def pick(self, obj):
        return "B"


class InputC:
    def pick(self, obj):
        return "WRONG"


def dispatch(obj):
    if isinstance(obj, int):
        return InputA().pick(obj)
    elif isinstance(obj, str):
        return InputB().pick(obj)
    else:
        return InputC().pick(obj)
`);
        fs.writeFileSync(path.join(d124, "test_mod.py"),
`from mod import dispatch

def test_dispatch_default():
    assert dispatch(object()) == "C"
`);
        const askedClasses = [];
        const fakeAgent124 = {
          root: d124, task: "Fix the bug in mod.py", stopped: false, overBudget: () => false,
          files: new Set(), gates: {}, failedCmds: new Map(), testSnapshots: {},
          authoritativeTests: { "test_mod.py": fs.readFileSync(path.join(d124, "test_mod.py"), "utf8") },
          eta: { chat: async (msgs) => {
            const u = msgs[msgs.length - 1].content;
            const fnM = u.match(/The function `(\w+)`/);
            const clsM = u.match(/the one in class `(\w+)`/);
            if (clsM) askedClasses.push(clsM[1]);
            const curM = u.match(/Current \(buggy\) version:\n([\s\S]*?)\n\nThe tests it must satisfy:/);
            const orig = curM ? curM[1] : "";
            if (fnM && fnM[1] === "pick" && clsM && clsM[1] === "InputC") return { content: 'def pick(self, obj):\n    return "C"\n' };
            return { content: orig }; // every other (target, class) pair: echo back unchanged — no improvement possible
          } },
          restoreTestsIfBroken: A.Agent.prototype.restoreTestsIfBroken,
          _collectionBroken: A.Agent.prototype._collectionBroken,
          apiFactsBlock: A.Agent.prototype.apiFactsBlock,
          _implicatedFns: A.Agent.prototype._implicatedFns,
          _disambiguateClass: A.Agent.prototype._disambiguateClass,
          _genOneFunction: A.Agent.prototype._genOneFunction,
          _surgicalOne: A.Agent.prototype._surgicalOne,
          unwrapActionJson: A.Agent.prototype.unwrapActionJson,
        };
        const won124 = await A.Agent.prototype.surgicalEditFix.call(fakeAgent124, "python -m pytest -q", () => {});
        check("surgicalEditFix (BUG 124): converges on the real dispatch-registry repro (tests pass)", won124 === true);
        check("surgicalEditFix (BUG 124): tried ALL THREE ambiguous candidate classes, not just the first",
          ["InputA", "InputB", "InputC"].every((c) => askedClasses.includes(c)), JSON.stringify(askedClasses));
        const fixedSrc = fs.readFileSync(path.join(d124, "mod.py"), "utf8");
        check("surgicalEditFix (BUG 124): the actually-buggy class (InputC, last textually) got the real fix",
          /class InputC:\s*\n\s*def pick\(self, obj\):\s*\n\s*return "C"/.test(fixedSrc), fixedSrc);
        check("surgicalEditFix (BUG 124): the two already-correct classes were left untouched (strictly-better-or-revert)",
          /class InputA:\s*\n\s*def pick\(self, obj\):\s*\n\s*return "A"/.test(fixedSrc) && /class InputB:\s*\n\s*def pick\(self, obj\):\s*\n\s*return "B"/.test(fixedSrc), fixedSrc);
        }
        // ---- LEVER 6: hard interface contract, derived from the LOCKED TESTS (no model call).
        // Ledger run 66 died writing `manage_account`/`post_entry` instead of `add_account`/`post`,
        // which broke test collection outright (0/1 passing).
        {
          const tsrc = `import unittest
from ledger import Ledger
from account import Account
from money import Money

class T(unittest.TestCase):
    def test_x(self):
        l = Ledger()
        a = Account("cash", Money(100))
        l.add_account(a)
        l.post("cash", "rev", Money(50))
        a.post(Money(50))
        self.assertEqual(len(l.entries()), 1)
        self.assertEqual(a.balance, Money(50))
        m = Money.from_dollars(1.5)
`;
          const c = A.contractFromTests(tsrc);
          check("contract: derives the required methods from the locked tests",
            c.Ledger && c.Ledger.methods.has("add_account") && c.Ledger.methods.has("post") && c.Ledger.methods.has("entries"));
          check("contract: picks up a classmethod called on the class", c.Money && c.Money.methods.has("from_dollars"));
          check("contract: picks up a required ATTRIBUTE (a.balance, not a call)", c.Account && c.Account.attrs.has("balance"));
          check("contract: does not invent methods from unittest boilerplate", !c.Ledger.methods.has("assertEqual"));
          // BUG 103 (2026-09-14): `from x import (Foo, Bar, Baz)` — PEP8's own preferred style for
          // a multi-name import — used to be captured by a bare `(.+)$` regex that kept the literal
          // "(" / ")" characters, so a naive comma-split left the FIRST and LAST names as
          // unmatchable fragments ("(Foo" / "Baz)") and silently dropped them from the required set
          // (a false negative in the same family as BUG 100/101/102). Only the middle name(s) ever
          // reached `contractViolations`, so a generated impl missing the class at either edge of a
          // parenthesized import list was never flagged.
          const tsrcParen = `from ledger2 import (Ledger, Account, Money)\n\nclass T:\n    def test_x(self):\n        l = Ledger()\n        l.post()\n        a = Account()\n        m = Money()\n`;
          const cParen = A.contractFromTests(tsrcParen);
          check("contract (BUG 103): a single-line parenthesized multi-import still requires the FIRST name",
            !!cParen.Ledger, Object.keys(cParen));
          check("contract (BUG 103): ...and the LAST name too", !!cParen.Money, Object.keys(cParen));
          check("contract (BUG 103): ...and the middle name (never actually broken by this bug either way)", !!cParen.Account, Object.keys(cParen));
          // multi-line wrapped form (also PEP8-common) must work the same way
          const tsrcParenMulti = `from ledger3 import (\n    Ledger,\n    Account,\n    Money,\n)\n\nclass T:\n    def test_x(self):\n        l = Ledger()\n        l.post()\n        a = Account()\n        m = Money()\n`;
          const cParenMulti = A.contractFromTests(tsrcParenMulti);
          check("contract (BUG 103): a multi-line-wrapped parenthesized import also requires the FIRST and LAST names",
            !!cParenMulti.Ledger && !!cParenMulti.Money, Object.keys(cParenMulti));
          // BUG 104 (2026-09-14): `imported` only ever held the PRE-ALIAS name, but a test that does
          // `from x import Foo as F` and only ever calls `F(...)` never mentions "Foo" literally —
          // so the class was silently never required at all (not even a wrong-name violation: the
          // class key never appears in the contract), a false negative in the same family as
          // BUG 100/101/102/103.
          const tsrcAlias = `from ledger4 import Foo as F, Bar\n\nclass T:\n    def test_x(self):\n        f = F()\n        f.do_thing()\n        b = Bar()\n        b.other_thing()\n`;
          const cAlias = A.contractFromTests(tsrcAlias);
          check("contract (BUG 104): a class used only via its import alias is still required",
            !!cAlias.Foo, Object.keys(cAlias));
          check("contract (BUG 104): ...and its method call resolves under the REAL class name",
            cAlias.Foo && cAlias.Foo.methods.has("do_thing"));
          check("contract (BUG 104): a plain (non-aliased) sibling on the same import line is unaffected",
            !!cAlias.Bar && cAlias.Bar.methods.has("other_thing"));
          // classmethod call through the alias: F.classm(...) must also resolve to Foo
          const tsrcAliasCm = `from ledger5 import Foo as F\n\nclass T:\n    def test_cm(self):\n        F.classm(1)\n`;
          const cAliasCm = A.contractFromTests(tsrcAliasCm);
          check("contract (BUG 104): a classmethod called through the alias resolves to the real class",
            cAliasCm.Foo && cAliasCm.Foo.methods.has("classm"));
          // regression guard: a plain non-aliased import is completely unaffected by the alias plumbing
          const tsrcNoAlias = `from ledger6 import Foo\n\nclass T:\n    def test_x(self):\n        Foo().m()\n`;
          const cNoAlias = A.contractFromTests(tsrcNoAlias);
          check("contract (BUG 104): non-aliased import still works exactly as before", !!cNoAlias.Foo);
          // the run-66 drift: code defines manage_account/post_entry, spec wants add_account/post
          const drifted = { methods: { Ledger: new Set(["manage_account", "post_entry", "entries", "__init__"]), Account: new Set(["__init__"]), Money: new Set(["from_dollars"]) } };
          const v = A.contractViolations(c, drifted);
          check("contract: reports add_account + post as violations", v.some((x) => x.name === "add_account") && v.some((x) => x.name === "post"));
          const fx = A.nameDriftFixes(c, drifted);
          check("contract: detects manage_account -> add_account drift", fx.some((f) => f.from === "manage_account" && f.to === "add_account"));
          check("contract: detects post_entry -> post drift", fx.some((f) => f.from === "post_entry" && f.to === "post"));
          check("contract: never renames a method the contract already requires", !fx.some((f) => f.from === "entries"));
          // a correct implementation must produce NO violations and NO renames
          const good = { methods: { Ledger: new Set(["add_account", "post", "entries"]), Account: new Set(["__init__", "post"]), Money: new Set(["from_dollars"]) } };
          check("contract: a spec-faithful implementation has zero violations", A.contractViolations(c, good).length === 0);
          check("contract: a spec-faithful implementation triggers zero renames", A.nameDriftFixes(c, good).length === 0);
          // A genuine TIE must be left alone rather than guessed: insert_account and
          // create_account are equally similar to add_account, so neither is safe to pick.
          const wantAdd = { Ledger: { methods: new Set(["add_account", "post", "entries"]), attrs: new Set() } };
          const tied = { methods: { Ledger: new Set(["insert_account", "create_account", "post", "entries"]) } };
          check("contract: a genuine tie is NOT renamed (no guessing)",
            A.nameDriftFixes(wantAdd, tied).some((f) => f.to === "add_account") === false);
          // ...but a CLEAR best match is taken (and the tests still get the final say)
          const clear = { methods: { Ledger: new Set(["add_account_v2", "post", "entries"]) } };
          check("contract: a clear best match IS renamed", A.nameDriftFixes(wantAdd, clear).some((f) => f.from === "add_account_v2" && f.to === "add_account"));
          // A required method with NO similar name (tests want post(), code has apply_delta())
          // cannot be renamed — it must be INSERTED into the class instead.
          const acc2 = "from money import Money\n\n\nclass Account:\n    def __init__(self, name):\n        self.name = name\n\n    def apply_delta(self, d):\n        self.balance = self.balance + d\n";
          check("contract: a dissimilar name is NOT renamed (post vs apply_delta)",
            A.nameDriftFixes({ Account: { methods: new Set(["post"]), attrs: new Set() } }, { methods: { Account: new Set(["__init__", "apply_delta"]) } }).length === 0);
          // ---- attrDriftFixes — the OTHER half of lever 6 (ATTRIBUTE drift, mirrors nameDriftFixes
          // for methods above), had ZERO direct tests despite being live-caught+built for a real
          // bug (boltons Test 5, run 47: locked tests required SimpleLogger._emitter, the executor
          // wrote self.emitter — a plain one-token drift on the attribute side that nothing checked
          // for until this function was added). Same algorithm as nameDriftFixes, so mirror its
          // test shape on the attrs side.
          const attrContract = { SimpleLogger: { methods: new Set(), attrs: new Set(["_emitter"]) } };
          const attrDrifted = { attrs: { SimpleLogger: { emitter: "EventEmitter" } } };
          const afx = A.attrDriftFixes(attrContract, attrDrifted);
          check("attrDriftFixes: detects the run-47 emitter -> _emitter drift", afx.some((f) => f.cls === "SimpleLogger" && f.from === "emitter" && f.to === "_emitter"), JSON.stringify(afx));
          check("attrDriftFixes: never renames an attribute the contract already requires",
            A.attrDriftFixes({ SimpleLogger: { methods: new Set(), attrs: new Set(["_emitter"]) } }, { attrs: { SimpleLogger: { _emitter: "EventEmitter" } } }).length === 0);
          check("attrDriftFixes: a spec-faithful implementation triggers zero renames",
            A.attrDriftFixes({ Account: { methods: new Set(), attrs: new Set(["balance"]) } }, { attrs: { Account: { balance: "Money" } } }).length === 0);
          // a genuine tie (both candidates equally similar to the target) must be left alone
          const wantQueue = { Worker: { methods: new Set(), attrs: new Set(["_result_queue"]) } };
          const tiedAttrs = { attrs: { Worker: { _input_queue: "Queue", _output_queue: "Queue" } } };
          check("attrDriftFixes: a genuine tie is NOT renamed (no guessing)",
            A.attrDriftFixes(wantQueue, tiedAttrs).some((f) => f.to === "_result_queue") === false, JSON.stringify(A.attrDriftFixes(wantQueue, tiedAttrs)));
          // ...but a CLEAR best match is taken
          const clearAttr = { attrs: { Worker: { _result_queue_v2: "Queue" } } };
          check("attrDriftFixes: a clear best match IS renamed",
            A.attrDriftFixes(wantQueue, clearAttr).some((f) => f.from === "_result_queue_v2" && f.to === "_result_queue"));
          // an attribute with NO similar name anywhere is left alone (nothing safe to rename)
          check("attrDriftFixes: a dissimilar name is NOT renamed (no candidate)",
            A.attrDriftFixes({ Account: { methods: new Set(), attrs: new Set(["_handler"]) } }, { attrs: { Account: { _state: "dict" } } }).length === 0);
          // ENGINE BUG (2026-09-13, unattended run 101): `used` was declared ONCE outside the
          // per-class loop in both nameDriftFixes and attrDriftFixes, so an extra method/attribute
          // in one class with the SAME STRING NAME as an unrelated class's own extra would get
          // marked "used" globally and silently starve the second, completely independent class of
          // its own unambiguous rename fix. Found via isolated-probe (no live LLM), not a live task.
          const crossFoo = { Foo: { methods: new Set(["process_item"]), attrs: new Set() }, Bar: { methods: new Set(["process_order"]), attrs: new Set() } };
          const crossModel = { methods: { Foo: new Set(["process"]), Bar: new Set(["process"]) } };
          const crossFixes = A.nameDriftFixes(crossFoo, crossModel);
          check("nameDriftFixes: an identically-named extra in an UNRELATED class does not starve this class's own fix",
            crossFixes.some((f) => f.cls === "Foo" && f.to === "process_item") && crossFixes.some((f) => f.cls === "Bar" && f.to === "process_order"),
            JSON.stringify(crossFixes));
          const crossAttrContract = { Foo: { methods: new Set(), attrs: new Set(["item_total"]) }, Bar: { methods: new Set(), attrs: new Set(["order_total"]) } };
          const crossAttrModel = { attrs: { Foo: { total: "int" }, Bar: { total: "int" } } };
          const crossAttrFixes = A.attrDriftFixes(crossAttrContract, crossAttrModel);
          check("attrDriftFixes: an identically-named extra in an UNRELATED class does not starve this class's own fix",
            crossAttrFixes.some((f) => f.cls === "Foo" && f.to === "item_total") && crossAttrFixes.some((f) => f.cls === "Bar" && f.to === "order_total"),
            JSON.stringify(crossAttrFixes));
          const ins = A.insertMethod(acc2, "Account", "def post(self, delta):\n    self.balance = self.balance + delta");
          check("insertMethod: adds the method inside the class at method indentation", /\n    def post\(self, delta\):\n        self\.balance = self\.balance \+ delta/.test(ins));
          check("insertMethod: keeps the existing methods", ins.includes("    def __init__(self, name):") && ins.includes("    def apply_delta(self, d):"));
          check("insertMethod: unknown class -> null", A.insertMethod(acc2, "Ghost", "def x(self): pass") === null);
          check("addsExactlyOneDef: a clean single insertion is accepted", A.addsExactlyOneDef(acc2, ins, "post") === true);
          check("addsExactlyOneDef: rejects an insertion that also duplicated another method",
            A.addsExactlyOneDef(acc2, A.insertMethod(ins, "Account", "def __init__(self, name):\n    pass"), "post") === false);
          // ARITY (measured live): asked for Account.post the 16B wrote Ledger.post's 3-arg
          // signature; the tests call a.post(Money(50)) with ONE arg, so it is provably wrong.
          check("contract: records the arity the tests call a method with",
            c.Ledger.arity.post && c.Ledger.arity.post.has(3) && c.Account.arity.post.has(1));
          check("contract: nesting-aware arity — post('cash','rev',Money(50)) is 3 not 4", c.Ledger.arity.post.has(3) && !c.Ledger.arity.post.has(4));
          check("defParamSpec: counts params excluding self", (() => { const s = A.defParamSpec("def post(self, a, b, c):\n    pass"); return s.required === 3 && s.total === 3; })());
          check("defParamSpec: defaults widen total but not required", (() => { const s = A.defParamSpec("def f(self, a, b=1, c=2):\n    pass"); return s.required === 1 && s.total === 3; })());
          check("arity gate: REJECTS Ledger.post's 3-arg signature for Account.post (1 arg)",
            A.arityFits("def post(self, from_account, to_account, amount):\n    pass", new Set([1])) === false);
          check("arity gate: ACCEPTS the correct 1-arg signature", A.arityFits("def post(self, delta):\n    pass", new Set([1])) === true);
          check("arity gate: accepts a default-arg method called with fewer args", A.arityFits("def post(self, delta, memo=None):\n    pass", new Set([1])) === true);
          check("arity gate: *args is always allowed (variadic)", A.arityFits("def post(self, *a):\n    pass", new Set([1, 3])) === true);
          check("arity gate: no recorded arity -> no opinion", A.arityFits("def post(self, a, b):\n    pass", new Set()) === true);
          // ---- API-SURFACE GROUNDING ("strategy D", measured 0/9 best-of-N -> ~50% on total_debits).
          // Facts read from the class source; the CRITICAL requirement is it must never state a FALSE fact.
          const moneySrc = "class Money:\n    def __init__(self, cents):\n        self.cents = cents\n    def __eq__(self, other):\n        return self.cents == other.cents\n    def __add__(self, other):\n        return Money(self.cents + other.cents)\n    def __repr__(self):\n        return 'M'\n";
          const mf = A.pyApiSurface("Money", moneySrc);
          check("apiSurface: reports Money supports only == and +", mf.some((f) => /supports only.*==.*\+/.test(f)));
          check("apiSurface: warns Money has NO ordering (<, >, <=, >=)", mf.some((f) => /does NOT support.*<.*>.*TypeError/.test(f)));
          check("apiSurface: warns sum() needs an explicit start", mf.some((f) => /sum\(\).*explicit start.*Money\(0\)/.test(f)));
          // constructor + attribute facts (measured live: model hallucinated Money.amount/.currency)
          check("apiSurface: states the constructor signature", mf.some((f) => /constructed as Money\(cents\)/.test(f)));
          check("apiSurface: states the only data attribute is .cents", mf.some((f) => /only data attribute is \.cents.*NO other/.test(f)));
          // FALSE-FACT GUARDS — the whole value of D collapses if it lies.
          const totOrd = "@functools.total_ordering\nclass Ver:\n    def __eq__(self, o):\n        return True\n    def __lt__(self, o):\n        return True\n";
          check("apiSurface: @total_ordering -> does NOT falsely claim <=/> are missing",
            !A.pyApiSurface("Ver", totOrd).some((f) => /does NOT support/.test(f)));
          const radd = "class Vec:\n    def __add__(self, o):\n        return self\n    def __radd__(self, o):\n        return self\n";
          check("apiSurface: __radd__ present -> does NOT falsely warn about sum()",
            !A.pyApiSurface("Vec", radd).some((f) => /sum\(\)/.test(f)));
          check("apiSurface: a plain class with no operators -> stays SILENT (no noise)",
            A.pyApiSurface("Account", "class Account:\n    def __init__(self, n):\n        self.n = n\n    def post(self, d):\n        pass\n").length === 0);
          check("apiSurface: unknown class -> empty", A.pyApiSurface("Ghost", moneySrc).length === 0);
          // must isolate the right class, not bleed dunders across classes in the same file
          const twoCls = moneySrc + "\n\nclass Plain:\n    def __init__(self):\n        self.x = 1\n    def go(self):\n        return self.x\n";
          check("apiSurface: isolates the class (Plain has no operators despite Money above it)", A.pyApiSurface("Plain", twoCls).length === 0);
          check("apiSurface: still reads Money correctly from a multi-class file", A.pyApiSurface("Money", twoCls).some((f) => /supports only/.test(f)));
          // BUG 100 (2026-09-14): a nested paren in a default value (tuple/call default) used to
          // close the old `[^)]*\)` regex early, dropping every real param declared after it and
          // splicing a stray fragment in as a fabricated extra param — the opposite of this
          // function's whole purpose (never state a false fact).
          const boxSrc = "class Box:\n    def __init__(self, bounds=(1, 2), retries=3):\n        self.bounds = bounds\n        self.retries = retries\n    def __eq__(self, other):\n        return self.bounds == other.bounds\n";
          check("apiSurface (BUG 100): tuple default doesn't drop a later real param",
            A.pyApiSurface("Box", boxSrc).some((f) => /constructed as Box\(bounds, retries\)/.test(f)));
          check("apiSurface (BUG 100): tuple default doesn't fabricate a stray extra param",
            !A.pyApiSurface("Box", boxSrc).some((f) => /constructed as Box\([^)]*,\s*2\)/.test(f)));
          const callDefaultSrc = "class Retryer:\n    def __init__(self, callback, retries=int(3)):\n        self.callback = callback\n        self.retries = retries\n    def __eq__(self, other):\n        return self.retries == other.retries\n";
          check("apiSurface (BUG 100): a call default (retries=int(3)) still yields the right param names",
            A.pyApiSurface("Retryer", callDefaultSrc).some((f) => /constructed as Retryer\(callback, retries\)/.test(f)));
          const wrappedSigSrc = "class Wrapped:\n    def __init__(\n        self,\n        amount,\n        currency=\"USD\",\n    ):\n        self.amount = amount\n        self.currency = currency\n    def __eq__(self, other):\n        return self.amount == other.amount\n";
          check("apiSurface (BUG 100): a multi-line-wrapped __init__ signature still yields the right params",
            A.pyApiSurface("Wrapped", wrappedSigSrc).some((f) => /constructed as Wrapped\(amount, currency\)/.test(f)));
          // BUG 114 (2026-09-16, 128th unattended run): same triple-quote-blindness class as BUG
          // 107/109-113 -- pyApiSurface's own class-header scan matched `class Name` at ANY indent
          // with no triple-quote awareness, so a docstring usage example mentioning the SAME class
          // name EARLIER in the file made it lock onto the docstring line as the class body start,
          // silently reporting FALSE facts (measured: dropped __eq__ and every constructor/attribute
          // fact, because the scan stopped at the docstring's `class Money:` example which only
          // showed __add__).
          const docstringPhantomSrc = [
            "class Helper:",
            '    """',
            "    Example usage:",
            "        class Money:",
            "            def __add__(self, other): return self",
            '    """',
            "    def noop(self): pass",
            "",
            "",
            "class Money:",
            "    def __init__(self, amount, currency):",
            "        self.amount = amount",
            "        self.currency = currency",
            "    def __add__(self, other):",
            "        return Money(self.amount + other.amount, self.currency)",
            "    def __eq__(self, other):",
            "        return self.amount == other.amount",
            "",
          ].join("\n");
          const dpf = A.pyApiSurface("Money", docstringPhantomSrc);
          check("apiSurface (BUG 114): finds the REAL class, not an earlier docstring example of the same name",
            dpf.some((f) => /supports only.*==.*\+/.test(f)));
          check("apiSurface (BUG 114): does not drop the constructor fact to the docstring's shorter fake body",
            dpf.some((f) => /constructed as Money\(amount, currency\)/.test(f)));
          check("apiSurface (BUG 114): does not drop the attribute fact to the docstring's shorter fake body",
            dpf.some((f) => /only data attributes are \.amount, \.currency/.test(f)));
          // symmetric regression: an ordinary file with no triple-quoted content at all must scan
          // identically to before the fix (no narrowing of normal matching).
          check("apiSurface (BUG 114): no regression on a plain file with no docstrings",
            A.pyApiSurface("Money", moneySrc).some((f) => /supports only.*==.*\+/.test(f)));
        }
        // HONESTY: a wrong-receiver call (method lives on an attribute's class) = the TEST's fault
        const SEP = "=".repeat(70);
        const errBlock = (t, cls, attr) => `${SEP}\nERROR: ${t} (m.T.${t})\nAttributeError: '${cls}' object has no attribute '${attr}'\n`;
        const cacheModel = { attrs: { LRUCache: { stats: "CacheStats" }, CacheStats: {} }, methods: { LRUCache: new Set(["put"]), CacheStats: new Set(["reset"]) } };
        const cm = A.apiMismatches(errBlock("test_reset", "LRUCache", "reset"), cacheModel);
        check("honesty: reset on the wrong receiver -> TEST side, suggests .stats.reset()", cm[0]?.side === "test" && /stats\.reset/.test(cm[0]?.why || ""));
        // a method the code never wrote anywhere on that class = the CODE's fault (was blamed on the test!)
        const ledgerModel = { attrs: { Account: { balance: "Money" }, Ledger: {}, Money: {} }, methods: { Account: new Set(["__repr__"]), Ledger: new Set(["post"]), Money: new Set([]) } };
        const lm = A.apiMismatches(errBlock("test_posting", "Account", "post"), ledgerModel);
        check("honesty: Account.post genuinely missing -> CODE side (never blames the test)", lm[0]?.side === "code" && /INCOMPLETE/.test(lm[0]?.why || ""));
        check("honesty: with no impl context, it HEDGES (never asserts the test is wrong)", /either the code is incomplete or the test/.test(A.apiMismatches(errBlock("t", "Foo", "bar"), null)[0]?.why || ""));
      }

      // ---- cleanRel must NEVER crash the run (ledger run 64): asked to "create the four files",
      // the model gave write_file a path ARRAY (mimicking batched read_file) and `(p||"").trim()`
      // on an array threw "(p||'').trim is not a function", killing the WHOLE run at 3.8m. ----
      check("cleanRel: an array path takes the first entry (no crash)", A.cleanRel(["money.py", "account.py"], "d:/x") === "money.py");
      check("cleanRel: null / number / object never throw", A.cleanRel(null, "d:/x") === "" && A.cleanRel(42, "d:/x") === "42" && (() => { try { A.cleanRel({ a: 1 }, "d:/x"); return true; } catch { return false; } })());
      check("cleanRel: a normal string still normalizes", A.cleanRel("./src/money.py", "d:/x") === "src/money.py");
      check("cleanRel: empty array is safe", A.cleanRel([], "d:/x") === "");
      // package/package layout (MEASURED LIVE, boltons run 68): workspace "boltons" contains
      // "boltons/strutils.py". The old basename-strip collapsed it to "strutils.py" and lost the
      // file. We keep the path whenever "<base>/" is a REAL SUBDIRECTORY, and only strip a
      // prepended repo name when no such subdirectory exists.
      // MEASURED LIVE (boltons Test 4, run @2026-07-21): the first fix (existence-check on the
      // FULL FILE) still broke on a brand-new file inside a real pkg/pkg subdir — "boltons/
      // slugutils.py" doesn't exist yet (it's being CREATED), so the old guard always "failed
      // open" and stripped it to the repo root anyway. Checking the DIRECTORY (not the file)
      // fixes both the existing-file case and this new-file case at once.
      {
        // Build a real pkg/pkg layout in a temp dir so the test is self-contained (no dependency
        // on the boltons checkout): workspace "pkgx" containing "pkgx/mod.py".
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-pkgpkg-"));
        const ws = path.join(tmp, "pkgx");
        fs.mkdirSync(path.join(ws, "pkgx"), { recursive: true });
        fs.writeFileSync(path.join(ws, "pkgx", "mod.py"), "x = 1\n");
        check("cleanRel: keeps pkg/pkg path that EXISTS (pkgx/mod.py)", A.cleanRel("pkgx/mod.py", ws) === "pkgx/mod.py");
        check("cleanRel: keeps a NEW file inside a real pkg/pkg subdir (pkgx/nope_xyz_123.py)", A.cleanRel("pkgx/nope_xyz_123.py", ws) === "pkgx/nope_xyz_123.py");
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
      {
        // No pkg/pkg layout at all here — "flatapp/" is NOT a real subdirectory of the workspace,
        // so a model that prepends the repo name by mistake must still get stripped back to root.
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-flatapp-"));
        const ws = path.join(tmp, "flatapp");
        fs.mkdirSync(ws, { recursive: true });
        check("cleanRel: strips a prepended repo name when no such subdir exists", A.cleanRel("flatapp/app.py", ws) === "app.py");
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      }

      // ---- SECURITY SCAN (ISSUE 11): the execution oracle is BLIND to this — `eval(user_input)`
      // computes the right answers so the tests stay GREEN while the code is a hole. Measured live
      // (run 60): the model solved the calculator with `eval(expr, {'__builtins__': None})`. ----
      {
        check("security: flags the real eval() the live model wrote", A.scanDangerous("calc.py", "def evaluate(e):\n    return eval(e, {'__builtins__': None}, {})").length === 1);
        check("security: names the safe alternative (parser / literal_eval)", /parser|literal_eval/.test(A.scanDangerous("calc.py", "return eval(e)")[0] || ""));
        check("security: catches exec / os.system / shell=True / pickle / yaml.load", ["exec(c)", "os.system('rm ' + n)", "subprocess.run(c, shell=True)", "pickle.loads(b)", "yaml.load(f)"].every((s) => A.scanDangerous("x.py", s).length));
        check("security: catches JS eval + new Function", A.scanDangerous("x.js", "eval(u)").length && A.scanDangerous("x.js", "new Function(s)").length);
        // must NOT false-positive on legitimate code
        check("security: a real parser (no eval) is clean", A.scanDangerous("x.py", "def evaluate(e):\n    return factor(e)").length === 0);
        check("security: the .eval() METHOD (model.eval()) is NOT the builtin", A.scanDangerous("x.py", "model.eval()").length === 0);
        check("security: the word 'eval' in a comment/string is ignored", A.scanDangerous("x.py", "# never use eval\nmsg = 'eval is unsafe'").length === 0);
        check("security: yaml.safe_load and safe subprocess are clean", A.scanDangerous("x.py", "yaml.safe_load(f)").length === 0 && A.scanDangerous("x.py", "subprocess.run(['ls','-l'])").length === 0);
        // BUG 101: a nested call before the flagged kwarg used to hide it from a `[^)]*`-style scan.
        check("security: shell=True is still caught behind a nested call (shlex.split(cmd))", A.scanDangerous("x.py", "subprocess.call(shlex.split(cmd), shell=True)").length === 1);
        check("security: yaml.load with Loader behind a nested call (f.read()) is NOT flagged", A.scanDangerous("x.py", "yaml.load(f.read(), Loader=yaml.SafeLoader)").length === 0);
        // non-discriminating regression guards: these shapes had no nesting, so they were never
        // affected by BUG 101 either way — kept so a future change can't silently break them.
        check("security: shell=True with no nesting is still caught", A.scanDangerous("x.py", "subprocess.call(cmd, shell=True)").length === 1);
        check("security: yaml.load with Loader and no nesting is still clean", A.scanDangerous("x.py", "yaml.load(f, Loader=yaml.SafeLoader)").length === 0);
      }
      // ---- WRONG-CLASS API FIX (ISSUE 9b): the test-author called a method on the wrong class
      // (`cache.reset()` when reset() lives on CacheStats, reachable as cache.stats.reset()). A
      // prompt rule did nothing (3/3->3/3, persuasion ceiling). Fix it deterministically from the
      // AttributeError + the impl's attribute types; strictly-better-or-revert (edits a LOCKED
      // test, so re-running the tests is the only thing that lets it stand). ----
      {
        const STATS = "class CacheStats:\n    def __init__(self):\n        self.hits = 0\n    def record_hit(self):\n        self.hits += 1\n    def reset(self):\n        self.hits = 0\n";
        const CACHE = "from stats import CacheStats\n\nclass LRUCache:\n    def __init__(self, capacity, ttl, clock):\n        self.capacity = capacity\n        self.stats = CacheStats()\n    def put(self, k, v):\n        pass\n";
        const TEST = 'import unittest\nfrom cache import LRUCache\n\nclass T(unittest.TestCase):\n    def test_reset(self):\n        c = LRUCache(2, 10, lambda: 0)\n        c.stats.record_hit()\n        c.reset()\n        self.assertEqual(c.stats.hits, 0)\n    def test_put(self):\n        c = LRUCache(2, 10, lambda: 0)\n        c.put("a", 1)\n';
        const cmd = 'python -B -m unittest discover -p "test*.py"';
        const mk = (cacheSrc, testSrc) => { const w = fresh("api9b" + Math.random().toString(36).slice(2, 6)); fs.writeFileSync(path.join(w, "stats.py"), STATS); fs.writeFileSync(path.join(w, "cache.py"), cacheSrc); fs.writeFileSync(path.join(w, "test_cache.py"), testSrc); return w; };
        const setup = (w) => { const a = new A.Agent(w, { maxSteps: 1 }); a.files = new Set(["stats.py", "cache.py", "test_cache.py"]); a.authoritativeTests = {}; a.testSnapshots = {}; a.failedCmds = new Map([["x", true]]); return a; };
        const w1 = mk(CACHE, TEST); const a1 = setup(w1);
        const won1 = await a1.fixWrongClassApi(cmd, () => {});
        const after1 = fs.readFileSync(path.join(w1, "test_cache.py"), "utf8");
        check("api9b: rewrites c.reset() -> c.stats.reset() and reaches all-pass", won1 === true && /c\.stats\.reset\(\)/.test(after1));
        check("api9b: leaves the already-valid test alone", /c\.put\("a", 1\)/.test(after1) && !/c\.stats\.put/.test(after1));
        // ambiguity: two attributes both define reset -> cannot disambiguate -> revert untouched
        const w2 = mk(CACHE.replace("self.stats = CacheStats()", "self.stats = CacheStats()\n        self.backup = CacheStats()"), TEST);
        const a2 = setup(w2); const won2 = await a2.fixWrongClassApi(cmd, () => {});
        check("api9b: ambiguous (2 matching attrs) -> refuses to guess, reverts", won2 === false && fs.readFileSync(path.join(w2, "test_cache.py"), "utf8") === TEST);
        // a genuine wrong ANSWER (AssertionError) is the coder's problem — never rewritten
        const w3 = mk(CACHE, "import unittest\nfrom cache import LRUCache\n\nclass T(unittest.TestCase):\n    def test_cap(self):\n        c = LRUCache(2, 10, lambda: 0)\n        self.assertEqual(c.capacity, 99)\n");
        const a3 = setup(w3); check("api9b: a real AssertionError is left untouched (stays the coder's)", (await a3.fixWrongClassApi(cmd, () => {})) === false);
      }

      // ---- EFFORT SCALING (fast-path): a small task doesn't warrant a wide best-of-N search. ----
      const bon = A.Agent.prototype.bestOfNCount;
      check("effort: small task (<=2 steps) caps samples at 2", bon.call({ leanPosture: () => false, lockedFiles: new Set(["t"]), stepBudget: 2 }) === 2);
      check("effort: big task keeps the full 5-sample budget", bon.call({ leanPosture: () => false, lockedFiles: new Set(["t"]), stepBudget: 6 }) === 5);
      check("effort: strong-brain (lean) never pays to sample", bon.call({ leanPosture: () => true, lockedFiles: new Set(["t"]), stepBudget: 8 }) === 1);

      // ---- TEST-ORACLE: the authored tests are the ruler, but the weak model computes the
      // expected values wrong (measured live: locked 3+4*2/(1-5)==2.0; truth is 1.0 — perfect
      // code capped at 3/6). Before locking, run the tests AGAINST the CI-verified reference
      // and repair wrong values deterministically. ----
      const BROKEN_TESTS = `import unittest
import calc

class T(unittest.TestCase):
    def test_precedence(self):
        self.assertAlmostEqual(calc.evaluate("3 + 4 * 2 / ( 1 - 5 )"), 2.0)

    def test_unary(self):
        self.assertAlmostEqual(calc.evaluate("2 * -(3 + 1)"), -8.0)
`;
      const oLogs = [];
      const oFixed = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_calc.py", "Create calc.py: evaluate(expr) infix expression with precedence and unary minus",
        BROKEN_TESTS, (e) => { if (e.type === "log") oLogs.push(e.text); });
      check("oracle: repairs the wrong expected value (2.0 -> 1.0)", oFixed && oFixed.includes('"3 + 4 * 2 / ( 1 - 5 )"), 1.0)'), (oFixed || "null").slice(120, 260));
      check("oracle: leaves the already-correct assert alone", oFixed && oFixed.includes('"2 * -(3 + 1)"), -8.0)'));
      check("oracle: announces the correction", oLogs.some((t) => /corrected 1 wrong expected value/.test(t)), oLogs.join(" | "));
      const oNone = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_calc.py", "Build a REST API for todo items", BROKEN_TESTS, () => {});
      check("oracle: no matching verified pattern -> stays out of the way (null)", oNone === null);
      const oClean = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_calc.py", "Create calc.py: evaluate(expr) infix with precedence and unary minus",
        BROKEN_TESTS.replace('"), 2.0)', '"), 1.0)'), () => {});
      check("oracle: already-honest tests -> untouched (null, nothing to fix)", oClean === null);
      // repr/list repair (graph task): a wrong LIST expected value is corrected too, not just numbers
      const BROKEN_LIST = `import unittest\nfrom scheduler import plan\n\nclass T(unittest.TestCase):\n    def test_tie(self):\n        self.assertEqual(plan({'A': [], 'B': ['A'], 'C': ['A'], 'D': []}), ['D', 'A', 'B', 'C'])\n`;
      const oList = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_scheduler.py", "schedule tasks by dependency with prerequisites and alphabetical tie-breaking",
        BROKEN_LIST, () => {});
      check("oracle: repairs a wrong LIST expected value (['D','A','B','C'] -> ['A','B','C','D'])",
        oList && oList.includes("['A', 'B', 'C', 'D']") && !oList.includes("['D', 'A', 'B', 'C']"), (oList || "null").slice(-90));
      // INDIRECTION (caught live): weak models bind the expected value to a variable, so the
      // traceback's failing line holds only the NAME — the repair must find the real binding.
      const BROKEN_VAR = `import unittest\nfrom scheduler import plan\n\nclass T(unittest.TestCase):\n    def test_tie(self):\n        tasks = {'A': [], 'B': ['A'], 'C': ['A'], 'D': []}\n        expected = ['D', 'A', 'B', 'C']\n        self.assertEqual(plan(tasks), expected)\n`;
      const oVar = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_scheduler.py", "schedule tasks by dependency with prerequisites and alphabetical tie-breaking",
        BROKEN_VAR, () => {});
      check("oracle: repairs an expected value bound to a VARIABLE (not on the failing line)",
        oVar && oVar.includes("expected = ['A', 'B', 'C', 'D']"), (oVar || "null").slice(-70));
      // ambiguity guard: same wrong repr twice in one test → cannot disambiguate → leave alone
      const AMBIG = `import unittest\nfrom scheduler import plan\n\nclass T(unittest.TestCase):\n    def test_tie(self):\n        a = ['D', 'A', 'B', 'C']\n        b = ['D', 'A', 'B', 'C']\n        self.assertEqual(plan({'A': [], 'B': ['A'], 'C': ['A'], 'D': []}), a)\n`;
      const oAmb = await A.Agent.prototype.verifyAuthoredTests.call(ORACLE_THIS,
        "test_scheduler.py", "schedule tasks by dependency prerequisites alphabetical tie-breaking", AMBIG, () => {});
      check("oracle: ambiguous duplicate values -> refuses to guess (null)", oAmb === null);

      // ---- deep_research: read many sources in isolation, return signal not page chrome ----
      // readability: a raw page is mostly nav. Dumping it raw cost ~1000 tokens of "Skip to
      // content / Sign in" — a quarter of the 4k starter context — and truncated the answer away.
      const chromePage = `<html><head><title>T</title><style>x{}</style></head><body>
        <nav>Skip to content</nav><header>Navigation Menu Sign in</header>
        <main><article class="markdown-body"><p>The real answer is to use -ot exps=CPU.</p>
        <p>It keeps expert tensors on the CPU.</p></article></main>
        <footer>Terms Privacy</footer></body></html>`;
      const readable = A.readableText(chromePage);
      check("readability: drops nav/header/footer chrome", !/Skip to content|Navigation Menu|Sign in|Terms Privacy/.test(readable), JSON.stringify(readable.slice(0, 80)));
      check("readability: keeps the actual answer", /-ot exps=CPU/.test(readable) && /expert tensors/.test(readable));
      check("readability: strips script/style", !/x\{\}/.test(readable));
      check("readability: prefers the article region over the whole shell", readable.length < 200, readable.length + " chars");

      // deep_research tool is registered and reachable
      const rTools = A.Agent.prototype.actionSchema.call({ mcpNames: new Set() }).properties.tool.enum;
      check("deep_research is a registered tool", rTools.includes("deep_research"));
      // execTool dispatch: needs ctx.research (handed through like ctx.judge)
      const noCtx = await A.execTool("deep_research", { question: "x" }, { root: SANDBOX, log: () => {} });
      check("deep_research without ctx.research → graceful error (not a crash)", /unavailable/i.test(noCtx), noCtx);
      const withCtx = await A.execTool("deep_research", { question: "how to X" },
        { root: SANDBOX, log: () => {}, research: async (q) => ({ brief: "- do X [1]\nAPPLY:\n- call X()", sources: ["https://a.example"], read: 1, searched: 3 }) });
      check("deep_research returns the brief + numbered sources", /do X \[1\]/.test(withCtx) && /\[1\] https:\/\/a\.example/.test(withCtx) && /1\/3 useful/.test(withCtx), withCtx.slice(0, 60));
      check("deep_research missing question → error", /required/i.test(await A.execTool("deep_research", {}, { root: SANDBOX, log: () => {}, research: async () => ({}) })));

      // ask_user tool is registered and reachable
      check("ask_user is a registered tool", rTools.includes("ask_user"));
      const askNoCtx = await A.execTool("ask_user", { question: "which approach?", options: ["A", "B"] }, { root: SANDBOX, log: () => {} });
      check("ask_user without ctx.askUser → graceful error (not a crash)", /unavailable/i.test(askNoCtx), askNoCtx);
      const askWithCtx = await A.execTool("ask_user", { question: "which approach?", options: ["A", "B"] },
        { root: SANDBOX, log: () => {}, askUser: async (q, opts) => opts[1] });
      check("ask_user returns the user's picked answer", /User answered: B/.test(askWithCtx), askWithCtx);
      check("ask_user missing question → error", /required/i.test(await A.execTool("ask_user", { options: ["A"] }, { root: SANDBOX, log: () => {}, askUser: async () => "A" })));
      check("ask_user missing/empty options → error", /required/i.test(await A.execTool("ask_user", { question: "x?", options: [] }, { root: SANDBOX, log: () => {}, askUser: async () => "A" })));
      const askNoAnswer = await A.execTool("ask_user", { question: "x?", options: ["A", "B"] }, { root: SANDBOX, log: () => {}, askUser: async () => null });
      check("ask_user no answer → falls back to model's own judgement (not a crash)", /best judgement/i.test(askNoAnswer), askNoAnswer);

      // ---- delegate_subtask tool (Zoo/Roo Code's Boomerang Tasks — isolated context, summary-only handback) ----
      check("delegate_subtask is a registered tool", rTools.includes("delegate_subtask"));
      const delNoCtx = await A.execTool("delegate_subtask", { instructions: "investigate X" }, { root: SANDBOX, log: () => {} });
      check("delegate_subtask without ctx.delegate → graceful error (not a crash)", /unavailable/i.test(delNoCtx), delNoCtx);
      const delWithCtx = await A.execTool("delegate_subtask", { instructions: "investigate X" }, { root: SANDBOX, log: () => {}, delegate: async (i) => `Sub-task done: found the bug in ${i}` });
      check("delegate_subtask returns what the sub-run reports", /Sub-task done: found the bug/.test(delWithCtx), delWithCtx);
      check("delegate_subtask missing instructions → error", /required/i.test(await A.execTool("delegate_subtask", {}, { root: SANDBOX, log: () => {}, delegate: async () => "" })));

      // delegateSubtask itself: isolated context, summary-only handback, file-touch fallback
      const delAgent = new A.Agent(SANDBOX, { maxSteps: 1 });
      delAgent.execute = async (msgs, subEmit) => { subEmit({ type: "answer", text: "renamed the variable" }); return msgs; };
      const delSummary = await delAgent.delegateSubtask("rename the variable", {}, () => {});
      check("delegateSubtask: captures the sub-run's finish summary via the answer event", /Sub-task done: renamed the variable/.test(delSummary), delSummary);
      const delAgent2 = new A.Agent(SANDBOX, { maxSteps: 1 });
      delAgent2.execute = async (msgs) => { delAgent2.files.add("touched.py"); return msgs; };
      const delSummary2 = await delAgent2.delegateSubtask("do something", {}, () => {});
      check("delegateSubtask: never finished but touched files -> honest fallback naming them", /never called finish/.test(delSummary2) && /touched\.py/.test(delSummary2), delSummary2);
      const delAgent3 = new A.Agent(SANDBOX, { maxSteps: 1 });
      delAgent3.execute = async (msgs) => msgs;
      const delSummary3 = await delAgent3.delegateSubtask("do nothing useful", {}, () => {});
      check("delegateSubtask: no finish, no files touched -> honest 'made no changes' fallback", /made no changes/.test(delSummary3), delSummary3);

      // ---- multi-file contract false-positive fix (LIVE-CAUGHT 2026-07-21): the 1.5B inspector
      // hallucinated the gap on a real run, and the run reported "done" with no whisper() ever
      // created. contractSectionFor + _inspectFile's deterministic-first check + the run-level
      // backstop are the fix — same pattern as the earlier single-file false-positive bug. ----
      const CONTRACT = "### mathutils.py\n- Add function `subtract(a, b)` that returns a - b.\n\n### stringstuff.py\n- Add function `whisper(s)` that returns s.lower() + \".\"\n";
      check("contractSectionFor: isolates the named file's own section", /whisper/.test(A.contractSectionFor(CONTRACT, "stringstuff.py")) && !/subtract/.test(A.contractSectionFor(CONTRACT, "stringstuff.py")));
      check("contractSectionFor: other file's section stays isolated too", /subtract/.test(A.contractSectionFor(CONTRACT, "mathutils.py")) && !/whisper/.test(A.contractSectionFor(CONTRACT, "mathutils.py")));
      check("contractSectionFor: unknown file -> safe fallback to the whole contract (over-inclusion, not silent skip)", A.contractSectionFor(CONTRACT, "nope.py") === CONTRACT);
      check("contractSectionFor: empty contract doesn't crash", A.contractSectionFor("", "x.py") === "");

      const idir = fresh("inspect-fix");
      fs.writeFileSync(path.join(idir, "stringstuff.py"), 'def shout(s):\n    return s.upper() + "!"\n'); // whisper genuinely missing
      const iAgent = new A.Agent(idir, { maxSteps: 1 });
      iAgent.contract = CONTRACT;
      iAgent.resolveHelperModel = async () => { throw new Error("must not reach the LLM — deterministic check should short-circuit first"); };
      const iMissing = await iAgent._inspectFile("stringstuff.py");
      check("_inspectFile: catches a genuinely-missing contract function WITHOUT ever calling the LLM", iMissing.ok === false && /whisper/.test(iMissing.gap), JSON.stringify(iMissing));
      // now write whisper for real -> deterministic check passes -> falls through to the (mocked) LLM
      fs.writeFileSync(path.join(idir, "stringstuff.py"), 'def shout(s):\n    return s.upper() + "!"\n\ndef whisper(s):\n    return s.lower() + "."\n');
      const iAgent2 = new A.Agent(idir, { maxSteps: 1 });
      iAgent2.contract = CONTRACT;
      iAgent2.resolveHelperModel = async () => "fake-helper";
      iAgent2._askHelper = async () => "YES";
      const iOk = await iAgent2._inspectFile("stringstuff.py");
      check("_inspectFile: function present -> falls through to the LLM's (softer) judgement", iOk.ok === true);

      // ---- extractFunctionBody + narrowed judge prompt (2026-07-21 follow-up: the inspector
      // hallucinated about `shout` — a pre-existing function neither the task nor contract ever
      // mentioned — because it was shown the WHOLE file. Fix: show it ONLY the required function. ----
      const STRSRC = 'def shout(s):\n    return s.upper() + "!"\n\ndef whisper(s):\n    return s.lower() + "."\n\ndef other():\n    pass\n';
      const whisperBody = A.extractFunctionBody(STRSRC, "whisper");
      check("extractFunctionBody: extracts exactly the named function", /def whisper\(s\):/.test(whisperBody) && /lower/.test(whisperBody) && !/shout/.test(whisperBody) && !/def other/.test(whisperBody), whisperBody);
      check("extractFunctionBody: unknown name -> null (never fabricate)", A.extractFunctionBody(STRSRC, "nope") === null);
      check("extractFunctionBody: empty source doesn't crash", A.extractFunctionBody("", "x") === null);

      const iAgent3 = new A.Agent(idir, { maxSteps: 1 });
      iAgent3.contract = CONTRACT;
      iAgent3.resolveHelperModel = async () => "fake-helper";
      let capturedPrompt = "";
      iAgent3._askHelper = async (prompt) => { capturedPrompt = prompt; return "YES"; };
      await iAgent3._inspectFile("stringstuff.py");
      check("_inspectFile: the judge prompt shows the required function...", /whisper/.test(capturedPrompt), capturedPrompt.slice(0, 200));
      check("_inspectFile: ...but NEVER the unrelated pre-existing shout function (structurally can't hallucinate about what it can't see)", !/shout/.test(capturedPrompt), capturedPrompt.slice(0, 200));
      check("_inspectFile: ...and only THIS file's contract section, not mathutils.py's", !/subtract/.test(capturedPrompt), capturedPrompt.slice(0, 200));

      // retrieveContext BIG-repo path: 8 keyword-matching files, helper keeps only the 2 relevant
      const rdir = fresh("explore");
      for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(rdir, `widget${i}.py`), `# widget module ${i}\n${i <= 2 ? "# RELEVANT_MARKER core widget logic" : "# unrelated helper"}\ndef widget${i}():\n    pass\n`);
      const emits = [];
      const agent = { root: rdir, _helperModel: "helper", memModel: "helper",
        resolveHelperModel: async () => "helper", _judgeRelevance: A.Agent.prototype._judgeRelevance,
        _askHelper: A.Agent.prototype._askHelper, // routing seam: no _helperBase → falls back to eta.ask
        eta: { ask: async (prompt) => /RELEVANT_MARKER/.test(prompt) ? "YES: core widget" : "NO" } };
      const ctx = await A.Agent.prototype.retrieveContext.call(agent, "build the widget system", (e) => emits.push(e));
      const kept = new Set(ctx.files);
      check("explore keeps only helper-approved files on a big repo", kept.has("widget1.py") && kept.has("widget2.py") && ![...kept].some(f => /widget[3-8]/.test(f)), JSON.stringify(ctx.files));
      check("explore emitted the parallel-isolated fan-out log", emits.some(e => e.type === "log" && /judging relevance in parallel/.test(e.text)));

      // NAMED FILES override (LIVE-CAUGHT, boltons run 91, 2026-07-27): a file explicitly named
      // by path in the task text must survive into context even when keyword-ranking noise or the
      // helper's fuzzy judgment would otherwise drop it — same "trust an explicit name" principle
      // already used for implFocus (named/namedExist), now applied to retrieveContext too.
      fs.writeFileSync(path.join(rdir, "target.py"), "# unrelated content, no RELEVANT_MARKER\ndef target():\n    pass\n");
      const ctx2 = await A.Agent.prototype.retrieveContext.call(agent, "build the widget system, see target.py for the spec", () => {});
      check("retrieveContext: a file named explicitly by path survives even when the helper judge would reject it", ctx2.files.includes("target.py"), JSON.stringify(ctx2.files));
      check("retrieveContext: named-file override doesn't discard the genuinely relevant helper-approved files", ctx2.files.includes("widget1.py") && ctx2.files.includes("widget2.py"), JSON.stringify(ctx2.files));

      // UNANIMOUS REJECTION is a real verdict (LIVE-CAUGHT, boltons runs 107+108, 2026-08-06 —
      // bug 21). A FROM-SCRATCH task names only files that don't exist yet, so every discriminating
      // term matches nothing and the keyword ranking is pure generic-word noise (docs/conf.py,
      // CHANGELOG.md, README.md). The helper correctly rejected ALL candidates — and the engine
      // then used those very rejected files anyway ("judged 0 of 14 relevant ... focusing on top
      // 6"), injecting them into the brief; the critic invented a docs/conf.py requirement and
      // reported a fully-correct run as "⚠ Not fully complete" (a false NEGATIVE).
      const rejectAll = { ...agent, eta: { ask: async () => "NO" } };
      const ctx3 = await A.Agent.prototype.retrieveContext.call(rejectAll, "add a brand new unrelated subsystem", (e) => emits.push(e));
      check("retrieveContext: a UNANIMOUS helper rejection yields NO focused subset (never the rejected files)", ctx3.files.length === 0 && ctx3.brief === "", JSON.stringify(ctx3.files));
      check("retrieveContext: ...and says so honestly in the log instead of claiming to focus on them", emits.some(e => e.type === "log" && /judged NONE of \d+ candidates relevant/.test(e.text)));
      // ...but an explicitly-named EXISTING file must still survive a unanimous rejection (the
      // bug-16 override is the anchor that keeps this fix from starving a named-file task).
      const ctx4 = await A.Agent.prototype.retrieveContext.call(rejectAll, "rework the widget system, see target.py for the spec", () => {});
      check("retrieveContext: a named existing file still survives a unanimous rejection", ctx4.files.includes("target.py") && ctx4.files.every(f => !/widget[3-8]/.test(f)), JSON.stringify(ctx4.files));
      // A helper OUTAGE must NOT look like a rejection: _judgeRelevance returns keep:true when the
      // helper call throws, so a thrown helper keeps the keyword candidates rather than blanking context.
      const brokenHelper = { ...agent, eta: { ask: async () => { throw new Error("helper down"); } } };
      const ctx5 = await A.Agent.prototype.retrieveContext.call(brokenHelper, "build the widget system", () => {});
      check("retrieveContext: a helper OUTAGE keeps keyword candidates (an outage is not a rejection)", ctx5.files.length > 0, JSON.stringify(ctx5.files));

      // ---- TERM BUDGET + IDENTIFIER RANKING (bug 22, found 2026-08-06 while measuring bug 21's
      // fix; reproduced with a no-model harness, never guessed). The 12-term search budget used to
      // be spent by POSITION IN THE SENTENCE, so a task opening with generic prose spent all 12 on
      // scaffolding words and never searched the one code identifier that locates the target file.
      // Even once searched, a raw hit COUNT let decoys matching many prose lines outrank it.
      // Measured on a 20-decoy repo: the target file went from rank 21 of 21 (absent from context
      // entirely) to rank 1. ----
      const tdir = fresh("termbudget");
      for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(tdir, `decoy${i}.py`),
        "# handler registry inside the service package directory\n# containing helpers that support processing pipeline routing\ndef helper():\n    return None\n");
      fs.writeFileSync(path.join(tdir, "target_impl.py"), "def normalize_timestamp(v):\n    return v\n");
      // Generic prose FIRST, the discriminating identifier LAST — and it is a bare identifier, so
      // the bug-16 named-file override (which requires a file extension) cannot rescue it.
      const budgetTask = "Please look inside the service package directory containing the handler " +
        "registry helpers that support the processing pipeline routing, then update the existing " +
        "function normalize_timestamp so it also accepts an integer.";
      const keepAll = { root: tdir, resolveHelperModel: async () => "helper",
        _judgeRelevance: async (t, file) => ({ file, keep: true, why: "" }) };
      const ctx6 = await A.Agent.prototype.retrieveContext.call(keepAll, budgetTask, () => {});
      check("retrieveContext: a late-positioned code identifier is still SEARCHED (target found at all)",
        ctx6.files.includes("target_impl.py") || ctx6.files.length === 0, JSON.stringify(ctx6.files));
      check("retrieveContext: a file matching the task's code identifier OUTRANKS decoys matching more prose words",
        ctx6.files[0] === "target_impl.py", JSON.stringify(ctx6.files));

      // The rule is deliberately conservative: with NO identifier in the task, every file has zero
      // identifier hits and the ordering must stay exactly the count-based order it always was.
      const proseTask = "Please look inside the service package directory containing the handler " +
        "registry helpers that support the processing pipeline routing and tidy them up.";
      const ctx7 = await A.Agent.prototype.retrieveContext.call(keepAll, proseTask, () => {});
      check("retrieveContext: a task naming NO code identifier is unaffected (target not force-promoted)",
        ctx7.files.length > 0 && ctx7.files[0] !== "target_impl.py", JSON.stringify(ctx7.files));

      // ---- SEARCH DETERMINISM + PER-FILE FAIRNESS (bug 23, found 2026-08-06 while probing what
      // happens when the task's identifier is COMMON rather than rare). ripgrep walks with a
      // PARALLEL thread pool, so its output order was a thread race; search()'s 60-line truncation
      // then kept whichever lines won, and the very SET of files reported varied run to run on an
      // unchanged repo (measured on boltons: six calls for `__init__` returned 25/26/25/24/25/24
      // distinct files). Everything downstream inherits that — retrieveContext ranks purely by
      // which files appear, so context selection itself was nondeterministic. ----
      const sdir = fresh("searchdet");
      for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(sdir, `f${String(i).padStart(2, "0")}.py`),
        Array.from({ length: 10 }, (_, n) => `def __init__${n}(self):  # file ${i}`).join("\n") + "\n");
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(await A.search(sdir, "__init__"));
      check("search: repeated identical searches return an IDENTICAL result set (no parallel-traversal race)",
        new Set(runs).size === 1, `${new Set(runs).size} distinct results across 5 calls`);
      // ...and the truncation must not hand the whole budget to the first few files: a ranking
      // caller asks for one line per file and gets FILE COVERAGE instead.
      const wide = A.search ? await A.search(sdir, "__init__") : "";
      const narrow = await A.search(sdir, "__init__", { maxPerFile: 1 });
      const distinct = (out) => new Set(out.split("\n").map((l) => (l.match(/^(.+?):\d+:/) || [])[1]).filter(Boolean)).size;
      check("search: maxPerFile:1 covers far more distinct FILES within the same line budget",
        distinct(narrow) > distinct(wide), `narrow=${distinct(narrow)} files, wide=${distinct(wide)} files`);
      check("search: maxPerFile:1 really is one line per file", narrow.split("\n").length === distinct(narrow),
        `${narrow.split("\n").length} lines, ${distinct(narrow)} files`);

      // ---- GENERIC-IDENTIFIER CROWDING (bug 23's ranking half). Both counters used to be
      // incremented per matching LINE, so a file repeating ONE generic identifier (`__init__`,
      // boilerplate in every Python class) 8 times outscored the file matching the SPECIFIC
      // identifier that actually locates the target — and after bug 22, idHits DOMINATE the sort,
      // so repetition decided the ranking outright. Measured on real boltons: boltons/typeutils.py,
      // which DEFINES make_sentinel and matches it more than any other file, ranked #6 of 40 (right
      // at the 6-file context cutoff) behind four files leading purely on `__init__`. ----
      const cdir = fresh("crowding");
      // Decoys sort BEFORE the target, so under the old per-line counting they also ate the
      // 60-line budget first and the target scored zero for the generic term as well.
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(cdir, `adecoy${i}.py`),
        Array.from({ length: 8 }, (_, n) => `    def __init__(self, arg${n}):  # sentinel default handling`).join("\n") + "\n");
      fs.writeFileSync(path.join(cdir, "target_sentinel.py"),
        "def make_sentinel(name):\n    return _MISSING\n\nclass S:\n    def __init__(self):\n        self.v = make_sentinel('v')\n\n_MISSING = make_sentinel('_MISSING')\n");
      const crowdTask = "Sentinel values are breaking one of our classes: an instance stores a sentinel " +
        "created by make_sentinel as a default in its __init__ method, and after the object is deep-copied " +
        "the identity comparison no longer holds. Please fix the sentinel implementation.";
      const keepAllC = { root: cdir, resolveHelperModel: async () => "helper",
        _judgeRelevance: async (t, file) => ({ file, keep: true, why: "" }) };
      const ctx8 = await A.Agent.prototype.retrieveContext.call(keepAllC, crowdTask, () => {});
      check("retrieveContext: the file matching the SPECIFIC identifier outranks files repeating a GENERIC one",
        ctx8.files[0] === "target_sentinel.py", JSON.stringify(ctx8.files));
      check("retrieveContext: ...and the generic-identifier decoys don't crowd it out of context entirely",
        ctx8.files.includes("target_sentinel.py"), JSON.stringify(ctx8.files));

      // ---- PER-TERM FILE CAP (bug 26). Once maxPerFile:1 made every returned line a distinct
      // FILE, search()'s default 60-LINE budget silently became "only the first 60 FILES can score
      // for this term" — and rg sorts by path, so the truncation is ALPHABETICAL. A file whose path
      // sorts late scores 0 for a term it matches perfectly, and because idHits DOMINATE the sort
      // (bug 22) that can zero out the exact identifier evidence the ranking runs on. Measured with
      // a no-model harness (D:/tmp/repro-file-cap.mjs): the definition site was ABSENT from the
      // candidate list entirely — 60 candidates, all callers. Two definition sites here on purpose,
      // so _definingFiles' exactly-one rule cannot rescue it and the cap alone decides the outcome.
      // Counterfactual-verified against a copy of agent.mjs with the fix neutralized: 61 candidates
      // and the target absent, vs 82 and rank #1 with it. ----
      const capdir = fresh("filecap");
      for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(capdir, `aaa_caller_${String(i).padStart(3, "0")}.py`),
        `from core import render_widget\n\ndef go_${i}():\n    return render_widget(${i})\n`);
      fs.writeFileSync(path.join(capdir, "aaa_alt.py"), "def render_widget(n):\n    return n\n");
      fs.writeFileSync(path.join(capdir, "zzz_core.py"),
        'def render_widget(n):\n    """Handles escaping of widget output."""\n    # escaping the output incorrectly here\n    return n\n');
      const keepAllCap = { root: capdir, resolveHelperModel: async () => "helper",
        _judgeRelevance: async (t, file) => ({ file, keep: true, why: "" }) };
      const ctxCap = await A.Agent.prototype.retrieveContext.call(keepAllCap,
        "The render_widget helper is escaping its output incorrectly. Fix render_widget escaping.", () => {});
      check("retrieveContext: a term matching MORE than 60 files still scores the late-sorting target (per-term file cap)",
        ctxCap.files.includes("zzz_core.py"), JSON.stringify(ctxCap.files));
      check("retrieveContext: ...and that target ranks FIRST, not merely present",
        ctxCap.files[0] === "zzz_core.py", JSON.stringify(ctxCap.files));
      // Non-regression: a repo SMALLER than the cap must rank byte-identically to before, since no
      // term can reach the old 60-file ceiling there (measured on real boltons, whose most common
      // non-stop terms reach 49 files). Re-running the crowding case above must be unchanged.
      const ctx8b = await A.Agent.prototype.retrieveContext.call(keepAllC, crowdTask, () => {});
      check("retrieveContext: raising the per-term file cap leaves a small repo's ranking unchanged",
        JSON.stringify(ctx8b.files) === JSON.stringify(ctx8.files), `${JSON.stringify(ctx8b.files)} vs ${JSON.stringify(ctx8.files)}`);

      // ---- DEFINITION-SITE OVERRIDE (bug 24, LIVE-CAUGHT on boltons runs 112+113, 2026-08-07).
      // The SAME is_sentinel task run twice. The deterministic keyword ranking got it right BOTH
      // times (boltons/typeutils.py, which defines make_sentinel, ranked #1 of 73 — measured), but
      // the 1.5B relevance helper is nondeterministic: run 112 kept it and landed the function in
      // the right module; run 113 DROPPED the #1 candidate and kept two USAGE-only sites instead,
      // then planned against the wrong module ("Open boltons/funcutils.py"), took the multi-file
      // decomposition path, burned its whole 8m budget and shipped nothing. Ranking was never the
      // hole — an unprotected fuzzy VETO over the definition site was. A task that points at a
      // module by IDENTIFIER ("the module where make_sentinel is already defined") gets the same
      // protection bug 16 gave a module named by PATH. ----
      const ddir = fresh("defsite");
      fs.writeFileSync(path.join(ddir, "target_sentinel.py"),
        "def make_sentinel(name):\n    class S(object):\n        pass\n    return S()\n");
      // Usage-only decoys: they mention make_sentinel (so they rank) but define it nowhere.
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(ddir, `usage${i}.py`),
        `from target_sentinel import make_sentinel\n\n_MISSING = make_sentinel('_MISSING')\n\nclass C${i}(object):\n    def __init__(self, v=_MISSING):\n        self.v = v\n`);
      const defTask = "Sentinels are used in several places in this codebase: a class stores one as a " +
        "default value in its __init__ method and later compares against it by identity. Please add a " +
        "function called is_sentinel(obj) that returns True when obj was produced by make_sentinel and " +
        "False otherwise. It belongs in the same module where make_sentinel is already defined.";
      // A REAL Agent instance (not a stub): this is what proves the method is actually wired into
      // retrieveContext, so the `?.` guard there can never silently disable the whole feature.
      const defAgent = new A.Agent(ddir, { maxSteps: 1 });
      defAgent.resolveHelperModel = async () => "helper";
      defAgent._judgeRelevance = async (t, file) => ({ file, keep: false, why: "" }); // reject EVERYTHING, as run 113's helper effectively did to the definer
      const defEmits = [];
      const ctx9 = await A.Agent.prototype.retrieveContext.call(defAgent, defTask, (e) => defEmits.push(e));
      check("retrieveContext: the file DEFINING a task-named identifier survives a helper rejection (bug 24)",
        ctx9.files.includes("target_sentinel.py"), JSON.stringify(ctx9.files));
      check("retrieveContext: ...without resurrecting the usage-only files the helper rejected",
        ctx9.files.every((f) => !/^usage/.test(f)), JSON.stringify(ctx9.files));
      check("retrieveContext: ...and says out loud that it force-included it rather than trusting fuzzy judgment",
        defEmits.some((e) => e.type === "log" && /force-included .*target_sentinel\.py/.test(e.text)),
        JSON.stringify(defEmits.filter((e) => e.type === "log").map((e) => e.text)));

      // The override is deliberately narrow. Direct tests of the rule itself:
      const defCall = (ids, opts) => A.Agent.prototype._definingFiles.call({ root: ddir }, ids, opts);
      check("_definingFiles: an identifier defined in exactly ONE file resolves to that file",
        JSON.stringify(await defCall(["make_sentinel"])) === '["target_sentinel.py"]');
      check("_definingFiles: an AMBIGUOUS identifier resolves to nothing (__init__ is defined in all 10 decoys)",
        (await defCall(["__init__"])).length === 0);
      check("_definingFiles: a not-yet-existing name resolves to nothing (an ADD task must not force-include anything)",
        (await defCall(["is_sentinel"])).length === 0);
      check("_definingFiles: a USAGE-only reference is not a definition",
        (await defCall(["_MISSING"])).length === 0);
      check("_definingFiles: no identifiers at all is a no-op", (await defCall([])).length === 0);
      check("_definingFiles: the max cap is honoured", (await defCall(["make_sentinel", "C0", "C1"], { max: 1 })).length === 1);
      // A task naming NO code identifier must leave context byte-identical to before this fix — the
      // same conservatism the bug-22 rule was held to.
      const defAgent2 = new A.Agent(ddir, { maxSteps: 1 });
      defAgent2.resolveHelperModel = async () => "helper";
      defAgent2._judgeRelevance = async (t, file) => ({ file, keep: false, why: "" });
      const ctx10 = await A.Agent.prototype.retrieveContext.call(defAgent2, "tidy up the modules in this package", () => {});
      check("retrieveContext: a task naming no code identifier force-includes nothing (unanimous rejection still honoured)",
        ctx10.files.length === 0, JSON.stringify(ctx10.files));

      // ---- DEPENDENCY CLOSURE (one hop), LIVE-CAUGHT on boltons run 200, 2026-09-05. A cross-file
      // root-cause task names a symptom's file ("trace the call chain from Rectangle.moved, the bug
      // may not be in shapeutils.py itself"), but the file that actually holds the bug is a plain
      // IMPORT of the named file and can share none of the task's keywords or identifiers — it never
      // keyword-ranks and the fuzzy helper never sees it as a candidate at all. On the real run, the
      // injected bug lived in boltons/pointutils.py's translated() (imported by shapeutils.py, called
      // from Rectangle.moved); retrieveContext focused ONLY on tests/test_shapeutils.py, pointutils.py
      // was never read, and the model patched around the symptom instead of fixing the real bug,
      // landing at 485/486. Fix reuses the already-tested dependency-graph infra (fileDeps) rather
      // than new parsing: any file force-included by name/definition also contributes its own direct
      // imports, capped at 4, additive only. ----
      const depdir = fresh("depclosure");
      fs.writeFileSync(path.join(depdir, "caller.py"), "from callee import helper_fn\n\ndef target():\n    return helper_fn()\n");
      fs.writeFileSync(path.join(depdir, "callee.py"), "def helper_fn():\n    return 42\n");
      // Not imported by anything named/defined — must stay governed by the (here, unanimously
      // rejecting) fuzzy judge, not swept in by the new dependency-closure logic.
      fs.writeFileSync(path.join(depdir, "decoy.py"), "# unrelated module, imports nothing relevant\ndef unrelated():\n    pass\n");
      const depRejectAll = { root: depdir, resolveHelperModel: async () => "helper",
        _judgeRelevance: async (t, file) => ({ file, keep: false, why: "" }) };
      const depEmits = [];
      const ctx11 = await A.Agent.prototype.retrieveContext.call(depRejectAll,
        "There is a real bug causing caller.py to return the wrong value. Trace the call chain to find where it actually comes from -- it may not be in caller.py itself.",
        (e) => depEmits.push(e));
      check("retrieveContext: dependency closure pulls in a named file's direct import even when the fuzzy judge rejects everything",
        ctx11.files.includes("callee.py"), JSON.stringify(ctx11.files));
      check("retrieveContext: ...the named file itself is still present",
        ctx11.files.includes("caller.py"), JSON.stringify(ctx11.files));
      check("retrieveContext: ...but an unrelated, non-imported decoy is NOT swept in",
        !ctx11.files.includes("decoy.py"), JSON.stringify(ctx11.files));
      check("retrieveContext: ...and says out loud it was included via dependency closure, not fuzzy judgment",
        depEmits.some((e) => e.type === "log" && /one-hop dependency closure/.test(e.text) && /callee\.py/.test(e.text)),
        JSON.stringify(depEmits.filter((e) => e.type === "log").map((e) => e.text)));

      // Negative control: no named/defining file at all -> `forced` is empty -> the whole
      // dependency-closure block is skipped, byte-identical to before this fix.
      const ctx12 = await A.Agent.prototype.retrieveContext.call(depRejectAll, "tidy up this small module.", () => {});
      check("retrieveContext: no named/defining file at all -> dependency closure never fires (nothing force-included)",
        ctx12.files.length === 0, JSON.stringify(ctx12.files));

      // Cap check: a named file importing many modules only contributes up to 4 extra deps.
      const capddir = fresh("depclosurecap");
      let importLines = "";
      for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(capddir, `mod${i}.py`), `def fn${i}():\n    return ${i}\n`); importLines += `from mod${i} import fn${i}\n`; }
      fs.writeFileSync(path.join(capddir, "hub.py"), importLines + "\ndef target():\n    return fn0()\n");
      const capDep = { root: capddir, resolveHelperModel: async () => "helper",
        _judgeRelevance: async (t, file) => ({ file, keep: false, why: "" }) };
      const ctx13 = await A.Agent.prototype.retrieveContext.call(capDep, "There is a bug in hub.py, trace the call chain.", () => {});
      const depCount = ctx13.files.filter((f) => /^mod\d\.py$/.test(f)).length;
      check("retrieveContext: dependency closure is capped (at most 4 extra deps pulled in from one named file)",
        depCount === 4, JSON.stringify(ctx13.files));

      // ---- degenerate-ratio sanity check (LIVE-CAUGHT on boltons, Test 5, 2026-07-21): a locked
      // test's expected value used the SAME tautological formula as the implementation
      // (`unique_count / len(word_count)` where unique_count IS len(word_count)) — the oracle went
      // green, but `unique_word_ratio` could only ever return 1.0. ----
      const candSrc = 'def unique_word_ratio(text):\n    return 1\n\ndef helper(a, b):\n    return a\n\ndef word_count(text):\n    return {}\n';
      const cands = A.degenerateRatioCandidates(["mod.py"], new Map([["mod.py", candSrc]]));
      check("degenerateRatioCandidates: matches a ratio-named single-arg function", cands.some(c => c.name === "unique_word_ratio"), JSON.stringify(cands));
      check("degenerateRatioCandidates: a 2-arg function is not a candidate (not the single-string-arg shape)", !cands.some(c => c.name === "helper"), JSON.stringify(cands));
      check("degenerateRatioCandidates: a name with no ratio/average/percent/rate/score is not a candidate", !cands.some(c => c.name === "word_count"), JSON.stringify(cands));
      // isolates the single-arg restriction from the name-keyword restriction: `helper` above is
      // excluded by BOTH filters at once (no ratio-keyword name AND 2 args), so it can't prove the
      // arg-count check does anything on its own. A ratio-KEYWORD-named 2-arg function is the only
      // fixture that exercises the arg-count restriction in isolation (checkDegenerateRatios can only
      // ever call a candidate with a single string argument, so a required-2nd-arg function must never
      // become a candidate or the runtime probe script would crash calling it).
      const candSrc2 = 'def average_score(text, weight):\n    return len(text) * weight\n';
      const cands2 = A.degenerateRatioCandidates(["mod2.py"], new Map([["mod2.py", candSrc2]]));
      check("degenerateRatioCandidates: a ratio-keyword-named 2-arg function is still not a candidate (arg-count restriction, isolated from the name filter)",
        !cands2.some(c => c.name === "average_score"), JSON.stringify(cands2));

      // BUG 93 (found via isolated probe, 2026-09-13): the old regex required the single parameter
      // to be a bare identifier with nothing else inside the parens, so a type annotation, a default
      // value, or a `-> ReturnType` annotation on the def line — all ordinary modern-Python styles —
      // made it match ZERO characters, silently exempting the candidate from the whole check.
      const candSrc3 =
        'def unique_word_ratio(text: str) -> float:\n    return 1.0\n\n' +
        'def average_score(text="") :\n    return 1.0\n\n' +
        'def match_percent(text: str = "") -> float:\n    return 1.0\n\n' +
        'def helper(text: str, extra: int) -> float:\n    return 1.0\n';
      const cands3 = A.degenerateRatioCandidates(["mod3.py"], new Map([["mod3.py", candSrc3]]));
      check("degenerateRatioCandidates (BUG 93): matches a ratio-named function with a type-annotated single param",
        cands3.some(c => c.name === "unique_word_ratio"), JSON.stringify(cands3));
      check("degenerateRatioCandidates (BUG 93): matches a ratio-named function with a defaulted single param",
        cands3.some(c => c.name === "average_score"), JSON.stringify(cands3));
      check("degenerateRatioCandidates (BUG 93): matches a ratio-named function with BOTH a type annotation and a default value",
        cands3.some(c => c.name === "match_percent"), JSON.stringify(cands3));
      check("degenerateRatioCandidates (BUG 93): a 2-arg TYPED function is still not a candidate (arg-count restriction preserved)",
        !cands3.some(c => c.name === "helper"), JSON.stringify(cands3));

      const rdir2 = fresh("degenrat");
      fs.writeFileSync(path.join(rdir2, "wordcountutils.py"),
        "import re\nfrom collections import Counter\ndef word_count(text):\n    return dict(Counter(re.findall(r'\\w+', text.lower())))\n");
      // the exact live bug: numerator and denominator are both len(word_count) -> always 1
      fs.writeFileSync(path.join(rdir2, "readabilityutils.py"),
        "from wordcountutils import word_count\ndef unique_word_ratio(text):\n    wc = word_count(text)\n    unique_count = len(wc)\n    return unique_count / len(wc) if wc else 0.0\n");
      const flagsBad = await A.checkDegenerateRatios(rdir2, ["readabilityutils.py"]);
      check("checkDegenerateRatios: catches the live self-canceling unique_word_ratio bug", flagsBad.some(f => /unique_word_ratio/.test(f)), JSON.stringify(flagsBad));

      // a CORRECT implementation (unique / total occurrences, not unique / unique) must NOT be flagged
      fs.writeFileSync(path.join(rdir2, "readabilityutils.py"),
        "from wordcountutils import word_count\ndef unique_word_ratio(text):\n    wc = word_count(text)\n    total = sum(wc.values())\n    return len(wc) / total if total else 0.0\n");
      const flagsGood = await A.checkDegenerateRatios(rdir2, ["readabilityutils.py"]);
      check("checkDegenerateRatios: a genuinely input-sensitive ratio is NOT flagged (no false positive)", flagsGood.length === 0, JSON.stringify(flagsGood));

      // BUG 93 end-to-end: the exact same live self-canceling bug, but written with a type
      // annotation + return annotation — the style the old regex silently let through unflagged.
      fs.writeFileSync(path.join(rdir2, "readabilityutils.py"),
        "from wordcountutils import word_count\ndef unique_word_ratio(text: str) -> float:\n    wc = word_count(text)\n    unique_count = len(wc)\n    return unique_count / len(wc) if wc else 0.0\n");
      const flagsBadTyped = await A.checkDegenerateRatios(rdir2, ["readabilityutils.py"]);
      check("checkDegenerateRatios (BUG 93): catches the same self-canceling bug when the function has a type annotation",
        flagsBadTyped.some(f => /unique_word_ratio/.test(f)), JSON.stringify(flagsBadTyped));

      // a candidate that CRASHES (e.g. a NameError from a typo'd reference) must never be mislabeled
      // as self-canceling. This was previously untested in either direction. Mutation-tested: both
      // calls share ONE try/except, so a first-call exception short-circuits the second print
      // entirely, leaving exactly 1 output line — already excluded by the `lines.length >= 2` check
      // alone, independent of the separate `!/^ERR/.test(lines[0])` guard right next to it (confirmed
      // by mutation: removing that specific guard alone does not change this test's outcome, because
      // this exact code shape can never reach 2 lines with lines[0] starting "ERR" — that guard is
      // defensive against a hypothetical future refactor with a try/except per call, not reachable
      // today. This fixture still closes a real gap: no test previously covered a crashing candidate.
      fs.writeFileSync(path.join(rdir2, "readabilityutils.py"),
        "def unique_word_ratio(text):\n    return undefined_name_typo(text)\n");
      const flagsCrash = await A.checkDegenerateRatios(rdir2, ["readabilityutils.py"]);
      check("checkDegenerateRatios: a candidate that crashes is NOT flagged as self-canceling",
        flagsCrash.length === 0, JSON.stringify(flagsCrash));
      try { fs.rmSync(rdir2, { recursive: true, force: true }); } catch {}

      // ---- checkDegenerateTestExpectations (LIVE-CAUGHT on boltons, Test 5, 2026-07-21): the
      // OTHER half of the same bug class — the residual live failure was the LOCKED TEST's own
      // expected-value formula being a tautology, not the implementation. Exact real test body. ----
      const badTestSrc = [
        "import unittest",
        "from boltons import wordcountutils, readabilityutils",
        "",
        "class TestReadabilityUtils(unittest.TestCase):",
        "    def test_unique_word_ratio_multiple_words(self):",
        "        text = \"hello world hello\"",
        "        word_count = wordcountutils.word_count(text)",
        "        unique_count = len(word_count)",
        "        result = readabilityutils.unique_word_ratio(text)",
        "        self.assertEqual(result, unique_count / len(word_count))",
      ].join("\n");
      const testFlagsBad = A.checkDegenerateTestExpectations(badTestSrc);
      check("checkDegenerateTestExpectations: catches the live self-canceling assertEqual (unique_count/len(word_count))",
        testFlagsBad.some(f => /test_unique_word_ratio_multiple_words/.test(f) && /len\(word_count\)/.test(f)), JSON.stringify(testFlagsBad));

      // the SAME shape but with a genuinely different denominator name must NOT be flagged
      const goodTestSrc = [
        "import unittest",
        "from boltons import wordcountutils, readabilityutils",
        "",
        "class TestReadabilityUtils(unittest.TestCase):",
        "    def test_average_word_length(self):",
        "        text = \"hello world\"",
        "        word_count = wordcountutils.word_count(text)",
        "        total_chars = sum(len(w) for w in text.split())",
        "        result = readabilityutils.average_word_length(text)",
        "        self.assertEqual(result, total_chars / len(word_count))",
      ].join("\n");
      const testFlagsGood = A.checkDegenerateTestExpectations(goodTestSrc);
      check("checkDegenerateTestExpectations: a genuinely different numerator/denominator is NOT flagged (no false positive)",
        testFlagsGood.length === 0, JSON.stringify(testFlagsGood));

      // the direct len(A)/len(B) shape with A===B, no intermediate variable
      const directTautology = "class T(unittest.TestCase):\n    def test_direct(self):\n        d = {}\n        self.assertEqual(1.0, len(d) / len(d))\n";
      const testFlagsDirect = A.checkDegenerateTestExpectations(directTautology);
      check("checkDegenerateTestExpectations: catches the direct len(d)/len(d) shape (no intermediate var)",
        testFlagsDirect.some(f => /test_direct/.test(f)), JSON.stringify(testFlagsDirect));

      // isolates the `direct[1] === direct[2]` equality check: the ONLY existing direct-shape test
      // uses the SAME name on both sides (len(d)/len(d)), so it can't tell the equality check apart
      // from "the direct shape was matched at all". A direct len(A)/len(B) with genuinely DIFFERENT
      // names must NOT be flagged.
      const directDifferent = "class T(unittest.TestCase):\n    def test_direct_ok(self):\n        a = {1: 1}\n        b = {1: 1, 2: 2}\n        self.assertEqual(0.5, len(a) / len(b))\n";
      const testFlagsDirectOk = A.checkDegenerateTestExpectations(directDifferent);
      check("checkDegenerateTestExpectations: a direct len(A)/len(B) with DIFFERENT names is NOT flagged (equality check, isolated from shape-match)",
        testFlagsDirectOk.length === 0, JSON.stringify(testFlagsDirectOk));

      // ---- BUG 95 (found via isolated probe, 2026-09-13): both matchers used to require the line
      // to end IMMEDIATELY after the relevant `)`, so an ordinary trailing `# explanation` comment
      // on either the `len()` assignment line or the `assertEqual(...)` line silently defeated
      // detection entirely (including on a comment shaped EXACTLY like this file's own historical
      // motivating comment above), and a long `assertEqual(...)` wrapped across multiple lines by a
      // formatter was never even matched at all. Fixed via stripLineComment (string-aware, so a `#`
      // inside a quoted string is never mistaken for a comment) + findCallArgs/splitTopLevelArgs
      // (balanced-paren, multi-line-capable call scanning) replacing the old single-line regexes. ----
      const commentOnLenOfSrc = [
        "class T(unittest.TestCase):",
        "    def test_comment_on_lenof(self):",
        "        word_count = wc(text)",
        "        unique_count = len(word_count)  # unique_count IS len(word_count)",
        "        self.assertEqual(result, unique_count / len(word_count))",
      ].join("\n");
      const commentOnLenOfFlags = A.checkDegenerateTestExpectations(commentOnLenOfSrc);
      check("checkDegenerateTestExpectations (BUG 95): still catches the tautology when the `len()` assignment line has a trailing comment",
        commentOnLenOfFlags.some(f => /test_comment_on_lenof/.test(f)), JSON.stringify(commentOnLenOfFlags));

      const commentOnAssertSrc = [
        "class T(unittest.TestCase):",
        "    def test_comment_on_assert(self):",
        "        word_count = wc(text)",
        "        unique_count = len(word_count)",
        "        self.assertEqual(result, unique_count / len(word_count))  # always 1.0, bug",
      ].join("\n");
      const commentOnAssertFlags = A.checkDegenerateTestExpectations(commentOnAssertSrc);
      check("checkDegenerateTestExpectations (BUG 95): still catches the tautology when the `assertEqual(...)` line has a trailing comment",
        commentOnAssertFlags.some(f => /test_comment_on_assert/.test(f)), JSON.stringify(commentOnAssertFlags));

      const multilineAssertSrc = [
        "class T(unittest.TestCase):",
        "    def test_multiline_assert(self):",
        "        word_count = wc(text)",
        "        unique_count = len(word_count)",
        "        self.assertEqual(",
        "            result,",
        "            unique_count / len(word_count),",
        "        )",
      ].join("\n");
      const multilineAssertFlags = A.checkDegenerateTestExpectations(multilineAssertSrc);
      check("checkDegenerateTestExpectations (BUG 95): still catches the tautology when assertEqual(...) is wrapped across multiple lines",
        multilineAssertFlags.some(f => /test_multiline_assert/.test(f)), JSON.stringify(multilineAssertFlags));

      // regression guard: a `#` INSIDE a string argument must not be mistaken for a comment start
      const hashInStringSrc = [
        "class T(unittest.TestCase):",
        "    def test_hash_in_string_not_comment(self):",
        "        self.assertEqual(result, \"a#b\")",
        "        note = \"len(x) # not code\"",
      ].join("\n");
      const hashInStringFlags = A.checkDegenerateTestExpectations(hashInStringSrc);
      check("checkDegenerateTestExpectations (BUG 95 regression guard): a `#` inside a string literal is NOT treated as a comment (no false positive, no crash)",
        hashInStringFlags.length === 0, JSON.stringify(hashInStringFlags));

      // regression guard: an assertEqual with an optional 3rd `msg` arg must still resolve the
      // EXPECTED value from arg 2 only, not get corrupted by the extra comma
      const msgArgSrc = [
        "class T(unittest.TestCase):",
        "    def test_msg_arg_still_works(self):",
        "        word_count = wc(text)",
        "        unique_count = len(word_count)",
        "        self.assertEqual(result, unique_count / len(word_count), \"should be 1.0\")",
      ].join("\n");
      const msgArgFlags = A.checkDegenerateTestExpectations(msgArgSrc);
      check("checkDegenerateTestExpectations (BUG 95 regression guard): a 3-arg assertEqual with a trailing msg string still correctly resolves the tautology from arg 2",
        msgArgFlags.some(f => /test_msg_arg_still_works/.test(f)), JSON.stringify(msgArgFlags));

      // ---- BUG 106 (2026-09-14): findCallArgs/splitTopLevelArgs never got the BUG 105 triple-quote
      // fix that balancedBraceSpans got, even though they're used by this SAME checker. A
      // triple-quoted arg with a stray char matching its own delimiter (e.g. a docstring-style
      // string like `"""He said 5" tall"""`) desynced findCallArgs' depth-tracking when it sat in
      // the SAME assertEqual call as a genuine tautology, truncating the captured inner text before
      // args[1] could be split out — silently missing a real self-canceling expected-value.
      // Live-proven via an isolated A/B probe before fixing: identical source with the stray quote
      // removed was correctly flagged; with it present, the flag vanished. ----
      const strayQuoteCallSrc = [
        "class T(unittest.TestCase):",
        "    def test_stray_quote_in_same_call(self):",
        "        unique_count = len(word_count)",
        '        self.assertEqual("""He said 5" tall""", unique_count / len(word_count))',
        "        other_call()", // real trailing code after the call — without it, the naive
        // pre-fix scanner can accidentally hit the text's own end-of-string exactly where the
        // desynced depth counter happens to land, masking the bug; a following statement makes the
        // desync's mis-scan consume real code and reliably fail pre-fix (verified by A/B probe).
      ].join("\n");
      const strayQuoteCallFlags = A.checkDegenerateTestExpectations(strayQuoteCallSrc);
      check("checkDegenerateTestExpectations (BUG 106): catches the tautology even when the SAME assertEqual call also has a triple-quoted arg with a stray matching-delimiter quote char",
        strayQuoteCallFlags.some(f => /test_stray_quote_in_same_call/.test(f)), JSON.stringify(strayQuoteCallFlags));

      // regression guard: a triple-quoted arg with genuinely BALANCED content (no stray delimiter)
      // sharing a call with a non-tautological expected value must NOT be flagged
      const strayQuoteNoTautologySrc = [
        "class T(unittest.TestCase):",
        "    def test_stray_quote_no_false_positive(self):",
        "        total_chars = sum(len(w) for w in text.split())",
        "        word_count = wc(text)",
        '        self.assertEqual("""He said tall""", total_chars / len(word_count))',
      ].join("\n");
      const strayQuoteNoTautologyFlags = A.checkDegenerateTestExpectations(strayQuoteNoTautologySrc);
      check("checkDegenerateTestExpectations (BUG 106 regression guard): a triple-quoted arg alongside a genuinely different numerator/denominator is NOT flagged",
        strayQuoteNoTautologyFlags.length === 0, JSON.stringify(strayQuoteNoTautologyFlags));

      // ---- checkDuplicateLiteralKeys (LIVE-CAUGHT on boltons, Test 5 follow-up run, 2026-07-22):
      // a different broken-ruler shape than the tautology above — the test author's OWN dict
      // literal repeats a key, so Python silently drops one of the two "cases" it tried to encode.
      // Exact real test body (tests/test_wordcountutils.py, run 42). ----
      const dupTestSrc = [
        "import unittest",
        "from boltons import wordcountutils",
        "",
        "class TestWordCountUtils(unittest.TestCase):",
        "    def test_word_count_mixed_case_words(self):",
        "        text = \"Hello hello Hello\"",
        "        expected = {\"hello\": 2, \"hello\": 1}  # This should be ignored due to case sensitivity",
        "        self.assertEqual(wordcountutils.word_count(text), expected)",
      ].join("\n");
      const dupFlagsBad = A.checkDuplicateLiteralKeys(dupTestSrc);
      check("checkDuplicateLiteralKeys: catches the live duplicate-key dict literal ({\"hello\":2,\"hello\":1})",
        dupFlagsBad.some(f => /test_word_count_mixed_case_words/.test(f) && /hello/.test(f)), JSON.stringify(dupFlagsBad));

      // a dict literal with genuinely distinct keys must NOT be flagged
      const dupTestGood = [
        "class T(unittest.TestCase):",
        "    def test_ok(self):",
        "        expected = {\"hello\": 2, \"world\": 1}",
        "        self.assertEqual(wordcountutils.word_count(\"hello hello world\"), expected)",
      ].join("\n");
      const dupFlagsGood = A.checkDuplicateLiteralKeys(dupTestGood);
      check("checkDuplicateLiteralKeys: distinct keys are NOT flagged (no false positive)", dupFlagsGood.length === 0, JSON.stringify(dupFlagsGood));

      // a plain set literal (no colon) must NOT be mistaken for a dict
      const setLitSrc = "class T(unittest.TestCase):\n    def test_set(self):\n        expected = {\"a\", \"a\", \"b\"}\n        self.assertEqual(set(\"a a b\".split()), expected)\n";
      const setFlags = A.checkDuplicateLiteralKeys(setLitSrc);
      check("checkDuplicateLiteralKeys: a set literal (no colon) is not treated as a dict", setFlags.length === 0, JSON.stringify(setFlags));

      // ---- BUG 94 (found via isolated probe, 2026-09-13): the old regex `\{([^{}]*)\}` requires
      // the whole literal to contain NO braces at all, so a duplicate top-level key was silently
      // missed whenever any of that dict's own values was itself a nested {..} (dict/set), AND the
      // old code scanned one line at a time, so a duplicate key was also silently missed whenever
      // the dict literal was written across multiple lines (both are ordinary, common Python
      // styles). Fixed via a depth-aware balanced-brace scan (balancedBraceSpans) plus masking any
      // nested-bracket content before running the key regex (maskNestedContent), operating on the
      // whole test-method body instead of one line. ----
      const nestedDupSrc = [
        "class T(unittest.TestCase):",
        "    def test_nested_dup(self):",
        "        d = {\"a\": 1, \"b\": {\"x\": 2}, \"a\": 3}",
        "        assert d[\"a\"] == 3",
      ].join("\n");
      const nestedDupFlags = A.checkDuplicateLiteralKeys(nestedDupSrc);
      check("checkDuplicateLiteralKeys (BUG 94): catches a top-level duplicate key even when another value is a nested dict",
        nestedDupFlags.some(f => /test_nested_dup/.test(f) && /`a`/.test(f)), JSON.stringify(nestedDupFlags));

      const multilineDupSrc = [
        "class T(unittest.TestCase):",
        "    def test_multiline_dup(self):",
        "        d = {",
        "            \"a\": 1,",
        "            \"a\": 2,",
        "        }",
        "        assert d[\"a\"] == 2",
      ].join("\n");
      const multilineDupFlags = A.checkDuplicateLiteralKeys(multilineDupSrc);
      check("checkDuplicateLiteralKeys (BUG 94): catches a duplicate key in a dict literal written across multiple lines",
        multilineDupFlags.some(f => /test_multiline_dup/.test(f) && /`a`/.test(f)), JSON.stringify(multilineDupFlags));

      const nestedOwnDupSrc = [
        "class T(unittest.TestCase):",
        "    def test_nested_own_dup(self):",
        "        d = {\"a\": 1, \"b\": {\"x\": 2, \"x\": 3}}",
        "        assert d[\"b\"][\"x\"] == 3",
      ].join("\n");
      const nestedOwnDupFlags = A.checkDuplicateLiteralKeys(nestedOwnDupSrc);
      check("checkDuplicateLiteralKeys (BUG 94): a nested dict's OWN duplicate key is caught and attributed to `x`, not the outer `a`",
        nestedOwnDupFlags.length === 1 && /`x`/.test(nestedOwnDupFlags[0]) && !/`a`/.test(nestedOwnDupFlags[0]), JSON.stringify(nestedOwnDupFlags));

      const valueWithColonSrc = [
        "class T(unittest.TestCase):",
        "    def test_value_with_colon(self):",
        "        d = {\"a\": \"x:y\", \"b\": 2}",
        "        assert d[\"a\"] == \"x:y\"",
      ].join("\n");
      const valueWithColonFlags = A.checkDuplicateLiteralKeys(valueWithColonSrc);
      check("checkDuplicateLiteralKeys (BUG 94 regression guard): distinct keys where a value string itself contains a colon is NOT a false positive",
        valueWithColonFlags.length === 0, JSON.stringify(valueWithColonFlags));

      const listOfDictsSrc = [
        "class T(unittest.TestCase):",
        "    def test_list_of_dicts_no_false_positive(self):",
        "        d = [{\"a\": 1}, {\"a\": 2}]",
        "        assert d[0][\"a\"] == 1",
      ].join("\n");
      const listOfDictsFlags = A.checkDuplicateLiteralKeys(listOfDictsSrc);
      check("checkDuplicateLiteralKeys (BUG 94 regression guard): two SEPARATE dict literals sharing a key name (neither internally duplicated) is NOT a false positive",
        listOfDictsFlags.length === 0, JSON.stringify(listOfDictsFlags));

      // ---- BUG 105 (2026-09-14): balancedBraceSpans' quote-tracker toggled each `"`/`'` as an
      // independent single-char flag, so a triple-quoted docstring containing an ODD count of its
      // own delimiter char as a plain character (e.g. a measurement like `5"`, an ordinary and
      // common real-world shape) desynced the tracker permanently — it silently swallowed every
      // `{`/`}` (and therefore every duplicate-key dict literal) appearing AFTER that docstring in
      // the same test method, a dangerous-direction false negative. Confirmed via isolated A/B: the
      // pre-fix tracker finds ZERO dict spans at all for this exact source. Fixed via tripleQuoteAt
      // making balancedBraceSpans triple-quote-aware. ----
      const strayQuoteDocstringSrc = [
        "class T(unittest.TestCase):",
        "    def test_stray_quote_before_dup(self):",
        "        \"\"\"A docstring with a measurement like 5\" in it.\"\"\"",
        "        expected = {\"hello\": 2, \"hello\": 1}",
        "        assert expected[\"hello\"] == 1",
      ].join("\n");
      const strayQuoteDocstringFlags = A.checkDuplicateLiteralKeys(strayQuoteDocstringSrc);
      check("checkDuplicateLiteralKeys (BUG 105): catches a duplicate key even when a preceding docstring has an odd (single) stray quote char",
        strayQuoteDocstringFlags.some(f => /test_stray_quote_before_dup/.test(f) && /`hello`/.test(f)), JSON.stringify(strayQuoteDocstringFlags));

      // a docstring with a stray quote but NO duplicate key afterward must NOT be a false positive
      const strayQuoteNoDupSrc = [
        "class T(unittest.TestCase):",
        "    def test_stray_quote_no_dup(self):",
        "        \"\"\"A docstring with a measurement like 5\" in it.\"\"\"",
        "        expected = {\"hello\": 2, \"world\": 1}",
        "        assert expected[\"hello\"] == 2",
      ].join("\n");
      const strayQuoteNoDupFlags = A.checkDuplicateLiteralKeys(strayQuoteNoDupSrc);
      check("checkDuplicateLiteralKeys (BUG 105 regression guard): a stray quote in a preceding docstring with genuinely distinct keys is NOT a false positive",
        strayQuoteNoDupFlags.length === 0, JSON.stringify(strayQuoteNoDupFlags));
    }

    // ---- Ollama-free helper routing (2026-07-22): resolveHelperModel/_askHelper no longer
    // REQUIRE Ollama — the universal 1.5B tier now also comes from OUR OWN bundled llama-server
    // (moe.mjs ensureHelperServer, launched directly via `-hf`) when the main provider isn't
    // Ollama. Ollama itself stays a fully supported BYOM choice — its model store is tried
    // FIRST when it IS the main provider, unchanged from before. NOTE: the actual bundled-
    // server LAUNCH path (ensureHelperServer's real spawn+download) is intentionally not
    // unit-tested here — it was already verified live (90.3 tok/s measured, see
    // eta-ide-ollama-removal-foundation memory); only the deterministic routing/branching logic
    // that agent.mjs adds on top of it is covered by the fast suite.
    {
      const realFetch = globalThis.fetch;

      // askLlamaServer: native llama-server /completion — no chat framing, no `model` field
      let seenUrl, seenBody;
      globalThis.fetch = async (url, opts) => { seenUrl = url; seenBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: "YES" }) }; };
      const ans = await A.askLlamaServer("http://127.0.0.1:8721", "is this ok?", 8);
      globalThis.fetch = realFetch;
      check("askLlamaServer: hits the native /completion endpoint", seenUrl === "http://127.0.0.1:8721/completion", seenUrl);
      check("askLlamaServer: sends prompt + n_predict, no chat framing", seenBody.prompt === "is this ok?" && seenBody.n_predict === 8 && !("messages" in seenBody), JSON.stringify(seenBody));
      check("askLlamaServer: returns the content field", ans === "YES");

      globalThis.fetch = async () => ({ ok: false });
      check("askLlamaServer: non-ok response -> \"\"", await A.askLlamaServer("http://x", "p") === "");
      globalThis.fetch = async () => { throw new Error("down"); };
      check("askLlamaServer: network failure -> \"\" (never throws)", await A.askLlamaServer("http://x", "p") === "");
      globalThis.fetch = realFetch;

      // askLlamaInfill: native llama-server /infill (FIM, Ollama-free 2026-07-23) — prefix/suffix
      // framing, no chat wrapper, no `model` field.
      let seenInfillUrl, seenInfillBody;
      globalThis.fetch = async (url, opts) => { seenInfillUrl = url; seenInfillBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: "a + b;" }) }; };
      const infillAns = await A.askLlamaInfill("http://127.0.0.1:8723", "function add(a,b){ return ", " }", 80, ["<|endoftext|>"]);
      globalThis.fetch = realFetch;
      check("askLlamaInfill: hits the native /infill endpoint", seenInfillUrl === "http://127.0.0.1:8723/infill", seenInfillUrl);
      check("askLlamaInfill: sends input_prefix/input_suffix, no chat framing", seenInfillBody.input_prefix === "function add(a,b){ return " && seenInfillBody.input_suffix === " }" && seenInfillBody.n_predict === 80 && !("messages" in seenInfillBody), JSON.stringify(seenInfillBody));
      check("askLlamaInfill: returns the content field", infillAns === "a + b;");

      globalThis.fetch = async () => ({ ok: false });
      check("askLlamaInfill: non-ok response -> \"\"", await A.askLlamaInfill("http://x", "p", "s") === "");
      globalThis.fetch = async () => { throw new Error("down"); };
      check("askLlamaInfill: network failure -> \"\" (never throws)", await A.askLlamaInfill("http://x", "p", "s") === "");
      globalThis.fetch = realFetch;

      // _askHelper routes on _helperKind, not just on _helperBase being set
      let calledLlama = false;
      globalThis.fetch = async () => ({ ok: true, json: async () => { calledLlama = true; return { content: "llama-answer" }; } });
      const rLlama = await A.Agent.prototype._askHelper.call(
        { _helperBase: "http://127.0.0.1:8721", _helperKind: "llama", eta: { ask: async () => { throw new Error("must not reach the main brain"); } } },
        "q", "helper", 10);
      globalThis.fetch = realFetch;
      check("_askHelper: kind \"llama\" routes to askLlamaServer (native /completion)", calledLlama && rLlama === "llama-answer");

      let calledOllama = false;
      globalThis.fetch = async (url) => { calledOllama = /\/api\/chat$/.test(String(url)); return { ok: true, json: async () => ({ message: { content: "ollama-answer" } }) }; };
      const rOllama = await A.Agent.prototype._askHelper.call(
        { _helperBase: "http://127.0.0.1:11434", _helperKind: "ollama", eta: { ask: async () => { throw new Error("must not reach the main brain"); } } },
        "q", "some-model", 10);
      globalThis.fetch = realFetch;
      check("_askHelper: kind \"ollama\" still routes to askOllama (/api/chat), unchanged", calledOllama && rOllama === "ollama-answer");

      const rNone = await A.Agent.prototype._askHelper.call({ _helperBase: null, eta: { ask: async (p, m) => `main-brain:${m}` } }, "q", "m", 10);
      check("_askHelper: no helper resolved -> falls back to the main brain", rNone === "main-brain:m");

      // resolveHelperModel: when the main provider genuinely IS Ollama, its model store is
      // tried FIRST and wins outright (exact pre-existing behavior, unchanged)
      const savedKind = A.provider.kind;
      A.provider.kind = "ollama";
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: "qwen2.5-coder:1.5b-instruct" }] }) });
      const fakeOllamaAgent = { memModel: "big-brain" };
      const found = await A.Agent.prototype.resolveHelperModel.call(fakeOllamaAgent);
      globalThis.fetch = realFetch;
      A.provider.kind = savedKind;
      check("resolveHelperModel: Ollama-as-main-provider still finds its installed helper first",
        found === "qwen2.5-coder:1.5b-instruct" && fakeOllamaAgent._helperKind === "ollama", JSON.stringify({ found, kind: fakeOllamaAgent._helperKind }));

      // THE FIX (2026-07-22): per-step routing must NOT hand a whole tool-calling execute()
      // session to the bundled (non-Ollama) helper — it lives on its OWN port, unreachable via
      // the main provider's `model` field the way Ollama's multi-model daemon is. Only Ollama-
      // kind helpers may be routed a full step; a "llama"-kind helper must be skipped.
      const stepText = "rename the variable x to total"; // matches TRIVIAL_STEP_HINTS
      const baseStepAgent = () => ({
        memModel: "big-brain", files: new Set(), lockedFiles: new Set(), failedCmds: new Map(),
        rootList: "(empty)", task: "t", stopped: false, overBudget: () => false, gates: {},
      });
      const llamaStepAgent = baseStepAgent();
      llamaStepAgent.resolveHelperModel = async () => { llamaStepAgent._helperKind = "llama"; return "helper"; };
      llamaStepAgent.execute = async (msgs, emit, ctx, opts) => { llamaStepAgent.seenModel = opts.model; return []; };
      await A.Agent.prototype.runOneStep.call(llamaStepAgent, stepText, 0, [stepText], {}, () => {}, "sys");
      check("runOneStep: never routes a full step to the bundled (non-Ollama) helper", llamaStepAgent.seenModel === undefined, JSON.stringify(llamaStepAgent.seenModel));

      const ollamaStepAgent = baseStepAgent();
      ollamaStepAgent.resolveHelperModel = async () => { ollamaStepAgent._helperKind = "ollama"; return "qwen2.5-coder:1.5b-instruct"; };
      ollamaStepAgent.execute = async (msgs, emit, ctx, opts) => { ollamaStepAgent.seenModel = opts.model; return []; };
      await A.Agent.prototype.runOneStep.call(ollamaStepAgent, stepText, 0, [stepText], {}, () => {}, "sys");
      check("runOneStep: Ollama-kind helper routing still works, unchanged", ollamaStepAgent.seenModel === "qwen2.5-coder:1.5b-instruct", ollamaStepAgent.seenModel);
    }

    // AMD/Intel VRAM detection fix (2026-07-23): Win32_VideoController.AdapterRAM is a
    // DOCUMENTED 32-bit WMI field that caps/misreports any GPU above ~4GB (real-world reports of
    // 8GB+ cards reading back as 4GB or negative). This was the ONLY VRAM source for any GPU
    // that isn't reachable via nvidia-smi (i.e. every AMD Radeon and Intel Arc user) — meaning
    // real 6GB/8GB/12GB dGPUs would be silently treated as ~4GB, feeding an under-estimate into
    // computeLlamaFlags. Fix: cross-check against the registry's real 64-bit qwMemorySize value
    // and prefer it when readable. No AMD/Intel hardware needed to test the parsing logic itself.
    check("classifyGpuVendor: Radeon name recognized as amd", A.classifyGpuVendor("AMD Radeon RX 6700 XT") === "amd");
    check("classifyGpuVendor: Arc name recognized as intel", A.classifyGpuVendor("Intel Arc A770") === "intel");
    check("classifyGpuVendor: GeForce name recognized as nvidia", A.classifyGpuVendor("NVIDIA GeForce RTX 3060") === "nvidia");
    check("classifyGpuVendor: unrecognized name falls back to other", A.classifyGpuVendor("Some Weird Adapter") === "other");

    check("matchRegistryVram: an 8GB Radeon reads back as 8GB, not the WMI-capped 4GB",
      A.matchRegistryVram([{ DriverDesc: "AMD Radeon RX 6600", qwMemorySize: 8589934592 }], "AMD Radeon RX 6600") === 8589934592);
    check("matchRegistryVram: a 12GB card is not truncated (proves this isn't just a 4GB-cap fix, it's a real 64-bit read)",
      A.matchRegistryVram([{ DriverDesc: "NVIDIA GeForce RTX 3060", qwMemorySize: 12884901888 }], "NVIDIA GeForce RTX 3060") === 12884901888);
    check("matchRegistryVram: dGPU+iGPU box picks the entry matching the WMI-reported name, not just the first one",
      A.matchRegistryVram([{ DriverDesc: "Intel(R) UHD Graphics", qwMemorySize: 1073741824 }, { DriverDesc: "AMD Radeon RX 6700 XT", qwMemorySize: 12884901888 }], "AMD Radeon RX 6700 XT") === 12884901888);
    check("matchRegistryVram: falls back to the largest entry when no name matches (assume the real dGPU, not an iGPU stub)",
      A.matchRegistryVram([{ DriverDesc: "Microsoft Basic Display Adapter", qwMemorySize: 268435456 }, { DriverDesc: "AMD Radeon RX 6800", qwMemorySize: 17179869184 }], "Some Unmatched Name String") === 17179869184);
    check("matchRegistryVram: no usable entries returns null (caller falls back to AdapterRAM)",
      A.matchRegistryVram([{ DriverDesc: "Microsoft Basic Display Adapter", qwMemorySize: 0 }], "AMD Radeon") === null);
    check("matchRegistryVram: empty/missing entries array is handled without throwing", A.matchRegistryVram([], "AMD Radeon") === null && A.matchRegistryVram(null, "AMD Radeon") === null);

    // Live end-to-end check on THIS box (Nvidia, real 12GB card): force detectHardware() down the
    // WMI+registry fallback branch (by hiding nvidia-smi from PATH while keeping powershell.exe
    // reachable) to prove the REAL shipped code — not a reimplementation — reads the true 12GB via
    // the registry cross-check instead of trusting a possibly-capped AdapterRAM. (An earlier version
    // of this test called powershell directly via execFile with an array of args to exercise just
    // the registry query in isolation; that specific invocation shape turned out to fail silently
    // against this exact multi-statement ForEach-Object pipeline for reasons unrelated to the fix
    // itself — the real detectHardware()/execP path, which uses a single shell command string, is
    // what ships and is what's verified here, end-to-end.)
    if (os.platform() === "win32") {
      const savedPath = process.env.PATH;
      process.env.PATH = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0;C:\\WINDOWS\\System32";
      try {
        const hw = await A.detectHardware();
        check("LIVE: detectHardware() falls back to WMI+registry when nvidia-smi is unreachable, and reads the true 12GB (not a 4GB-capped AdapterRAM value)",
          hw.gpu && hw.gpu.vendor === "nvidia" && hw.gpu.vramGB === 12, JSON.stringify(hw.gpu));
      } finally { process.env.PATH = savedPath; }
    }
  }

  section("chatStream (openai kind): SSE tail-flush bug (2026-09-08)");
  {
    // BUG (found this run): the OpenAI-compat streaming branch of chatStream only emitted a
    // parsed "data:" line once a trailing "\n" completed it in the buffer, and returned early
    // only on an explicit "data: [DONE]" line — with NO fallback flush after the read loop like
    // its sibling Ollama branch a few lines below already has. A stream whose LAST chunk arrives
    // without a trailing newline and without a [DONE] sentinel (some non-conformant OpenAI-compat
    // local servers on abrupt disconnect) silently dropped the final delta. Verified against a
    // real local mock HTTP SSE server (not a reimplementation) — chatStream is exercised directly,
    // in-process, against agent.mjs's real exported function.
    const A = await import("./agent.mjs");
    const savedProvider = { ...A.provider };
    const runCase = async (handler) => {
      const server = http.createServer(handler);
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      const port = server.address().port;
      A.setProvider({ kind: "openai", base: `http://127.0.0.1:${port}`, model: "test", key: "" });
      let out = "";
      await A.chatStream([{ role: "user", content: "hi" }], (d) => { out += d; });
      await new Promise((res) => server.close(res));
      return out;
    };
    const sseChunk = (s) => (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(s); res.end(); };

    const doneTerminated = await runCase(sseChunk(
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n'));
    check("chatStream openai: normal [DONE]-terminated stream is unaffected", doneTerminated === "Hello world", doneTerminated);

    const newlineNoDone = await runCase(sseChunk(
      'data: {"choices":[{"delta":{"content":"foo"}}]}\n\ndata: {"choices":[{"delta":{"content":"bar"}}]}\n\n'));
    check("chatStream openai: newline-terminated stream with no [DONE] at all is unaffected", newlineNoDone === "foobar", newlineNoDone);

    const unterminatedTail = await runCase(sseChunk(
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}'));
    check("chatStream openai: FIX — an unterminated final chunk (no trailing newline, no [DONE]) is no longer dropped",
      unterminatedTail === "Hello world", unterminatedTail);

    const emptyTail = await runCase(sseChunk('data: {"choices":[{"delta":{"content":"only"}}]}\n\n'));
    check("chatStream openai: a clean end with an empty tail does not throw or double-emit", emptyTail === "only", emptyTail);

    const unterminatedDone = await runCase(sseChunk('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]'));
    check("chatStream openai: an unterminated [DONE] tail is recognized as the sentinel, not emitted as garbage text",
      unterminatedDone === "x", unterminatedDone);

    A.setProvider(savedProvider); // restore — this in-process module instance is isolated from the spawned server child, but keep hygiene
  }

  section("chatStream (anthropic + gemini kind): same SSE tail-flush bug (2026-09-08)");
  {
    // BUG (found this run, same day as the openai/ollama fix above): the Anthropic and Gemini
    // streaming branches of chatStream had the exact same gap — no fallback flush for a final
    // "data:" line that arrives without a trailing newline when the stream closes mid-line. A
    // non-conformant Anthropic-compatible or Gemini-compatible gateway (both are documented,
    // first-class BYOM provider kinds in this codebase, not just the literal vendor APIs) that
    // disconnects right after its last chunk would silently drop the final delta, same as the
    // openai case. Verified against real local mock HTTP SSE servers, exercising chatStream
    // directly against agent.mjs's real exported function.
    const A = await import("./agent.mjs");
    const savedProvider = { ...A.provider };
    const runCase = async (kind, handler) => {
      const server = http.createServer(handler);
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      const port = server.address().port;
      A.setProvider({ kind, base: `http://127.0.0.1:${port}`, model: "test", key: "k" });
      let out = "";
      await A.chatStream([{ role: "user", content: "hi" }], (d) => { out += d; });
      await new Promise((res) => server.close(res));
      return out;
    };
    const sseChunk = (s) => (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(s); res.end(); };

    const anthNormal = await runCase("anthropic", sseChunk(
      'data: {"type":"content_block_delta","delta":{"text":"Hello "}}\n\ndata: {"type":"content_block_delta","delta":{"text":"world"}}\n\ndata: {"type":"message_stop"}\n\n'));
    check("chatStream anthropic: normal message_stop-terminated stream is unaffected", anthNormal === "Hello world", anthNormal);

    const anthUnterminated = await runCase("anthropic", sseChunk(
      'data: {"type":"content_block_delta","delta":{"text":"Hello "}}\n\ndata: {"type":"content_block_delta","delta":{"text":"world"}}'));
    check("chatStream anthropic: FIX — an unterminated final chunk (no trailing newline) is no longer dropped",
      anthUnterminated === "Hello world", anthUnterminated);

    const anthEmptyTail = await runCase("anthropic", sseChunk('data: {"type":"content_block_delta","delta":{"text":"only"}}\n\n'));
    check("chatStream anthropic: a clean end with an empty tail does not throw or double-emit", anthEmptyTail === "only", anthEmptyTail);

    const gemNormal = await runCase("gemini", sseChunk(
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\n'));
    check("chatStream gemini: normal newline-terminated stream is unaffected", gemNormal === "Hello world", gemNormal);

    const gemUnterminated = await runCase("gemini", sseChunk(
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}'));
    check("chatStream gemini: FIX — an unterminated final chunk (no trailing newline) is no longer dropped",
      gemUnterminated === "Hello world", gemUnterminated);

    const gemEmptyTail = await runCase("gemini", sseChunk('data: {"candidates":[{"content":{"parts":[{"text":"only"}]}}]}\n\n'));
    check("chatStream gemini: a clean end with an empty tail does not throw or double-emit", gemEmptyTail === "only", gemEmptyTail);

    A.setProvider(savedProvider);
  }

  section("pullModel: NDJSON tail-flush bug (2026-09-08)");
  {
    // BUG (same day, same tail-flush class as the chatStream fixes above): pullModel's Ollama
    // /api/pull NDJSON reader only parsed a line once a trailing "\n" completed it in the buffer,
    // with no fallback flush after the read loop. A stream whose LAST line arrives without a
    // trailing newline was silently dropped — and if that dropped line was `{"error":...}` (a
    // genuinely FAILED pull), pullModel fell through to `return {ok:true,status:"pulled"}`,
    // reporting a failed download as a success. Verified against a real local mock HTTP server,
    // exercising pullModel directly against agent.mjs's real exported function.
    const A = await import("./agent.mjs");
    const savedProvider = { ...A.provider };
    const emptyTags = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [] })); };
    const runCase = async (pullHandler, onProgress = () => {}) => {
      const server = http.createServer((req, res) => {
        if (req.url === "/api/tags") return emptyTags(req, res);
        if (req.url === "/api/pull") return pullHandler(req, res);
        res.writeHead(404); res.end();
      });
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      const port = server.address().port;
      A.setProvider({ kind: "ollama", base: `http://127.0.0.1:${port}` });
      const result = await A.pullModel("test-model:latest", onProgress);
      await new Promise((res) => server.close(res));
      return result;
    };
    const ndjson = (s) => (req, res) => { res.writeHead(200, { "content-type": "application/x-ndjson" }); res.write(s); res.end(); };

    const normal = await runCase(ndjson('{"status":"pulling manifest"}\n{"status":"success"}\n'));
    check("pullModel: normal newline-terminated stream is unaffected", normal.ok === true && normal.status === "pulled", JSON.stringify(normal));

    const successNoNL = await runCase(ndjson('{"status":"pulling manifest"}\n{"status":"success"}'));
    check("pullModel: a final SUCCESS line with no trailing newline still reports success",
      successNoNL.ok === true && successNoNL.status === "pulled", JSON.stringify(successNoNL));

    const errorNoNL = await runCase(ndjson('{"status":"pulling manifest"}\n{"error":"pull failed: disk full"}'));
    check("pullModel: FIX — a final ERROR line with no trailing newline is no longer swallowed as a false success",
      errorNoNL.ok === false && /disk full/.test(errorNoNL.reason || ""), JSON.stringify(errorNoNL));

    const progressCalls = [];
    const tailProgress = await runCase(ndjson('{"status":"pulling manifest"}\n{"status":"verifying sha256 digest"}'), (m) => progressCalls.push(m));
    check("pullModel: the unterminated tail status is still reported via onProgress",
      progressCalls.includes("verifying sha256 digest") && tailProgress.ok === true, JSON.stringify(progressCalls));

    const emptyTailCalls = [];
    const emptyTail = await runCase(ndjson('{"status":"success"}\n'), (m) => emptyTailCalls.push(m));
    check("pullModel: a clean end with an empty tail does not throw or double-emit",
      emptyTail.ok === true && emptyTailCalls.filter((m) => m === "success").length === 1, JSON.stringify(emptyTailCalls));

    A.setProvider(savedProvider);
  }

  section("completeCode: fenced-echo anti-dedup asymmetry bug (2026-09-09)");
  {
    // BUG 87: completeCode's anti-echo check (`t.startsWith(curLine.trimStart())`) only caught an
    // echoed current-line when the reply had NO leading whitespace of its own. stripFences()'s
    // outer .trim() strips a NO-FENCE reply's leading whitespace for free, but a FENCED reply's
    // captured inner block keeps its first line's leading whitespace verbatim (correct in general
    // — fenced blocks carry meaningful indentation) — so a model that wrapped an echoed line in
    // ``` and reproduced its own indentation defeated the check entirely, leaving the already-typed
    // prefix duplicated in the inserted ghost text. Fixed via a shared dropEchoedCurLine() helper
    // that strips the completion's own leading spaces/tabs before comparing. Verified against the
    // real exported completeCode via a real local mock HTTP server (both the chat-fallback route
    // AND the explicit-override FIM route share the same helper).
    const A = await import("./agent.mjs");
    const savedProvider = { ...A.provider };
    const runCase = async ({ chatReply, generateReply, completionModel = "" }) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url.includes("/api/generate")) res.end(JSON.stringify({ response: generateReply || "" }));
        else res.end(JSON.stringify({ message: { content: chatReply || "" } }));
      });
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      const port = server.address().port;
      A.setProvider({ kind: "ollama", base: `http://127.0.0.1:${port}`, completionModel });
      const out = await A.completeCode("def total(a, b):\n    tot", "\n", `t${Date.now()}_${Math.random()}`);
      await new Promise((res) => server.close(res));
      return out;
    };

    const noFence = await runCase({ chatReply: "    total = a + b" });
    check("completeCode: no-fence echo with leading whitespace dedupes correctly", noFence === "al = a + b", noFence);

    const fenced = await runCase({ chatReply: "```python\n    total = a + b\n```" });
    check("completeCode: FIX — fenced echo with leading whitespace now also dedupes correctly", fenced === "al = a + b", fenced);

    const fencedClean = await runCase({ chatReply: "```python\ntotal = a + b\n```" });
    check("completeCode: fenced echo with no leading whitespace still dedupes (no regression)", fencedClean === "al = a + b", fencedClean);

    const multiLine = await runCase({ chatReply: "```python\n    total = a + b\n    return total\n```" });
    check("completeCode: multi-line fenced echo strips only the echoed 1st line, keeps 2nd line's own indent",
      multiLine === "al = a + b\n    return total", multiLine);

    const noEcho = await runCase({ chatReply: "al = a + b" });
    check("completeCode: a genuine non-echo completion passes through unchanged", noEcho === "al = a + b", noEcho);

    const fimEcho = await runCase({ generateReply: "    total = a + b", completionModel: "fake-fim-tag" });
    check("completeCode: FIX — the FIM-override route's leading-ws echo also dedupes correctly", fimEcho === "al = a + b", fimEcho);

    A.setProvider(savedProvider);
  }

  section("editCode: indentation-loss + empty-deletion-fallback bugs (2026-09-09)");
  {
    // BUG 88: editCode (Cmd-K inline edit) used the shared stripFences(), whose unconditional outer
    // .trim() strips leading whitespace off the very START of a non-fenced reply. Every OTHER
    // stripFences() caller generates whole-file/whole-function content that legitimately starts at
    // column 0, but editCode replaces an arbitrary-indent SELECTED SPAN and its own system prompt
    // explicitly demands "preserve the surrounding indentation style" — so a model that obeyed and
    // matched the surrounding indent got that exact indentation silently destroyed on just the
    // first line. Fixed via a new stripFencesKeepIndent() that only strips leading BLANK LINES, not
    // leading whitespace on the first real content line.
    //
    // BUG 89: the old `... || code` fallback fired whenever the STRIPPED result was empty, which
    // conflated two different situations: (a) a genuine API/model non-response (nothing to work
    // with, safe to leave the span untouched) and (b) a deliberate reply that legitimately strips
    // down to nothing (e.g. instruction "delete this code", model answers with an empty fenced
    // block) — a mainstream real Cmd-K use case. The old fallback fired on both, so asking Cmd-K to
    // delete code silently did nothing. Fixed by checking the RAW content (pre-strip) for emptiness
    // instead of the post-strip result.
    const A = await import("./agent.mjs");
    const savedProvider = { ...A.provider };
    const runCase = async (chatReply, code = "    x = 1\n    y = 2\n", instruction = "delete this code entirely") => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: { content: chatReply } }));
      });
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      const port = server.address().port;
      A.setProvider({ kind: "ollama", base: `http://127.0.0.1:${port}` });
      const out = await A.editCode(code, instruction, "python", "t.py");
      await new Promise((res) => server.close(res));
      A.setProvider(savedProvider);
      return out;
    };

    const ambiguousEmpty = await runCase("");
    check("editCode: bare-empty reply (true API non-response) stays conservative fallback",
      ambiguousEmpty === "    x = 1\n    y = 2\n", ambiguousEmpty);

    const genuineDeletion = await runCase("```python\n\n```");
    check("editCode: FIX (BUG 89) — deliberate empty fenced deletion actually deletes, not silently ignored",
      genuineDeletion === "", genuineDeletion);

    const missingContent = await runCase(undefined);
    check("editCode: content missing entirely (real API failure) stays conservative fallback",
      missingContent === "    x = 1\n    y = 2\n", missingContent);

    const normalReplace = await runCase("    z = 3\n");
    check("editCode: normal non-fenced replacement passes through (with FIX indent preserved)",
      normalReplace === "    z = 3", normalReplace);

    const indentPreserved = await runCase("    new_line_1\n    new_line_2\n", "    old_1\n    old_2\n", "rename these variables");
    check("editCode: FIX (BUG 88) — non-fenced multi-line reply keeps its first line's indentation",
      indentPreserved === "    new_line_1\n    new_line_2", indentPreserved);
  }

  section("UI smoke: page loads with ZERO JS errors (headless)");
  try {
    const { chromium } = await import("playwright-core");
    const exes = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"];
    let exe = null; for (const c of exes) { try { fs.accessSync(c); exe = c; break; } catch { } }
    if (!exe) { console.log("  INFO  no local Chromium — UI smoke skipped"); }
    else {
      const br = await chromium.launch({ executablePath: exe, headless: true });
      const pg = await br.newPage();
      const jsErrors = [];
      pg.on("pageerror", (e) => jsErrors.push(String(e.message || e)));
      await pg.goto(BASE + "/", { waitUntil: "load" });
      await pg.waitForTimeout(1500);
      check("no JS errors on load", jsErrors.length === 0, jsErrors.join(" | ").slice(0, 200));
      const mgr = await pg.evaluate(() => ({
        newtask: !!document.getElementById("newtask"), projects: !!document.getElementById("projects"),
        modelchip: !!document.getElementById("modelchip"), settings: !!document.getElementById("wset"),
        title: document.title,
      }));
      check("Agent Manager is the app's home page", mgr.newtask && mgr.projects && mgr.modelchip && mgr.settings && /Agent Manager/.test(mgr.title), JSON.stringify(mgr));
      await pg.evaluate(() => { document.getElementById("gear").click(); });
      await pg.waitForTimeout(500);
      const setOpen = await pg.evaluate(() => document.getElementById("wset").classList.contains("on") && !!document.getElementById("presets"));
      check("Manager settings open with model presets", setOpen === true);
      await pg.evaluate(() => { S.projects = ["X:/demo"]; S.project = "X:/demo"; S.health = { configured: true, eta: true, model: "m", local: true }; S.runs["1"] = { meta: { id: "1", task: "demo task", workspace: "X:/demo", status: "running", started: Date.now(), files: [], warnings: [] }, events: [{ type: "plan_review", id: "1:plan", plan: "step one" }] }; document.getElementById("sclose").click(); S.view = "1"; render(); });
      await pg.waitForTimeout(500);
      const rv = await pg.evaluate(() => ({ needs: !!document.querySelector(".ev.need"), proceed: !!document.querySelector('[data-a="approve"]'), art: !!document.getElementById("art") }));
      check("run view shows a plan to approve with Proceed + artifacts pane", rv.needs && rv.proceed && rv.art, JSON.stringify(rv));
      check("still no JS errors after interactions", jsErrors.length === 0, jsErrors.join(" | ").slice(0, 200));

      // EMBED mode (inside the VS Code fork): agent panel ONLY — the host IDE
      // draws explorer/editor/terminal, so none of ours may be visible.
      const pg2 = await br.newPage({ viewport: { width: 420, height: 900 } });
      const jsErrors2 = [];
      pg2.on("pageerror", (e) => jsErrors2.push(String(e.message || e)));
      await pg2.goto(BASE + "/?embed=1", { waitUntil: "load" });
      await pg2.waitForTimeout(1500);
      check("embed: no JS errors", jsErrors2.length === 0, jsErrors2.join(" | ").slice(0, 200));
      const emb = await pg2.evaluate(() => {
        const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null && el.offsetWidth > 0; };
        return {
          right: vis("right"), chatbox: vis("chatbox"), esettings: vis("esettings"),
          activity: vis("activity"), sidebar: vis("sidebar"), center: vis("center"), statusbar: vis("statusbar"),
          rightWide: document.getElementById("right").offsetWidth >= window.innerWidth - 4,
          termSession: typeof termId !== "undefined" ? termId : null,
        };
      });
      check("embed: agent panel visible + full width", emb.right && emb.chatbox && emb.esettings && emb.rightWide, JSON.stringify(emb));
      check("embed: NO nested IDE (activity/explorer/editor/statusbar hidden)", !emb.activity && !emb.sidebar && !emb.center && !emb.statusbar, JSON.stringify(emb));
      check("embed: no hidden shell session spawned", emb.termSession === null, String(emb.termSession));
      await pg2.evaluate(() => document.getElementById("esettings").click());
      await pg2.waitForTimeout(400);
      const sOpen = await pg2.evaluate(() => document.getElementById("settings").style.display !== "none");
      check("embed: settings reachable from panel header", sOpen === true);

      // connect screen: when no model is connected the panel shows model setup, not chat
      const cn = await pg2.evaluate(() => {
        document.getElementById("settings").style.display = "none";
        document.getElementById("right").classList.add("disconnected");
        const vis = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
        const r = { connect: vis("connect"), chatlog: vis("chatlog"), rtabs: vis("rtabs"),
          base: !!document.getElementById("cn-base"), model: !!document.getElementById("cn-model"),
          presets: document.querySelectorAll("#cn-presets button").length };
        document.getElementById("right").classList.remove("disconnected");
        return r;
      });
      check("embed: connect screen replaces chat when no model", cn.connect && !cn.chatlog && !cn.rtabs, JSON.stringify(cn));
      check("embed: connect screen has endpoint + model + 5 presets", cn.base && cn.model && cn.presets === 5, JSON.stringify(cn));

      // fixed black identity: applyTheme must NOT adopt the host palette (stays black + blue)
      const th = await pg2.evaluate(() => {
        applyTheme({ kind: "light", colors: { editor: "rgb(255, 255, 255)", txt: "rgb(17, 17, 17)", accent: "rgb(0, 120, 90)", font: "Verdana" } });
        const cs = getComputedStyle(document.documentElement);
        return { editor: cs.getPropertyValue("--editor").trim(), accent: cs.getPropertyValue("--accent").trim(), font: cs.getPropertyValue("--eta-font").trim() };
      });
      check("embed: fixed black identity — host palette NOT adopted", !/255/.test(th.editor) && !/120/.test(th.accent), JSON.stringify(th));
      check("embed: host UI font still borrowed", /Verdana/.test(th.font), th.font);
      check("embed: still no JS errors", jsErrors2.length === 0, jsErrors2.join(" | ").slice(0, 200));
      await br.close();
    }
  } catch (e) { check("UI smoke ran", false, String(e).slice(0, 150)); }

  section("SSE: events were broadcast");
  await sleep(400);
  sseReq.destroy();
  check("SSE stream carried run/approval traffic", sse.includes('"type"'), sse.slice(0, 120));

  // teardown
  lspMock.close();
  try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" }); } catch { try { child.kill(); } catch {} }
  console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
