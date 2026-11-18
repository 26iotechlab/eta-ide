// RESUME AFTER A CRASH (2026-11-14). Saves the plan and which steps are done, in <project>/.eta/run.json,
// so a run that stopped (crash, closed window, stop button) can continue from the next unfinished step.
// Also a lock file (.eta/run.lock) so two runs never write to the same folder at once.
// Known limit (v1): if the user edits project files by hand between runs, the saved plan is not re-checked.
import fs from "fs";
import path from "path";

const dir = (root) => path.join(root, ".eta");
const stateFile = (root) => path.join(dir(root), "run.json");
const lockFile = (root) => path.join(dir(root), "run.lock");

// Atomic write: write a temp file, then rename, so a crash mid-write never leaves half a file.
// Saving progress is an extra: it must NEVER stop a run (antivirus, OneDrive or a read-only folder can make it fail). Returns true if saved.
export function saveRunState(root, state) {
  try {
    fs.mkdirSync(dir(root), { recursive: true });
    const tmp = stateFile(root) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, stateFile(root));
    return true;
  } catch { return false; }
}

// Returns the saved state, or null if there is none or it cannot be read.
export function loadRunState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(root), "utf8"));
    if (!s || typeof s.task !== "string" || !Array.isArray(s.steps)) return null;
    s.done = Array.isArray(s.done) ? s.done.filter((i) => Number.isInteger(i)) : [];
    return s;
  } catch { return null; }
}

// Steps still to do (indices into state.steps).
export function unfinishedSteps(state) {
  const done = new Set(state?.done || []);
  return (state?.steps || []).map((_, i) => i).filter((i) => !done.has(i));
}

export function clearRunState(root) {
  try { fs.rmSync(stateFile(root), { force: true }); } catch {}
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// A lock older than this is treated as left behind (the old program was killed and Windows gave its number to another program).
export const LOCK_MAX_AGE_MS = 6 * 3600 * 1000;
// Returns false ONLY when another live Eta process really holds a fresh lock. If the lock file cannot be written, the run goes on (true).
export function acquireRunLock(root) {
  try {
    const cur = JSON.parse(fs.readFileSync(lockFile(root), "utf8"));
    const age = Date.now() - Date.parse(cur && cur.started);
    if (cur && cur.pid !== process.pid && pidAlive(cur.pid) && !(age >= LOCK_MAX_AGE_MS)) return false;
  } catch {}
  try {
    fs.mkdirSync(dir(root), { recursive: true });
    fs.writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), "utf8");
  } catch {}
  return true;
}

export function releaseRunLock(root) {
  try {
    const cur = JSON.parse(fs.readFileSync(lockFile(root), "utf8"));
    if (cur && cur.pid === process.pid) fs.rmSync(lockFile(root), { force: true });
  } catch {}
}

// The panel message "/continue" (alone). Tells the server what to do: not a continue request / nothing saved / continue.
export function continueRequest(ws, message) {
  if (!ws || !/^\/continue\s*$/i.test(String(message || "").trim())) return { kind: "none" };
  const st = loadRunState(ws);
  const left = st ? unfinishedSteps(st).length : 0;
  if (!st || !left) return { kind: "nothing" };
  return { kind: "continue", state: st, left };
}
