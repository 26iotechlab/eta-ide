// Test: agent chat panel PHASE 1 ("Control and calm") — headless browser, NO model, NO GPU.
// Replays realistic run events into the page (taskEvent) and checks the new behaviour.
// Run: node test-ui-phase1.mjs      (starts its own model-less server on :8891 when none answers there)
import fs from "fs"; import os from "os"; import path from "path"; import { spawn } from "child_process";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.slice(0, 900) + ")"}`); };
const PORT = process.env.ETA_UI_PORT || "8891", BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pw; try { pw = await import("playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed"); process.exit(0); }
const exes = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
let exe = null; for (const c of exes) { try { fs.accessSync(c); exe = c; break; } catch { } }
if (!exe) { console.log("SKIPPED: no local Chromium/Edge found"); process.exit(0); }

// ---- server: use the one on PORT if it answers, else start our own (no model) and stop exactly that process
let child = null;
const up = async () => { try { return (await fetch(BASE + "/", { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
if (!(await up())) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eta-p1-"));
  child = spawn(process.execPath, ["server.mjs"], { cwd: here, env: { ...process.env, PORT, USERPROFILE: home, HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(500);
  if (!(await up())) { try { child.kill(); } catch { } console.log("SKIPPED: could not start the model-less server"); process.exit(0); }
}

const EMOJI = /(?![\u00A9\u00AE\u2122])[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u20E3]/u;
const backupPath = "D:\\eta-ide\\reports\\backup-20261115\\ui.html.bak";
let br;
try {
  br = await pw.chromium.launch({ executablePath: exe, headless: true });

  // ---------- events of one realistic run ----------
  const run = (id) => [
    { type: "start", runId: id },
    { type: "agent", runId: id, role: "planner" },
    { type: "plan", runId: id, text: "1. Read src/app.py\n2. Fix the zero-division bug\n3. Run the tests" },
    { type: "narration", runId: id, text: "Here's my plan — 3 steps:\n1. Read src/app.py\n2. Fix the zero-division bug\n3. Run the tests\n\nStarting now." },
    { type: "agent", runId: id, role: "executor" }, { type: "agent", runId: id, role: "executor" }, { type: "agent", runId: id, role: "executor" },
    { type: "narration", runId: id, track: "grounding", text: "🔍 Looking at `src/app.py:42` first ✅ then the tests" },
    { type: "tool", runId: id, name: "read_file", args: { path: "src/app.py" } },
    { type: "tool", runId: id, name: "search", args: { query: "divide" } },
    { type: "tool", runId: id, name: "list_dir", args: { path: "src" } },
    { type: "tool", runId: id, name: "run_command", args: { command: "python -m pytest -q" } },
    { type: "toolResult", runId: id, name: "run_command", result: "COMMAND FAILED (exit 1)\n1 failed, 1 passed in 0.2s" },
    { type: "agent", runId: id, role: "executor" },
    { type: "diff", runId: id, file: "src/app.py", start: 40, removed: ["return a / b"], added: ["if b == 0:", "    return 0", "return a / b"], addedTotal: 3, removedTotal: 1 },
    { type: "gate", runId: id, ok: true, file: "src/app.py", msg: "syntax ok" },
    { type: "agent", runId: id, role: "executor" },
    { type: "tool", runId: id, name: "run_command", args: { command: "python -m pytest -q" } },
    { type: "toolResult", runId: id, name: "run_command", result: "2 passed in 0.2s" },
    { type: "agent", runId: id, role: "reviewer" }, { type: "agent", runId: id, role: "reviewer" },
    { type: "review", runId: id, approved: true },
    { type: "answer", runId: id, text: "Fixed. See src/app.py:42 for the new check. 🎉" },
  ];
  const doneEv = (id) => ({ type: "done", runId: id, canRevert: true, warnings: [], suggestion: "💡 A bigger model could help." });

  const open = async (url, route) => {
    const ctx = await br.newContext({ viewport: { width: 420, height: 560 }, permissions: ["clipboard-read", "clipboard-write"] });
    const pg = await ctx.newPage(); const errs = [];
    pg.on("pageerror", (e) => errs.push(String(e.message || e)));
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("console: " + m.text()); });
    if (route) await pg.route(BASE + "/?embed=1", (r) => r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: route }));
    await pg.goto(url, { waitUntil: "load" }); await pg.waitForTimeout(1200);
    // no model is connected here, so the panel would show the connect screen; force the chat view
    await pg.addStyleTag({ content: "html.embed #right.disconnected #chatlog{display:block!important} html.embed #right.disconnected #connect{display:none!important}" });
    return { pg, errs };
  };
  const replay = (pg, evs) => pg.evaluate((e) => { const id = e[0].runId; runs[id] = { id, task: "t", started: Date.now() - 1500, status: "running", files: ["src/app.py"] }; for (const x of e) taskEvent(x); }, evs);
  const lineCount = (pg) => pg.evaluate(() => { const c = document.querySelector("#chatlog .work"); return c ? c.innerText.split("\n").map((s) => s.trim()).filter(Boolean).length : -1; });

  // ======================= NEW PAGE =======================
  const { pg, errs } = await open(BASE + "/?embed=1");
  ok(errs.length === 0, "page loads with zero JS errors", errs);
  const posts = []; await pg.route("**/api/cancel", (r) => { posts.push({ t: Date.now(), body: r.request().postData() }); r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); });
  await pg.evaluate(() => { window.__msgs = []; window.addEventListener("message", (e) => { if (e.data && e.data.eta === "open") window.__msgs.push(e.data); }); });

  // --- run 1: everything up to (not including) done
  await replay(pg, run("r1"));
  await pg.waitForTimeout(300);
  const live = await pg.evaluate(() => { const c = cards["r1"]; const st = c.querySelector(".wst"); return { stop: c.querySelectorAll(".wstop").length, st: st && st.querySelector(".wst-t").textContent, live: !!c.querySelector('[aria-live="polite"]'), tm: getComputedStyle(document.getElementById("tmeter")).display }; });
  ok(live.stop === 1, "Stop button is in the running task card", live);
  ok(/^(Working|Reviewing) - \d+ s - last output \d+ s ago$/.test(live.st || ""), "in-card status shows phase, elapsed time and last output", live.st);
  ok(live.live, "in-card status has aria-live=polite");
  // meter: speed appears; old line stays hidden
  await pg.evaluate(() => { liveMeter({ phase: "writing", perSec: 12.5, written: 100, read: 50, seconds: 5, ctxPct: 80, busy: true }); tmeter({ phase: "writing", perSec: 12.5, written: 100, read: 50, seconds: 5, busy: true }); });
  const mt = await pg.evaluate(() => ({ st: document.querySelector("#chatlog .wst-t").textContent, tm: getComputedStyle(document.getElementById("tmeter")).display }));
  ok(/12\.5 tokens per second/.test(mt.st) && /Memory 80% full/.test(mt.st), "status uses real meter data (speed, memory)", mt.st);
  ok(mt.tm === "none", "old status line is hidden while a task card is working (not shown twice)", mt.tm);
  const t1 = await pg.evaluate(() => document.querySelector("#chatlog .wst-t").textContent); await pg.waitForTimeout(1300);
  const t2 = await pg.evaluate(() => document.querySelector("#chatlog .wst-t").textContent);
  ok(t1 !== t2, "status refreshes by itself every second", [t1, t2]);
  const sr1 = await pg.evaluate(() => document.querySelector("#chatlog .wst-sr").textContent); await pg.waitForTimeout(1200);
  const sr2 = await pg.evaluate(() => document.querySelector("#chatlog .wst-sr").textContent);
  ok(sr1 === sr2 && sr1.length > 0, "screen-reader text changes only when the phase changes", [sr1, sr2]);

  // --- Stop click reaches the engine fast with the right run id
  const tClick = Date.now(); await pg.click("#chatlog .wstop"); await pg.waitForTimeout(400);
  ok(posts.length === 1 && JSON.parse(posts[0].body).runId === "r1" && posts[0].t - tClick < 2000, "Stop sends POST /api/cancel with the run id within 2 s", posts);

  // --- headers, plan, emoji, copy, details (before done)
  const pre = await pg.evaluate(() => {
    const c = cards["r1"]; const heads = [...c.querySelectorAll(".whead")].map((h) => h.className.replace("whead ", ""));
    let rep = 0; for (let i = 1; i < heads.length; i++) if (heads[i] === heads[i - 1]) rep++;
    const txt = c.innerText;
    return { heads, rep, bug: (txt.match(/zero-division/g) || []).length, planBlocks: c.querySelectorAll(".wplan").length, starting: /Starting now/.test(txt), ref: !!c.querySelector(".fref") };
  });
  ok(pre.rep === 0, "no two consecutive identical role headers", pre.heads);
  ok(pre.heads.join(",") === "planner,executor,reviewer", "headers appear only when the role changes (3 headers for 9 agent events)", pre.heads);
  ok(pre.bug === 1 && pre.planBlocks === 1, "plan text appears exactly once (not again as narration)", pre);
  ok(pre.starting, "the 'Starting now' line of the plan narration is still shown", pre);

  // details toggle
  const d0 = await pg.evaluate(() => { const c = cards["r1"]; const sec = [...c.querySelectorAll(".sec")]; return { n: sec.length, hidden: sec.every((e) => getComputedStyle(e).display === "none"), btn: c.querySelector(".wdet").textContent, shown: getComputedStyle(c.querySelector(".wtop")).display !== "none" }; });
  ok(d0.n >= 4 && d0.hidden && d0.shown, "Details: secondary lines are hidden by default and a toggle exists", d0);
  await pg.click("#chatlog .wdet");
  const d1 = await pg.evaluate(() => { const c = cards["r1"]; return { vis: [...c.querySelectorAll(".sec")].every((e) => getComputedStyle(e).display !== "none"), ls: localStorage.getItem("eta.details"), btn: c.querySelector(".wdet").textContent }; });
  ok(d1.vis && d1.ls === "1" && /Hide details/.test(d1.btn), "Details toggle shows the lines and is remembered in localStorage", d1);
  await pg.click("#chatlog .wdet"); // back to hidden

  // copy buttons
  await pg.evaluate(() => chatMsg("eta", "Use this:\n```py\nx = 1\nprint(x)\n```"));
  const cp = await pg.evaluate(() => ({ code: document.querySelectorAll(".cpwrap .cpbtn").length, diff: document.querySelectorAll(".fcard .fhead .cpbtn").length, cmd: document.querySelectorAll(".cmdblk .cmdhead .cpbtn").length }));
  ok(cp.code >= 1 && cp.diff >= 1 && cp.cmd >= 2, "Copy buttons exist on code blocks, diffs and command blocks", cp);
  await pg.click(".cpwrap .cpbtn"); await pg.waitForTimeout(150);
  const lab = await pg.evaluate(() => document.querySelector(".cpwrap .cpbtn").textContent);
  let clip = null; try { clip = await pg.evaluate(() => navigator.clipboard.readText()); } catch { }
  ok(lab === "Copied", "Copy button says Copied after a click", lab);
  ok(clip === null || clip.replace(/\r\n/g, "\n") === "x = 1\nprint(x)", "Copy puts the code on the clipboard", clip);
  await pg.waitForTimeout(1700);
  ok((await pg.evaluate(() => document.querySelector(".cpwrap .cpbtn").textContent)) === "Copy", "Copy label goes back to Copy after 1.5 s");

  // file:line links
  await pg.click("#chatlog .fref"); await pg.waitForTimeout(150);
  const m1 = await pg.evaluate(() => window.__msgs.slice());
  ok(m1.some((m) => m.path === "src/app.py" && m.line === 42), "a file:line reference opens that file at that line", m1);
  await pg.click("#chatlog .fopen"); await pg.waitForTimeout(150);
  const m2 = await pg.evaluate(() => window.__msgs.slice());
  ok(m2.some((m) => m.path === "src/app.py" && m.line === 40), "diff 'Open in editor' opens at the first changed line", m2);

  // --- scrolling (still running): scrolled up => no movement + jump button
  await pg.evaluate(() => { document.getElementById("chatlog").scrollTop = 1e9; }); await pg.waitForTimeout(200);
  await pg.evaluate(() => { for (let i = 0; i < 40; i++) taskEvent({ type: "narration", runId: "r1", text: "Working on step " + i + " of the long job." }); });
  const sc0 = await pg.evaluate(() => { const l = document.getElementById("chatlog"); return { over: l.scrollHeight > l.clientHeight + 200, near: l.scrollHeight - l.scrollTop - l.clientHeight }; });
  ok(sc0.over && sc0.near <= 60, "following the output while at the bottom", sc0);
  await pg.evaluate(() => { document.getElementById("chatlog").scrollTop = 0; }); await pg.waitForTimeout(200);
  await pg.evaluate(() => { for (let i = 0; i < 5; i++) taskEvent({ type: "narration", runId: "r1", text: "More output " + i }); });
  const sc1 = await pg.evaluate(() => ({ top: document.getElementById("chatlog").scrollTop, jump: (() => { const b = document.getElementById("jumpbtn"); return !!b && getComputedStyle(b).display !== "none" && /jump to bottom/.test(b.textContent); })() }));
  ok(sc1.top === 0 && sc1.jump, "scrolled up: new output does not move the view and the jump button shows", sc1);
  await pg.click("#jumpbtn"); await pg.waitForTimeout(150);
  const sc2 = await pg.evaluate(() => { const l = document.getElementById("chatlog"); const b = document.getElementById("jumpbtn"); return { near: l.scrollHeight - l.scrollTop - l.clientHeight, hidden: getComputedStyle(b).display === "none" }; });
  ok(sc2.near <= 60 && sc2.hidden, "the jump button goes to the bottom and hides", sc2);

  // --- end of run 1: Stop gone, one button row, no emoji
  await pg.evaluate((d) => taskEvent(d), doneEv("r1")); await pg.waitForTimeout(300);
  const end = await pg.evaluate(() => { const c = cards["r1"]; return { stop: c.querySelectorAll(".wstop").length, st: c.querySelectorAll(".wst").length, rows: c.querySelectorAll(".wactions").length, btns: [...c.querySelectorAll(".wactions button")].map((b) => b.textContent), loose: [...c.querySelectorAll("button.btn")].filter((b) => !b.closest(".wactions") && !b.closest(".proofcard")).length, tm: getComputedStyle(document.getElementById("tmeter")).display }; });
  ok(end.stop === 0 && end.st === 0, "after the run ends the Stop button and live status are gone", end);
  ok(end.rows === 1 && end.btns.length === 5 && end.loose === 0, "one button row at the end of the run (4 actions; 3 of them behind More)", end);
  ok(end.btns.join("|") === "Review changes|More|View walkthrough|Go back to a step|Revert this run", "button labels are plain text (2026-11-15: Review changes + More first)", end.btns);

  // error run: Stop removed too; engine text with emoji
  await replay(pg, [{ type: "agent", runId: "r2", role: "planner" }, { type: "narration", runId: "r2", text: "🚀 Starting ⚙️ now" }, { type: "error", runId: "r2", text: "⚠ boom 😱 at src/x.py:7" }]);
  const e2 = await pg.evaluate(() => ({ stop: cards["r2"].querySelectorAll(".wstop").length, txt: cards["r2"].innerText }));
  ok(e2.stop === 0, "an error also removes the Stop button", e2);
  ok(/Starting now/.test(e2.txt) && /boom at src\/x\.py:7/.test(e2.txt) && !/\S {2,}\S/.test(e2.txt), "emoji removed without leaving odd gaps", e2.txt);

  const all = await pg.evaluate(() => document.getElementById("chatlog").innerText + "\n" + [...document.querySelectorAll("#chatlog button")].map((b) => b.textContent).join(" "));
  ok(!EMOJI.test(all), "zero emoji characters in the chat text and buttons", [...all].filter((c) => EMOJI.test(c)).join(""));
  const keep = await pg.evaluate(() => { const l = document.createElement("div"); l.textContent = noEmoji("naive ->  a → b, ü é ñ © ✓ ✗ x -> y"); return l.textContent; });
  ok(keep === "naive ->  a → b, ü é ñ © ✓ ✗ x -> y", "normal punctuation, arrows and non-English letters are kept", keep);
  const newLines = await lineCount(pg);
  ok(errs.length === 0, "still zero JS errors after the whole replay", errs);

  // ======================= OLD PAGE (backup) for the line-count comparison =======================
  let oldLines = -1;
  if (fs.existsSync(backupPath)) {
    const old = await open(BASE + "/?embed=1", fs.readFileSync(backupPath, "utf8"));
    await replay(old.pg, [...run("r1"), doneEv("r1")]); await old.pg.waitForTimeout(300);
    oldLines = await lineCount(old.pg);
    const fresh = await open(BASE + "/?embed=1");
    await replay(fresh.pg, [...run("r1"), doneEv("r1")]); await fresh.pg.waitForTimeout(300);
    const nl = await lineCount(fresh.pg);
    const cut = oldLines > 0 ? Math.round((1 - nl / oldLines) * 100) : 0;
    console.log(`  INFO  same replayed run: old panel ${oldLines} visible lines, new panel ${nl} visible lines (${cut}% fewer)`);
    ok(nl < oldLines, "a replayed run shows fewer lines than before", { oldLines, nl });
    // a tool-heavy run (25 extra read/search rows, typical for a real task)
    const heavy = (id) => { const e = run(id); const extra = []; for (let i = 0; i < 25; i++) extra.push(i % 2 ? { type: "tool", runId: id, name: "search", args: { query: "term" + i } } : { type: "tool", runId: id, name: "read_file", args: { path: "src/mod" + i + ".py" } }); e.splice(5, 0, ...extra); return e; };
    const o2 = await open(BASE + "/?embed=1", fs.readFileSync(backupPath, "utf8")); await replay(o2.pg, [...heavy("r1"), doneEv("r1")]); await o2.pg.waitForTimeout(200);
    const n2 = await open(BASE + "/?embed=1"); await replay(n2.pg, [...heavy("r1"), doneEv("r1")]); await n2.pg.waitForTimeout(200);
    const ol = await lineCount(o2.pg), nl2 = await lineCount(n2.pg);
    console.log(`  INFO  tool-heavy run: old ${ol} visible lines, new ${nl2} visible lines (${Math.round((1 - nl2 / ol) * 100)}% fewer)`);
    ok(nl2 < ol, "a tool-heavy run shows fewer lines than before", { ol, nl2 });
    ok(fresh.errs.length === 0, "fresh page replay: zero JS errors", fresh.errs);
  } else console.log("  INFO  backup ui.html not found; old line count not compared (new panel: " + newLines + " lines)");
} catch (e) { ok(false, "test ran to the end", String(e && e.message || e).replace(/001b[[0-9;]*m/g, "").slice(0, 900)); }
finally { try { await br?.close(); } catch { } if (child) { try { child.kill(); } catch { } } }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
