// VERIFIED REFERENCE PATTERNS — "show, don't tell".
//
// Why this exists (measured, not theoretical): on the infix-calculator task the 16B was given
// the failing case, the exception, the culprit line and a debugger analysis — and across TWO
// runs / ~35 minutes it NEVER implemented unary minus. It already knew it was wrong. Telling it
// again doesn't help: it doesn't know HOW.
//
// The research says the fix for a FROZEN small model is in-context reference code:
//   • arXiv 2601.00509 — retrieval of working examples + tool feedback, no fine-tuning:
//     DeepSeek-Coder-1.3B vulns −96%; CodeLlama-7B critical defects 58.55% → 22.19%.
//   • Voyager (arXiv 2305.16291) — a library of VERIFIED code retrieved as building blocks;
//     "learns in-context, not by changing model weights". That is the whole point here: the
//     user never has to swap models.
//
// HARD RULE — a reference must be PROVABLY correct or it must not exist:
//   1. Every pattern carries `selftest` cases that are EXECUTED by the test suite
//      (test-patterns.mjs). A wrong reference fails CI and cannot ship.
//   2. We never inject code scraped from the web as a reference. Untrusted code is exactly the
//      "incorrect reference" failure mode.
//   3. Learned skills are only added after the execution test gate is GREEN — verified by
//      running them, never by the model claiming success.
import * as path from "path";
import * as os from "os";

