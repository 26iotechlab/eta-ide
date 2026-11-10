// Private safety snapshots and Undo for agent runs (moved out of server.mjs so they can be tested on their own).
import * as fs from "fs"; import * as fsp from "fs/promises"; import * as path from "path"; import { exec } from "child_process"; import * as os from "os";
const GIT = `git -c user.name="Eta IDE" -c user.email="eta@26io.local"`;
function sh(cwd, cmd, timeout = 90000, extraEnv = null) {
  return new Promise((res) => exec(cmd, { cwd, timeout, maxBuffer: 4 << 20, windowsHide: true, ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}) },
    (err, so, se) => res({ ok: !err, out: ((so || "") + (se || "")).slice(-3000) })));
}

// Keeps Eta's own folder out of the user's git: one line in the LOCAL .git/info/exclude (never committed, never pushed).
// Only when the folder already has git. Nothing else in the user's repository is touched.
export async function excludeEta(ws) {
  try {
    if (!(await sh(ws, "git rev-parse --is-inside-work-tree")).ok) return;
    const gd = (await sh(ws, "git rev-parse --git-common-dir")).out.trim();
    const gitDir = path.isAbsolute(gd) ? gd : path.join(ws, gd);
    const ex = path.join(gitDir, "info", "exclude");
    let cur = ""; try { cur = await fsp.readFile(ex, "utf8"); } catch {}
    if (!/^\.eta\/?$/m.test(cur)) { await fsp.mkdir(path.dirname(ex), { recursive: true }); await fsp.writeFile(ex, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".eta/\n", "utf8"); }
  } catch {}
}

// ---- PRIVATE safety snapshots (Gokul, 2026-11-10: "fix it") ----
// Before: every run committed ALL the user's work (also secrets like .env) into the user's OWN branch, ran "git init" in
// folders without git, untracked node_modules in the user's index, and Undo did "git reset --hard" + "git clean"
// (moved the branch back and deleted the user's own new files). Now snapshots live in a hidden store inside the project,
// .eta/snapshots.git, with the project as its work tree. The user's .git, branch, index and history are never touched,
// and a folder without git stays without git. The project's .gitignore still applies.
const snapDir = (ws) => path.join(ws, ".eta", "snapshots.git");
const SNAP_EXCLUDE = ".eta/\n.git\n.git/\nnode_modules/\n__pycache__/\n*.pyc\n.venv/\nvenv/\n.next/\n.nuxt/\n.cache/\n.parcel-cache/\ntarget/\n";
const SG = (ws) => `git --git-dir="${snapDir(ws)}" --work-tree="${ws}" -c user.name="Eta IDE" -c user.email="eta@26io.local" -c core.autocrlf=false -c core.safecrlf=false -c core.longpaths=true -c gc.auto=0`;
export async function gitSnapshot(ws) {
  if (!(await sh(ws, "git --version")).ok) return null; // git not installed: no undo point, the run still works
  const d = snapDir(ws);
  if (!fs.existsSync(path.join(d, "HEAD"))) {
    await fsp.mkdir(d, { recursive: true });
    if (!(await sh(ws, `git --git-dir="${d}" init -q`)).ok) return null;
    await sh(ws, `git --git-dir="${d}" config core.bare false`);
    await fsp.mkdir(path.join(d, "info"), { recursive: true });
    await fsp.writeFile(path.join(d, "info", "exclude"), SNAP_EXCLUDE, "utf8");
  }
  await excludeEta(ws);
  await sh(ws, `${SG(ws)} add -A`, 180000);
  await sh(ws, `${SG(ws)} commit --allow-empty --no-verify -q -m "snapshot ${new Date().toISOString()}"`, 120000);
  const h = await sh(ws, `${SG(ws)} rev-parse HEAD`);
  return h.ok && /^[0-9a-f]{40}/.test(h.out.trim()) ? "eta:" + h.out.trim().split("\n").pop().trim() : null;
}
// Undo a run: files the run changed or deleted get their snapshot content back; files that appeared during the run
// (newer than its start) are removed. Files the user did not have in the snapshot and that are older stay.
export async function revertRun(r) {
  const ws = r.workspace;
  if (!String(r.snapshot).startsWith("eta:")) { // a run saved the old way (a commit in the user's repo): restore files only, never move the branch
    const a = await sh(ws, `git checkout ${r.snapshot} -- .`);
    return { ok: a.ok, detail: a.out.slice(0, 200) };
  }
  const h = r.snapshot.slice(4), S = SG(ws);
  await sh(ws, `${S} add -A`, 180000);
  const added = (await sh(ws, `${S} diff --cached --name-only --no-renames --diff-filter=A ${h}`)).out.split("\n").map((x) => x.trim()).filter(Boolean);
  const a = await sh(ws, `${S} checkout -f ${h} -- .`, 180000);
  const since = (r.started || Date.now()) - 2000; let removed = 0;
  for (const rel of added) {
    const f = path.join(ws, rel);
    try { if (fs.statSync(f).mtimeMs >= since) { fs.rmSync(f, { force: true }); removed++; } } catch {}
  }
  await sh(ws, `${S} reset -q`); // the private store's own index back to its last snapshot
  return { ok: a.ok, detail: (a.ok ? `restored the files, removed ${removed} new file(s)` : a.out).slice(0, 200) };
}

