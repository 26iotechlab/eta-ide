// Finding the right files from evidence, contract completeness, number of tests asked for. No GPU, no model.
import { vocabLocalize, symbolMap, contractNamedFiles, contractHedges, testsExpected, numberedItems, stem, splitIdent, isTestPath } from "./localize.mjs";
import { contractSaysNoChange, fileSectionOf } from "./agent.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let pass = 0, fail = 0;
const t = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
const NL = String.fromCharCode(10);

t(stem("fees") === stem("fee") && stem("borrowing") === stem("borrow") && stem("returned") === stem("return"), "stemmer joins word forms");
t(splitIdent("lateFee_days").join(",") === "late,fee,days", "identifiers are split into words");
t(isTestPath("tests/test_a.py") && isTestPath("test_a.py") && isTestPath("a_test.py") && !isTestPath("library/fines.py"), "test paths are recognised");

// a small project like reality task 09: the bug is in fines.py, which the wrong plan never opened
const d = fs.mkdtempSync(path.join(os.tmpdir(), "eta-power-"));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
w("lib/fines.py", '"""Late fees."""' + NL + "FEE_PER_DAY = 0.25" + NL + "def days_late(due, when):" + NL + "    return (when - due).days + 1" + NL + "def late_fee(due, when):" + NL + "    return days_late(due, when) * FEE_PER_DAY" + NL);
w("lib/models.py", '"""Data classes."""' + NL + "class Member:" + NL + "    max_loans = 3" + NL + "class Book:" + NL + "    title = 1" + NL);
w("lib/catalog.py", '"""The book catalog."""' + NL + "def search(q):" + NL + "    return []" + NL);
w("tests/test_x.py", "def test_late_fee():" + NL + "    pass" + NL);
const r = await vocabLocalize(d, "A reader returned a book 1 day after the due date and was charged 0.50. The fee is 0.25 per late day.");
t(r.length && r[0].file === "lib/fines.py", "the fee bug leads to fines.py: " + JSON.stringify(r));
t(!r.some((x) => /test_/.test(x.file)), "test files are never ranked");
t((await vocabLocalize(d, "zzz qqq www")).length === 0, "nothing matches: no guess");
t((await vocabLocalize(path.join(d, "nope"), "fee late")).length === 0, "a missing folder gives nothing");
const m = await symbolMap(d);
t(/lib\/fines\.py: Late fees\. \| FEE_PER_DAY, days_late, late_fee/.test(m) && !/test_x/.test(m), "project map lists names and the first doc line: " + m);

// the contract named a file that the plan did not list
const contract = ["**lib/fines.py**: Change days_late to return (when - due).days.", "**lib/catalog.py**: No changes needed; search is fine.", "**lib/ghost.py**: Add x.", "**tests/test_x.py**: Add tests."].join(NL);
const named = await contractNamedFiles(d, contract, contractSaysNoChange, fileSectionOf);
t(named.join() === "lib/fines.py", "only existing, changing, non-test files are named: " + named.join());

// guessing contracts
t(contractHedges("days_late was likely adding 1").length === 1, "'was likely' is a guess");
t(contractHedges("Change days_late to return (when - due).days").length === 0, "a plain fact is not a guess");
t(contractHedges("probably wrong; or using the wrong count").length >= 2, "several guess words are found");

// how many new tests does the task ask for
const t09 = "Two bug reports.\n1. Anna may borrow a 4th book.\n2. A late fee is wrong.\nPlease fix both bugs. Add a test for each bug in the tests folder, and keep the existing tests passing.";
t(testsExpected(t09) === 2, "a test for each of 2 bugs = 2 tests, got " + testsExpected(t09));
t(testsExpected("Fix the discount. Add a test for it.") === 1, "one test");
t(testsExpected("Fix the discount in cart.py.") === 0, "no test asked = 0");
t(testsExpected("Please add two tests for the parser.") === 2, "spelled number");
t(numberedItems(t09) === 2 && numberedItems("no list here") === 0, "numbered items are counted");

// wiring in the engine
const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
t(/await vocabLocalize\(this\.root, task/.test(src) && /let implFocus = named\.length/.test(src), "run() adds files found by the task's own words");
t(/contractNamedFiles\(this\.root, this\.contract, contractSaysNoChange, fileSectionOf\)/.test(src), "files named by the contract join the work list");
t(/contractHedges\(contract\)/.test(src) && /symbolMap\(this\.root\)/.test(src), "the contract is asked again when it guesses, and sees the project map");
t(/testsExpected\(task\)/.test(src) && /asking for the rest/.test(src), "the add-test step asks until every wanted test exists");
t(/the contract gives it no job/.test(src) && /includes\(path\.basename\(f\)\)/.test(src), "a file the contract never mentions is left alone");
t(/rels = inferTestFiles\(task\)\.map/.test(src) && /\["tests", "test"\]/.test(src), "a guessed test name goes into the tests folder");
import { dropBuiltinNames } from "./agent.mjs";
t(dropBuiltinNames(["timedelta", "round", "bulk_discount", "Path"]).join() === "bulk_discount", "standard-library names are never 'missing definitions'");
fs.rmSync(d, { recursive: true, force: true });
console.log(`power: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
