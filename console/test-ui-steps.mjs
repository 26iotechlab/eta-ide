// Test: the panel's "Go back to a step" code (B3, 2026-11-13) — NO browser, NO model, NO server.
// Run: node test-ui-steps.mjs
import fs from "fs"; import path from "path"; import vm from "vm";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const html = fs.readFileSync(path.join(here, "ui.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let bad = null; scripts.forEach((s, i) => { try { new vm.Script(s, { filename: "ui.html#" + i }); } catch (e) { bad = bad || `${i}: ${e.message}`; } });
ok(!bad, "every inline script of ui.html compiles", bad);
const src = /async function showSteps\([\s\S]*?\n}\n(?=\n\/\* B2: look at what)/.exec(html)?.[0];
ok(!!src, "showSteps is in ui.html");
ok(/Go back to a step/.test(html) && /showSteps\(id,sv\)/.test(html), "the 'Go back to a step' button calls it");
ok(/m\.type==="hunks-reverted"\|\|m\.type==="rewound"/.test(html), "the panel reloads the file tree when a rewind happened");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
class El {
  constructor() { this.className = ""; this.children = []; this._html = ""; this.onclick = null; this.disabled = false; this.textContent = ""; this._btn = null; }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; this._btn = null; if (v === "") this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  querySelector(sel) { if (sel === ".stepbox") return this.children.find((c) => /stepbox/.test(c.className)) || null; if (sel === "button") return /<button/.test(this._html) ? (this._btn ||= new El()) : null; return null; }
}
const mk = (fetchImpl, confirmAnswer = true) => {
  const alerts = [], calls = [], confirms = [];
  const fetch = async (url, opt) => { calls.push({ url, opt }); return { json: async () => fetchImpl(url, opt) }; };
  const fn = new Function("esc", "uiAlert", "uiConfirm", "fetch", "document", src + "; return showSteps;")(esc, (m) => alerts.push(m), async (m) => { confirms.push(m); return confirmAnswer; }, fetch, { createElement: () => new El() });
  return { fn, alerts, calls, confirms };
};
const flush = () => new Promise((r) => setTimeout(r, 5));
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };
const steps = { ok: true, canRewind: true, steps: [{ n: 0, label: "Start of the run", ts: 1 }, { n: 1, tool: "edit_file", file: "a.js", ts: 2 }, { n: 2, tool: "write_file", file: "<b>.js", ts: 3 }, { n: 3, tool: "rewind", label: "Before going back to step 1", ts: 4 }] };

{ const t = mk(() => steps); const host = new El(); await t.fn("7", host); await flush();
  const box = host.querySelector(".stepbox"); const rows = walk(box).filter((e) => e.className === "hk");
  ok(t.calls[0].url === "/api/run-steps?runId=7" && rows.length === 4, "asks for the steps of the right run and shows 4 rows", { u: t.calls[0].url, r: rows.length });
  ok(/Start of the run/.test(rows[0].innerHTML) && /Step 1 · edited a\.js/.test(rows[1].innerHTML) && /Step 2 · wrote &lt;b&gt;\.js/.test(rows[2].innerHTML), "rows say what each step did; file names are escaped", rows.map((r) => r.innerHTML.slice(0, 90)));
  ok(/Step 3 · Before going back to step 1/.test(rows[3].innerHTML), "a saved-before-rewind step shows its label");
  // click step 1
  const b = rows[1].querySelector("button"); await b.onclick({ target: b }); await flush(); await flush();
  const post = t.calls.find((c) => c.url === "/api/rewind"); const body = post && JSON.parse(post.opt.body);
  ok(post?.opt.method === "POST" && body.runId === "7" && body.step === 1, "going back sends the run and the step number", body);
  ok(t.confirms.length === 1 && /step 1/.test(t.confirms[0]), "the user is asked first", t.confirms);
  ok(host.children.some((c) => /went back to step 1/.test(c.textContent || "")), "a note says where we went back to");
  ok(t.calls.filter((c) => c.url.startsWith("/api/run-steps")).length === 2, "the list is loaded again after going back"); }
{ const t = mk((u) => u.startsWith("/api/run-steps") ? steps : { ok: true }, false); const host = new El(); await t.fn("7", host); await flush();
  const rows = walk(host.querySelector(".stepbox")).filter((e) => e.className === "hk"); const b = rows[2].querySelector("button"); await b.onclick({ target: b }); await flush();
  ok(!t.calls.some((c) => c.url === "/api/rewind") && b.disabled === false, "answering Cancel sends nothing"); }
{ const t = mk((u) => u.startsWith("/api/run-steps") ? steps : { ok: false, error: "The run is still working. Stop it first." }); const host = new El(); await t.fn("7", host); await flush();
  const b = walk(host.querySelector(".stepbox")).filter((e) => e.className === "hk")[0].querySelector("button"); await b.onclick({ target: b }); await flush(); await flush();
  ok(t.alerts[0] === "The run is still working. Stop it first." && b.disabled === false, "an engine error is shown and the button works again", { a: t.alerts, d: b.disabled }); }
{ const t = mk(() => ({ ok: true, canRewind: true, steps: [{ n: 0, label: "Start of the run" }] })); const host = new El(); await t.fn("7", host); await flush();
  ok(/no steps to go back to/.test(host.querySelector(".stepbox").innerHTML), "only the start: says there is nothing to go back to"); }
{ const t = mk(() => ({ ok: true, canRewind: false, steps: steps.steps })); const host = new El(); await t.fn("7", host); await flush();
  ok(/cannot be rewound/.test(host.querySelector(".stepbox").innerHTML), "a run that cannot be rewound says so"); }
{ const t = mk(() => ({ ok: false, error: "No such run." })); const host = new El(); await t.fn("7", host); await flush(); ok(/No such run/.test(host.querySelector(".stepbox").innerHTML), "an engine error is shown"); }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
