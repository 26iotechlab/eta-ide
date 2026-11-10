// PROVES every bundled reference is correct by RUNNING it.
// The user's constraint: "it should not take the incorrect code for reference." A reference we
// merely *believe* is right is worth nothing — a wrong one is worse than none, because the model
// will faithfully copy the bug. So each pattern's selftest is executed here: if any reference is
// wrong, this suite fails and it cannot ship.
// Run: node test-patterns.mjs
import { PATTERNS, findPattern, patternBlock } from "./patterns.mjs";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

section("every reference is EXECUTED and proven correct");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eta-pat-"));
for (const p of PATTERNS) {
  if (p.lang !== "python") { console.log(`  SKIP  ${p.id} (${p.lang})`); continue; }
  const file = path.join(tmp, "ref.py");
  // build a harness that exercises the reference exactly as the selftest declares. JSON is a
  // valid subset of Python literals (dict/list/str/num), so JSON.stringify renders each case's
  // input + expected as Python the reference can be called with — strings, numbers, dicts, lists.
  const fn = p.fn || "evaluate";               // function name (calculator = evaluate)
  const equal = p.compare === "equal";          // list/exact output vs numeric tolerance
  const cases = p.selftest.ok.map(([e, x]) => `    _chk(${JSON.stringify(e)}, ${JSON.stringify(x)})`).join("\n");
  const raises = (p.selftest.raises || []).map((e) => `    _raises(${JSON.stringify(e)})`).join("\n");
  const cmp = equal
    ? `    if got != want:\n        _fails.append("%r -> %r (wanted %r)" % (arg, got, want))`
    : `    if abs(got - want) > 1e-9:\n        _fails.append("%r -> %r (wanted %r)" % (arg, got, want))`;
  const harness = `${p.code}

_fails = []
def _chk(arg, want):
    try:
        got = ${fn}(arg)
    except Exception as ex:
        _fails.append("%r -> raised %s (wanted %r)" % (arg, ex, want)); return
${cmp}
def _raises(arg):
    try:
        got = ${fn}(arg)
        _fails.append("%r -> %r (wanted ValueError)" % (arg, got))
    except ValueError:
        pass
    except Exception as ex:
        _fails.append("%r -> %s (wanted ValueError)" % (arg, type(ex).__name__))

if True:
${cases || "    pass"}
${raises || "    pass"}

print("FAILS:" + "|".join(_fails) if _fails else "ALLPASS")`;
  fs.writeFileSync(file, harness);
  let out = "";
  try { out = execFileSync("python", [file], { encoding: "utf8", timeout: 30000 }).trim(); }
  catch (e) { out = "CRASH: " + ((e.stdout || "") + (e.stderr || "")).slice(-300); }
  const n = p.selftest.ok.length + (p.selftest.raises || []).length;
  check(`${p.id}: all ${n} selftest cases pass (reference is CORRECT)`, out === "ALLPASS", out.slice(0, 300));
}

section("the unary-minus case the 16B never solved");
const ep = PATTERNS.find((p) => p.id === "expression-parser");
check("reference covers 2*-(3+1) = -8", ep.selftest.ok.some(([e, x]) => e === "2*-(3+1)" && x === -8));
check("reference covers -3+5 = 2", ep.selftest.ok.some(([e]) => e === "-3+5"));
check("reference rejects division by zero", (ep.selftest.raises || []).includes("10/0"));
check("reference rejects malformed input", (ep.selftest.raises || []).includes("2+"));
check("reference actually implements unary minus (recurses in factor)", /-factor\(\)/.test(ep.code));

section("the graph bugs the 16B shipped live (cycle detection + tie-break)");
const sp = PATTERNS.find((p) => p.id === "dependency-scheduler");
check("scheduler reference covers the tie-break case (correct answer, not the model's wrong one)",
  sp.selftest.ok.some(([i, o]) => JSON.stringify(i) === JSON.stringify({ A: [], B: ["A"], C: ["A"], D: [] }) && JSON.stringify(o) === JSON.stringify(["A", "B", "C", "D"])));
check("scheduler reference raises on a direct cycle a<->b", (sp.selftest.raises || []).some((r) => JSON.stringify(r) === JSON.stringify({ A: ["B"], B: ["A"] })));
check("scheduler reference raises on a self-cycle a->a", (sp.selftest.raises || []).some((r) => JSON.stringify(r) === JSON.stringify({ A: ["A"] })));
check("scheduler reference detects cycles by length, NOT by negative in-degree (the real bug)", /len\(order\) != len\(nodes\)/.test(sp.code) && !/in_degree < 0|indeg\[\w+\] < 0/.test(sp.code));
check("scheduler reference tie-breaks with a heap (alphabetical), not a plain queue", /heapq/.test(sp.code));
check("scheduler reference names a task in the cycle error", /ValueError\(.*cycle/i.test(sp.code) && /join\(stuck\)/.test(sp.code));

section("matching — a reference is only offered when relevant");
check("matches an infix-calculator failure", !!findPattern("evaluate an infix expression with precedence"));
check("matches on the word 'unary'", !!findPattern("unary minus is not handled"));
check("matches a dependency-scheduler task", findPattern("plan an execution order from task prerequisites")?.id === "dependency-scheduler");
check("matches on 'topological'/'cycle detection'", findPattern("topological sort with cycle detection")?.id === "dependency-scheduler");
check("scheduler task does NOT mis-route to the calculator pattern", findPattern("schedule tasks by dependency with prerequisites")?.id !== "expression-parser");
check("calculator task does NOT mis-route to the scheduler pattern", findPattern("evaluate an infix arithmetic expression")?.id === "expression-parser");
check("no match -> null (we give NO reference rather than a wrong one)", findPattern("write a REST endpoint for user signup") === null);
check("no match for a different language", findPattern("infix expression parser", "javascript") === null);

section("injected block");
const b = patternBlock(ep);
check("block carries the code", /def evaluate/.test(b));
check("block says ADAPT, not copy blindly", /ADAPT it/.test(b) && /do not copy it blindly/.test(b));
check("block states it is verified", /known-correct/.test(b));
check("patternBlock(null) -> empty", patternBlock(null) === "");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
for (const f of failures) console.log("  ✗ " + f);
process.exit(fail ? 1 : 0);