export const PATTERNS = [
  {
    id: "expression-parser",
    lang: "python",
    // matched against the task + the failure text
    match: /\b(infix|expression|evaluat\w*|calculator|precedence|shunting|unary|tokeni[sz]\w*|parser|parenthes[ei]s)\b/i,
    title: "Infix expression evaluator (precedence, parentheses, unary minus)",
    // what the model keeps getting wrong, stated plainly
    note: "Recursive descent. Unary minus is handled in factor() by recursing (-factor()), which is the part naive Shunting-Yard tokenisers miss: they treat '-' as binary only, so '2 * -(3+1)' explodes.",
    code: `def evaluate(expr: str) -> float:
    """Evaluate an infix arithmetic expression.
    Supports + - * / , parentheses, unary +/-, decimals and spaces.
    Raises ValueError on malformed input or division by zero."""
    s = "".join(str(expr).split())          # strip ALL whitespace
    if not s:
        raise ValueError("empty expression")
    i = 0

    def peek():
        return s[i] if i < len(s) else ""

    def number():
        nonlocal i
        start = i
        while i < len(s) and (s[i].isdigit() or s[i] == "."):
            i += 1
        text = s[start:i]
        if not text or text.count(".") > 1:
            raise ValueError("bad number: %r" % text)
        return float(text)

    def factor():                            # unary +/- , parentheses, number
        nonlocal i
        c = peek()
        if c == "-":                         # UNARY MINUS — recurse, so -(3+1) and --3 work
            i += 1
            return -factor()
        if c == "+":                         # unary plus
            i += 1
            return factor()
        if c == "(":
            i += 1
            v = expression()
            if peek() != ")":
                raise ValueError("unbalanced parentheses")
            i += 1
            return v
        if c.isdigit() or c == ".":
            return number()
        raise ValueError("unexpected %r" % c if c else "unexpected end of input")

    def term():                              # * /
        nonlocal i
        v = factor()
        while peek() in ("*", "/"):          # tuple, NOT "*/" — "" in "*/" is True in Python
            op = s[i]
            i += 1
            r = factor()
            if op == "*":
                v = v * r
            else:
                if r == 0:
                    raise ValueError("division by zero")
                v = v / r
        return v

    def expression():                        # + -
        nonlocal i
        v = term()
        while peek() in ("+", "-"):          # tuple, NOT "+-" — see term()
            op = s[i]
            i += 1
            r = term()
            v = v + r if op == "+" else v - r
        return v

    result = expression()
    if i != len(s):                          # trailing junk => malformed
        raise ValueError("unexpected trailing input: %r" % s[i:])
    return float(result)`,
    // EXECUTED in CI — these prove the reference is correct before it can ever be injected.
    selftest: {
      ok: [["1+2", 3], ["2+3*4", 14], ["(2+3)*4", 20], ["2*(3+(4-1))", 12], ["10/4", 2.5],
        ["2*3+4*5", 26], [" 7 - 2 * 3 ", 1], ["-3+5", 2], ["2*-(3+1)", -8],
        ["3.5+4.2*2/(1-5)", 1.4], ["--3", 3], ["2.5*4", 10]],
      raises: ["10/0", "", "   ", "2+", "((1+2)", "2**3", "abc", "1+*2"],
    },
  },
  {
    id: "dependency-scheduler",
    lang: "python",
    fn: "plan",            // the function the selftest calls
    compare: "equal",      // list output → exact equality, not numeric tolerance
    match: /\b(schedul\w*|topolog\w*|dependenc\w*|prerequisite\w*|\bdag\b|execution order|task order|kahn|cycle detect\w*|build order)\b/i,
    title: "Dependency scheduler / topological sort (alphabetical tie-break, cycle detection)",
    // the two things weak models get wrong here, stated plainly (measured live: the 16B shipped
    // both bugs — no tie-break sorting, and a cycle check that could never fire)
    note: "Kahn's algorithm with a MIN-HEAP on the name (so ready tasks come out in alphabetical order — a plain queue does NOT tie-break). Include tasks that appear ONLY as a prerequisite. Detect a cycle by len(order) != number of nodes (NOT by any in-degree going negative — that never happens), and name a stuck task in the error.",
    code: `import heapq

def plan(tasks: dict) -> list:
    """Return ONE valid execution order for a dependency graph.
    tasks maps a task name -> list of prerequisite names. Tasks that are ready
    at the same time are emitted in ALPHABETICAL order. Tasks that appear only
    as a prerequisite are included. Raises ValueError (naming a task in the
    cycle) if the dependencies contain a cycle. Empty dict -> empty list."""
    # 1) every node, including ones that only ever appear as a prerequisite
    nodes = set(tasks)
    for prereqs in tasks.values():
        nodes.update(prereqs)
    # 2) in-degree = how many prerequisites; succ = who is waiting on me
    indeg = {n: 0 for n in nodes}
    succ = {n: [] for n in nodes}
    for task in nodes:
        for pre in tasks.get(task, []):
            indeg[task] += 1
            succ[pre].append(task)
    # 3) MIN-HEAP on the name => alphabetical tie-breaking among ready tasks
    ready = [n for n in nodes if indeg[n] == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        n = heapq.heappop(ready)
        order.append(n)
        for m in succ[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                heapq.heappush(ready, m)
    # 4) fewer emitted than exist => the rest are trapped in a cycle
    if len(order) != len(nodes):
        stuck = sorted(n for n in nodes if indeg[n] > 0)
        raise ValueError("dependency cycle involving: " + ", ".join(stuck))
    return order`,
    // EXECUTED in CI — proves the reference is correct (and, notably, that the tie-break case a
    // weak test-author got WRONG live — expecting ['D','A','B','C'] — is really ['A','B','C','D']).
    selftest: {
      ok: [
        [{}, []],
        [{ A: [] }, ["A"]],
        [{ A: [], B: ["A"], C: ["B"] }, ["A", "B", "C"]],              // linear chain
        [{ A: [], B: ["A"], C: ["A"], D: ["B", "C"] }, ["A", "B", "C", "D"]], // diamond
        [{ A: [], B: ["A"], C: ["A"], D: [] }, ["A", "B", "C", "D"]],  // alphabetical tie-break
        [{ B: ["A"] }, ["A", "B"]],                                     // implicit task (A only a prereq)
        [{ C: ["A", "B"], A: [], B: [] }, ["A", "B", "C"]],            // two prereqs, alpha ready-set
        [{ X: ["Y"], Y: [] }, ["Y", "X"]],
      ],
      raises: [
        { A: ["B"], B: ["A"] },          // direct cycle
        { A: ["A"] },                     // self cycle
        { A: ["B"], B: ["C"], C: ["A"] }, // 3-node cycle
      ],
    },
  },
];

// Pick a verified reference for a task/failure. Returns null when nothing matches — we would
// rather give NO reference than a wrong one.
export function findPattern(text, lang = "python") {
  const s = String(text || "");
  if (!s.trim()) return null;
  return PATTERNS.find((p) => p.lang === lang && p.match.test(s)) || null;
}

// The block injected into the prompt. Framed as "adapt this", not "here is your answer" —
// the spec still rules, and the test gate still has the final say.
export function patternBlock(p) {
  if (!p) return "";
  return `\n\n📘 VERIFIED REFERENCE — ${p.title}\nThis implementation is known-correct (it is executed by our test suite). ${p.note}\nADAPT it to the task's spec — do not invent your own from scratch, and do not copy it blindly if the spec differs.\n\n\`\`\`${p.lang}\n${p.code}\n\`\`\``;
}
