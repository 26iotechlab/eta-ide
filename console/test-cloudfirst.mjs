// test-cloudfirst.mjs (2026-11-15h) — the cloud offer when this PC is slow. NO model, NO GPU, NO internet.
// 1) host.mjs: confirmSlow (the 3-to-5 borderline re-measure) and _speedTest with a stubbed speed measure
// 2) cloudguard.mjs: the secret-file deny-list
// 3) server.mjs: privacy tick for a cloud address, key never in a GET answer, "Back to the local model"
//    (a fake local model server on 127.0.0.1; the "cloud" address is 127.0.0.2:9, which nothing answers)
// 4) ui.html in a headless browser: the card, the button order, the privacy box, the chat-panel indicator, escaping
// Run: node test-cloudfirst.mjs
import fs from "fs"; import os from "os"; import path from "path"; import http from "http"; import { spawn } from "child_process";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.slice(0, 600) + ")"}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "eta-cloud-"));
process.env.ETA_MODELS_DIR = path.join(T, "models");

// ---------- 1. host.mjs
{
  const { confirmSlow, Host } = await import("./host.mjs");
  const seq = (...v) => { let i = 0; const f = async () => { f.calls++; return v[Math.min(i++, v.length - 1)]; }; f.calls = 0; return f; };
  let again = seq(9); let r = await confirmSlow(2.0, again);
  ok(r.slow === true && again.calls === 0, "2.0 words/s: slow at once, no second measure", { r, calls: again.calls });
  again = seq(1); r = await confirmSlow(6.0, again);
  ok(r.slow === false && again.calls === 0, "6.0 words/s: not slow, no second measure", { r, calls: again.calls });
  again = seq(6.2); r = await confirmSlow(3.5, again);
  ok(r.slow === false && again.calls === 1 && r.tokPerSec === 6.2, "3.5 then 6.2 (borderline, warm second run): not slow", r);
  again = seq(3.2); r = await confirmSlow(4.5, again);
  ok(r.slow === true && again.calls === 1 && r.tokPerSec === 3.2, "4.5 then 3.2 (borderline): slow after the second measure", r);
  again = seq(0); r = await confirmSlow(3.5, again);
  ok(r.slow === true && again.calls === 1 && r.tokPerSec === 3.5, "3.5 then a failed second measure (0): keeps 3.5, slow", r);
  for (const [a, calls] of [[2.9, 0], [3, 1], [5, 1], [5.1, 0]]) { const f = seq(4.4); await confirmSlow(a, f); ok(f.calls === calls, `first result ${a}: ${calls ? "measures again" : "no second measure"}`, f.calls); }

  const tiny = { ramGB: 4, gpu: null, diskFreeGB: 500 };
  const card12 = { ramGB: 32, gpu: { name: "RTX 3060", vendor: "nvidia", vramGB: 12 }, diskFreeGB: 500 };
  const mk = (hw, vals) => { const h = new Host({ stateFile: path.join(T, "host-" + Math.random().toString(36).slice(2) + ".json"), getHw: async () => hw }); h.exe = { cmd: "none", pre: [] }; h.measure = seq(...vals); return h; };
  const big = { id: "flagship", label: "Big", sizeGB: 60 };
  let h = mk(tiny, [2.0]); h.s.modelId = "flagship"; await h._speedTest(big);
  ok(h.s.cloudHint === true && h.s.suggest === null && h.measure.calls === 1, "slow (2.0) and no smaller local model fits: cloud card on", { hint: h.s.cloudHint, suggest: h.s.suggest });
  const sf = h.o.stateFile; await sleep(100);
  const h2 = new Host({ stateFile: sf, getHw: async () => tiny }); await h2.init(); h2.shutdown();
  ok(h2.s.cloudHint === true, "the cloud card choice is remembered after a restart (saved with the speed)", h2.s.cloudHint);
  h = mk(card12, [2.0]); await h._speedTest(big);
  ok(h.s.cloudHint === false && h.s.suggest && h.s.suggest.id, "slow (2.0) but a smaller local model fits: suggest it, no cloud card", { hint: h.s.cloudHint, suggest: h.s.suggest });
  h = mk(tiny, [6.0]); await h._speedTest(big);
  ok(h.s.cloudHint === false && h.measure.calls === 1, "fast enough (6.0): no cloud card", h.s.cloudHint);
  h = mk(tiny, [3.8, 7.0]); await h._speedTest(big);
  ok(h.s.cloudHint === false && h.measure.calls === 2 && h.s.tokPerSec === 7, "borderline 3.8 then 7.0: measured twice, no cloud card", { hint: h.s.cloudHint, tok: h.s.tokPerSec });
  h = mk(tiny, [4.6, 2.5]); await h._speedTest(big);
  ok(h.s.cloudHint === true && h.measure.calls === 2, "borderline 4.6 then 2.5: measured twice, cloud card on", { hint: h.s.cloudHint, calls: h.measure.calls });
}

