// Test: resume after a crash or stop (2026-11-14). Fake step runner, temp folder. NO model, NO GPU.
// Run: node test-resume.mjs
import fs from "fs"; import os from "os"; import path from "path";
import { Agent } from "./agent.mjs";
import { saveRunState, loadRunState, unfinishedSteps, clearRunState, acquireRunLock, releaseRunLock, continueRequest } from "./runstate.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-resume-"));
const steps = ["step A", "step B", "step C"];
const noopEmit = () => {};

// 1. pure state helpers
saveRunState(root, { task: "t", steps, done: [0], savedAt: "x" });
const s1 = loadRunState(root);
ok(s1 && s1.task === "t" && s1.steps.length === 3, "saved state loads back");
ok(JSON.stringify(unfinishedSteps(s1)) === "[1,2]", "unfinished steps are 1 and 2", unfinishedSteps(s1));
ok(loadRunState(fs.mkdtempSync(path.join(os.tmpdir(), "eta-empty-"))) === null, "no file gives null");
fs.mkdirSync(path.join(root, ".eta"), { recursive: true }); fs.writeFileSync(path.join(root, ".eta", "run.json"), "{broken");
ok(loadRunState(root) === null, "broken file gives null (no crash)");

// 2. stop in the middle, then continue: only the unfinished steps run
const ag = new Agent(root, {});
ag.task = "t2"; const calls = [];
ag.runOneStep = async (step, i) => { calls.push(i); if (i === 1) ag.stopped = true; return "r" + i; };
await ag.microExecute(steps, {}, noopEmit, "sys");
const afterStop = loadRunState(root);
ok(afterStop && JSON.stringify(afterStop.done) === "[0]", "stop pressed DURING step B: only A counts as done (B may be half done)", afterStop && afterStop.done);
ok(afterStop && unfinishedSteps(afterStop).length === 2, "state keeps two unfinished steps (B and C)");

const ag2 = new Agent(root, {}); ag2.task = "t2"; const calls2 = [];
ag2.runOneStep = async (step, i) => { calls2.push(i); return "r" + i; };
ag2._doneSteps = new Set(afterStop.done);
await ag2.microExecute(afterStop.steps, {}, noopEmit, "sys");
ok(JSON.stringify(calls2) === "[1,2]", "continue redoes B and runs C, never A", calls2);
ok(loadRunState(root) === null, "all done: saved state is cleared");

// 3. a fresh run with all steps succeeding leaves no state behind
const ag3 = new Agent(root, {}); ag3.task = "t3"; const calls3 = [];
ag3.runOneStep = async (step, i) => { calls3.push(i); return "ok"; };
await ag3.microExecute(["x", "y"], {}, noopEmit, "sys");
ok(JSON.stringify(calls3) === "[0,1]" && loadRunState(root) === null, "clean run runs all and leaves no state", calls3);

// 4. one run per folder: lock
ok(acquireRunLock(root) === true, "first run gets the lock");
ok(acquireRunLock(root) === true, "same process can re-take its own lock");
fs.writeFileSync(path.join(root, ".eta", "run.lock"), JSON.stringify({ pid: process.ppid, started: "x" }));
ok(acquireRunLock(root) === false, "a live other process holds the lock: refused");
fs.writeFileSync(path.join(root, ".eta", "run.lock"), JSON.stringify({ pid: 999999, started: "x" }));
ok(acquireRunLock(root) === true, "a dead process's lock is taken over");
releaseRunLock(root);
ok(!fs.existsSync(path.join(root, ".eta", "run.lock")), "release removes our lock");

// 5. the panel message "/continue"
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-cont-"));
ok(continueRequest(root2, "fix the bug").kind === "none", "a normal message is not a continue request");
ok(continueRequest(root2, "/continue now please").kind === "none", "'/continue' with extra words is not one either");
ok(continueRequest("", "/continue").kind === "none", "no folder open: not a continue request");
ok(continueRequest(root2, "/continue").kind === "nothing", "'/continue' with nothing saved says nothing to continue");
saveRunState(root2, { task: "big job", steps: ["a", "b", "c"], done: [0], savedAt: "x" });
const cr = continueRequest(root2, "  /Continue  ");
ok(cr.kind === "continue" && cr.left === 2 && cr.state.task === "big job", "'/continue' with a saved run: continue, 2 steps left", cr);
saveRunState(root2, { task: "big job", steps: ["a"], done: [0], savedAt: "x" });
ok(continueRequest(root2, "/continue").kind === "nothing", "all steps done: nothing to continue");
fs.rmSync(root2, { recursive: true, force: true });

