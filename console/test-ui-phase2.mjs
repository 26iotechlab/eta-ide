// Test: agent chat panel PHASE 2 ("Tool blocks + live plan") — headless browser, NO model, NO GPU.
// 1) engine helper toolOutcome (ok, short redacted summary); 2) replays run events into the page (taskEvent)
// and checks the tool blocks, durations, failed marker, escaping, live plan status, and that OLD saved runs
// (events without callId / ms / ok / summary) still replay. Also replays the real saved runs of this PC
// (~/.eta-ide/state.json, read only) when that file exists.
// Run: node test-ui-phase2.mjs      (starts its own model-less server on :8892 when none answers there)
import fs from "fs"; import os from "os"; import path from "path"; import { spawn } from "child_process";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.slice(0, 900) + ")"}`); };
const PORT = process.env.ETA_UI2_PORT || "8892", BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT = process.env.ETA_UI2_SHOT || "D:\\eta-ide\\reports\\ui-phase2.png";

// ---------- 1. engine helper (no browser needed)
{
  const { toolOutcome } = await import("./agent.mjs");
  const a = toolOutcome("read_file", "line one\nline two\nkey sk-ant-abcdefghijklmnopqrstuvwxyz0123");
  ok(a.ok === true && /line one/.test(a.summary) && !/abcdefghijklmnop/.test(a.summary) && /hidden/.test(a.summary), "toolOutcome: ok result, secret key hidden in the summary", a);
  const big = toolOutcome("search", Array.from({ length: 300 }, (_, i) => "match " + i + " " + "x".repeat(50)).join("\n"));
  ok(big.summary.length <= 400 && big.resultLines === 300 && big.summary.split("\n").length <= 6, "toolOutcome: big output becomes a short summary (at most 6 lines, 400 characters)", { len: big.summary.length, lines: big.resultLines });
  const cmd = toolOutcome("run_command", "⚠ COMMAND FAILED (exit 1) — you must fix this\n" + Array.from({ length: 20 }, (_, i) => "out " + i).join("\n") + "\n1 failed, 3 passed");
  ok(cmd.ok === false && /1 failed, 3 passed/.test(cmd.summary), "toolOutcome: a failed command is ok=false and keeps its LAST lines", cmd);
  for (const r of ["VETOED by verifier: x", "BLOCKED by hook: y", "Error: 'path' is required.", "Edit failed: no match", "Could not read a.py: ENOENT", "⚠ STOP — you already ran this"])
    ok(toolOutcome("edit_file", r).ok === false, "toolOutcome: '" + r.slice(0, 22) + "' counts as failed");
  ok(toolOutcome("list_dir", "").ok === true && toolOutcome("list_dir", "").summary === "", "toolOutcome: empty result is ok with an empty summary");
}
// engine source: every executed call carries callId + ms + the outcome; steps are announced
{
  const src = fs.readFileSync(path.join(here, "agent.mjs"), "utf8");
  ok(/emit\(\{ type: "tool", name: tc\.name, args: tc\.args, callId \}\)/.test(src), "engine: the tool event carries a callId");
  ok(/type: "toolResult", name: tc\.name, result: String\(r\)\.slice\(0, 1500\), callId, ms: Date\.now\(\) - toolT0, \.\.\.toolOutcome\(tc\.name, r\)/.test(src) && (src.match(/noStart: true, args: tc\.args/g) || []).length === 2, "engine: the toolResult event keeps the old result field and adds callId, ms and the outcome");
  ok(/type: "plan_steps"/.test(src) && /type: "plan_step", index: i/.test(src) && /stepEv\(i, "working"\)/.test(src) && /stepEv\(i, "done"\)/.test(src) && /stepEv\(i, "failed"\)/.test(src), "engine: plan steps are announced (working, done, failed)");
}

let pw; try { pw = await import("playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed"); console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0); }
const exes = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
let exe = null; for (const c of exes) { try { fs.accessSync(c); exe = c; break; } catch { } }
if (!exe) { console.log("SKIPPED: no local Chromium/Edge found"); console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0); }

let child = null;
const up = async () => { try { return (await fetch(BASE + "/", { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
if (!(await up())) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eta-p2-"));
  child = spawn(process.execPath, ["server.mjs"], { cwd: here, env: { ...process.env, PORT, USERPROFILE: home, HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(500);
  if (!(await up())) { try { child.kill(); } catch { } console.log("SKIPPED: could not start the model-less server"); console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0); }
}

let br;
try {
  br = await pw.chromium.launch({ executablePath: exe, headless: true });
  const T0 = Date.now() - 60000;
  // ---------- a NEW-format run: ids, durations, outcome, plan steps
  const HTMLY = '<img src=x onerror="window.__xss=1"><b>bold</b> & <script>window.__xss=2</script>';
  const run = (id) => [
    { type: "start", runId: id, ts: T0 },
    { type: "agent", runId: id, role: "planner" },
    { type: "plan", runId: id, text: "1. Read src/app.py\n2. Fix the zero-division bug\n3. Run the tests", steps: ["Read src/app.py", "Fix the zero-division bug", "Run the tests"] },
    { type: "narration", runId: id, text: "Here's my plan — 3 steps:\n1. Read src/app.py\n2. Fix the zero-division bug\n3. Run the tests\n\nStarting now." },
    { type: "plan_steps", runId: id, steps: ["Read src/app.py", "Fix the zero-division bug", "Run the tests"], done: [] },
    { type: "plan_step", runId: id, index: 0, total: 3, text: "Read src/app.py", status: "working" },
    { type: "agent", runId: id, role: "executor" },
    { type: "tool", runId: id, name: "read_file", args: { path: "src/app.py" }, callId: "c1", ts: T0 + 1000 },
    { type: "toolResult", runId: id, name: "read_file", result: "def div(a, b):\n    return a / b\n", callId: "c1", ms: 12, ok: true, summary: "def div(a, b):\n    return a / b", resultLines: 2 },
    { type: "tool", runId: id, name: "search", args: { query: "<div>" }, callId: "c2" },
    { type: "toolResult", runId: id, name: "search", result: HTMLY, callId: "c2", ms: 1530, ok: true, summary: HTMLY, resultLines: 1 },
    { type: "plan_step", runId: id, index: 0, total: 3, text: "Read src/app.py", status: "done" },
    { type: "plan_step", runId: id, index: 1, total: 3, text: "Fix the zero-division bug", status: "working" },
    { type: "tool", runId: id, name: "edit_file", args: { path: "src/app.py" }, callId: "c3" },
    { type: "toolResult", runId: id, name: "edit_file", result: "Edit failed: the SEARCH text was not found in src/app.py", callId: "c3", ms: 2400, ok: false, summary: "Edit failed: the SEARCH text was not found in src/app.py", resultLines: 1 },
    { type: "toolResult", runId: id, name: "write_file", result: "VETOED by verifier: wrong file", callId: "c4", ms: 0, ok: false, summary: "VETOED by verifier: wrong file", noStart: true, args: { path: "src/other.py" } },
    { type: "tool", runId: id, name: "write_file", args: { path: "src/app.py" }, callId: "c5" },
    { type: "toolResult", runId: id, name: "write_file", result: "Wrote src/app.py (4 lines). Syntax gate: OK", callId: "c5", ms: 800, ok: true, summary: "Wrote src/app.py (4 lines). Syntax gate: OK" },
    { type: "diff", runId: id, file: "src/app.py", start: 1, removed: ["    return a / b"], added: ["    if b == 0:", "        return 0", "    return a / b"], addedTotal: 3, removedTotal: 1 },
    { type: "plan_step", runId: id, index: 1, total: 3, text: "Fix the zero-division bug", status: "done" },
    { type: "plan_step", runId: id, index: 2, total: 3, text: "Run the tests", status: "working" },
    { type: "tool", runId: id, name: "run_command", args: { command: "python -m pytest -q" }, callId: "c6" },
    { type: "toolResult", runId: id, name: "run_command", result: "⚠ COMMAND FAILED (exit 1) — you must fix this before finishing:\n1 failed, 1 passed in 0.2s", callId: "c6", ms: 4200, ok: false, summary: "1 failed, 1 passed in 0.2s" },
    { type: "plan_step", runId: id, index: 2, total: 3, text: "Run the tests", status: "failed" },
  ];
  const doneEv = (id) => ({ type: "done", runId: id, canRevert: false, warnings: [] });
  // ---------- an OLD-format run (shape copied from a real saved run: no callId / ms / ok / summary / steps)
  const oldRun = (id) => [
    { type: "start", runId: id, ts: T0 }, { type: "agent", runId: id, role: "planner" },
    { type: "plan", runId: id, text: "1. Replace app.js\n2. Check the page" }, { type: "agent", runId: id, role: "executor" },
    { type: "tool", runId: id, name: "read_file", args: { path: "app.js" } },
    { type: "toolResult", runId: id, name: "read_file", result: "let cards = [];\nfunction save() {}" },
    { type: "tool", runId: id, name: "write_file", args: { path: "app.js" } },
    { type: "gate", runId: id, file: "app.js", ok: true, msg: "node --check OK" },
    { type: "toolResult", runId: id, name: "write_file", result: "Wrote app.js (31 lines). Syntax gate: OK" },
    { type: "tool", runId: id, name: "check_page", args: { path: "/index.html" } },
    { type: "toolResult", runId: id, name: "check_page", result: "BROWSER CHECK index.html: OK — page loaded, console clean." },
    { type: "tool", runId: id, name: "run_command", args: { command: "node test.js" } },
    { type: "toolResult", runId: id, name: "run_command", result: "⚠ COMMAND FAILED (exit 1)\nAssertionError" },
    { type: "tool", runId: id, name: "finish", args: { summary: "fixed" } },
    { type: "toolResult", runId: id, name: "finish", result: "FINISHED: fixed" },
    { type: "answer", runId: id, text: "Fixed." }, { type: "done", runId: id, canRevert: false, warnings: [] },
  ];

  const open = async () => {
    const ctx = await br.newContext({ viewport: { width: 440, height: 900 } });
    const pg = await ctx.newPage(); const errs = [];
    pg.on("pageerror", (e) => errs.push(String(e.message || e)));
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("console: " + m.text()); });
    await pg.route("**/api/proof**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false,"error":"test"}' }));
    await pg.goto(BASE + "/?embed=1", { waitUntil: "load" }); await pg.waitForTimeout(1000);
    await pg.addStyleTag({ content: "html.embed #right.disconnected #chatlog{display:block!important} html.embed #right.disconnected #connect{display:none!important}" });
    return { pg, errs };
  };
  // live = like SSE events; history = like loadHistory (replay flag)
  const replay = (pg, evs, history) => pg.evaluate(([e, h]) => { const id = e[0].runId; runs[id] = { id, task: "t", started: Date.now() - 1500, status: "running", files: ["src/app.py"] }; for (const x of e) taskEvent(x, h); }, [evs, !!history]);
  const info = (pg, id) => pg.evaluate((id) => {
    const c = cards[id]; const bl = [...c.querySelectorAll(".tblk")];
    const lis = [...c.querySelectorAll("ol.wplist li")];
    return {
      blocks: bl.map((b) => ({ verb: b.querySelector(".tv").textContent, tg: b.querySelector(".ttg").textContent, st: b.querySelector(".tst").textContent, one: b.querySelector(".tone").textContent, failed: !!b.querySelector(".tfail") && b.querySelector(".tfail").textContent, sec: b.classList.contains("sec"), shown: getComputedStyle(b).display !== "none" })),
      cmd: [...c.querySelectorAll(".cmdblk .cmdbadge")].map((b) => b.textContent),
      plans: c.querySelectorAll(".wplan").length, live: !!c.querySelector("ol.wplist.haslive"),
      steps: lis.map((l) => l.dataset.s + ":" + l.querySelector(".pst").textContent + ":" + l.querySelector(".ptx").textContent),
      xss: window.__xss || 0, imgs: c.querySelectorAll(".tblk img, .tblk script, .tblk b").length,
    };
  }, id);

  // ======================= new-format run, live =======================
  const { pg, errs } = await open();
  ok(errs.length === 0, "page loads with zero JS errors", errs);
  // a running call first: shows "running N s" and ticks
  await replay(pg, [{ type: "start", runId: "r0" }, { type: "agent", runId: "r0", role: "executor" }, { type: "tool", runId: "r0", name: "list_dir", args: { path: "src" }, callId: "c1" }, { type: "tool", runId: "r0", name: "run_command", args: { command: "npm test" }, callId: "c2" }]);
  const a1 = await info(pg, "r0"); await pg.waitForTimeout(2200); const a2 = await info(pg, "r0");
  ok(/^running \d+ s$/.test(a1.blocks[0]?.st || "") && /^running \d+ s$/.test(a2.blocks[0]?.st || "") && a1.blocks[0].st !== a2.blocks[0].st, "a running tool shows 'running N s' and the seconds go up (real time, no fake progress)", [a1.blocks[0]?.st, a2.blocks[0]?.st]);
  ok(/^running \d+ s$/.test(a2.cmd[0] || ""), "a running command shows 'running N s' in its badge", a2.cmd);
  await pg.evaluate(() => taskEvent({ type: "cancelled", runId: "r0" }));
  const a3 = await info(pg, "r0");
  ok(a3.blocks[0].st === "no result" && a3.cmd[0] === "no result", "when the run ends, calls without a result say 'no result' (not running forever)", a3);

  await replay(pg, run("r1"));
  await pg.waitForTimeout(200);
  const n = await info(pg, "r1");
  // read, search, edit(failed), vetoed write (failed, no start), run_command is its own command block; the good write shows as the diff card only
  ok(n.blocks.length === 4, "one block per tool call (read, grep, failed edit, vetoed write); a good write is shown only by its diff card", n.blocks.map((b) => b.verb + " " + b.tg));
  ok(n.blocks[0].verb === "read" && n.blocks[0].tg === "src/app.py" && n.blocks[0].st === "12 ms" && n.blocks[0].one === "def div(a, b):", "block shows verb, target, duration and a one-line result", n.blocks[0]);
  ok(n.blocks[1].st === "1.5 s", "durations of 1 s and more are shown in seconds", n.blocks[1].st);
  ok(n.blocks[2].failed === "failed" && /Edit failed/.test(n.blocks[2].one), "a failed tool is marked with the word 'failed' (not colour only)", n.blocks[2]);
  ok(n.blocks[3].failed === "failed" && n.blocks[3].verb === "write" && n.blocks[3].tg === "src/other.py" && n.blocks[3].st === "not run" && /VETOED/.test(n.blocks[3].one), "a vetoed call (never started) is one finished, failed block", n.blocks[3]);
  ok(n.cmd.length === 1 && n.cmd[0] === "failed - 4.2 s", "command block badge shows result and duration", n.cmd);
  ok(n.xss === 0 && n.imgs === 0, "HTML in a tool result is not run and makes no elements", n);
  ok(n.blocks[1].one.includes("<img src=x") && n.blocks[1].tg === "<div>", "HTML-looking result and target are shown as plain text", n.blocks[1]);
  ok(n.blocks[0].sec && !n.blocks[0].shown && !n.blocks[2].sec && n.blocks[2].shown && n.blocks[3].shown, "Details hidden: ok blocks are hidden, failed blocks still show", n.blocks.map((b) => [b.sec, b.shown]));
  // Details toggle shows all
  await pg.evaluate(() => cards["r1"].querySelector(".wdet").click());
  const n2 = await info(pg, "r1");
  ok(n2.blocks.every((b) => b.shown), "Details toggle shows every tool block", n2.blocks.map((b) => b.shown));
  // click to expand
  const ex0 = await pg.evaluate(() => { const b = cards["r1"].querySelectorAll(".tblk")[1]; return { open: b.classList.contains("open"), pre: getComputedStyle(b.querySelector(".tbr")).display, aria: b.querySelector(".tbh").getAttribute("aria-expanded") }; });
  await pg.evaluate(() => cards["r1"].querySelectorAll(".tblk .tbh")[1].click());
  const ex1 = await pg.evaluate(() => { const b = cards["r1"].querySelectorAll(".tblk")[1]; return { open: b.classList.contains("open"), pre: getComputedStyle(b.querySelector(".tbr")).display, txt: b.querySelector(".tbr").textContent, aria: b.querySelector(".tbh").getAttribute("aria-expanded") }; });
  ok(!ex0.open && ex0.pre === "none" && ex1.open && ex1.pre === "block" && ex1.aria === "true" && ex1.txt.startsWith("<img src=x"), "click on a block shows the short result (escaped)", { ex0, ex1 });
  ok(n.plans === 1 && n.live, "plan shown once, as a list with live status", n);
  ok(n.steps.join("|") === "done:done:Read src/app.py|done:done:Fix the zero-division bug|failed:failed:Run the tests", "plan status per step: done, done, failed (text labels)", n.steps);
  // status change in place (no new plan block)
  const mid = await (async () => { const p = await open(); const evs = run("r9"); const cut = evs.findIndex((e) => e.type === "plan_step" && e.index === 1 && e.status === "working");
    await replay(p.pg, evs.slice(0, cut + 1)); const s1 = await info(p.pg, "r9"); await replay(p.pg, evs.slice(cut + 1)); const s2 = await info(p.pg, "r9"); await p.pg.close(); return { s1, s2 }; })();
  ok(mid.s1.steps.join("|") === "done:done:Read src/app.py|working:working:Fix the zero-division bug|pending:waiting:Run the tests" && mid.s2.plans === 1 && mid.s1.plans === 1, "plan status updates in place: done, working, waiting, then later states, still one plan block", mid);
  // edited plan: second plan event replaces the first
  await replay(pg, [{ type: "agent", runId: "r2", role: "planner" }, { type: "plan", runId: "r2", text: "1. A\n2. B", steps: ["A", "B"] }, { type: "plan", runId: "r2", text: "1. A\n2. B\n3. C", steps: ["A", "B", "C"] }]);
  const p2 = await info(pg, "r2");
  ok(p2.plans === 1 && p2.steps.length === 3 && !p2.live, "an edited plan replaces the first one in place; no status labels before steps really run", p2);
  // a run with an error mid-step: the working step becomes stopped
  await replay(pg, [{ type: "plan", runId: "r3", text: "1. A", steps: ["A"] }, { type: "plan_steps", runId: "r3", steps: ["A"], done: [] }, { type: "plan_step", runId: "r3", index: 0, total: 1, text: "A", status: "working" }, { type: "error", runId: "r3", text: "boom" }]);
  const p3 = await info(pg, "r3");
  ok(p3.steps[0] === "stopped:stopped:A", "when a run ends with an error, a step still working shows 'stopped'", p3.steps);
  await pg.evaluate((d) => taskEvent(d), doneEv("r1")); await pg.waitForTimeout(200);
  ok(errs.length === 0, "zero JS errors after the new-format replays", errs);

  // ======================= old-format run (no ids), live and as history =======================
  for (const hist of [false, true]) {
    const o = await open();
    await replay(o.pg, oldRun("o1"), hist); await o.pg.waitForTimeout(150);
    const oi = await info(o.pg, "o1");
    const tag = hist ? " (history replay)" : " (live replay)";
    ok(oi.blocks.length === 3 && oi.blocks.map((b) => b.verb).join(",") === "read,open,finish", "old run: one block per non-write tool" + tag, oi.blocks.map((b) => b.verb));
    ok(oi.blocks.every((b) => b.st === "" && !b.failed) && oi.blocks[0].one === "let cards = [];", "old run: results paired, no made-up duration" + tag, oi.blocks);
    ok(oi.cmd.length === 1 && oi.cmd[0] === "failed", "old run: command block still says failed" + tag, oi.cmd);
    ok(oi.plans === 1 && oi.steps.length === 0, "old run: plan still shown once as text" + tag, oi);
    ok(o.errs.length === 0, "old run: zero JS errors" + tag, o.errs);
    await o.pg.close();
  }

  // ======================= the real saved runs on this PC (read only), if any =======================
  const stateFile = path.join(os.homedir(), ".eta-ide", "state.json");
  if (fs.existsSync(stateFile)) {
    let saved = []; try { saved = (JSON.parse(fs.readFileSync(stateFile, "utf8")).runs || []).filter((r) => Array.isArray(r.events) && r.events.length); } catch { }
    if (saved.length) {
      const o = await open();
      const res = await o.pg.evaluate((rs) => { let tools = 0, blocks = 0, cmds = 0, running = 0;
        for (const r of rs) { runs[r.id] = { ...r, events: undefined }; for (const e of r.events) taskEvent(e, true);
          tools += r.events.filter((e) => e.type === "tool" && e.name !== "write_file" && e.name !== "run_command").length;
          const c = cards[r.id]; if (c) { blocks += c.querySelectorAll(".tblk").length; cmds += c.querySelectorAll(".cmdblk").length; running += c.querySelectorAll(".tblk.st-run").length; } }
        return { tools, blocks, cmds, running }; }, saved.map((r) => ({ id: "saved-" + r.id, status: r.status, started: r.started, files: r.files || [], events: r.events.map((e) => ({ ...e, runId: "saved-" + r.id })) })));
      console.log(`  INFO  replayed ${saved.length} real saved runs: ${res.tools} tool starts, ${res.blocks} tool blocks, ${res.cmds} command blocks`);
      ok(o.errs.length === 0, "real saved runs replay with zero JS errors", o.errs);
      ok(res.blocks >= res.tools && res.running === 0, "real saved runs: every tool start has a block and none is left 'running'", res);
      await o.pg.close();
    }
  } else console.log("  INFO  no saved runs on this PC; real-run replay skipped");

  // ======================= screenshot of the panel replaying a run =======================
  try {
    const s = await open();
    await s.pg.evaluate(() => { try { localStorage.setItem("eta.details", "1"); } catch { } });
    const evs = run("s1"); const cut = evs.findIndex((e) => e.type === "plan_step" && e.index === 2 && e.status === "working");
    await replay(s.pg, evs.slice(0, cut + 1).concat([{ type: "tool", runId: "s1", name: "run_command", args: { command: "python -m pytest -q" }, callId: "c6" }]));
    await s.pg.evaluate(() => { const b = cards["s1"].querySelectorAll(".tblk .tbh")[2]; if (b) b.click(); document.getElementById("chatlog").scrollTop = 0; });
    await s.pg.waitForTimeout(1300);
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    await s.pg.screenshot({ path: SHOT });
    console.log("  INFO  screenshot saved: " + SHOT);
    await s.pg.close();
  } catch (e) { console.log("  INFO  screenshot not taken: " + String(e?.message || e).slice(0, 200)); }
} catch (e) { ok(false, "test ran to the end", String(e && e.message || e).replace(/\u001b\[[0-9;]*m/g, "").slice(0, 900)); }
finally { try { await br?.close(); } catch { } if (child) { try { child.kill(); } catch { } } }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
