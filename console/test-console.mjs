import { readFile } from "fs/promises";
const base = "http://127.0.0.1:8710";
const ws = "d:\\eta-ide\\sandbox";

const h = await (await fetch(base + "/api/health")).json();
console.log("health:", h);

const r = await (await fetch(base + "/api/spawn", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    task: "Read math.py, then add a function multiply(a, b) that returns a*b to it (keep the existing add). Then call finish.",
    workspace: ws, autoApprove: true,
  }),
})).json();
console.log("spawned run:", r.runId);

for (let i = 0; i < 45; i++) {
  await new Promise((s) => setTimeout(s, 3000));
  let t = "";
  try { t = await readFile(ws + "\\math.py", "utf8"); } catch {}
  if (t.includes("multiply")) {
    console.log(`\nSUCCESS ✓ agent edited math.py after ~${(i + 1) * 3}s:\n----`);
    console.log(t);
    process.exit(0);
  }
}
console.log("multiply not found within 135s (check console UI for the run transcript)");
process.exit(1);
