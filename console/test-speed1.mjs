// Tests for SPEED1 (2026-11-17, benchmark b2): agent-side time waste. No model, no GPU, no internet.
// The executor checks drive the real Agent.execute loop with a scripted fake model (no model server is started).
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import * as A from "./agent.mjs";
let pass = 0, fail = 0;
const check = (name, ok) => { if (ok) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name); } };

// #2 run-only plan steps
check("a step that only runs the tests is dropped", JSON.stringify(A.dropRunOnlySteps(["Implement verse()", "Run the tests", "Fix the failing cases"])) === JSON.stringify(["Implement verse()", "Fix the failing cases"]));
check("'verify all tests pass' is dropped, 'make sure' is not an edit", A.dropRunOnlySteps(["Write song.js", "Make sure all tests pass"]).length === 1);
check("'run the tests and fix failures' is kept", A.dropRunOnlySteps(["Write a.js", "Run the tests and fix any failures"]).length === 2);
check("a plan of only run steps is never emptied", A.dropRunOnlySteps(["Run the tests"]).length === 1 && A.dropRunOnlySteps(["Run tests", "Verify tests"]).length === 2);
check("bad input is returned as is", A.dropRunOnlySteps(null) === null);

// #5 exercise step cap
const EX = "Implement the exercise described below. Edit this file: dot_dsl.py (it contains only a starting stub). The test file dot_dsl_test.py is already in this folder: do NOT change it.";
const seven = ["Create Node", "Create Edge", "Create Graph", "Parse attrs", "Validate tuples", "Raise errors", "Handle empty"];
const capped = A.capExerciseSteps(seven, EX);
check("exercise task is recognised", A.isExerciseTask(EX) && !A.isExerciseTask("Build a todo app with a REST api"));
check("7 exercise steps become 3", capped.length === 3);
check("no planned item is lost when merging", seven.every((s) => capped.join(" ").includes(s)));
check("a normal task keeps its steps", A.capExerciseSteps(seven, "Build a dashboard app").length === 7);
check("3 steps or fewer stay as they are", A.capExerciseSteps(["a", "b"], EX).length === 2);

// #3 test runner redirect
check("runner groups", A.testRunnerGroup("node --test") === "node-test" && A.testRunnerGroup("npm test --silent") === "js" && A.testRunnerGroup("npx jest x.spec.js") === "js" && A.testRunnerGroup("python -m pytest -q") === "pytest" && A.testRunnerGroup('python -m unittest discover -p "*_test.py"') === "unittest");
check("non-runner commands are not runners", A.testRunnerGroup("cat jest.config.js") === null && A.testRunnerGroup("node app.js") === null && A.testRunnerGroup("python -c \"print(1)\"") === null);
check("node --test on a jest project is redirected", A.redirectTestCmd("node --test", "npm test --silent") === "npm test --silent");
check("--testPathPattern is redirected", A.redirectTestCmd("npm test -- --testPathPattern=beer", "npm test --silent") === "npm test --silent");
check("npx jest on one file is allowed", A.redirectTestCmd("npx jest beer-song.spec.js", "npm test --silent") === null);
check("pytest on a unittest project is allowed", A.redirectTestCmd("python -m pytest -q", 'python -m unittest discover -p "*_test.py"') === null);
check("unittest on a pytest project is redirected", A.redirectTestCmd("python -m unittest x_test", "python -m pytest -q") === "python -m pytest -q");
check("no detected command = no redirect", A.redirectTestCmd("node --test", "") === null && A.redirectTestCmd("ls", "npm test") === null);

// #6 deadline
check("budget is cut to fit a 15-minute limit", A.capBudgetToDeadline(12 * 60000, 1000, 1000 + 15 * 60000) === 15 * 60000 - 45000 - 150000);
check("a budget that already fits is kept", A.capBudgetToDeadline(5 * 60000, 1000, 1000 + 15 * 60000) === 5 * 60000);
check("no deadline = budget unchanged", A.capBudgetToDeadline(720000, 1000, 0) === 720000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "speed1-"));
{
  const ag = new A.Agent(tmp, { deadlineAt: Date.now() + 20000 });
  ag.startTime = Date.now(); ag.timeBudgetMs = 10 * 60000;
  check("over budget once inside the wrap-up time of the outer limit", ag.overBudget() === true);
  ag._deadlineAt = Date.now() + 10 * 60000;
  check("not over budget with time left", !ag.overBudget());
  ag.enterRepairPhase(() => {});
  ag._deadlineAt = Date.now() + 60000; ag._repairUntil = 0; ag.enterRepairPhase(null);
  check("repair window never runs past the outer limit", ag._repairUntil <= ag._deadlineAt - A.SPEED1_WRAP_MS);
  check("the repair window cannot outlive the outer limit", (ag._repairUntil = Date.now() + 999999, ag._deadlineAt = Date.now() + 1000, ag.overBudget()) === true);
  const ag2 = new A.Agent(tmp, {});
  check("no deadline given = old behaviour", ag2._deadlineAt === 0);
}