// 6. review fixes (Opus review 2026-11-14)
// 6a. saving progress must never throw (a failed save must not stop a run)
const fileAsRoot = path.join(os.tmpdir(), "eta-not-a-folder-" + process.pid); fs.writeFileSync(fileAsRoot, "x");
let threw = false, saved = null; try { saved = saveRunState(fileAsRoot, { task: "t", steps: ["a"], done: [] }); } catch { threw = true; }
ok(!threw && saved === false, "saveRunState on a bad folder: no throw, returns false", { threw, saved });
// 6b. a lock that cannot be written must not refuse the run
ok(acquireRunLock(fileAsRoot) === true, "lock write fails: the run still goes on");
fs.rmSync(fileAsRoot, { force: true });
// 6c. a left-behind lock (old, even if its number is alive again) is taken over; a fresh one by a live process still refuses
const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "eta-lock-")); fs.mkdirSync(path.join(root3, ".eta"), { recursive: true });
const lockPath = path.join(root3, ".eta", "run.lock");
fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, started: new Date(Date.now() - 7 * 3600e3).toISOString() }));
ok(acquireRunLock(root3) === true, "a 7-hour-old lock is treated as left behind");
fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, started: new Date().toISOString() }));
ok(acquireRunLock(root3) === false, "a fresh lock held by a live other process still refuses");
// 6d. a refused run and an empty /continue must END the run with an error event (otherwise the panel shows "running" forever)
const agR = new Agent(root3, {}); const ev = [];
await agR.run("do something", (e) => ev.push(e), async () => true);
ok(ev.some((e) => e.type === "error" && /Another Eta run/.test(e.text)) && !ev.some((e) => e.type === "start"), "refused run ends with an error event", ev.map((e) => e.type));
fs.rmSync(lockPath, { force: true });
const ev2 = []; await agR.resumeRun((e) => ev2.push(e), async () => true);
ok(ev2.some((e) => e.type === "error" && /Nothing to continue/.test(e.text)), "/continue with nothing saved ends with an error event", ev2.map((e) => e.type));
fs.rmSync(root3, { recursive: true, force: true });

// 6. MULTI-FILE runs (decomposeMultiFile): progress per file, /continue skips finished files and keeps the saved contract.
{
  const rootM = fs.mkdtempSync(path.join(os.tmpdir(), "eta-resume-mf-"));
  const files = ["a.py", "b.py", "c.py"];
  const stub = (ag, calls, stopAt) => {
    ag._fileDepths = async (fs_) => Object.fromEntries(fs_.map((f, i) => [f, i])); // a < b < c: strictly one at a time
    ag._buildContract = async () => { ag.contract = "CONTRACT-" + ag.task; ag._contractCalls = (ag._contractCalls || 0) + 1; };
    ag._runOneFile = async (f) => { calls.push(f); if (f === stopAt) ag.stopped = true; return [f]; };
  };
  const m1 = new Agent(rootM, {}); m1.task = "mf"; const c1 = []; stub(m1, c1, "b.py");
  await m1.decomposeMultiFile("mf", {}, noopEmit, "sys", files);
  const st = loadRunState(rootM);
  ok(st && st.mode === "files" && JSON.stringify(st.files) === JSON.stringify(files), "multi-file run saves its files in order", st);
  ok(st && JSON.stringify(st.done) === "[0]", "stop DURING b.py: only a.py counts as done", st && st.done);
  ok(st && st.contract === "CONTRACT-mf", "the contract is saved with the progress", st && st.contract);
  ok(st && unfinishedSteps(st).length === 2 && continueRequest(rootM, "/continue").kind === "continue", "/continue sees 2 files left");

  // continue: a NEW agent whose own focus order differs. It must use the saved order and the saved contract, never ask for a new one.
  const m2 = new Agent(rootM, {}); m2.task = "mf"; const c2 = []; stub(m2, c2, null);
  m2._resumeFiles = st;
  await m2.decomposeMultiFile("mf", {}, noopEmit, "sys", ["c.py", "x.py", "a.py"]);
  ok(JSON.stringify(c2) === '["b.py","c.py"]', "continue edits b.py and c.py, never a.py again", c2);
  ok(m2.contract === "CONTRACT-mf" && !m2._contractCalls, "continue keeps the saved contract (no new one)", { contract: m2.contract, calls: m2._contractCalls });
  ok(loadRunState(rootM) === null, "all files done: saved state is cleared");
  ok(m2._resumeFiles === null, "resume info is used once");

  // a clean multi-file run leaves nothing behind
  const m3 = new Agent(rootM, {}); m3.task = "mf3"; const c3 = []; stub(m3, c3, null);
  await m3.decomposeMultiFile("mf3", {}, noopEmit, "sys", files);
  ok(JSON.stringify(c3) === JSON.stringify(files) && loadRunState(rootM) === null, "clean multi-file run edits all and leaves no state", c3);

  // a broken saved file (missing contract, bad done list) must not crash and must not skip anything wrongly
  const m4 = new Agent(rootM, {}); m4.task = "mf4"; const c4 = []; stub(m4, c4, null);
  m4._resumeFiles = { mode: "files", files, done: [7, -1, "x"], steps: [] };
  await m4.decomposeMultiFile("mf4", {}, noopEmit, "sys", files);
  ok(JSON.stringify(c4) === JSON.stringify(files) && m4._contractCalls === 1, "bad saved data: all files run, a contract is made", { c4, k: m4._contractCalls });
  fs.rmSync(rootM, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