// ---- parallel agents: git worktree isolation ----
// Each parallel run works in its OWN worktree+branch so concurrent agents can't
// collide on files; afterward the user merges the good ones and discards the rest.
const gitLocks = new Map(); // serialize git ops per workspace (avoid index.lock races)
export function withGitLock(ws, fn) {
  const prev = gitLocks.get(ws) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  gitLocks.set(ws, next.then(() => {}, () => {}));
  return next;
}
// Removes a run's working copy and its branch. "git worktree remove" can fail on Windows (short path names, open files),
// and then the branch cannot be deleted; so the folder is removed directly and git's list is tidied first.
async function dropWorktree(ws, run) {
  if (run.wtPath) { await sh(ws, `git worktree remove --force "${run.wtPath}"`); try { fs.rmSync(run.wtPath, { recursive: true, force: true }); } catch {} await sh(ws, "git worktree prune"); }
  if (run.branch) await sh(ws, `git branch -D ${run.branch}`);
}
export async function makeWorktree(ws, runId) {
  return withGitLock(ws, async () => {
    // Needs the user's own git; without it the run goes direct (with a private snapshot). The start point is a commit
    // made from a TEMPORARY index (git commit-tree): the user's branch, index and files do not change.
    if (!(await sh(ws, "git rev-parse --is-inside-work-tree")).ok) return null;
    await excludeEta(ws);
    const idx = path.join(os.tmpdir(), `eta-idx-${runId}-${Date.now().toString(36)}`);
    // the temporary index goes in through the process environment (a "set X=..&&" shell prefix was not reliable)
    const tmpIdx = { GIT_INDEX_FILE: idx };
    await sh(ws, `git add -A`, 180000, tmpIdx);
    const tree = (await sh(ws, `git write-tree`, 90000, tmpIdx)).out.trim().split("\n").pop().trim();
    try { fs.rmSync(idx, { force: true }); } catch {}
    if (!/^[0-9a-f]{40}$/.test(tree)) return null;
    const head = await sh(ws, "git rev-parse --verify -q HEAD");
    const c = await sh(ws, `${GIT} commit-tree ${tree}${head.ok ? " -p " + head.out.trim().split("\n").pop().trim() : ""} -m "eta: start point of run ${runId}"`);
    const base = c.out.trim().split("\n").pop().trim();
    if (!/^[0-9a-f]{40}$/.test(base)) return null;
    await sh(ws, "git worktree prune");
    const branch = `eta/run-${runId}`;
    const wt = path.join(os.tmpdir(), "eta-wt", path.basename(ws) + "-" + runId + "-" + Date.now().toString(36));
    await fsp.mkdir(path.dirname(wt), { recursive: true });
    // autocrlf off while checking out: the run must see the user's files byte for byte (Windows line endings were added)
    const r = await sh(ws, `${GIT} -c core.autocrlf=false worktree add "${wt}" -b ${branch} ${base}`);
    if (!r.ok) return null;
    await sh(wt, "git config core.autocrlf false");
    return { path: wt, branch, base };
  });
}
export async function mergeWorktree(run, strategy) {
  return withGitLock(run.workspace, async () => {
    const ws = run.workspace;
    // The run's result is committed on ITS OWN branch only. Into the user's folder it goes as plain file changes (no commit,
    // no merge commit, the user's index untouched): the user reviews and commits it the normal way.
    //   default: apply each changed file as a patch; a file that cannot apply cleanly is a conflict (left as the user had it)
    //   theirs:  take the run's version of every changed file      ours: apply what applies, keep the user's version elsewhere
    if (run.wtPath) { await sh(run.wtPath, `${GIT} add -A`); await sh(run.wtPath, `${GIT} commit --allow-empty --no-verify -q -m "eta: run ${run.id} result"`); }
    const changes = (await sh(ws, `git diff --name-status --no-renames ${run.base} ${run.branch}`)).out.split("\n").map((l) => l.trim()).filter((l) => /^[AMDT]\t/.test(l)).map((l) => ({ s: l[0], f: l.slice(2) }));
    const files = []; let out = "";
    for (const c of changes) {
      const abs = path.join(ws, c.f);
      if (strategy === "theirs") {
        if (c.s === "D") { try { fs.rmSync(abs, { force: true }); } catch {} continue; }
        const r = await sh(ws, `git restore --source=${run.branch} --worktree -- "${c.f}"`); if (!r.ok) { files.push(c.f); out += r.out; }
        continue;
      }
      const patch = path.join(os.tmpdir(), `eta-run-${run.id}-${Math.random().toString(36).slice(2)}.patch`);
      await sh(ws, `git diff --binary --no-renames ${run.base} ${run.branch} -- "${c.f}" > "${patch}"`);
      const r = await sh(ws, `git apply --whitespace=nowarn "${patch}"`);
      try { fs.rmSync(patch, { force: true }); } catch {}
      if (!r.ok) { files.push(c.f); out += r.out; }
    }
    const conflict = files.length > 0 && strategy !== "ours";
    if (!conflict) {
      await dropWorktree(ws, run);
      run.wtPath = null;
    }
    run.merged = !conflict; run.conflicted = conflict;
    return { ok: !conflict, conflict, files, out: out.slice(0, 2000) };
  });
}
export async function discardWorktree(run) {
  return withGitLock(run.workspace, async () => {
    await dropWorktree(run.workspace, run);
    run.discarded = true; run.wtPath = null;
    return { ok: true };
  });
}
