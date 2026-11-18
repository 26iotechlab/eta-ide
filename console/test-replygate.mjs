// Fault table: each kind of bad model reply against the gate. Plain node, no GPU.
import { judgeReply, actOn, gateMode, ENDINGS, endingDone, normEnding, cutText } from "./replygate.mjs";
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

const R = (content, finish = "", toolCalls = []) => ({ content, finish, toolCalls });
const table = [
  // [name, reply, kind, opts, expected reason or null]
  ["cut off", R("def a():\n  return 1", "length"), "file", { ext: "py" }, "cut_off"],
  ["empty", R("   "), "file", { ext: "py" }, "empty"],
  ["action json as file", R('{"tool":"write_file","args":{"path":"a.py"}}'), "file", { ext: "py" }, "action_json"],
  ["action json as json file", R('{"tool":"x","args":{}}'), "file", { ext: "json" }, "action_json"],
  ["real json data with a name key is fine", R('{"name":"pkg","version":"1.0"}'), "file", { ext: "json" }, null],
  ["refusal in py", R("I cannot create that file."), "file", { ext: "py" }, "refusal"],
  ["refusal text ok in md", R("I cannot say more here, but see below."), "file", { ext: "md" }, null],
  ["sorry in html ok", R("Sorry, page not found"), "file", { ext: "html" }, null],
  ["too short", R("x=1"), "file", { ext: "py", minChars: 20 }, "too_short"],
  ["good code", R("def add(a, b):\n    return a + b\n"), "file", { ext: "py" }, null],
  ["good prose", R("The answer is 4."), "text", {}, null],
  ["tool call only is fine", R("", "", [{ name: "finish", args: {} }]), "text", {}, null],
  ["cut off prose", R("The answer is", "length"), "text", {}, "cut_off"],
  ["stop finish ok", R("fine", "stop"), "file", { ext: "py" }, null],
];
for (const [name, rep, kind, opts, want] of table) {
  const v = judgeReply(rep, kind, opts);
  ok(want ? (!v.ok && v.reason === want && v.retry === true) : v.ok === true, `${name}: got ${JSON.stringify(v)}`);
}
// gate modes
process.env.ETA_GATE = "warn";
ok(gateMode() === "warn", "warn mode"); ok(actOn(judgeReply(R("", "length"), "text")).ok === true, "warn never blocks");
process.env.ETA_GATE = "enforce";
ok(actOn(judgeReply(R("", "length"), "text")).ok === false, "enforce blocks");
process.env.ETA_GATE = "bogus"; ok(gateMode() === "enforce", "bogus falls back to enforce");
delete process.env.ETA_GATE;
let logged = ""; actOn(judgeReply(R("", "length"), "text"), (s) => { logged = s; }); ok(/cut_off/.test(logged), "gate logs the reason");

// endings: only finished/verified mean done; unknown means not done
for (const k of Object.keys(ENDINGS)) ok(endingDone(k) === (k === "finished" || k === "verified"), `ending ${k}`);
ok(normEnding("zzz") === "unknown" && !endingDone("zzz"), "unknown ending is not done");
for (const k of ["loop", "invalid_actions", "model_failed", "step_limit", "timeout", "cancelled", "cut_off"]) ok(!endingDone(k), `${k} not done`);

// cut helper always says how much was cut
ok(cutText("abc", 10) === "abc", "no cut when short");
ok(/showing 5 of 12 characters/.test(cutText("x".repeat(12), 5)), "cut is announced");

