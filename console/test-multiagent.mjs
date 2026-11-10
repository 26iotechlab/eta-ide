import { readFile } from "fs/promises";
const base = "http://127.0.0.1:8710";
const ws = "d:\\eta-ide\\sandbox";

const es = await fetch(base + "/events");
const reader = es.body.getReader();
const dec = new TextDecoder();
let buf = "", runId = null, done = false;
const seen = [];

const r = await (await fetch(base + "/api/spawn", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ task: "Add a function multiply(a, b) that returns a*b to math.py (keep add). Then finish.", workspace: ws, autoApprove: true }),
})).json();
runId = r.runId;
console.log("spawned run", runId, "\nwatching agent team…\n");

const deadline = Date.now() + 200000;
while (Date.now() < deadline && !done) {
  const { value, done: d } = await reader.read(); if (d) break;
  buf += dec.decode(value, { stream: true });
  let i; while ((i = buf.indexOf("\n\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!line.startsWith("data: ")) continue;
    const m = JSON.parse(line.slice(6));
    if (m.runId && m.runId !== runId) continue;
    if (m.type === "agent") { seen.push("[" + m.role + "]"); console.log("AGENT:", m.role); }
    else if (m.type === "plan") { seen.push("plan"); console.log("PLAN:\n" + (m.text || "").slice(0, 400) + "\n"); }
    else if (m.type === "tool") console.log("  tool:", m.name, JSON.stringify(m.args).slice(0, 100));
    else if (m.type === "review") { seen.push(m.approved ? "review:APPROVED" : "review:NEEDS_WORK"); console.log("REVIEW:", m.approved ? "APPROVED" : "NEEDS_WORK", "\n" + (m.feedback || "").slice(0, 300) + "\n"); }
    else if (m.type === "answer") { seen.push("answer"); console.log("ANSWER:", (m.text || "").slice(0, 150)); }
    else if (m.type === "done") done = true;
  }
}
console.log("\nSEQUENCE:", seen.join(" -> "));
const t = await readFile(ws + "\\math.py", "utf8").catch(() => "");
console.log("multiply present:", t.includes("multiply"));
process.exit(0);
