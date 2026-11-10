// Security test: the engine server must refuse other websites, fake host names and the network, and still serve its own window.
import http from "http"; import { spawn, spawnSync } from "child_process"; import fs from "fs"; import os from "os";
const PORT = 8799, home = fs.mkdtempSync(os.tmpdir() + "/eta-guard-");
const eng = spawn(process.execPath, ["server.mjs"], { cwd: new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), env: { ...process.env, PORT: String(PORT), USERPROFILE: home, HOME: home }, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (method, path, headers = {}, host = "127.0.0.1") => new Promise((res) => {
  const r = http.request({ host, port: PORT, path, method, headers }, (x) => { let b = ""; x.on("data", (c) => (b += c)); x.on("end", () => res(x.statusCode)); });
  r.on("error", (e) => res("no connection (" + e.code + ")")); r.end(method === "POST" ? '{"message":"echo hi"}' : undefined);
});
for (let i = 0; i < 40; i++) { if ((await call("GET", "/api/health")) === 200) break; await sleep(500); }
let pass = 0, fail = 0; const ok = (c, name, got) => { if (c) pass++; else fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${name} (got ${got})`); };
let s;
s = await call("GET", "/api/health"); ok(s === 200, "own tools without Origin (IDE extension, tests) are allowed", s);
s = await call("GET", "/api/health", { origin: `http://127.0.0.1:${PORT}` }); ok(s === 200, "own window (same origin) is allowed", s);
s = await call("POST", "/api/chat", { origin: "https://evil.example", "content-type": "text/plain" }); ok(s === 403, "a website's hidden POST is refused", s);
s = await call("POST", "/api/message", { origin: "null", "content-type": "text/plain" }); ok(s === 403, "a sandboxed or file page (Origin null) is refused", s);
s = await call("GET", "/api/health", { "sec-fetch-site": "cross-site" }); ok(s === 403, "a cross-site GET is refused", s);
s = await call("GET", "/api/health", { origin: "http://localhost:3000", "sec-fetch-site": "same-site" }); ok(s === 403, "another localhost app (port 3000) is refused", s);
s = await call("GET", "/", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }); ok(s === 200, "the IDE panel iframe can load the page", s);
s = await call("GET", "/api/health", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }); ok(s === 403, "a navigation to an /api address from another site is refused", s);
s = await call("GET", "/api/health", { host: "evil.example:" + PORT }); ok(s === 403, "a fake host name (DNS rebinding) is refused", s);
const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
if (lan) { s = await call("GET", "/api/health", {}, lan); ok(s !== 200, `the network address ${lan} cannot reach it`, s); }
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
eng.kill(); spawnSync("taskkill", ["/F", "/T", "/PID", String(eng.pid)], { stdio: "ignore" }); process.exit(fail ? 1 : 0);