// source guards: the engine really uses the gate and sets every named ending
const src = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
for (const e of ["model_failed", "invalid_actions", "step_limit", "timeout", "cancelled", "cut_off", '"loop"']) ok(src.includes(`_stepExit = ${e.startsWith('"') ? e : `"${e}"`}`) || src.includes(`_stepExit = res.finish === "length" ? "cut_off" : "invalid_actions"`), `agent sets ending ${e}`);
ok(/from "\.\/replygate\.mjs"/.test(src), "agent imports replygate");
ok(/finish: finish \|\| ""/.test(src), "Eta.chat returns finish");
ok(/this\.lastAsk = \{ ok: false/.test(src), "ask() remembers a failure");

ok(/if \(!this\.wm\) return msgs;/.test(src), "maybeCompact never writes [memory] undefined");
ok(/if \(step === maxSteps\) emit/.test(src), "step limit message uses the local limit");
ok(/_ex = "verified"/.test(src) && /_writeTick/.test(src), "step_limit/invalid_actions count as done only with proof");
ok(!/actOn\(judgeReply\(\{ content, finish: fin \}/.test(src), "_writeFile checks are enforced in every gate mode");
console.log(`replygate: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

// facts: measured, fresh, with a fake runner (no real python needed)
{
  const { measureFacts, factsLine, factsWarnings } = await import("./facts.mjs");
  const none = await measureFacts({ numCtx: 4096, autoApprove: true, run: () => null });
  const full = await measureFacts({ numCtx: 8192, run: (a) => (a[0] === "--version" ? "Python 3.12.1" : "1") });
  const nopt = await measureFacts({ run: (a) => (a[0] === "--version" ? "Python 3.11.0" : null) });
  const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
  t(!none.python && !none.pytest && none.personPresent === false, "no python is measured, not assumed");
  t(full.python && full.pytest && full.pythonVersion === "3.12.1" && full.personPresent === true, "full facts");
  t(nopt.python && !nopt.pytest, "python without pytest");
  t(factsWarnings(none, "write a python script").length === 1, "warn: python missing for a python task");
  t(factsWarnings(none, "make a web page").length === 0, "no warning for a non-python task");
  t(/NOT FOUND/.test(factsLine(none)) && /pytest yes/.test(factsLine(full)), "facts line");
  t(/await measureFacts\(/.test(src) && /_pytestOk = this\.facts\.pytest/.test(src), "run() measures facts and refreshes the pytest check");
  console.log(`replygate+facts: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

// ratchet: no NEW silent cut. Use cutText(s, n) from replygate.mjs (it says "showing X of Y"). Lower this number as cuts move.
{
  const n = (src.match(/\.slice\(0, *\d+\)/g) || []).length;
  const BASELINE = 204; // 204: +1 is a regex window in contractSaysNoChange (never goes to the model)
  if (n > BASELINE) { fail++; console.log(`FAIL: ${n} silent .slice(0,N) cuts in agent.mjs, baseline ${BASELINE}. Use cutText() for text that goes to the model.`); } else pass++;
  console.log(`silent cuts: ${n} (baseline ${BASELINE})`);
  process.exitCode = fail ? 1 : 0;
}

// live-caught 2026-11-15 (task 04): the inspector said cart.py lacked bulk_discount/round/tax (a neighbour file defines them; round is a builtin)
{
  const { definitionScope, missingNamedTargets, dropBuiltinNames } = await import("./agent.mjs");
  const fs = await import("node:fs"); const os = await import("node:os"); const pth = await import("node:path");
  const d = fs.mkdtempSync(pth.join(os.tmpdir(), "eta-scope-"));
  fs.mkdirSync(pth.join(d, "shop")); fs.mkdirSync(pth.join(d, "tests"));
  fs.writeFileSync(pth.join(d, "shop", "pricing.py"), "def bulk_discount(s, u):\n    return 0\n\ndef tax(a):\n    return a\n");
  fs.writeFileSync(pth.join(d, "shop", "cart.py"), "from . import pricing\n\nclass Cart:\n    def total(self):\n        return pricing.tax(1)\n");
  fs.writeFileSync(pth.join(d, "shop", "test_x.py"), "def other(): pass\n");
  const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
  const scope = await definitionScope(d, ["shop/cart.py"]);
  t(scope.includes("shop/pricing.py") && !scope.includes("shop/test_x.py"), "scope = named files + neighbour source files, not test files: " + scope);
  t((await missingNamedTargets(d, ["shop/cart.py"], ["bulk_discount", "tax"])).length === 2, "old check (cart.py alone) gave the false alarm");
  t((await missingNamedTargets(d, scope, ["bulk_discount", "tax"])).length === 0, "with the neighbour files in scope there is no false alarm");
  t((await missingNamedTargets(d, scope, ["really_missing"])).join() === "really_missing", "a name defined nowhere is still reported");
  t(dropBuiltinNames(["round", "sum", "len", "units"]).join() === "units", "builtins are never required");
  t(/definitionScope\(this\.root, \[file,/.test(src) && /definitionScope\(this\.root, \[\.\.\.this\.files/.test(src), "inspector and final contract check both use the scope");
  fs.rmSync(d, { recursive: true, force: true });
  console.log(`scope: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

// live-caught 2026-11-15 (task 04, second run): wrong test runner named; multi-file path lost the "add a test" step
{
  const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
  t(/TEST COMMAND ON THIS PC: pytest is installed/.test(src) && /pytest is NOT installed/.test(src), "executor prompt names the measured test runner");
  t(/const baseSystem = EXEC_SYS \+ testBlock/.test(src), "test runner line is part of every step's system prompt");
  t(/_addRequestedTest\(task, ctx, emit, baseSystem, msgs\)/.test(src), "multi-file path runs the add-a-test step");
  console.log(`runner+addtest: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}
