import http from "http";
import { startMcp, testMcpServer } from "./mcp.mjs";
import fs from "fs";
let seenSession = null, calls = 0;
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    if (req.method === "DELETE") { res.end(); return; }
    if (req.headers.authorization !== "Bearer secret") { res.writeHead(401); return res.end("no"); }
    const m = JSON.parse(b);
    if (m.method === "notifications/initialized") { seenSession = req.headers["mcp-session-id"]; res.writeHead(202); return res.end(); }
    let result;
    if (m.method === "initialize") { res.setHeader("mcp-session-id", "S1"); result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } }; }
    else if (m.method === "tools/list") result = { tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
    else if (m.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] }; }
    const out = JSON.stringify({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "tools/call") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("event: message\ndata: " + out + "\n\n"); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(out); }
  });
}).listen(0, async () => {
  const url = "http://127.0.0.1:" + srv.address().port + "/mcp";
  const ws = "D:/tmp/webws"; fs.mkdirSync(ws + "/.eta", { recursive: true });
  console.log("bad key:", JSON.stringify(await testMcpServer("w", { url, headers: { Authorization: "Bearer wrong" } }, ws)));
  fs.writeFileSync(ws + "/.eta/mcp.json", JSON.stringify({ mcpServers: { w: { url, headers: { Authorization: "Bearer secret" } } } }));
  console.log("good:", JSON.stringify(await testMcpServer("w", { url, headers: { Authorization: "Bearer secret" } }, ws)));
  const hub = await startMcp(ws, () => {});
  console.log("tools:", hub.tools.map(t => t.fullName));
  console.log("call:", JSON.stringify(await hub.call("mcp__w__echo", { text: "hi" })), "session seen:", seenSession);
  hub.stop(); srv.close();
});