// #1 batched read_file is not "missing"
{
  const ag = new A.Agent(tmp, {});
  check("read_file with a list of paths is not missing", !ag.missing("read_file", { path: ["a.js", "b.js"] }));
  check("read_file with an empty list is missing", ag.missing("read_file", { path: [] }));
  check("edit_file with a list is still missing", ag.missing("edit_file", { path: ["a.js"] }) || !A.TOOL_MAP?.edit_file);
}

// #7 stale test failures
{
  const ag = new A.Agent(tmp, {});
  ag.failedCmds = new Map([["python -m pytest -q", true], ["node build.js", true]]);
  ag.cmdLog = [{ command: "python -m pytest -q", result: "COMMAND FAILED (exit 1)" }, { command: 'python -m unittest discover -p "*_test.py"', result: "OK" }];
  ag._dropStaleTestFailures('python -m unittest discover -p "*_test.py"');
  check("other runner's failure is dropped after a green detected run", !ag.failedCmds.has("python -m pytest -q"));
  check("a non-test command failure is kept", ag.failedCmds.has("node build.js"));
  ag.failedCmds = new Map([["python -m pytest -q", true]]);
  ag.cmdLog = [{ command: 'python -m unittest discover -p "*_test.py"', result: "COMMAND FAILED (exit 1)" }];
  ag._dropStaleTestFailures('python -m unittest discover -p "*_test.py"');
  check("with a red detected run and no debt of its own, the other failure is kept", ag.failedCmds.has("python -m pytest -q"));
  ag.failedCmds = new Map([["python -m pytest -q", true]]); ag.cmdLog = [];
  ag._dropStaleTestFailures("npm test");
  check("no run of the detected command = nothing changes", ag.failedCmds.size === 1);
}

