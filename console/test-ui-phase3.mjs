// Test: agent chat panel PHASE 3 ("Keep / Undo for each file edit, during the run") — NO model, NO GPU.
// 1) editundo.mjs on real temp files: 20 generated single-block edits (CRLF, LF, non-ASCII, no final newline) undo to the
//    EXACT old bytes; 20 more undo only their block while a later change elsewhere stays; refusals when the file changed
//    inside the block or a multi-block edit changed later; Keep; created and binary files; folder and path guards.
// 2) the engine HTTP routes: wrong Origin / cross-site 403, unknown run refused, nothing written.
// 3) headless panel: Keep and Undo show on the edit card, statuses replay from saved events, text is escaped.
// Run: node test-ui-phase3.mjs     (starts its own model-less server on :8893 when none answers there)
import fs from "fs"; import os from "os"; import path from "path"; import { spawn } from "child_process";
import { beforeEdit, afterEdit, undoEdit, keepEdit, undoSingleHunk } from "./editundo.mjs";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.slice(0, 900) + ")"}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "eta-p3-"));
const F = (r) => path.join(ws, r);
const run = { id: "7", workspace: ws, root: ws, status: "running", events: [] };
// one edit, the way the engine does it: bytes before, the write, then afterEdit
async function edit(rel, next) { const t = await beforeEdit(run, rel); fs.mkdirSync(path.dirname(F(rel)), { recursive: true }); fs.writeFileSync(F(rel), next); return afterEdit(run, t, "edit_file"); }
const bytes = (rel) => fs.existsSync(F(rel)) ? fs.readFileSync(F(rel)) : null;

// deterministic generator: lines with non-ASCII text, LF or CRLF, with or without a final newline
let seed = 12345; const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
const WORDS = ["alpha", "größe", "naïve", "日本語", "😀 smile", "tab\there", "ünïcödé", "Ж", "plain", "x = 1  # comment"];
function gen(i) {
  const n = 12 + rnd(10), eol = i % 2 ? "\r\n" : "\n", finalNL = i % 5 !== 0;
  const lines = Array.from({ length: n }, (_, k) => `L${k} ${WORDS[(k + i) % WORDS.length]}`);
  return { lines, eol, finalNL };
}
const join = (lines, eol, finalNL) => lines.join(eol) + (finalNL ? eol : "");
function singleEdit(g, i) { // one changed block in the middle: replace, insert or delete
  const L = g.lines.slice(), at = 3 + rnd(4), kind = i % 3;
  if (kind === 0) L.splice(at, 1 + rnd(2), "NEW " + i + " é", "NEW2 中");
  else if (kind === 1) L.splice(at, 0, "INS " + i + " ø");
  else L.splice(at, 1 + rnd(2));
  return L;
}

