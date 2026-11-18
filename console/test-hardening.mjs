// test-hardening.mjs — checks for the 2026-11-15c hardening fixes. Temp folders only, no model, no internet.
//  A. one direct run per folder + a cap on running runs (pathguard.directRunRefusal, server spawn → HTTP 409)
//  B. atomicWrite (temp file + rename, fallback, no leftovers)
//  C. model download: a connection that stops sending data is retried and resumed (stall timeout)
//  D. secrets: Gemini key in a header, redact(), no secret variables for terminal commands and tool servers
import http from "http"; import fs from "fs"; import fsp from "fs/promises"; import os from "os"; import path from "path";
import { spawn as cpSpawn, spawnSync } from "child_process"; import { syncBuiltinESMExports } from "module"; import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eta-harden-"));
let pass = 0, fail = 0;
const ok = (c, name, got) => { if (c) pass++; else fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${name}${c || got === undefined ? "" : "  (got " + String(got).slice(0, 300) + ")"}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// ---------------------------------------------------------------- A (pure rule)
console.log("A. one direct run per folder");
const { directRunRefusal } = await import("./pathguard.mjs");
const wsA = path.join(tmpRoot, "wsA"), wsB = path.join(tmpRoot, "wsB"); fs.mkdirSync(wsA); fs.mkdirSync(wsB);
const R = (id, workspace, extra = {}) => ({ id, workspace, status: "running", ...extra });
ok(directRunRefusal([], wsA, 3) === null, "no runs: a new run may start");
ok(/run 1\b.*this folder/.test(directRunRefusal([R("1", wsA)], wsA, 3) || ""), "same folder running: refused with a clear message", directRunRefusal([R("1", wsA)], wsA, 3));
const alt = (process.platform === "win32" ? wsA.toUpperCase() : wsA) + path.sep;
ok(!!directRunRefusal([R("1", wsA)], alt, 3), "same folder written differently (case, trailing slash): still refused");
ok(directRunRefusal([R("1", wsA, { status: "done" })], wsA, 3) === null, "a finished run in the folder does not block");
ok(directRunRefusal([R("1", wsA)], wsB, 3) === null, "another folder may start");
ok(directRunRefusal([R("1", wsA, { isolated: true, branch: "eta/1", wtPath: path.join(tmpRoot, "wt1") })], wsA, 3) === null, "an isolated run in its own worktree does not block the folder");
ok(!!directRunRefusal([R("1", wsA, { isolated: true })], wsA, 3), "an isolated run without a worktree (works directly in the folder) blocks it");
ok(/3 Eta runs/.test(directRunRefusal([R("1", wsB), R("2", path.join(tmpRoot, "c")), R("3", path.join(tmpRoot, "d"))], wsA, 3) || ""), "cap: a 4th run is refused when 3 are running");
ok(directRunRefusal([R("1", wsB), R("2", path.join(tmpRoot, "c"))], wsA, 3) === null, "cap: a 3rd run may start");

// ---------------------------------------------------------------- A (real server: HTTP 409, message in the UI)
console.log("A. real engine: second run on the same folder answers 409");
{
  // a model server that accepts the request and never answers: the first run stays "running"
  const held = []; const hang = http.createServer((req, res) => { held.push(res); }); const hangPort = await listen(hang);
  const home = path.join(tmpRoot, "home"); const PORT = 8797;
  fs.mkdirSync(path.join(home, ".eta-ide"), { recursive: true });
  fs.writeFileSync(path.join(home, ".eta-ide", `config-${PORT}.json`), JSON.stringify({ provider: { base: `http://127.0.0.1:${hangPort}`, kind: "openai", model: "hang" }, updateCheck: false }));
  const eng = cpSpawn(process.execPath, ["server.mjs"], { cwd: here, env: { ...process.env, PORT: String(PORT), USERPROFILE: home, HOME: home, ETA_AUTO_APPROVE: "1" }, stdio: "ignore", windowsHide: true });
  const call = (method, p, b) => new Promise((res) => { const data = b ? JSON.stringify(b) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: data ? { "content-type": "application/json" } : {} }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} res({ status: x.statusCode, j }); }); });
    r.on("error", (e) => res({ status: 0, j: { error: e.code } })); if (data) r.write(data); r.end(); });
  try {
    let up = false; for (let i = 0; i < 60; i++) { if ((await call("GET", "/api/health")).status === 200) { up = true; break; } await sleep(500); }
    ok(up, "engine started");
    const a = await call("POST", "/api/spawn", { task: "make a.txt", workspace: wsA });
    ok(a.status === 200 && a.j?.runId, "first direct run starts", JSON.stringify(a));
    await sleep(300);
    const b = await call("POST", "/api/spawn", { task: "make b.txt", workspace: alt });
    ok(b.status === 409 && /still working in this folder/.test(b.j?.error || "") && b.j?.busy === true, "second direct run on the same folder: HTTP 409 with a clear message", JSON.stringify(b));
    const m = await call("POST", "/api/message", { message: "Create a file named hello.txt with the text hi", ws: wsA });
    ok(m.status === 409 && /still working in this folder/.test(m.j?.error || ""), "a task typed in the chat on the busy folder: HTTP 409 with the message", JSON.stringify(m));
    const c = await call("POST", "/api/spawn", { task: "make c.txt", workspace: wsB });
    ok(c.status === 200 && c.j?.runId, "a run in another folder still starts", JSON.stringify(c));
    ok(String(c.j?.runId) === String(Number(a.j?.runId) + 1), "the refused starts did not create a run (next run number is used by the next real run)", `${a.j?.runId} then ${c.j?.runId}`);
    const ra = await call("GET", "/api/run?id=" + a.j?.runId);
    ok(ra.j?.status === "running", "the first run is still running (not disturbed by the refused one)", ra.j?.status);
    await sleep(1500); // state is saved 0.8 s after a change
    const stPath = path.join(home, ".eta-ide", `state-${PORT}.json`);
    let parsed = null; try { parsed = JSON.parse(fs.readFileSync(stPath, "utf8")); } catch {}
    ok(parsed && Array.isArray(parsed.runs), "B: state file written by atomicWrite is whole JSON", stPath);
    const left = fs.readdirSync(path.join(home, ".eta-ide")).filter((f) => f.endsWith(".eta-tmp"));
    ok(left.length === 0, "B: no temporary files left next to the state and config files", left.join(", "));
    for (const id of [a.j?.runId, c.j?.runId].filter(Boolean)) await call("POST", "/api/cancel", { runId: id });
  } finally {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(eng.pid), "/T", "/F"], { windowsHide: true }); else eng.kill("SIGKILL");
    for (const r of held) { try { r.destroy(); } catch {} } hang.closeAllConnections?.(); hang.close();
  }
  const ui = fs.readFileSync(path.join(here, "ui.html"), "utf8");
  const send = ui.slice(ui.indexOf("async function send(){"), ui.indexOf("$(\"send\").onclick=send;"));
  ok(/if\(r\.error\)\{ chatMsg\("eta",r\.error\); return; \}/.test(send), "UI: the chat shows the refusal message (fetch does not throw on 409, so nothing hangs)");
}

