// Test: token meter (exact counts from the server, live count while streaming). 2026-11-10.
import { meterContext, meterBegin, meterDelta, meterEnd, snapshot, resetMeter, usageOf, meterHold, meterRelease } from "./meter.mjs";
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
// E3 (2026-11-13): an open question to the user must show "waiting", never "Done"
let d = meterBegin(); meterEnd(d, usageOf.openai({ usage: { prompt_tokens: 100, completion_tokens: 20 } }));
s = snapshot(); ok(s.phase === "done" && !s.waiting, "no question open: Done", s);
meterHold(true); s = snapshot(); ok(s.phase === "waiting" && s.waiting === true && !s.busy, "a question is open: waiting, not Done", s);
meterHold(true); meterHold(false); s = snapshot(); ok(s.phase === "waiting", "two questions, one answered: still waiting", s);
meterHold(false); s = snapshot(); ok(s.phase === "done" && !s.waiting, "last question answered: Done again", s);
meterHold(false); s = snapshot(); ok(s.phase === "done", "an extra release never goes below zero", s);
meterHold(true); let e = meterBegin(); s = snapshot(); ok(s.phase === "reading" && !s.waiting, "a model call running wins over an open question", s);
meterEnd(e, null); meterRelease(); s = snapshot(); ok(s.phase === "done" && !s.waiting, "the run ended (e.g. cancelled): release clears a stuck question", s);
meterHold(true); resetMeter(); s = snapshot(); ok(s.phase === "done", "a new task clears a stuck question", s);
// D5 (2026-11-13): context window fullness = the LAST call's prompt size against the window size (not the sum of all calls)
resetMeter(); meterContext(16384); s = snapshot(); ok(s.ctxMax === 16384 && s.ctxUsed === 0 && s.ctxPct === 0, "window size known, nothing read yet: 0%", s);
let f = meterBegin(); meterEnd(f, usageOf.openai({ usage: { prompt_tokens: 4096, completion_tokens: 10 } }));
s = snapshot(); ok(s.ctxUsed === 4096 && s.ctxPct === 25, "one call read 4,096 of 16,384 = 25%", s);
f = meterBegin(); meterEnd(f, usageOf.openai({ usage: { prompt_tokens: 8192, completion_tokens: 10 } }));
s = snapshot(); ok(s.ctxUsed === 8192 && s.ctxPct === 50 && s.read === 12288, "the second call replaces the first (not added): 50%, while 'read' still adds up", s);
f = meterBegin(); meterEnd(f, usageOf.openai({ usage: { prompt_tokens: 99999, completion_tokens: 1 } }));
s = snapshot(); ok(s.ctxPct === 100, "never above 100%", s);
f = meterBegin(); meterEnd(f, null); s = snapshot(); ok(s.ctxUsed === 99999, "a call with no report keeps the last known size", s);
resetMeter(); s = snapshot(); ok(s.ctxUsed === 0 && s.ctxMax === 16384, "new task: used goes back to 0, window size stays", s);
meterContext(0); s = snapshot(); ok(s.ctxMax === 0 && s.ctxPct === 0, "unknown window size: no percent", s);
meterContext(NaN); meterContext(-5); s = snapshot(); ok(s.ctxMax === 0, "bad sizes are ignored", s);
resetMeter();
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);

