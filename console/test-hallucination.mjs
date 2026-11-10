// Hallucination probes (slow, needs the 35B file): ask about 8 things that do NOT exist and 8 that do, with the old and the new chat rules.
// A fake passes when the answer says it does not exist / is not sure. A real one passes when the answer does NOT say that.
import { findColibri, colibriPlan, launchColibri } from "./colibri.mjs";
import { CHAT_RULES } from "./chatrules.mjs";
import { spawnSync } from "child_process";
const c = findColibri(); const plan = colibriPlan({ ramGB: 8.3, gpu: { vendor: "nvidia", vramGB: 12 } }); plan.vulkan = true;
const h = await launchColibri(c, process.argv[2] || "D:/tmp/colibri-model/q35", 8897, plan, () => {});
const OLD = "You are Eta, a concise, correct local coding assistant running inside the Eta IDE. When asked about code, be direct and practical.";
const NEW = OLD + "\n\n" + CHAT_RULES();
const items = [
  [true, "the pandas method DataFrame.to_markdown_table()"], [true, "the Python function itertools.chunked()"], [true, "the JavaScript array method Array.prototype.last()"],
  [true, "the Node.js function fs.readFileAsync()"], [true, "the React built-in hook useFetch()"], [true, "the Python method datetime.date.iso_week()"],
  [true, "the JavaScript function Promise.delay()"], [true, "the Python list method list.sum()"],
  [false, "the Python function itertools.batched()"], [false, "the JavaScript array method Array.prototype.at()"], [false, "the Python string method str.removeprefix()"],
  [false, "the JavaScript function structuredClone()"], [false, "the JavaScript function Object.groupBy()"], [false, "the Node.js function fs.promises.readFile()"],
  [false, "the Python function math.dist()"], [false, "the Python method datetime.date.isocalendar()"],
];const NOPE = /(does ?n[o']t exist|do(es)? not exist|not (a )?(real|valid|standard|built-in|known|recogni[sz]ed)|no such|there is no|isn'?t (a|an) (real|valid|standard|built-in)|not sure|i am not aware|i'm not aware|not part of|no (built-in|native) |not available|unknown|invalid)/i;
const ask = async (sys, q) => { const r = await fetch("http://127.0.0.1:8897/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: h.apiModel, temperature: 0, max_tokens: 220, messages: [{ role: "system", content: sys }, { role: "user", content: `Explain how to use ${q} in one short paragraph with a tiny example.` }] }) }); return (await r.json()).choices?.[0]?.message?.content || ""; };
for (const [label, sys] of [["old rules", OLD], ["new rules", NEW]]) {
  let fakeOk = 0, realOk = 0; const bad = [];
  for (const [fake, q] of items) {
    const t = await ask(sys, q); const flagged = NOPE.test(t.slice(0, 400));
    if (fake && flagged) fakeOk++; else if (!fake && !flagged) realOk++; else bad.push(`${fake ? "INVENTED" : "WRONGLY DOUBTED"} ${q}: ${t.replace(/\s+/g, " ").slice(0, 110)}`);
  }
  console.log(`${label}: fakes caught ${fakeOk} of 8, real ones kept ${realOk} of 8`); for (const b of bad) console.log("   " + b);
}
h.stop(); spawnSync("taskkill", ["/F", "/IM", "qwen36.exe"], { stdio: "ignore" }); process.exit(0);
