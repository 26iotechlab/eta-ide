// B3 (2026-11-13): go back to any step of a run, not only to its start.
// After each write_file / edit_file the engine takes a checkpoint: a snapshot in the private store (snapshot.mjs), kept in run.checkpoints.
// Two checkpoints with the same files are not stored twice. Rewinding restores the files of a checkpoint (new files made later are removed,
// the same rule as "Revert this run"). Before a rewind the current state is saved as a checkpoint too, so a rewind can be undone.
// Not for isolated runs (they have their own branch). Needs git; without it there are simply no checkpoints.
import { gitSnapshot, snapshotTree, revertRun } from "./snapshot.mjs";

export const MAX_CHECKPOINTS = 80;
const startsEta = (s) => String(s || "").startsWith("eta:");
const rootOf = (run) => run.root || run.workspace;

// Takes a checkpoint now. Returns the new checkpoint, or null (nothing changed, not possible, or git failed).
export async function takeCheckpoint(run, info = {}, deps = {}) {
  const snapFn = deps.snapshot || gitSnapshot, treeFn = deps.tree || snapshotTree;
  if (!run || run.isolated || run.wtPath || !startsEta(run.snapshot)) return null;
  const ws = rootOf(run); run.checkpoints ||= [];
  const snap = await snapFn(ws); if (!snap) return null;
  const tree = await treeFn(ws, snap);
  const last = run.checkpoints[run.checkpoints.length - 1];
  if (tree) { // the same files as an earlier step (or as the start of the run): no new step, name the old one (`info.sameAs`)
    const same = run.checkpoints.find((c) => c.tree === tree);
    if (same) { info.sameAs = same.n; return null; }
    if (tree === await treeFn(ws, run.snapshot)) { info.sameAs = 0; return null; }
  }
  const cp = { n: (last?.n || 0) + 1, snap, tree: tree || "", ts: Date.now(), tool: String(info.tool || "").slice(0, 40), file: String(info.file || "").slice(0, 200), label: String(info.label || "").slice(0, 120) };
  run.checkpoints.push(cp);
  if (run.checkpoints.length > MAX_CHECKPOINTS) run.checkpoints.splice(0, run.checkpoints.length - MAX_CHECKPOINTS);
  return cp;
}

// What the panel shows: step 0 is the start of the run.
export function listCheckpoints(run) {
  if (!run) return { ok: false, error: "No such run." };
  const cps = Array.isArray(run.checkpoints) ? run.checkpoints : [];
  return { ok: true, canRewind: !run.isolated && !run.wtPath && startsEta(run.snapshot) && run.status !== "running",
    steps: [{ n: 0, tool: "", file: "", label: "Start of the run", ts: run.started || 0 }, ...cps.map((c) => ({ n: c.n, tool: c.tool, file: c.file, label: c.label, ts: c.ts }))] };
}

// Rewinds the files to checkpoint n (0 = start of the run).
export async function rewindRun(run, n, deps = {}) {
  const revert = deps.revert || revertRun;
  if (!run) return { ok: false, error: "No such run." };
  if (run.status === "running") return { ok: false, error: "The run is still working. Stop it first." };
  if (run.isolated || run.wtPath) return { ok: false, error: "This run worked on its own branch. Use merge or discard." };
  if (!startsEta(run.snapshot)) return { ok: false, error: "This run has no undo point." };
  if (!Number.isInteger(n) || n < 0) return { ok: false, error: "Choose a step." };
  const target = n === 0 ? { n: 0, snap: run.snapshot, ts: run.started || Date.now() } : (run.checkpoints || []).find((c) => c.n === n);
  if (!target) return { ok: false, error: "That step is not available any more." };
  // save the present state first, so that this rewind can be undone by going to the newest step again
  const info = { tool: "rewind", label: `Before going back to step ${n}` };
  const saved = await takeCheckpoint(run, info, deps);
  const r = await revert({ workspace: run.workspace, snapshot: target.snap, started: target.ts });
  return { ok: !!r.ok, detail: r.detail || "", to: n, saved: saved ? saved.n : (info.sameAs ?? null) };
}
