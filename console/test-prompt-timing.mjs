// Test: the engine reads the local server's prompt-reuse numbers ("timings") from a streamed reply (2026-11-14).
// Fake local server. NO real model, NO GPU.  Run: node test-prompt-timing.mjs
import http from "http";
import { chatStream, setProvider, lastPromptTiming, recordPromptTiming } from "./agent.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
recordPromptTiming({});                       ok(lastPromptTiming === null || typeof lastPromptTiming === "object", "no timings: no crash");
recordPromptTiming({ timings: { prompt_n: 40, cache_n: 2496 } });
ok(lastPromptTiming && lastPromptTiming.fresh === 40 && lastPromptTiming.reused === 2496, "reads fresh and re-used counts", lastPromptTiming);
const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{}}],"timings":{"prompt_n":12,"cache_n":900}}\n\n');
  res.write("data: [DONE]\n\n"); res.end(); }); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
setProvider({ kind: "openai", base: `http://127.0.0.1:${srv.address().port}`, model: "fake" });
let got = ""; await chatStream([{ role: "user", content: "hi" }], (t) => (got += t), "fake");
ok(got === "ok", "text still streams");
ok(lastPromptTiming && lastPromptTiming.fresh === 12 && lastPromptTiming.reused === 900, "streamed timings recorded", lastPromptTiming);
srv.closeAllConnections?.(); srv.close();
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