// ---------- 2. cloudguard.mjs (secret files)
{
  const { isSecretFile, guardRead, filterSearchOutput, filterPaths } = await import("./cloudguard.mjs");
  const secret = [".env", ".env.local", ".env.production", "prod.env", "config/.env", "C:\\proj\\.env", "server.pem", "certs/private.key", "id_rsa", "id_ed25519", ".ssh/config", "home/.aws/config", "credentials", "credentials.json", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "secrets.yaml", "store.p12", "app.keystore", "service-account-prod.json", "client_secret_123.json", "prod.tfvars", "terraform.tfstate", ".ENV", "ID_RSA", ".env. ", "kube/../.kube/config"];
  const normal = ["index.js", "src/app.py", "README.md", "package.json", ".env.example", ".env.sample", "id_rsa.pub", "env.js", "environment.ts", "src/keyboard.js", "keys.py", "docs/credentials-guide.md", "monkey.txt", ".gitignore", "tests/test_env.py", "pem_parser.py", ""];
  const missS = secret.filter((p) => !isSecretFile(p)), missN = normal.filter((p) => isSecretFile(p));
  ok(!missS.length, `deny-list matches all ${secret.length} secret file names`, missS);
  ok(!missN.length, `deny-list does not match ${normal.length} normal file names`, missN);
  ok(/BLOCKED/.test(guardRead(".env", true) || "") && guardRead(".env", false) === null && guardRead("app.js", true) === null, "guardRead: blocks .env only when a cloud model is active");
  const out = "src/a.js:3:const k = process.env.KEY\n.env:1:KEY=sk-live-123\nconfig/id_rsa:1:-----BEGIN";
  const f = filterSearchOutput(out, true);
  ok(/src\/a\.js:3/.test(f) && !/sk-live-123/.test(f) && !/BEGIN/.test(f) && /2 line\(s\) from secret files were hidden/.test(f), "search output: lines from secret files are dropped with a cloud model", f);
  ok(filterSearchOutput(out, false) === out, "search output is unchanged with a local model");
  ok(JSON.stringify(filterPaths(["a.js", ".env", "b.pem"], true)) === '["a.js"]' && filterPaths(["a.js", ".env"], false).length === 2, "path lists: secret files dropped only for a cloud model");
}

// ---------- 3. server.mjs
const PORT = "8897", BASE = "http://127.0.0.1:" + PORT, KEY = "sk-test-CLOUDKEY-4321987";
const CLOUD = "http://127.0.0.2:9"; // not on this PC by the isLocalBase rule; nothing answers there (no internet used)
const HOME = path.join(T, "home"); fs.mkdirSync(path.join(HOME, ".eta-ide"), { recursive: true });
const fake = http.createServer((req, res) => { // fake LOCAL model server
  if (req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "fake-local" }] })); }
  if (req.url.startsWith("/v1/chat/completions")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })); }
  res.writeHead(404); res.end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const LOCAL = "http://127.0.0.1:" + fake.address().port;