// ======================= 1a. 20 single-block edits, file unchanged since: exact old bytes =======================
{
  let exact = 0, single = 0;
  for (let i = 0; i < 20; i++) {
    const g = gen(i), rel = `gen/f${i}.txt`, before = Buffer.from(join(g.lines, g.eol, g.finalNL), "utf8");
    fs.mkdirSync(path.dirname(F(rel)), { recursive: true }); fs.writeFileSync(F(rel), before);
    const ev = await edit(rel, join(singleEdit(g, i), g.eol, g.finalNL));
    if (ev && ev.hunks === 1) single++;
    const r = await undoEdit(run, ev?.editId, ws);
    if (r.ok && r.status === "undone" && bytes(rel).equals(before)) exact++;
  }
  ok(single === 20, "20 generated edits are each ONE changed block", single);
  ok(exact === 20, "20 of 20 single-block undos give the exact previous bytes (LF, CRLF, non-ASCII, no final newline)", exact);
}
// ======================= 1b. 20 single-block edits, a later change elsewhere: only this block goes back =======================
{
  let merged = 0;
  for (let i = 0; i < 20; i++) {
    const g = gen(100 + i), rel = `gen/m${i}.txt`, beforeLines = g.lines;
    fs.writeFileSync(F(rel), join(beforeLines, g.eol, g.finalNL));
    const afterLines = singleEdit(g, i);
    const ev = await edit(rel, join(afterLines, g.eol, g.finalNL));
    // the user (or a later step) changes line 0 or line 1 far from the block: same text in both versions
    const tgt = i % 2 ? "L0 " : "L1 ", ch = (L) => L.map((x) => x.startsWith(tgt) ? x + " (user)" : x);
    fs.writeFileSync(F(rel), join(ch(afterLines), g.eol, g.finalNL));
    const expect = Buffer.from(join(ch(beforeLines), g.eol, g.finalNL), "utf8");
    const r = await undoEdit(run, ev?.editId, ws);
    if (r.ok && r.how === "block-merged" && bytes(rel).equals(expect)) merged++;
  }
  ok(merged === 20, "20 of 20: with a later change elsewhere, Undo puts back only this block and keeps the later change", merged);
}
// ======================= 1c. refusals: nothing is written =======================
{
  fs.writeFileSync(F("r.txt"), "a\nb\nc\nd\ne\nf\n");
  const ev = await edit("r.txt", "a\nb\nC\nd\ne\nf\n");
  fs.writeFileSync(F("r.txt"), "a\nb\nC-user\nd\ne\nf\n"); // the user changed the SAME line
  const r = await undoEdit(run, ev.editId, ws);
  ok(!r.ok && r.conflict && /did not undo/.test(r.error) && bytes("r.txt").toString() === "a\nb\nC-user\nd\ne\nf\n", "file changed inside the block: refused with a plain message, the user's work is untouched", r);
  fs.writeFileSync(F("r2.txt"), "1\n2\n3\n4\n5\n6\n7\n");
  const ev2 = await edit("r2.txt", "1\n2\nX\n4\n5\n6\n7\n");
  fs.writeFileSync(F("r2.txt"), "1\n2\nX\nuser\n4\n5\n6\n7\n"); // touches the edge of the block
  ok(!(await undoEdit(run, ev2.editId, ws)).ok && bytes("r2.txt").toString() === "1\n2\nX\nuser\n4\n5\n6\n7\n", "a later change right next to the block counts as touching: refused");
  fs.writeFileSync(F("mh.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
  const ev3 = await edit("mh.txt", "A\nb\nc\nd\ne\nf\nG\nh\n");
  ok(ev3.hunks === 2, "a two-block edit is reported with 2 blocks", ev3);
  fs.writeFileSync(F("mh.txt"), "A\nb\nc\nd-user\ne\nf\nG\nh\n");
  const r3 = await undoEdit(run, ev3.editId, ws);
  ok(!r3.ok && r3.conflict && bytes("mh.txt").toString() === "A\nb\nc\nd-user\ne\nf\nG\nh\n", "a multi-block edit with a later change is refused (only whole-edit undo for those)", r3);
  fs.writeFileSync(F("mh.txt"), "A\nb\nc\nd\ne\nf\nG\nh\n");
  const r4 = await undoEdit(run, ev3.editId, ws);
  ok(r4.ok && bytes("mh.txt").toString() === "a\nb\nc\nd\ne\nf\ng\nh\n", "a multi-block edit, file unchanged: the whole edit is undone exactly", r4);
  ok(!(await undoEdit(run, ev3.editId, ws)).ok, "the same edit cannot be undone twice");
  // the block reaches the end of the file and the file changed: refused (final-newline cases are not guessed)
  ok(undoSingleHunk("a\nb\n", "a\nB\n", "user\na\nB\n") === null, "block at the end of the file + later change: refused");
  // an edit that also changed line endings is not a clean single block: refused when the file changed later
  ok(undoSingleHunk("a\r\nb\r\nc\r\nd\r\n", "a\nB\nc\nd\n", "u\na\nB\nc\nd\n") === null, "an edit that also changed line endings is not merged");
}
// ======================= 1d. created file, Keep, binary =======================
{
  const evc = await edit("new/made.py", "print('hi')\n");
  ok(evc.created === true, "a new file is reported as created", evc);
  const rc = await undoEdit(run, evc.editId, ws);
  ok(rc.ok && !fs.existsSync(F("new/made.py")), "Undo of a created file removes it", rc);
  const evc2 = await edit("new/made2.py", "x = 1\n"); fs.writeFileSync(F("new/made2.py"), "x = 2  # user\n");
  ok(!(await undoEdit(run, evc2.editId, ws)).ok && bytes("new/made2.py").toString() === "x = 2  # user\n", "a created file the user changed is NOT removed");
  fs.writeFileSync(F("k.txt"), "one\n"); const evk = await edit("k.txt", "two\n");
  const k = keepEdit(run, evk.editId, ws);
  ok(k.ok && k.status === "kept" && bytes("k.txt").toString() === "two\n", "Keep marks the edit and writes nothing", k);
  ok(!(await undoEdit(run, evk.editId, ws)).ok && bytes("k.txt").toString() === "two\n", "a kept edit is not undone afterwards");
  const bin = Buffer.from([0, 255, 254, 1, 2, 0xc3, 0x28, 10]); fs.writeFileSync(F("b.bin"), bin);
  const evb = await edit("b.bin", Buffer.from([0, 1, 2, 3]));
  ok(evb.hunks === -1, "a binary file has no text blocks (whole-edit undo only)", evb);
  ok((await undoEdit(run, evb.editId, ws)).ok && bytes("b.bin").equals(bin), "binary undo gives the exact old bytes");
  fs.writeFileSync(F("same.txt"), "x\n"); ok((await edit("same.txt", "x\n")) === null, "a call that changed nothing makes no Keep/Undo");
  const src = fs.readFileSync(path.join(here, "editundo.mjs"), "utf8");
  ok(/await atomicWrite\(full, rec\.before\)/.test(src) && /await atomicWrite\(full, Buffer\.from\(next, "utf8"\)\)/.test(src), "the restore write goes through atomicWrite");
}
// ======================= 1e. guards: folder and path =======================
{
  fs.writeFileSync(F("g.txt"), "g1\n"); const ev = await edit("g.txt", "g2\n");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "eta-p3o-"));
  ok((await undoEdit(run, ev.editId, other)).status === 403 && bytes("g.txt").toString() === "g2\n", "a different project folder is refused");
  ok((await undoEdit(run, ev.editId, undefined)).status === 403 && keepEdit(run, ev.editId, "").status === 403, "no project folder given: refused");
  ok((await undoEdit(null, ev.editId, ws)).status === 404 && (await undoEdit(run, "nope", ws)).status === 404, "unknown run or edit: refused");
  const rec = run.edits.get(ev.editId);
  const keepFile = rec.file; rec.file = "../" + path.basename(other) + "/g.txt"; // a tampered record that points outside
  fs.writeFileSync(path.join(other, "g.txt"), "outside\n");
  const re = await undoEdit(run, ev.editId, ws);
  ok(!re.ok && re.status === 403 && fs.readFileSync(path.join(other, "g.txt"), "utf8") === "outside\n", "a path outside the project is refused (guardPath), nothing written", re);
  rec.file = keepFile; rec.full = path.join(other, "g.txt");
  ok((await undoEdit(run, ev.editId, ws)).status === 403, "a record whose real path differs is refused");
  const home = { id: "h", workspace: os.homedir(), root: os.homedir() };
  ok((await beforeEdit(home, ".eta/trusted-folders.json")) === null && (await beforeEdit(home, ".eta-ide/state.json")) === null, "the trust list and ~/.eta are never tracked, even when the project is the home folder");
  ok((await beforeEdit(run, "../x.txt")) === null, "a path escape is never tracked");
  fs.rmSync(other, { recursive: true, force: true });
}
// engine source: the hook sits around every write_file / edit_file call, after the result event; approvals untouched
{
  const a = fs.readFileSync(path.join(here, "agent.mjs"), "utf8"), s = fs.readFileSync(path.join(here, "server.mjs"), "utf8");
  ok(/editTok = await this\.onFileEdit\("before", lockTarget\)/.test(a) && /if \(editTok\) \{ try \{ await this\.onFileEdit\("after", editTok, tc\.name\)/.test(a), "engine: bytes are kept before each write_file / edit_file and the edit is reported after it");
  ok(/u\.pathname === "\/api\/edit\/undo" \|\| u\.pathname === "\/api\/edit\/keep"/.test(s) && /undoEdit\(r, b\.editId, b\.ws\)/.test(s) && s.indexOf('"/api/edit/undo"') > s.indexOf("const denied = accessDenied(req)"), "server: the routes sit behind accessDenied and pass the panel's folder");
}

// ======================= 2. HTTP routes (model-less server) =======================
const PORT = process.env.ETA_UI3_PORT || "8893", BASE = `http://127.0.0.1:${PORT}`;
let child = null;
const up = async () => { try { return (await fetch(BASE + "/", { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
if (!(await up())) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eta-p3h-"));
  child = spawn(process.execPath, ["server.mjs"], { cwd: here, env: { ...process.env, PORT, USERPROFILE: home, HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(500);
}
let br;
try {
  if (!(await up())) ok(false, "model-less server started");
  else {
    const post = (p, b, h = {}) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(b) });
    for (const p of ["/api/edit/undo", "/api/edit/keep"]) {
      ok((await post(p, { runId: "1", editId: "1-e1", ws }, { origin: "http://evil.example" })).status === 403, p + ": wrong Origin is refused (403)");
      ok((await post(p, { runId: "1", editId: "1-e1", ws }, { "sec-fetch-site": "cross-site" })).status === 403, p + ": a cross-site request is refused (403)");
      const r = await post(p, { runId: "nope", editId: "x", ws, file: "../../evil.txt", path: "../../evil.txt" });
      ok(r.status === 404 && /No such run/.test((await r.json()).error || ""), p + ": unknown run refused; a path in the request is never used", r.status);
    }
    ok(!fs.existsSync(path.join(ws, "..", "..", "evil.txt")), "nothing was written outside");

    // ======================= 3. headless panel =======================
    let pw = null; try { pw = await import("playwright-core"); } catch { console.log("SKIPPED: playwright-core is not installed"); }
    const exes = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    let exe = null; for (const c of exes) { try { fs.accessSync(c); exe = c; break; } catch { } }
    if (pw && !exe) console.log("SKIPPED: no local Chromium/Edge found");
    if (pw && exe) {
      br = await pw.chromium.launch({ executablePath: exe, headless: true });
      const open = async () => {
        const ctx = await br.newContext({ viewport: { width: 440, height: 900 } }); const pg = await ctx.newPage(); const errs = [];
        pg.on("pageerror", (e) => errs.push(String(e.message || e)));
        pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push("console: " + m.text()); });
        await pg.route("**/api/proof**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false,"error":"test"}' }));
        await pg.goto(BASE + "/?embed=1&ws=" + encodeURIComponent(ws), { waitUntil: "load" }); await pg.waitForTimeout(800);
        await pg.addStyleTag({ content: "html.embed #right.disconnected #chatlog{display:block!important} html.embed #right.disconnected #connect{display:none!important}" });
        return { pg, errs };
      };
      const BAD = '<img src=x onerror="window.__xss=1">.py';
      const evs = (id) => [
        { type: "start", runId: id }, { type: "agent", runId: id, role: "executor" },
        { type: "tool", runId: id, name: "edit_file", args: { path: "src/app.py" }, callId: "c1" },
        { type: "diff", runId: id, file: "src/app.py", start: 2, removed: ["    return a / b"], added: ["    if b == 0:", "        return 0", "    return a / b"], addedTotal: 3, removedTotal: 1 },
        { type: "toolResult", runId: id, name: "edit_file", result: "Edited src/app.py", callId: "c1", ms: 30, ok: true, summary: "Edited src/app.py" },
        { type: "edit", runId: id, editId: id + "-e1", file: "src/app.py", created: false, hunks: 1, tool: "edit_file" },
        { type: "edit", runId: id, editId: id + "-e2", file: BAD, created: true, hunks: 3, tool: "write_file" },
        { type: "edit", runId: id, editId: id + "-e3", file: "src/app.py", created: false, hunks: 2, tool: "edit_file" },
      ];
      const look = (pg, id) => pg.evaluate((id) => [...cards[id].querySelectorAll(".fcard")].map((c) => { const b = c.querySelector(".ebar"); return { file: c.dataset.file, edit: c.dataset.edit || "", btns: b ? [...b.querySelectorAll("button")].map((x) => x.textContent) : [], st: b ? b.querySelector(".est").textContent : null, msg: b ? b.querySelector(".emsg").textContent : null }; }), id);
      const feed = (pg, list, hist) => pg.evaluate(([e, h]) => { const id = e[0].runId; runs[id] = { id, task: "t", started: Date.now() - 1500, status: "running", files: [] }; for (const x of e) taskEvent(x, h); }, [list, !!hist]);

      const { pg, errs } = await open();
      await feed(pg, evs("p1"));
      let L = await look(pg, "p1");
      ok(L.length === 3 && L[0].edit === "p1-e1" && L[0].btns.join(",") === "Keep,Undo", "DURING the run: the diff card of the edit shows Keep and Undo", L);
      ok(L[1].edit === "p1-e2" && L[1].btns.join(",") === "Keep,Undo whole edit" && L[2].edit === "p1-e3", "an edit without its own diff card gets its own small card; a multi-block edit says 'Undo whole edit'", L);
      ok(await pg.evaluate(() => (window.__xss || 0) === 0 && !document.querySelector(".fcard img")), "a file name with HTML is shown as text (no element made, no script run)");
      // clicks: the engine refuses (file changed), then accepts
      await pg.route("**/api/edit/undo", (r) => r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, conflict: true, error: "The file changed after this edit, so I did not undo it. <b>x</b>" }) }));
      await pg.evaluate(() => cards["p1"].querySelector('.ebar[data-edit="p1-e1"] .eundo').click()); await pg.waitForTimeout(300);
      L = await look(pg, "p1");
      ok(/did not undo it\. <b>x<\/b>$/.test(L[0].msg) && L[0].btns.length === 2 && !(await pg.evaluate(() => cards["p1"].querySelector(".ebar b"))), "a refusal shows the engine's plain message as text and keeps the buttons", L[0]);
      await pg.unroute("**/api/edit/undo");
      let sent = null;
      await pg.route("**/api/edit/undo", (r) => { sent = JSON.parse(r.request().postData() || "{}"); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, editId: "p1-e1", status: "undone", how: "exact" }) }); });
      await pg.evaluate(() => cards["p1"].querySelector('.ebar[data-edit="p1-e1"] .eundo').click()); await pg.waitForTimeout(300);
      L = await look(pg, "p1");
      ok(L[0].st === "Undone" && L[0].btns.length === 0 && L[0].msg === "", "after Undo the card says 'Undone' and the buttons are gone", L[0]);
      ok(sent && sent.runId === "p1" && sent.editId === "p1-e1" && sent.ws === ws, "the request names the run, the edit and the panel's folder", sent);
      await pg.route("**/api/edit/keep", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, editId: "p1-e3", status: "kept" }) }));
      await pg.evaluate(() => cards["p1"].querySelector('.ebar[data-edit="p1-e3"] .ekeep').click()); await pg.waitForTimeout(300);
      L = await look(pg, "p1");
      ok(L[2].st === "Kept" && L[2].btns.length === 0, "after Keep the card says 'Kept'", L[2]);
      ok(errs.length === 0, "zero JS errors (live)", errs);
      // reload: saved events replay with their statuses (no engine memory needed)
      const o = await open();
      await feed(o.pg, evs("p2").concat([
        { type: "edit_status", runId: "p2", editId: "p2-e1", status: "undone", how: "block-merged" },
        { type: "edit_status", runId: "p2", editId: "p2-e3", status: "kept" },
        { type: "done", runId: "p2", canRevert: false, warnings: [] }]), true);
      const H = await look(o.pg, "p2");
      ok(H[0].st === "Undone (only this change; later changes stay)" && H[0].btns.length === 0 && H[2].st === "Kept" && H[2].btns.length === 0 && H[1].btns.join(",") === "Keep,Undo whole edit", "after a panel reload the replay shows Undone, Kept, and still-open buttons", H);
      ok(o.errs.length === 0, "zero JS errors (history replay)", o.errs);
      // old saved runs without edit events still replay (no buttons, no errors)
      const o2 = await open();
      await feed(o2.pg, [{ type: "start", runId: "p3" }, { type: "diff", runId: "p3", file: "a.py", start: 1, removed: ["a"], added: ["b"], addedTotal: 1, removedTotal: 1 }, { type: "done", runId: "p3", canRevert: false, warnings: [] }], true);
      ok((await look(o2.pg, "p3")).every((c) => c.btns.length === 0) && o2.errs.length === 0, "an old run without edit events shows no buttons and no errors");
      try { await pg.evaluate(() => { document.getElementById("chatlog").scrollTop = 0; }); await pg.screenshot({ path: "D:\\eta-ide\\reports\\ui-phase3.png" }); console.log("  INFO  screenshot saved: D:\\eta-ide\\reports\\ui-phase3.png"); } catch (e) { console.log("  INFO  screenshot not taken"); }
    }
  }
} catch (e) { ok(false, "test ran to the end", String(e && e.message || e).replace(/\u001b\[[0-9;]*m/g, "").slice(0, 900)); }
finally { try { await br?.close(); } catch { } if (child) { try { child.kill(); } catch { } } try { fs.rmSync(ws, { recursive: true, force: true }); } catch { } }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
