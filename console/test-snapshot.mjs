// Test: private safety snapshots + Undo never touch the user's git (branch, history, index) and never delete the
// user's own files. No model needed. 2026-11-10.
import fs from "fs"; import os from "os"; import path from "path"; import { execSync } from "child_process";
import { gitSnapshot, revertRun } from "./snapshot.mjs";

let pass = 0, fail = 0;
const ok = (c, n, g = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${g})`}`); };
const git = (ws, a) => { try { return execSync(`git ${a}`, { cwd: ws, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "ERR"; } };
const W = (ws, f, t) => { fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true }); fs.writeFileSync(path.join(ws, f), t); };
const R = (ws, f) => { try { return fs.readFileSync(path.join(ws, f), "utf8"); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("== folder WITH the user's own git");
const a = fs.mkdtempSync(path.join(os.tmpdir(), "eta-snap-git-"));
git(a, "init -q -b main"); git(a, "config user.email u@x"); git(a, "config user.name U");
W(a, "a.txt", "one\n"); W(a, "b.txt", "keep me\n"); W(a, ".gitignore", "node_modules/\n"); git(a, "add -A"); git(a, 'commit -q -m "user commit"');
W(a, "a.txt", "one\nuser edit not committed\n"); W(a, ".env", "SECRET=123\n"); W(a, "mine.txt", "my own new file\n"); W(a, "node_modules/x/index.js", "x\n");
git(a, "add a.txt"); // something staged by the user
const before = { head: git(a, "rev-parse HEAD"), count: git(a, "rev-list --count HEAD"), status: git(a, "status --porcelain"), staged: git(a, "diff --cached --name-only"), branch: git(a, "branch --show-current") };
const snap = await gitSnapshot(a);
ok(/^eta:[0-9a-f]{40}$/.test(snap || ""), "a private snapshot is made", snap);
ok(git(a, "rev-parse HEAD") === before.head && git(a, "rev-list --count HEAD") === before.count, "the user's branch and history do not change", git(a, "log --oneline -3"));
ok(git(a, "status --porcelain") === before.status, "git status looks exactly the same for the user", git(a, "status --porcelain"));
ok(git(a, "diff --cached --name-only") === before.staged, "what the user staged stays staged", git(a, "diff --cached --name-only"));
ok(!git(a, "log --all --format=%H -- .env").replace("ERR", ""), "the secret .env is in no commit of the user's repo");
const store = `--git-dir="${path.join(a, ".eta", "snapshots.git")}"`;
ok(!/node_modules/.test(git(a, `${store} ls-tree -r --name-only HEAD`)), "ignored folders (node_modules) are not copied into the snapshot");
// the "agent run"
const started = Date.now(); await sleep(50);
W(a, "a.txt", "AGENT BROKE THIS\n"); fs.rmSync(path.join(a, "b.txt")); W(a, "new-by-agent.js", "console.log(1)\n"); W(a, "src/deep/gen.py", "x=1\n");
const res = await revertRun({ workspace: a, snapshot: snap, started });
ok(res.ok, "Undo works", JSON.stringify(res));
ok(R(a, "a.txt") === "one\nuser edit not committed\n", "a changed file gets back the user's (uncommitted) version", R(a, "a.txt"));
ok(R(a, "b.txt") === "keep me\n", "a deleted file comes back", R(a, "b.txt"));
ok(R(a, "new-by-agent.js") === null && R(a, "src/deep/gen.py") === null, "files made during the run are removed");
ok(R(a, "mine.txt") === "my own new file\n" && R(a, ".env") === "SECRET=123\n", "the user's own new files and .env stay");
ok(R(a, "node_modules/x/index.js") === "x\n", "ignored folders are left alone");
ok(git(a, "rev-parse HEAD") === before.head && git(a, "rev-list --count HEAD") === before.count && git(a, "branch --show-current") === before.branch, "after Undo: branch and history still unchanged");
ok(git(a, "diff --cached --name-only") === before.staged, "after Undo: the user's staged files unchanged");

console.log("== folder WITHOUT git");
const b = fs.mkdtempSync(path.join(os.tmpdir(), "eta-snap-plain-"));
W(b, "index.html", "<h1>hi</h1>\n");
const s2 = await gitSnapshot(b);
ok(/^eta:/.test(s2 || "") && !fs.existsSync(path.join(b, ".git")), "a snapshot is made and NO git repository is created in the folder", fs.existsSync(path.join(b, ".git")));
const t2 = Date.now(); await sleep(50);
W(b, "index.html", "<h1>broken</h1>\n"); W(b, "style.css", "x{}\n");
await revertRun({ workspace: b, snapshot: s2, started: t2 });
ok(R(b, "index.html") === "<h1>hi</h1>\n" && R(b, "style.css") === null, "Undo works in a folder without git");

console.log("== two runs in a row");
const s3 = await gitSnapshot(b); W(b, "index.html", "<h1>v2</h1>\n"); const s4 = await gitSnapshot(b); const t4 = Date.now(); await sleep(50);
W(b, "index.html", "<h1>v3 broken</h1>\n");
await revertRun({ workspace: b, snapshot: s4, started: t4 });
ok(R(b, "index.html") === "<h1>v2</h1>\n", "Undo of the second run goes back to the state before the second run (not the first)", R(b, "index.html"));

console.log("== parallel runs (own worktree) merged back without commits in the user's branch");
const { makeWorktree, mergeWorktree } = await import("./snapshot.mjs");
const c = fs.mkdtempSync(path.join(os.tmpdir(), "eta-snap-wt-"));
git(c, "init -q -b main"); git(c, "config user.email u@x"); git(c, "config user.name U");
W(c, "x.txt", "line1\nline2\n"); W(c, "y.txt", "y1\n"); git(c, "add -A"); git(c, 'commit -q -m "user commit"');
W(c, "notes.txt", "user's uncommitted work\n");
const h0 = git(c, "rev-parse HEAD"), n0 = git(c, "rev-list --count HEAD"), st0 = git(c, "status --porcelain");
const wt = await makeWorktree(c, "t1");
ok(wt && fs.existsSync(wt.path), "a parallel run gets its own working copy", JSON.stringify(wt));
ok(git(c, "rev-parse HEAD") === h0 && git(c, "status --porcelain") === st0 && !git(c, "diff --cached --name-only"), "making it does not change the user's branch, status or index", git(c, "diff --cached --name-only"));
ok(R(wt.path, "notes.txt") === "user's uncommitted work\n", "the run starts from the user's current files (also uncommitted ones)");
W(wt.path, "y.txt", "y1\ny2 by run\n"); W(wt.path, "z.txt", "new by run\n");
const run = { workspace: c, wtPath: wt.path, branch: wt.branch, base: wt.base, id: "t1", task: "test" };
const m1 = await mergeWorktree(run);
ok(m1.ok && R(c, "y.txt") === "y1\ny2 by run\n" && R(c, "z.txt") === "new by run\n", "the run's changes arrive as plain file changes", JSON.stringify(m1));
ok(git(c, "rev-parse HEAD") === h0 && git(c, "rev-list --count HEAD") === n0, "no commit and no merge commit in the user's branch", git(c, "log --oneline -3"));
ok(R(c, "notes.txt") === "user's uncommitted work\n" && !git(c, "branch --list eta/run-t1"), "user's work stays; the run's branch is removed");
// conflict
const wt2 = await makeWorktree(c, "t2");
W(wt2.path, "x.txt", "line1 CHANGED BY RUN\nline2\n");
W(c, "x.txt", "line1 CHANGED BY USER\nline2\n");
const run2 = { workspace: c, wtPath: wt2.path, branch: wt2.branch, base: wt2.base, id: "t2", task: "test2" };
const m2 = await mergeWorktree(run2);
ok(!m2.ok && m2.conflict && m2.files.includes("x.txt") && R(c, "x.txt") === "line1 CHANGED BY USER\nline2\n", "a conflict is reported and the user's version is kept", JSON.stringify(m2).slice(0, 200));
const m3 = await mergeWorktree(run2, "theirs");
ok(m3.ok && R(c, "x.txt") === "line1 CHANGED BY RUN\nline2\n" && git(c, "rev-list --count HEAD") === n0, "\"take the run's version\" works, still without commits");

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
