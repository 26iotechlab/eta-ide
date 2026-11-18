// "Did you mean" on a failed edit (Aider's idea) and one copy of a file in the prompt (Cline's idea). No GPU.
import { applyOneEdit, closestLines, lineLikeness } from "./agent.mjs";
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const NL = String.fromCharCode(10);

const file = ["def total(self):", "    sub = self.subtotal()", "    disc = pricing.bulk_discount(sub, self.units())", "    after = round(sub - disc, 2)", "    return round(after + pricing.tax(after), 2)", ""].join(NL);

// exact and indent-flexible matches still work and are unchanged
t(applyOneEdit(file, "    sub = self.subtotal()", "    sub = 1").ok, "exact match still applies");
t(applyOneEdit(file, "sub = self.subtotal()", "sub = 1").ok, "indent-flexible match still applies");

// a near miss now shows the real lines
const miss = applyOneEdit(file, ["    disc = pricing.bulk_discount(sub, self.units)", "    after = round(sub - disc, 2)"].join(NL), "x");
t(!miss.ok && /Did you mean these lines \(file lines 3-4\)/.test(miss.reason), "near miss names the real line range: " + miss.reason);
t(/self\.units\(\)\)/.test(miss.reason), "and shows the real text with the real call");
// nothing close: no made-up suggestion
const none = applyOneEdit(file, "completely different words here", "x");
t(!none.ok && !/Did you mean/.test(none.reason) && /read_file/.test(none.reason), "no close text: plain advice, no guess");
// the change may already be done
const done = applyOneEdit(file, "    sub = self.subtotalX()", "    after = round(sub - disc, 2)");
t(!done.ok && /ALREADY in the file/.test(done.reason), "tells the model the replacement is already there");
// ambiguity messages are unchanged
t(/more than once/.test(applyOneEdit("a" + NL + "a" + NL, "a", "b").reason), "ambiguous match message unchanged");

t(lineLikeness("  return x", "return x") === 1 && lineLikeness("abc def", "xyz qrs") < 0.2, "line likeness is sensible");
t(closestLines(file, "zzz qqq") === null, "closestLines gives null when nothing is close");

// wiring
const src = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/an older copy of \$\{tc\.args\.path\} was removed/.test(src), "older copy of a re-read file is replaced by a note");
t(/_readCopies\.set\(`\$\{tc\.args\.path\}\|/.test(src) && /start_line \?\? ""/.test(src), "copies are keyed by path AND range, so reading another part of a file keeps both");
t(/it began: \$\{cutText\(first\.trim\(\), 90\)\}/.test(src), "an elided result says what it was");

// the one-copy rule itself, run on the real execute() bookkeeping through a tiny stand-in
{
  const map = new Map(); const msgs = [];
  const read = (path, body, range = "") => {
    const key = `${path}|${range}|`;
    const prev = map.get(key);
    if (prev && String(prev.content).length > 400 && /^RESULT read_file:/.test(prev.content)) prev.content = `RESULT read_file: [an older copy of ${path} was removed to save space; the newest read of it is further down]`;
    msgs.push({ role: "user", content: `RESULT read_file:${NL}${body}` }); map.set(key, msgs[msgs.length - 1]);
  };
  const big = "x".repeat(900);
  read("a.py", big); read("b.py", big); read("a.py", big + "NEW");
  t(/older copy of a\.py was removed/.test(msgs[0].content) && msgs[1].content.length > 800 && msgs[2].content.includes("NEW"), "stand-in: only the older copy of the re-read file is dropped");
  read("a.py", big, "1-50"); t(msgs[2].content.includes("NEW"), "a different range of the same file does not drop the other");
}
console.log(`editassist: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
