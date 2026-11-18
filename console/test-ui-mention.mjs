// Test: the panel's "@" file menu (D3, 2026-11-13) — NO browser, NO model, NO server.
// Extracts updateSlash from ui.html and runs it against a tiny fake page and a fake engine.
// Run: node test-ui-mention.mjs
import fs from "fs"; import path from "path"; import vm from "vm";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const html = fs.readFileSync(path.join(here, "ui.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let bad = null; scripts.forEach((s, i) => { try { new vm.Script(s, { filename: "ui.html#" + i }); } catch (e) { bad = bad || `${i}: ${e.message}`; } });
ok(!bad, "every inline script of ui.html still compiles", bad);
const src = /let _mentSeq=0;\nasync function updateSlash\(\)\{[\s\S]*?\n\}\n(?=\$\("chatbox"\)\.addEventListener\("keydown")/.exec(html)?.[0];
ok(!!src, "updateSlash is in ui.html");
ok(/e\.key==="Tab"&&\$\("slashmenu"\)\.style\.display==="block"/.test(html), "Tab accepts the first menu item while the menu is open");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
const flush = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const mk = ({ value, caret, ws = "/proj", files = [], agents = [], delay = 0 }) => {
  const box = { value, selectionStart: caret ?? value.length, focused: false, setSelectionRange(a) { this.selectionStart = a; }, focus() { this.focused = true; } };
  const menu = { innerHTML: "", style: {}, _items: [], querySelectorAll() { return this._items; } };
  Object.defineProperty(menu, "innerHTML", { get() { return this._h || ""; }, set(h) { this._h = h; this._items = [...h.matchAll(/class="slashitem"([^>]*)>/g)].map((m) => ({ dataset: { k: (/data-k="([^"]*)"/.exec(m[1]) || [])[1], n: unesc((/data-n="([^"]*)"/.exec(m[1]) || [])[1] || "") }, style: {}, onclick: null })); } });
  const calls = [];
  const fetch = async (url) => { calls.push(url); if (delay) await flush(delay); return { json: async () => ({ files: typeof files === "function" ? files(url) : files }) }; };
  const $ = (id) => id === "chatbox" ? box : id === "slashmenu" ? menu : null;
  const fn = new Function("$", "esc", "fetch", "WS", "workflows", "skillsList", "agentsList", "hideSlash", src + "; return updateSlash;")(
    $, esc, fetch, ws, async () => [], async () => [], async () => agents, () => { menu.style.display = "none"; });
  return { fn, box, menu, calls };
};

{ const t = mk({ value: "look at @sr", files: ["src/app.js", "src/util/math.js"] }); await t.fn(); await flush();
  ok(t.menu.style.display === "block" && t.menu._items.length === 2 && t.menu._items.every((i) => i.dataset.k === "file"), "typing @sr in the middle of a message shows the files", t.menu._items.map((i) => i.dataset));
  ok(t.calls[0] === "/api/mention-files?ws=%2Fproj&q=sr", "asks the engine with the open folder and the typed text", t.calls);
  t.menu._items[0].onclick(); ok(t.box.value === "look at @src/app.js " && t.box.selectionStart === t.box.value.length, "clicking replaces only the typed @text and puts the cursor after it", { v: t.box.value, c: t.box.selectionStart });
  ok(t.menu.style.display === "none" && t.box.focused, "the menu closes and the box has focus again"); }
{ const t = mk({ value: "fix @ap and then test it", caret: 7, files: ["src/app.js"] }); await t.fn();
  ok(t.calls[0].endsWith("q=ap"), "only the text before the cursor counts", t.calls);
  t.menu._items[0].onclick(); ok(t.box.value === "fix @src/app.js  and then test it" || t.box.value === "fix @src/app.js and then test it".replace("js and", "js  and"), "text after the cursor is kept", t.box.value);
  ok(t.box.selectionStart === "fix @src/app.js ".length, "cursor sits right after the inserted path", t.box.selectionStart); }
{ const t = mk({ value: "@notes", files: ["notes/my notes.md"] }); await t.fn(); t.menu._items[0].onclick();
  ok(t.box.value === '@"notes/my notes.md" ', "a path with a space is put in quotes", t.box.value); }
{ const t = mk({ value: "mail bob@example.com", files: ["x.js"] }); await t.fn();
  ok(t.calls.length === 0 && t.menu.style.display === "none", "an e-mail address does not open the menu", t.calls); }
{ const t = mk({ value: "see @", files: ["a.js"], ws: "" }); await t.fn();
  ok(t.calls.length === 0, "no open folder: no file menu"); }
{ const t = mk({ value: "@re", files: ["README.md"], agents: [{ name: "reviewer", description: "reviews code" }, { name: "other", description: "x" }] }); await t.fn();
  const kinds = t.menu._items.map((i) => i.dataset.k || "agent"); ok(kinds.join() === "agent,file", "at the start of the message, agents and files are both offered", kinds);
  t.menu._items[0].onclick(); ok(t.box.value === "@reviewer ", "clicking an agent still works as before", t.box.value); }
{ const t = mk({ value: "/anything", files: ["a.js"] }); await t.fn();
  ok(t.calls.length === 0, "the / menu does not ask for files"); }
{ const t = mk({ value: "check @a", files: [] }); await t.fn(); ok(t.menu.style.display === "none", "no matching file: the menu stays closed"); }
{ // a slow answer for old text must not replace the list for newer text
  const t = mk({ value: "x @a", files: (u) => u.includes("q=a&") || u.endsWith("q=a") ? ["old.js"] : ["new.js"], delay: 30 });
  const p1 = t.fn(); t.box.value = "x @ab"; t.box.selectionStart = 5; const p2 = t.fn(); await Promise.all([p1, p2]); await flush();
  ok(t.menu._items.length === 1 && t.menu._items[0].dataset.n === "new.js", "an old, slow answer is dropped", t.menu._items.map((i) => i.dataset.n)); }
{ const t = mk({ value: 'a @"quo' }); await t.fn(); ok(t.calls.length === 0, "a started quote does not crash the menu (no list)", t.calls); }
{ const t = mk({ value: "@x", files: ['a"b<c>.js'] }); await t.fn(); ok(t.menu._h.includes("a&quot;b&lt;c&gt;.js") && !t.menu._h.includes("a\"b<c>"), "file names are escaped in the page", t.menu._h.slice(0, 200)); }
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
