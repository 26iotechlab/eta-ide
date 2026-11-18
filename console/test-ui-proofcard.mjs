// Test: the panel's proof card code (2026-11-13) — NO browser, NO model, NO server.
// Run: node test-ui-proofcard.mjs
import fs from "fs"; import path from "path"; import vm from "vm";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const html = fs.readFileSync(path.join(here, "ui.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let bad = null; scripts.forEach((s, i) => { try { new vm.Script(s, { filename: "ui.html#" + i }); } catch (e) { bad = bad || `${i}: ${e.message}`; } });
ok(!bad, "every inline script of ui.html compiles", bad);
const src = /async function undoRun\([\s\S]*?\n}\n\n\/\* Proof card[\s\S]*?async function showProof\([\s\S]*?\n}\n(?=\n\/\* B3: go back)/.exec(html)?.[0];
ok(!!src, "undoRun and showProof are in ui.html");
ok(/showProof\(id,pc\)/.test(html) && /onclick=\(ev\)=>undoRun\(id,ev\.target\)/.test(html), "the done line shows the card; the Revert button uses the same undo");
ok(/m\.type==="reverted"\)&&proofHosts\[m\.runId\]\) showProof/.test(html), "the card is loaded again after an undo");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
class El {
  constructor() { this._html = ""; this._btn = null; this.disabled = false; }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; this._btn = null; }
  querySelector(sel) { return sel === "button" && /<button/.test(this._html) ? (this._btn ||= new El()) : null; }
}
const mk = (fetchImpl, confirmAnswer = true) => {
  const alerts = [], calls = [], confirms = [];
  const fetch = async (url, opt) => { calls.push({ url, opt }); return { json: async () => fetchImpl(url, opt) }; };
  const fns = new Function("esc", "uiAlert", "uiConfirm", "fetch", src + "; return { showProof, undoRun, proofHosts };")(esc, (m) => alerts.push(m), async (m) => { confirms.push(m); return confirmAnswer; }, fetch);
  return { ...fns, alerts, calls, confirms };
};
const flush = () => new Promise((r) => setTimeout(r, 5));
const card = { ok: true, tests: { status: "passed", text: "Tests passed: npm test." }, files: { text: "2 files changed (+13 −1 lines).", list: [{ file: "a.js", status: "modified", added: 3, removed: 1, counted: true }, { file: "<b>.js", status: "added", added: 10, removed: 0, counted: true }] },
  undo: { available: true, text: "One click restores the files." }, privacy: { local: true, text: "Nothing left this PC." } };

{ const t = mk(() => card); const host = new El(); await t.showProof("7", host);
  ok(t.calls[0].url === "/api/proof?runId=7" && t.proofHosts["7"] === host, "asks for the proof of the right run and remembers the card", t.calls[0].url);
  ok(/✓ Tests passed: npm test\./.test(host.innerHTML) && /2 files changed/.test(host.innerHTML) && /✓ Nothing left this PC\./.test(host.innerHTML), "shows tests, files and the privacy line", host.innerHTML);
  ok(/a\.js <span class="badd">\+3<\/span> <span class="brem">−1<\/span>/.test(host.innerHTML) && /&lt;b&gt;\.js/.test(host.innerHTML) && !/<b>\.js/.test(host.innerHTML) && /· added/.test(host.innerHTML), "each file has its +/- lines; names are escaped", host.innerHTML);
  const b = host.querySelector("button"); await b.onclick({ target: b }); await flush();
  const post = t.calls.find((c) => c.url === "/api/revert");
  ok(t.confirms.length === 1 && post?.opt.method === "POST" && JSON.parse(post.opt.body).runId === "7", "Undo asks first, then calls the existing revert", { c: t.confirms, p: post && post.opt }); }
{ const t = mk((u) => u.startsWith("/api/proof") ? card : { ok: true }, false); const host = new El(); await t.showProof("7", host);
  const b = host.querySelector("button"); await b.onclick({ target: b }); await flush();
  ok(!t.calls.some((c) => c.url === "/api/revert") && b.disabled === false, "answering Cancel sends nothing"); }
{ const t = mk((u) => u.startsWith("/api/proof") ? card : { error: "no snapshot for this run" }); const host = new El(); await t.showProof("7", host);
  const b = host.querySelector("button"); await b.onclick({ target: b }); await flush();
  ok(t.alerts[0] === "no snapshot for this run" && b.disabled === false, "an undo error is shown and the button works again", t.alerts); }
{ const t = mk(() => ({ ok: true, tests: { status: "none", text: "No tests were run." }, files: { text: "No files changed.", list: [] }, undo: { available: false, text: "This run has no undo point." }, privacy: { local: false, text: "Something left this PC: web search was used." } }));
  const host = new El(); await t.showProof("8", host);
  ok(/– No tests were run\./.test(host.innerHTML) && /⚠ Something left this PC: web search was used\./.test(host.innerHTML) && !/<button/.test(host.innerHTML) && /no undo point/.test(host.innerHTML), "no tests, web used, no undo: all said plainly, no button", host.innerHTML); }
{ const t = mk(() => ({ ok: false, error: "No such run." })); const host = new El(); await t.showProof("9", host); ok(/No such run/.test(host.innerHTML), "an engine error is shown"); }
{ const t = mk(() => { throw new Error("down"); }); const host = new El(); await t.showProof("9", host); ok(/Proof card:/.test(host.innerHTML), "a broken answer does not crash the panel", host.innerHTML); }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
