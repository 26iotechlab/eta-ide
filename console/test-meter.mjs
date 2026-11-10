// Test: token meter (exact counts from the server, live count while streaming). 2026-11-10.
import { meterBegin, meterDelta, meterEnd, snapshot, resetMeter, usageOf } from "./meter.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
resetMeter(); let a = meterBegin(); await sleep(300);
let s = snapshot(); ok(s.busy && s.phase === "reading" && s.written === 0, "before the first piece: reading", s);
for (let i = 0; i < 40; i++) { meterDelta(a); await sleep(10); }
s = snapshot(); ok(s.phase === "writing" && s.written === 40 && !s.exact && s.perSec > 0, "while streaming: live count, marked about", s);
meterEnd(a, usageOf.openai({ usage: { prompt_tokens: 900, completion_tokens: 37 } }));
s = snapshot(); ok(!s.busy && s.written === 37 && s.read === 900 && s.exact, "after the end: the server's exact count replaces the live count", s);
let b = meterBegin(); await sleep(50); meterEnd(b, usageOf.ollama({ prompt_eval_count: 100, eval_count: 50, eval_duration: 2e9 }));
s = snapshot(); ok(s.written === 87 && s.read === 1000 && s.exact, "counts add up over calls (Ollama report)", s);
let c = meterBegin(); for (let i = 0; i < 10; i++) meterDelta(c); meterEnd(c, null);
s = snapshot(); ok(s.written === 97 && !s.exact, "a server without a report: the live count stays, marked about", s);
resetMeter(); s = snapshot(); ok(s.written === 0 && s.read === 0 && s.exact, "reset for a new task (also clears the about mark)", s);
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);