// executor loop with a scripted fake model: repeat test run, wrong runner, repeat read
async function drive(actions, setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speed1x-"));
  fs.writeFileSync(path.join(dir, "spec.txt"), "line one\nline two\n");
  fs.writeFileSync(path.join(dir, "count.txt"), "");
  const ag = new A.Agent(dir, {});
  ag.startTime = Date.now(); ag.timeBudgetMs = 10 * 60000;
  let i = 0;
  ag.eta = { numCtx: 8192, chat: async () => ({ content: JSON.stringify(actions[Math.min(i++, actions.length - 1)]) }), ask: async () => "" };
  ag.memory = { maybeCompact: async (m) => m, microCompact: (m) => ({ msgs: m }) };
  ag.critic = async () => null; ag.runHooks = async () => ({ blocked: false }); ag.importSmokeTest = async () => "";
  ag.snapshotGreen = async () => {}; ag.traceExecution = async () => ""; ag.mcpNames ||= new Set();
  if (setup) setup(ag, dir);
  const logs = [], results = [];
  const emit = (e) => { if (e.type === "log") logs.push(e.text); if (e.type === "toolResult") results.push(e); };
  const ctx = { root: dir, log: () => {}, approve: async () => true, files: ag.files };
  let msgs = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
  try { msgs = await ag.execute(msgs, emit, ctx, { maxSteps: actions.length }); } catch (e) { logs.push("CRASH " + (e?.stack || e)); }
  if (process.env.S1DBG) console.log(logs.join(String.fromCharCode(10)));
  return { ag, logs, results, msgs, dir };
}
const countCmd = `node -e "require('fs').appendFileSync('count.txt','x');process.exit(1)"`;
{
  // the detected command counts its own runs in a file that is NOT top-level-tracked: use a sub folder
  const r = await drive([{ tool: "run_tests", args: {} }, { tool: "run_tests", args: {} }, { tool: "finish", args: { summary: "x" } }], (ag, dir) => {
    fs.mkdirSync(path.join(dir, "o")); ag._detectedTestCmd = `node -e "require('fs').appendFileSync('o/n.txt','x');process.exit(1)"`;
  });
  const runs = (() => { try { return fs.readFileSync(path.join(r.dir, "o", "n.txt"), "utf8").length; } catch { return 0; } })();
  check("run_tests with no arguments runs the detected command", runs >= 1);
  check("the same test run with no change is not run twice", runs === 1 && r.logs.some((l) => /not re-run/.test(l)));
  check("the model is told nothing changed", r.msgs.some((m) => /NOTHING CHANGED/.test(m.content || "")));
  check("no crash in the executor", !r.logs.some((l) => /^CRASH/.test(l)));
}
{
  // a write in between makes the test run again
  const r = await drive([{ tool: "run_tests", args: {} }, { tool: "write_file", args: { path: "o/a.js", content: "x" } }, { tool: "run_tests", args: {} }, { tool: "finish", args: { summary: "x" } }], (ag, dir) => {
    fs.mkdirSync(path.join(dir, "o")); ag._detectedTestCmd = `node -e "require('fs').appendFileSync('o/n.txt','x');process.exit(1)"`;
    ag.writeFile = async (args) => { fs.writeFileSync(path.join(dir, args.path), "x" + Date.now()); ag.files.add(args.path); ag._writeTick = (ag._writeTick || 0) + 1; return "Wrote " + args.path; };
  });
  const runs = (() => { try { return fs.readFileSync(path.join(r.dir, "o", "n.txt"), "utf8").length; } catch { return 0; } })();
  check("after a file write the tests run again", runs === 2);
}
{
  const r = await drive([{ tool: "run_command", args: { command: "node --test" } }, { tool: "finish", args: { summary: "x" } }], (ag, dir) => { fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node -e \"console.log('detected ran')\"" } })); ag._detectedTestCmd = "npm test --silent"; });
  check("another test runner is redirected to the detected command", r.logs.some((l) => /test runner: ran/.test(l)) && r.msgs.some((m) => /detected ran/.test(m.content || "")));
}
{
  const r = await drive([{ tool: "read_file", args: { path: "spec.txt" } }, { tool: "list_dir", args: { path: "." } }, { tool: "read_file", args: { path: "spec.txt" } }, { tool: "finish", args: { summary: "x" } }]);
  const copies = r.msgs.filter((m) => /line two/.test(m.content || "")).length;
  check("a second read of an unchanged file adds no second copy", copies === 1 && r.msgs.some((m) => /has not changed since you read it/.test(m.content || "")));
}
{
  const r = await drive([{ tool: "read_file", args: { path: ["spec.txt", "count.txt"] } }, { tool: "finish", args: { summary: "x" } }]);
  check("a batched read makes no argument-recovery model call", !r.logs.some((l) => /recovering read_file arguments/.test(l)));
}
{
  // #4: two failed edits -> one targeted retry with the failing-test text, then no whole rewrite of a medium file
  const hints = []; let rewrites = 0;
  const ed = (n) => ({ tool: "edit_file", args: { path: "m.js", note: "try " + n } });
  const r = await drive([ed(1), ed(2), ed(3), ed(4), { tool: "finish", args: { summary: "x" } }], (ag, dir) => {
    fs.writeFileSync(path.join(dir, "m.js"), ("// x" + String.fromCharCode(10)).repeat(800));
    ag._lastExecFailOut = ["COMMAND FAILED (exit 1)", "  ● verse › first", "    Expected: \"99 bottles\"", "    Received: undefined", ""].join(String.fromCharCode(10));
    ag.editFile = async (args, m, e, c, hint) => { hints.push(hint || ""); return "Edit failed: SEARCH text not found"; };
    ag.writeFile = async () => { rewrites++; return "Wrote m.js"; };
  });
  check("third edit is a targeted retry that names the failed attempts", hints.length >= 3 && /did not apply/.test(hints[2]) && !/did not apply/.test(hints[0]));
  check("a medium file is not rewritten whole after failed edits", rewrites === 0 && r.logs.some((l) => /no full rewrite for a file this size/.test(l)));
}
{
  let rewrites = 0; const ed = (n) => ({ tool: "edit_file", args: { path: "s.js", note: "try " + n } });
  await drive([ed(1), ed(2), ed(3), ed(4), { tool: "finish", args: { summary: "x" } }], (ag, dir) => {
    fs.writeFileSync(path.join(dir, "s.js"), "let a = 1;" + String.fromCharCode(10));
    ag.editFile = async () => "Edit failed: SEARCH text not found";
    ag.writeFile = async () => { rewrites++; return "Wrote s.js"; };
  });
  check("a small file may still be rewritten when edits keep failing", rewrites >= 1);
}
void countCmd;
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exitCode = fail ? 1 : 0;
