// Real Eta class against a fake model server: the cut-off reason and call failures must survive the REAL call path
// (the earlier tests used a fake Eta object that skipped the real wrapper). No GPU.
import http from "node:http";
import { Eta, setProvider } from "./agent.mjs";
import { judgeReply } from "./replygate.mjs";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
let mode = "good";
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (!/chat\/completions/.test(req.url)) { res.writeHead(404); return res.end("{}"); }
    if (mode === "fail") { res.writeHead(400, { "content-type": "application/json" }); return res.end('{"error":{"message":"bad request"}}'); }
    const reply = { good: ["def a():\n    return 1\n", "stop"], cut: ["def a():\n    ret", "length"], empty: ["", "stop"], refusal: ["I cannot do that.", "stop"], json: ['{"tool":"write_file","args":{"path":"a.py"}}', "stop"] }[mode];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply[0] }, finish_reason: reply[1] }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
setProvider({ base: `http://127.0.0.1:${srv.address().port}`, kind: "openai", model: "fake" });
const eta = new Eta("fake", 4096);
const msgs = [{ role: "user", content: "write a.py" }];
const table = { good: null, cut: "cut_off", empty: "empty", refusal: "refusal", json: "action_json" };
for (const [m, want] of Object.entries(table)) {
  mode = m;
  const out = await eta.chat(msgs, null, null, 100);
  const v = judgeReply(out, "file", { ext: "py" });
  ok(want ? (!v.ok && v.reason === want) : v.ok, `chat ${m}: verdict ${JSON.stringify(v)}`);
  if (m === "cut") ok(out.finish === "length", "Eta.chat passes the stop reason through the real wrapper");
}
mode = "cut"; await eta.ask("hi"); ok(eta.lastAsk.finish === "length" && eta.lastAsk.ok, "ask() records a cut-off");
mode = "fail"; const a = await eta.ask("hi"); ok(a === "" && eta.lastAsk.ok === false && eta.lastAsk.error.length > 0, "ask() failure returns empty AND is recorded");
mode = "good"; await eta.ask("hi"); ok(eta.lastAsk.ok && eta.lastAsk.error === "", "a good call clears the failure");
srv.close();
console.log(`faulttable: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
