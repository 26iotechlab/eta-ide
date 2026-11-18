// Test: the panel's "Review changes" code (B2, 2026-11-13) — NO browser, NO model, NO server.
// 1) every inline <script> of ui.html still compiles; 2) the review function runs against a tiny fake page and a fake engine.
// Run: node test-ui-review.mjs
import fs from "fs"; import path from "path"; import vm from "vm";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const html = fs.readFileSync(path.join(here, "ui.html"), "utf8");

// 1) syntax of all inline scripts
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok(scripts.length > 0, "ui.html has inline scripts", scripts.length);
let bad = null; scripts.forEach((s, i) => { try { new vm.Script(s, { filename: "ui.html#" + i }); } catch (e) { bad = bad || `${i}: ${e.message}`; } });
ok(!bad, "every inline script compiles", bad);

// 2) behaviour of reviewChanges against fakes
const src = /async function reviewChanges\([\s\S]*?\n}\n(?=\n\/\* pasted image)/.exec(html)?.[0];
ok(!!src, "reviewChanges is in ui.html");
const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
class El {
  constructor() { this.className = ""; this.children = []; this._html = ""; this.parentNode = null; this.onclick = null; this.disabled = false; this._btn = null; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this._btn = null; if (v === "") this.children = []; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  querySelector(sel) {
    if (sel === ".hkbox") return this.children.find((c) => c.className === "hkbox") || null;
    if (sel === "button") { if (!/<button/.test(this._html)) return null; return (this._btn ||= new El()); }
    return null;
  }
}
const mk = async (fetchImpl) => {
  const alerts = []; const calls = [];
  const document = { createElement: () => new El() };
  const fetch = async (url, opt) => { calls.push({ url, opt }); return { json: async () => fetchImpl(url, opt, calls) }; };
  const fn = new Function("esc", "uiAlert", "fetch", "document", src + "; return reviewChanges;")(esc, (m) => alerts.push(m), fetch, document);
  return { fn, alerts, calls };
};
const flush = () => new Promise((r) => setTimeout(r, 5));
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };
const twoHunks = { ok: true, files: [
  { file: "a.py", status: "modified", hunks: [
    { id: "3-aaaa1111", oldStart: 3, newStart: 3, removed: ["x = 1"], removedTotal: 1, added: ["x = 2", "<b>"], addedTotal: 2, before: ["def f():"], after: ["return x"] },
    { id: "9-bbbb2222", oldStart: 9, newStart: 10, removed: [], removedTotal: 0, added: ["y = 3"], addedTotal: 1, before: [], after: [] } ] },
  { file: "new.txt", status: "added", wholeFileOnly: true, hunks: [] },
  { file: "big.bin", status: "modified", binary: true, hunks: [] } ] };

{ // list is shown, text is escaped, files that cannot be split say so
  const t = await mk(() => twoHunks); const host = new El(); await t.fn("7", host); await flush();
  const box = host.querySelector(".hkbox"); const all = walk(box);
  ok(!!box && t.calls[0].url === "/api/run-changes?runId=7", "asks the engine for the changes of the right run", t.calls[0]);
  ok(all.filter((e) => /Undo this change/.test(e.innerHTML)).length === 2, "one 'Undo this change' button per block (2)");
  ok(all.some((e) => /&lt;b&gt;/.test(e.innerHTML)) && !all.some((e) => /<b>/.test(e.innerHTML.replace(/<\/?(div|span|pre|button)[^>]*>/g, ""))), "text from the file is escaped");
  ok(all.some((e) => /new file/.test(e.innerHTML) && /Revert this run/.test(e.innerHTML)), "a new file points to 'Revert this run'");
  ok(all.some((e) => /binary file/.test(e.innerHTML)), "a binary file is marked");
}
{ // clicking Undo sends the right request and shows "undone"
  const t = await mk((url) => url.startsWith("/api/run-changes") ? twoHunks : { ok: true, reverted: 1, remaining: ["9-bbbb2222"] });
  const host = new El(); await t.fn("7", host); await flush();
  const hk = walk(host.querySelector(".hkbox")).find((e) => e.className === "hk");
  await hk.querySelector("button").onclick({ target: hk.querySelector("button") }); await flush(); await flush();
  const post = t.calls.find((c) => c.url === "/api/revert-hunks");
  const b = post && JSON.parse(post.opt.body);
  ok(post && post.opt.method === "POST" && b.runId === "7" && b.file === "a.py" && b.hunkIds.length === 1 && b.hunkIds[0] === "3-aaaa1111", "Undo sends run, file and exactly that block's id", b);
  ok(host.children.some((c) => /undone: line 3 of a\.py/.test(c.textContent || "")), "a note says which block was undone");
  ok(t.calls.filter((c) => c.url.startsWith("/api/run-changes")).length === 2, "the list is reloaded after a successful undo", t.calls.map((c) => c.url));
}
{ // conflict: alert and reload the list
  let listCalls = 0;
  const t = await mk((url) => { if (url.startsWith("/api/run-changes")) { listCalls++; return twoHunks; } return { ok: false, conflict: true, error: "The file changed since this list was made. Reload the changes." }; });
  const host = new El(); await t.fn("7", host); await flush();
  const hk = walk(host.querySelector(".hkbox")).find((e) => e.className === "hk");
  await hk.querySelector("button").onclick({ target: hk.querySelector("button") }); await flush(); await flush();
  ok(t.alerts.length === 1 && /changed since/.test(t.alerts[0]), "a conflict is shown to the user", t.alerts);
  ok(listCalls === 2, "the list is loaded again after a conflict", listCalls);
}
{ // other error: alert, button usable again
  const t = await mk((url) => url.startsWith("/api/run-changes") ? twoHunks : { ok: false, error: "boom" });
  const host = new El(); await t.fn("7", host); await flush();
  const hk = walk(host.querySelector(".hkbox")).find((e) => e.className === "hk");
  const btn = hk.querySelector("button"); await btn.onclick({ target: btn }); await flush();
  ok(t.alerts[0] === "boom" && btn.disabled === false, "an error is shown and the button works again", { a: t.alerts, d: btn.disabled });
}
{ // empty list and engine error
  let t = await mk(() => ({ ok: true, files: [] })); let host = new El(); await t.fn("7", host); await flush();
  ok(/No changed blocks/.test(host.querySelector(".hkbox").innerHTML), "no changes: says so");
  t = await mk(() => ({ ok: false, error: "This run has no undo point." })); host = new El(); await t.fn("7", host); await flush();
  ok(/no undo point/.test(host.querySelector(".hkbox").innerHTML), "engine error text is shown");
}
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