// ---------------------------------------------------------------- B
console.log("B. atomicWrite");
const { atomicWrite } = await import("./atomicwrite.mjs");
const dirB = path.join(tmpRoot, "b"); fs.mkdirSync(dirB);
const fB = path.join(dirB, "x.txt");
await atomicWrite(fB, "first", "utf8");
ok(fs.readFileSync(fB, "utf8") === "first", "new file written");
await atomicWrite(fB, "second ünïcode", "utf8");
ok(fs.readFileSync(fB, "utf8") === "second ünïcode", "existing file replaced, utf8 kept");
await atomicWrite(path.join(dirB, "bin.dat"), Buffer.from([0, 1, 2, 255]));
ok(Buffer.compare(fs.readFileSync(path.join(dirB, "bin.dat")), Buffer.from([0, 1, 2, 255])) === 0, "binary content (no encoding) written as bytes");
ok(fs.readdirSync(dirB).every((f) => !f.endsWith(".eta-tmp")), "no temporary file left after normal writes");
if (process.platform !== "win32") { fs.chmodSync(fB, 0o640); await atomicWrite(fB, "mode", "utf8"); ok((fs.statSync(fB).mode & 0o777) === 0o640, "file mode kept"); }
{ // a symbolic link stays a link; the real file gets the text
  const real = path.join(dirB, "real.txt"), link = path.join(dirB, "link.txt"); fs.writeFileSync(real, "old");
  let made = false; try { fs.symlinkSync(real, link, "file"); made = true; } catch {}
  if (made) { await atomicWrite(link, "through link", "utf8"); ok(fs.lstatSync(link).isSymbolicLink() && fs.readFileSync(real, "utf8") === "through link", "symbolic link followed, link kept"); }
  else console.log("  (skip) symbolic link check: this account cannot make links");
}
{ // rename fails: falls back to a direct write and removes the temporary file
  const real = fsp.rename; fsp.rename = async () => { throw Object.assign(new Error("EPERM: busy"), { code: "EPERM" }); }; syncBuiltinESMExports();
  try { await atomicWrite(fB, "fallback text", "utf8"); } finally { fsp.rename = real; syncBuiltinESMExports(); }
  ok(fs.readFileSync(fB, "utf8") === "fallback text", "rename failure: direct write fallback still saves the text");
  ok(fs.readdirSync(dirB).every((f) => !f.endsWith(".eta-tmp")), "rename failure: temporary file removed");
}
{ // both fail (target is a folder): the error is reported, nothing left behind
  const d = path.join(dirB, "adir"); fs.mkdirSync(d); let threw = false;
  try { await atomicWrite(d, "x", "utf8"); } catch { threw = true; }
  ok(threw && fs.readdirSync(dirB).every((f) => !f.endsWith(".eta-tmp")), "write impossible: error thrown, temporary file removed");
}
{ // two writers at the same time never mix their text
  await Promise.all(Array.from({ length: 8 }, (_, i) => atomicWrite(fB, String(i).repeat(5000), "utf8")));
  const t = fs.readFileSync(fB, "utf8"); ok(t.length === 5000 && /^(\d)\1*$/.test(t), "8 writers at once: the file is one whole version, not a mix");
}
{ // the agent's write_file and edit_file land files through atomicWrite
  const src = fs.readFileSync(path.join(here, "agent.mjs"), "utf8");
  const a = src.indexOf("  async _writeFile(args, msgs, emit, ctx, hint) {"), b = src.indexOf("  async _genFileContent(");
  const body = src.slice(a, b);
  ok(a > 0 && b > a && !/fs\.writeFile\(full,/.test(body) && (body.match(/atomicWrite\(full,/g) || []).length >= 10, "agent write_file and edit_file use atomicWrite (no plain fs.writeFile(full, …) left)", (body.match(/atomicWrite\(full,/g) || []).length);
  const srv = fs.readFileSync(path.join(here, "server.mjs"), "utf8");
  ok(/atomicWrite\(CFG_PATH,/.test(srv) && /atomicWrite\(STATE_PATH,/.test(srv), "server config and state files use atomicWrite");
}

// ---------------------------------------------------------------- C
console.log("C. download stall timeout");
{
  const { Host } = await import("./host.mjs");
  const data = Buffer.alloc(2000); for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const seen = []; const socks = new Set();
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || ""); const from = m ? +m[1] : 0; seen.push(from);
    if (seen.length === 1) { res.writeHead(200, { "content-length": data.length }); res.write(data.subarray(0, 1000)); return; } // then silence
    res.writeHead(206, { "content-length": data.length - from, "content-range": `bytes ${from}-${data.length - 1}/${data.length}` }); res.end(data.subarray(from));
  });
  srv.on("connection", (s) => { socks.add(s); s.on("close", () => socks.delete(s)); });
  const port = await listen(srv);
  const host = new Host({ stateFile: path.join(tmpRoot, "host.json"), getHw: async () => ({}), isBusy: () => false, stallMs: 1000 });
  const dest = path.join(tmpRoot, "model.gguf"); const t0 = Date.now(); let err = null;
  try { await host._dlFile(`http://127.0.0.1:${port}/f`, dest, data.length, new AbortController().signal, () => {}); } catch (e) { err = e; }
  const secs = (Date.now() - t0) / 1000;
  ok(!err && fs.existsSync(dest) && Buffer.compare(fs.readFileSync(dest), data) === 0, "a stalled download is stopped and resumed: whole file, correct bytes", err?.message);
  ok(seen.length === 2 && seen[1] === 1000, "the retry asked only for the missing part (resume from byte 1000)", JSON.stringify(seen));
  ok(secs < 10, `it did not hang (took ${secs.toFixed(1)} s with a 1 s stall limit)`);
  // the user pressing Pause during a stall still stops at once (not counted as a stall to retry)
  seen.length = 0; const ctl = new AbortController(); const dest2 = path.join(tmpRoot, "model2.gguf");
  const host2 = new Host({ stateFile: path.join(tmpRoot, "host2.json"), getHw: async () => ({}), isBusy: () => false, stallMs: 30000 });
  setTimeout(() => ctl.abort(), 400); let e2 = null; const t1 = Date.now();
  try { await host2._dlFile(`http://127.0.0.1:${port}/f`, dest2, data.length, ctl.signal, () => {}); } catch (e) { e2 = e; }
  ok(e2 && Date.now() - t1 < 5000 && !fs.existsSync(dest2), "pause during a silent connection stops at once", e2?.message);
  for (const s of socks) s.destroy(); srv.close();
  // the default stays 60 s, and the env variable sets it for tests
  const src = fs.readFileSync(path.join(here, "host.mjs"), "utf8");
  ok(/ETA_DL_STALL_MS/.test(src) && /\|\| 60000/.test(src), "default stall limit 60 s, ETA_DL_STALL_MS can change it");
}

// ---------------------------------------------------------------- D
console.log("D. secrets");
const { redact, safeEnv } = await import("./redact.mjs");
{
  const keys = {
    openai: "sk-proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4", anthropic: "sk-ant-api03-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2", google: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6",
    github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8", bearer: "Bearer " + "eyJhbGciOiJIUzI1NiJ9.abc123def456",
  };
  for (const [k, v] of Object.entries(keys)) { const out = redact(`value: ${v} end`); ok(!out.includes(v.replace(/^Bearer /, "")) && out.includes("[hidden]") && out.endsWith(" end"), `redact hides a ${k} key`, out); }
  const hex = "api_key=" + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"; ok(!redact(hex).includes("9f86d0818"), "redact hides a long hex value after api_key=", redact(hex));
  const b64 = 'SECRET_TOKEN: "' + "aGVsbG8gd29ybGQgdGhpcyBpcyBzZWNyZXQx" + '"'; ok(!redact(b64).includes("aGVsbG8g"), "redact hides a base64 value after a token word", redact(b64));
  const normal = "Traceback (most recent call last):\n  File \"calc.py\", line 3, in add\nTypeError: unsupported operand\n12 passed, 0 failed\nconst keyName = 'x'; tokens: 1234";
  ok(redact(normal) === normal, "redact leaves normal program output alone", redact(normal));
  ok(redact("") === "" && redact(null) === null, "redact handles empty input");
  const { cleanOutput, runShell } = await import("./terminal.mjs");
  ok(!cleanOutput("\x1b[32m" + keys.openai + "\x1b[0m").includes(keys.openai), "terminal output cleaning hides a key (also inside colour codes)");
  // a command run for the model does not get secret variables, but keeps PATH and normal ones
  process.env.ETA_TEST_API_KEY = "should-not-leak-1"; process.env.ETA_TEST_TOKEN = "should-not-leak-2"; process.env.MY_SECRET_THING = "should-not-leak-3"; process.env.DB_PASSWORD = "should-not-leak-4"; process.env.ETA_TEST_PLAIN = "plain-ok-5";
  const cmd = process.platform === "win32" ? "echo [%ETA_TEST_API_KEY%] [%ETA_TEST_TOKEN%] [%MY_SECRET_THING%] [%DB_PASSWORD%] [%ETA_TEST_PLAIN%] [%PATH%]" : 'echo "[$ETA_TEST_API_KEY] [$ETA_TEST_TOKEN] [$MY_SECRET_THING] [$DB_PASSWORD] [$ETA_TEST_PLAIN] [$PATH]"';
  const r = await runShell(tmpRoot, cmd, { timeoutMs: 20000 });
  ok(!/should-not-leak/.test(r.out), "terminal command: *_KEY, *_TOKEN, *SECRET*, *PASSWORD* variables removed", r.out);
  ok(/plain-ok-5/.test(r.out) && /system32|\/usr|\/bin/i.test(r.out), "terminal command: normal variables and PATH kept", r.out.slice(0, 200));
  const se = safeEnv({ PATH: "p", OPENAI_API_KEY: "k", GH_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", pgpassword: "x", HOME: "h" }, ["GH_TOKEN"]);
  ok(se.PATH === "p" && se.HOME === "h" && se.GH_TOKEN === "t" && !("OPENAI_API_KEY" in se) && !("AWS_SECRET_ACCESS_KEY" in se) && !("pgpassword" in se), "safeEnv: drops secrets, keeps names listed explicitly", JSON.stringify(se));
  // an MCP tool server: gets a secret only when its own config names it
  const { testMcpServer } = await import("./mcp.mjs");
  const fake = path.join(tmpRoot, "fake-mcp.cjs");
  fs.writeFileSync(fake, `let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id==null)continue;
const names=["has_key_"+(process.env.ETA_TEST_API_KEY?"yes":"no"),"has_listed_"+(process.env.ETA_TEST_TOKEN==="from-config"?"yes":"no"),"has_plain_"+(process.env.ETA_TEST_PLAIN?"yes":"no")];
const result=m.method==="initialize"?{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"f",version:"1"}}:{tools:names.map(n=>({name:n,inputSchema:{type:"object"}}))};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");}});`);
  const t = await testMcpServer("fake", { command: process.execPath, args: [fake], env: { ETA_TEST_TOKEN: "from-config" } }, tmpRoot);
  ok(t.ok && t.tools.includes("has_key_no") && t.tools.includes("has_listed_yes") && t.tools.includes("has_plain_yes"), "MCP server: our secret dropped, its own listed variable and normal ones kept", JSON.stringify(t));
  for (const k of ["ETA_TEST_API_KEY", "ETA_TEST_TOKEN", "MY_SECRET_THING", "DB_PASSWORD", "ETA_TEST_PLAIN"]) delete process.env[k];
}
{ // Gemini: the key goes in the x-goog-api-key header, never in the address; provider error texts are redacted
  const KEY = "AIza" + "SyTESTkey1234567890abcdefghijklmnop";
  const reqs = []; let mode = "ok";
  const g = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    reqs.push({ url: req.url, key: req.headers["x-goog-api-key"] });
    if (mode === "err") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "API key not valid: " + KEY } })); }
    if (req.url.includes("streamGenerateContent")) { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'); }
    if (req.url.includes("generateContent")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] } }] })); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ models: [{ name: "models/gemini-test" }] }));
  }); });
  const gp = await listen(g);
  const ag = await import("./agent.mjs");
  ag.setProvider({ base: `http://127.0.0.1:${gp}`, kind: "gemini", key: KEY, model: "gemini-test" });
  if (ag.provider.kind !== "gemini") ag.provider.kind = "gemini";
  const e = new ag.Eta("gemini-test");
  const c1 = await e.chat([{ role: "user", content: "hi" }]);
  let streamed = ""; await ag.chatStream([{ role: "user", content: "hi" }], (d) => (streamed += d), "gemini-test");
  const h = await e.health();
  const lm = await ag.listProviderModels(`http://127.0.0.1:${gp}`, KEY, "gemini");
  ok(c1.content === "hello" && streamed === "hi" && h === true && lm.models.includes("gemini-test"), "Gemini calls still work (chat, stream, health, model list)", JSON.stringify({ c: c1.content, streamed, h, lm }));
  ok(reqs.length >= 4 && reqs.every((r) => !/key=/i.test(r.url) && r.key === KEY), "Gemini key is sent in the x-goog-api-key header, never in the address", JSON.stringify(reqs.map((r) => r.url)));
  mode = "err"; let msg = "";
  try { await e.chat([{ role: "user", content: "hi" }]); } catch (er) { msg = String(er?.message || er); }
  ok(/LLM provider 400/.test(msg) && !msg.includes(KEY) && msg.includes("[hidden]"), "a provider error that echoes the key is shown with the key hidden", msg);
  g.closeAllConnections?.(); g.close();
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
