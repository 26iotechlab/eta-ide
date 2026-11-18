// Test: "cache_prompt" is sent only to a server on this PC (C1, 2026-11-13). Fake local server. NO real model, NO GPU.
// Run: node test-cache-prompt.mjs
import http from "http";
import { isLocalBase, localServerExtras, editCode, chatStream, setProvider } from "./agent.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
for (const b of ["http://127.0.0.1:8722", "http://localhost:8080", "https://localhost", "http://[::1]:9", "HTTP://LOCALHOST:1/v1", "http://127.0.0.1"]) ok(isLocalBase(b), "local: " + b);
for (const b of ["https://api.openai.com/v1", "http://127.0.0.1.evil.com", "http://localhost.evil.com:80", "http://192.168.1.5:8080", "http://example.com/127.0.0.1", "", null, undefined, "127.0.0.1"]) ok(!isLocalBase(b), "not local: " + JSON.stringify(b));
ok(localServerExtras("http://localhost:1").cache_prompt === true && Object.keys(localServerExtras("https://api.openai.com")).length === 0, "extras only for a local server");
let seen = null;
const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { seen = JSON.parse(b); } catch { seen = null; }
  if (seen?.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'); res.end(); }
  else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); } }); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
setProvider({ kind: "openai", base: `http://127.0.0.1:${srv.address().port}`, model: "fake" });
await editCode("a", "b", "js"); ok(seen?.cache_prompt === true && seen.stream === false, "a normal request to a local server asks for prompt reuse", seen && Object.keys(seen));
let got = ""; await chatStream([{ role: "user", content: "hi" }], (t) => (got += t), "fake"); ok(seen?.cache_prompt === true && seen.stream === true && got === "hi", "a streamed request does too", seen && Object.keys(seen));
srv.closeAllConnections?.(); srv.close();
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