const CFG = path.join(HOME, ".eta-ide", `config-${PORT}.json`);
fs.writeFileSync(CFG, JSON.stringify({ provider: { base: LOCAL, model: "fake-local", kind: "openai" } }));
const call = (method, p, data) => new Promise((resolve) => {
  const s = data ? JSON.stringify(data) : null;
  const rq = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: s ? { "content-type": "application/json", "content-length": Buffer.byteLength(s) } : {} }, (r) => {
    let t = ""; r.on("data", (d) => (t += d)); r.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: r.statusCode, text: t, json: j }); });
  });
  rq.on("error", (e) => resolve({ status: 0, text: String(e), json: null })); rq.setTimeout(30000, () => rq.destroy(new Error("timeout"))); if (s) rq.write(s); rq.end();
});
const child = spawn(process.execPath, ["server.mjs"], { cwd: here, env: { ...process.env, PORT, USERPROFILE: HOME, HOME, ETA_AUTO_APPROVE: "", ETA_MODELS_DIR: path.join(T, "models") }, stdio: "ignore", windowsHide: true });
let up = false; for (let i = 0; i < 80 && !up; i++) { await sleep(500); up = (await call("GET", "/api/health")).status === 200; }
ok(up, "the model-less engine started on port " + PORT);
const noKey = (r) => !r.text.includes(KEY) && !r.text.includes("CLOUDKEY");
let br = null;
try {
  if (up) {
    let hl = (await call("GET", "/api/health")).json;
    ok(hl && hl.cloud === false && hl.base === LOCAL, "start: the local model is active, no cloud flag", hl);
    let bl = await call("POST", "/api/provider/back-to-local", {});
    ok(bl.status === 400 && /No local model/.test(bl.json?.error || ""), "back-to-local with nothing saved: a plain refusal", bl.text);
    let r = await call("POST", "/api/config", { provider: { base: CLOUD, model: "cloud-m", kind: "openai", key: KEY } });
    ok(r.status === 400 && r.json?.needPrivacyOk === true, "a cloud address WITHOUT the privacy tick is refused", r.text);
    ok((await call("GET", "/api/config")).json?.provider?.base === LOCAL, "after the refusal the local model is still active");
    ok(!fs.readFileSync(CFG, "utf8").includes(KEY), "after the refusal the key was not saved");
    r = await call("POST", "/api/config", { provider: { base: CLOUD, model: "cloud-m", kind: "openai", key: KEY }, privacyOk: true });
    ok(r.status === 200 && r.json?.provider?.base === CLOUD && noKey(r), "with the privacy tick the cloud model is saved (answer has no key)", r.text);
    const gets = {};
    for (const p of ["/api/config", "/api/health", "/api/host"]) gets[p] = await call("GET", p);
    ok(Object.values(gets).every((g) => g.status === 200 && noKey(g)), "the key is in NO GET answer (/api/config, /api/health, /api/host)", Object.fromEntries(Object.entries(gets).map(([k, v]) => [k, v.status + " " + v.text.slice(0, 120)])));
    ok(gets["/api/config"].json?.provider?.keySet === true && gets["/api/config"].json?.cloud === true, "/api/config says a key is saved and a cloud model is active", gets["/api/config"].json);
    hl = gets["/api/health"].json;
    ok(hl?.cloud === true && hl?.canGoLocal === true && hl?.eta === false, "health: cloud active, can go back, and offline (nothing answers at the cloud address)", hl);
    const raw = fs.readFileSync(CFG, "utf8");
    ok(!raw.includes(KEY) && /"lastLocal"/.test(raw) && raw.includes(CLOUD), "config file: key only encrypted, the old local model saved as lastLocal, address remembered", raw.slice(0, 300));
    r = await call("POST", "/api/config", { provider: { base: CLOUD, model: "cloud-m2", kind: "openai" } });
    ok(r.status === 200 && r.json?.provider?.model === "cloud-m2", "the tick is remembered for the same address", r.text);
    bl = await call("POST", "/api/provider/back-to-local", {});
    ok(bl.status === 200 && bl.json?.provider?.base === LOCAL && bl.json?.provider?.model === "fake-local" && noKey(bl), "Back to the local model: the old address and model are back", bl.text);
    const c2 = (await call("GET", "/api/config")).json;
    ok(c2?.cloud === false && c2?.provider?.keySet === false, "after going back: no cloud flag, the cloud key is not used for the local model", c2);
    ok((await call("GET", "/api/health")).json?.eta === true, "after going back: the local model answers");

    // ---------- 4. ui.html
    let pw = null; try { pw = await import("playwright-core"); } catch {}
    const exes = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean);
    let exe = null; for (const c of exes) { try { fs.accessSync(c); exe = c; break; } catch {} }
    if (!pw || !exe) console.log("  (browser part skipped: no playwright-core or no local Chrome/Edge)");
    else {
      br = await pw.chromium.launch({ executablePath: exe, headless: true });
      const pg = await br.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(String(e)));
      await pg.goto(BASE + "/", { waitUntil: "domcontentloaded" }); await sleep(1500);
      const card = await pg.evaluate(() => { const d = document.createElement("div"); d.innerHTML = cloudCardHtml({ tokPerSec: 2.4 }); document.body.appendChild(d);
        const t = d.textContent, btns = [...d.querySelectorAll("button")].map((b) => b.textContent.trim()); d.remove(); return { t, btns }; });
      ok(/2\.4 words per second/.test(card.t) && /30 minutes/.test(card.t), "card: shows the measured speed", card.t);
      ok(/your code and files leave this PC and go to the provider/.test(card.t), "card: honest privacy warning", card.t);
      ok(/you pay the provider/i.test(card.t) && /no cost counter yet/.test(card.t), "card: cost note", card.t);
      ok(JSON.stringify(card.btns) === JSON.stringify(["Keep the local model", "Anthropic", "Gemini", "OpenAI-style"]), "card: 'Keep the local model' comes first, then the three providers", card.btns);
      ok(!/must|hurry|now!|recommended/i.test(card.t), "card: no pressure words", card.t);
      const xss = await pg.evaluate(() => { const bad = '<img src=x onerror="window.__xss=1"><b id=bx>b</b>'; const d = document.createElement("div");
        d.innerHTML = cloudCardHtml({ tooSmall: true, dev: bad }) + cloudCardHtml({ tokPerSec: bad }); document.body.appendChild(d);
        cloudBar({ cloud: true, base: "https://x.example/" + bad, model: bad, eta: true, canGoLocal: true });
        const r = { imgs: document.querySelectorAll("#cloudcard img, #cloudbar img, img[src=x]").length, b: !!document.getElementById("bx"), text: d.textContent.includes("<img") && document.getElementById("cloudbar").textContent.includes("<b id=bx>") };
        d.remove(); return r; });
      await sleep(300);
      ok(xss.imgs === 0 && !xss.b && xss.text && !(await pg.evaluate(() => window.__xss)), "text is escaped (no HTML from speed, device, model or address runs)", xss);
      const sel = (s) => pg.evaluate((q) => { const e = document.querySelector(q); return e ? { shown: getComputedStyle(e).display !== "none" && e.offsetParent !== null || getComputedStyle(e).display !== "none", text: e.textContent } : null; }, s);
      await pg.evaluate(() => { localStorage.clear(); cloudBar({ cloud: true, base: "http://127.0.0.2:9", model: "cloud-m", eta: false, canGoLocal: true }); });
      let cb = await sel("#cloudbar");
      ok(cb && cb.shown && /Cloud model/.test(cb.text) && /Back to the local model/.test(cb.text), "chat panel: a clear 'Cloud model' indicator with 'Back to the local model'", cb);
      ok(/first time/.test(cb.text) && /does not answer/.test(cb.text), "chat panel: first-use notice and the plain offline message", cb.text);
      await pg.click("#cb-ok"); cb = await sel("#cloudbar");
      ok(!/first time/.test(cb.text) && /Back to the local model/.test(cb.text), "first-use notice goes away after OK; the back button stays", cb.text);
      await pg.evaluate(() => cloudBar({ cloud: false })); cb = await sel("#cloudbar");
      ok(cb && cb.shown === false, "chat panel: no indicator with a local model", cb);
      // model card in the Models screen
      const mc = await pg.evaluate(() => { const out = {};
        const st = { modelId: "flagship", label: "Big", status: "ready", active: true, tokPerSec: 2.4, verdict: "tooslow", cloudHint: true, idleMin: 30, suggest: null };
        window._health = { cloud: false }; window._cloudKept = false;
        hostData = { state: st, models: [], dir: "D:/m", hw: null }; modelsRender(); out.on = !!document.querySelector("#cmodels .cloudcard");
        hostData = { state: { ...st, cloudHint: false, tokPerSec: 12, verdict: "good" }, models: [], dir: "D:/m", hw: null }; modelsRender(); out.fast = !!document.querySelector("#cmodels .cloudcard");
        hostData = { state: st, models: [], dir: "D:/m", hw: null }; modelsRender(); document.querySelector('#cmodels [data-cc="keep"]').click(); out.afterKeep = !!document.querySelector("#cmodels .cloudcard");
        window._cloudKept = false; window._health = { cloud: true, model: "cloud-m", base: "https://api.anthropic.com" }; modelsRender();
        out.back = !!document.querySelector('#cmodels [data-cc="back"]'); window._health = { cloud: false }; return out; });
      ok(mc.on === true && mc.fast === false, "Models screen: the cloud card shows for a slow measured speed, not for a fast one", mc);
      ok(mc.afterKeep === false, "'Keep the local model' hides the card", mc);
      ok(mc.back === true, "Models screen: 'Back to the local model' button while a cloud model is active", mc);
      // privacy box blocks the save
      await pg.evaluate(async () => { await openSettings(); });
      await pg.fill("#cfg-base", "https://api.anthropic.com"); await pg.fill("#cfg-model", "claude-x");
      let pr = await sel("#cfg-privacy-row");
      ok(pr && pr.shown && /leave this PC/.test(pr.text), "key screen: privacy box shows for a cloud address", pr);
      await pg.click("#cfg-save"); await sleep(400);
      const st1 = await pg.evaluate(() => document.getElementById("cfg-status").textContent);
      ok(/tick the box/.test(st1) && (await call("GET", "/api/config")).json?.provider?.base === LOCAL, "key screen: Save without the tick is blocked, nothing is sent", st1);
      await pg.fill("#cfg-base", "http://localhost:11434"); pr = await sel("#cfg-privacy-row");
      ok(pr && pr.shown === false, "key screen: no privacy box for an address on this PC", pr);
      const presets = await pg.evaluate(() => [...document.querySelectorAll("#presets button")].map((b) => b.textContent.trim()));
      ok(presets.includes("Anthropic") && presets.includes("Gemini") && presets.includes("OpenAI"), "key screen: Anthropic, Gemini and OpenAI buttons", presets);
      const keyField = await pg.evaluate(async () => { await cloudPickProvider("https://generativelanguage.googleapis.com"); return { base: document.getElementById("cfg-base").value, key: document.getElementById("cfg-key").value, box: getComputedStyle(document.getElementById("cfg-privacy-row")).display }; });
      ok(keyField.base === "https://generativelanguage.googleapis.com" && keyField.key === "" && keyField.box !== "none", "provider button fills the existing key screen (address set, key empty, privacy box shown)", keyField);
      // back-to-local through the page
      await call("POST", "/api/config", { provider: { base: CLOUD, model: "cloud-m", kind: "openai", key: KEY }, privacyOk: true });
      const back = await pg.evaluate(async () => await cloudBackToLocal({ canGoLocal: true }));
      ok(back.ok === true && (await call("GET", "/api/config")).json?.cloud === false, "page button 'Back to the local model' switches the engine back", back);
      ok(!errs.length, "no page errors", errs);
    }
  }
} finally {
  try { await br?.close(); } catch {}
  try { child.kill(); } catch {}
  fake.close();
  await sleep(500); try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
console.log(`========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
