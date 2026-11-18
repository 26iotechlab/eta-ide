// Test: go back to any step of a run (B3, 2026-11-13). Uses REAL git in a temp folder. NO model, NO GPU, NO server.
// Run: node test-checkpoints.mjs
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import { execSync } from "child_process";
import { gitSnapshot, snapshotTree } from "./snapshot.mjs";
import { takeCheckpoint, listCheckpoints, rewindRun, MAX_CHECKPOINTS } from "./checkpoints.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
try { execSync("git --version", { stdio: "ignore" }); } catch { console.log("git is not installed: test skipped"); process.exit(0); }
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "eta-cp-"));
const F = (r) => path.join(ws, r), W = (r, t) => { fs.mkdirSync(path.dirname(F(r)), { recursive: true }); fs.writeFileSync(F(r), t); }, R = (r) => fs.existsSync(F(r)) ? fs.readFileSync(F(r), "utf8") : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

W("a.txt", "v0"); W("keep.txt", "keep");
const run = { id: "1", workspace: ws, started: Date.now(), status: "running", snapshot: await gitSnapshot(ws) };
ok(/^eta:[0-9a-f]{40}$/.test(run.snapshot), "the run has a start snapshot");
ok((await snapshotTree(ws, run.snapshot))?.length === 40, "a snapshot has a tree hash");
ok((await snapshotTree(ws, "eta:nothex")) === null && (await snapshotTree(ws, null)) === null && (await snapshotTree("", run.snapshot)) === null, "a bad snapshot or folder gives no tree");

ok((await takeCheckpoint(run, { tool: "write_file", file: "a.txt" })) === null, "nothing changed since the start: no checkpoint");
await sleep(30); W("a.txt", "v1"); const c1 = await takeCheckpoint(run, { tool: "edit_file", file: "a.txt" });
ok(c1?.n === 1 && c1.file === "a.txt" && c1.tool === "edit_file", "a change makes checkpoint 1", c1);
ok((await takeCheckpoint(run, { tool: "edit_file", file: "a.txt" })) === null, "the same files again: no new checkpoint");
await sleep(30); W("b.txt", "new file"); const c2 = await takeCheckpoint(run, { tool: "write_file", file: "b.txt" }); ok(c2?.n === 2, "a new file makes checkpoint 2", c2);
await sleep(30); W("a.txt", "v2"); const c3 = await takeCheckpoint(run, { tool: "edit_file", file: "a.txt" }); ok(c3?.n === 3, "checkpoint 3", c3);
let l = listCheckpoints(run); ok(l.ok && l.steps.length === 4 && l.steps[0].n === 0 && l.steps[0].label === "Start of the run" && l.steps[3].file === "a.txt", "the list has the start and 3 steps", l.steps.map((s) => s.n));
ok(l.canRewind === false, "a running run cannot be rewound yet");

// rewinding
run.status = "done";
ok(listCheckpoints(run).canRewind === true, "a finished run can be rewound");
let r = await rewindRun(run, 1);
ok(r.ok && R("a.txt") === "v1" && R("b.txt") === null && R("keep.txt") === "keep", "back to step 1: a.txt is v1, b.txt is gone, other files stay", { r, a: R("a.txt"), b: R("b.txt") });
ok(r.saved === 3 && run.checkpoints.length === 3, "the state before the rewind was already step 3, so no new step is made and step 3 is named", { saved: r.saved, n: run.checkpoints.length });
r = await rewindRun(run, 3);
ok(r.ok && r.saved === 1 && R("a.txt") === "v2" && R("b.txt") === "new file" && run.checkpoints.length === 3, "from step 1 forward to step 3: the files of step 1 are already stored, nothing new is added", { saved: r.saved, n: run.checkpoints.length });
await sleep(30); W("a.txt", "v-extra"); r = await rewindRun(run, 1);
ok(r.ok && r.saved === 4 && run.checkpoints.at(-1).label === "Before going back to step 1" && R("a.txt") === "v1", "an unsaved state is stored as a new step before the rewind", { saved: r.saved });
r = await rewindRun(run, 4); ok(r.ok && R("a.txt") === "v-extra" && R("b.txt") === "new file", "and that step brings the unsaved work back", { a: R("a.txt") });
r = await rewindRun(run, 2); ok(r.ok && R("a.txt") === "v1" && R("b.txt") === "new file", "step 2: new file is there, a.txt still v1", { a: R("a.txt"), b: R("b.txt") });
r = await rewindRun(run, 0); ok(r.ok && R("a.txt") === "v0" && R("b.txt") === null && R("keep.txt") === "keep", "step 0 is the start of the run", { a: R("a.txt"), b: R("b.txt") });
W("user-old.txt", "x"); fs.utimesSync(F("user-old.txt"), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
r = await rewindRun(run, 3); ok(r.ok && R("a.txt") === "v2", "forward to step 3 works too");

// refusals
ok((await rewindRun(run, 99)).error === "That step is not available any more.", "a missing step is refused");
ok((await rewindRun(run, -1)).ok === false && (await rewindRun(run, 1.5)).ok === false && (await rewindRun(run, "2")).ok === false && (await rewindRun(run, null)).ok === false, "a bad step number is refused");
ok((await rewindRun(null, 1)).ok === false, "no run is refused");
ok((await rewindRun({ ...run, status: "running" }, 1)).error === "The run is still working. Stop it first.", "a running run is refused");
ok((await rewindRun({ ...run, isolated: true }, 1)).ok === false && (await rewindRun({ ...run, wtPath: "x" }, 1)).ok === false, "an isolated run is refused");
ok((await rewindRun({ ...run, snapshot: "abc123" }, 1)).error === "This run has no undo point.", "an old-style snapshot is refused");
ok(listCheckpoints(null).ok === false && listCheckpoints({ status: "done" }).steps.length === 1, "list: no run -> error; no checkpoints -> only the start");
ok((await takeCheckpoint({ ...run, isolated: true }, {})) === null && (await takeCheckpoint({ status: "done" }, {})) === null && (await takeCheckpoint(null, {})) === null, "no checkpoints for isolated runs, runs without snapshot, or no run");
ok(R("a.txt") === "v2" && R("keep.txt") === "keep" && R("user-old.txt") === "x", "the refused calls changed nothing; an old user file is never removed");

// cap and fake git failure
{ const fake = { id: "9", workspace: ws, started: 1, status: "done", snapshot: "eta:" + "a".repeat(40), checkpoints: [] };
  let k = 0; const deps = { snapshot: async () => "eta:" + String(++k).padStart(40, "0"), tree: async (_w, s) => (s === fake.snapshot ? "T0" : "T" + s.slice(-5)) };
  for (let i = 0; i < MAX_CHECKPOINTS + 5; i++) await takeCheckpoint(fake, { tool: "write_file", file: "f" + i }, deps);
  ok(fake.checkpoints.length === MAX_CHECKPOINTS && fake.checkpoints[0].n === 6 && fake.checkpoints.at(-1).n === MAX_CHECKPOINTS + 5, "at most 80 steps are kept; the oldest are dropped", [fake.checkpoints.length, fake.checkpoints[0].n]);
  ok((await takeCheckpoint(fake, {}, { snapshot: async () => null, tree: async () => null })) === null, "git failing gives no checkpoint and no crash");
  const r2 = await rewindRun(fake, 1, deps); ok(r2.ok === false && /not available/.test(r2.error), "a dropped step is reported as not available"); }

fs.rmSync(ws, { recursive: true, force: true });
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
