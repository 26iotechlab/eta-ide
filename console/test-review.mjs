// Test: review.mjs (list a run's changed blocks, undo single blocks) with a real private snapshot in a TEMP folder.
// Only git in temp folders; no model, no server. 2026-11-13 (job B2).
import fs from "fs"; import os from "os"; import path from "path";
import { gitSnapshot, readSnapshotFile } from "./snapshot.mjs";
import { runChanges, revertHunks } from "./review.mjs";

let pass = 0, fail = 0;
const ok = (c, n, g = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${String(g).slice(0, 300)})`}`); };
const J = JSON.stringify;
const W = (ws, f, t) => { fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true }); fs.writeFileSync(path.join(ws, f), t); };
const R = (ws, f) => { try { return fs.readFileSync(path.join(ws, f), "utf8"); } catch { return null; } };
const L = (...a) => a.join("\n") + "\n";
const temps = [];

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "eta-review-")); temps.push(ws);
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eta-review-out-")); temps.push(outside);
W(outside, "x", "secret outside\n");
const A0 = L("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11");
W(ws, "src/a.js", A0);
W(ws, "crlf.txt", "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n");
W(ws, "gone.txt", "will be deleted\n");
W(ws, "same.txt", "not changed\n");
W(ws, "bin.dat", Buffer.from([1, 2, 0, 3, 4]));
W(ws, "other.txt", L("o1", "o2"));
const snapshot = await gitSnapshot(ws);
ok(/^eta:[0-9a-f]{40}$/.test(snapshot || ""), "a private snapshot is made", snapshot);
const run = { id: "t", workspace: ws, snapshot, started: Date.now(), status: "done",
  files: new Set(["src/a.js", "crlf.txt", "gone.txt", "same.txt", "bin.dat", "new.txt", "other.txt", "src\\a.js"]) };

ok((await readSnapshotFile(run, "src/a.js")) === A0, "readSnapshotFile gives the snapshot text");
ok((await readSnapshotFile(run, "src\\a.js")) === A0, "readSnapshotFile accepts a backslash path");
ok((await readSnapshotFile(run, "new.txt")) === null, "readSnapshotFile: a file missing at the snapshot is null");
ok((await readSnapshotFile(run, "bin.dat")) === undefined, "readSnapshotFile: a binary file is not supported");
ok((await readSnapshotFile({ ...run, snapshot: "abc123" }, "src/a.js")) === undefined, "readSnapshotFile: an old kind of snapshot is not supported");

// the "run" edits after the snapshot
const A1 = L("1", "TWO", "3", "4", "5", "SIX", "7", "8", "9", "TEN", "11");
W(ws, "src/a.js", A1);
W(ws, "crlf.txt", "a\r\nB\r\nc\r\nd\r\ne\r\nf\r\nG\r\n");
fs.rmSync(path.join(ws, "gone.txt"));
W(ws, "bin.dat", Buffer.from([1, 2, 0, 9, 9]));
W(ws, "new.txt", "made by the run\n");
W(ws, "other.txt", L("o1", "O2 changed"));
W(ws, "notlisted.txt", "the run did not write this\n");

console.log("== runChanges");
const c = await runChanges(run);
ok(c.ok, "runChanges works", J(c));
const by = Object.fromEntries((c.files || []).map((f) => [f.file, f]));
ok(!by["same.txt"] && !by["gone.txt"] && !by["notlisted.txt"], "unchanged, deleted and not-listed files are skipped", J(Object.keys(by)));
ok(Object.keys(by).filter((k) => /a\.js$/.test(k)).length === 1, "the same file written with \\ and / is listed once", J(Object.keys(by)));
ok(by["src/a.js"]?.status === "modified" && by["src/a.js"].hunks.length === 3, "a.js: modified with three blocks", J(by["src/a.js"]));
const h0 = by["src/a.js"].hunks[0];
ok(J(h0.removed) === '["2"]' && J(h0.added) === '["TWO"]' && h0.removedTotal === 1 && h0.addedTotal === 1 && h0.oldStart === 2 && h0.newStart === 2 && J(h0.before) === '["1"]', "a block has the shown lines and counts", J(h0));
ok(by["new.txt"]?.status === "added" && by["new.txt"].wholeFileOnly === true && by["new.txt"].hunks.length === 0, "a new file is 'added', whole-file undo only", J(by["new.txt"]));
ok(by["bin.dat"]?.binary === true && by["bin.dat"].hunks.length === 0, "a binary file is marked binary", J(by["bin.dat"]));
ok(by["crlf.txt"]?.hunks.length === 2 && !by["crlf.txt"].hunks[0].added[0].includes("\r"), "CRLF file: two blocks, lines without CR", J(by["crlf.txt"]));

console.log("== revertHunks");
const ids = by["src/a.js"].hunks.map((h) => h.id);
const r1 = await revertHunks(run, "src/a.js", [ids[1]]);
ok(r1.ok && r1.reverted === 1 && J(r1.remaining) === J([ids[0], ids[2]]), "undo the middle block; the other two stay listed", J(r1));
ok(R(ws, "src/a.js") === L("1", "TWO", "3", "4", "5", "6", "7", "8", "9", "TEN", "11"), "file: only the middle block went back", R(ws, "src/a.js"));
ok(R(ws, "other.txt") === L("o1", "O2 changed") && R(ws, "new.txt") === "made by the run\n", "other files are not touched");
const cr = by["crlf.txt"].hunks;
const r2 = await revertHunks(run, "crlf.txt", [cr[0].id]);
ok(r2.ok && R(ws, "crlf.txt") === "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\nG\r\n", "CRLF file: one block back, CRLF kept", J(R(ws, "crlf.txt")));

console.log("== safety");
const before = R(ws, "src/a.js");
for (const bad of ["../x", path.join(outside, "x"), "C:/Windows/win.ini", "/etc/passwd", ".eta/snapshots.git/HEAD", ".git/config", "notlisted.txt", "src/../../x", "src/a.js:stream", ""]) {
  const res = await revertHunks({ ...run, files: new Set([...run.files, bad]) }, bad, [ids[0]]);
  ok(!res.ok && !res.conflict, `refused: ${J(bad)}`, J(res));
}
const r3 = await revertHunks(run, "notlisted.txt", ["1-00000000"]);
ok(!r3.ok && /not one this run changed/.test(r3.error), "a file the run did not write is refused", J(r3));
ok(R(outside, "x") === "secret outside\n" && R(ws, "src/a.js") === before, "nothing was written by the refused calls");
ok(!(await revertHunks({ ...run, wtPath: "C:/tmp/wt" }, "src/a.js", [ids[0]])).ok, "isolated runs are refused");
ok(!(await revertHunks({ ...run, status: "running" }, "src/a.js", [ids[0]])).ok, "a run that is still working is refused");
ok(!(await runChanges({ ...run, snapshot: null })).ok && !(await runChanges({ ...run, snapshot: "abc" })).ok && !(await runChanges({ ...run, workspace: path.join(ws, "nope") })).ok, "runChanges errors: no snapshot, old kind, missing folder");
ok(!(await revertHunks(run, "new.txt", ["1-00000000"])).ok, "block undo of a new file is refused (whole-run Undo)");
ok(!(await revertHunks(run, "bin.dat", ["1-00000000"])).ok, "block undo of a binary file is refused");

console.log("== conflict");
const list = (await runChanges(run)).files.find((f) => f.file === "src/a.js");
W(ws, "src/a.js", L("1", "TWO user edit", "3", "4", "5", "6", "7", "8", "9", "TEN", "11")); // user edits after the list
const afterUser = R(ws, "src/a.js");
const r4 = await revertHunks(run, "src/a.js", [list.hunks[0].id]);
ok(!r4.ok && r4.conflict === true && /changed since/.test(r4.error), "a changed block gives a conflict", J(r4));
ok(R(ws, "src/a.js") === afterUser, "the conflict wrote nothing");

console.log("== undo every block of a file");
const all = (await runChanges(run)).files.find((f) => f.file === "src/a.js").hunks.map((h) => h.id);
const r5 = await revertHunks(run, "src/a.js", all);
ok(r5.ok && r5.remaining.length === 0 && R(ws, "src/a.js") === A0, "undoing every block restores the snapshot exactly", J(r5));
const all2 = (await runChanges(run)).files.find((f) => f.file === "crlf.txt").hunks.map((h) => h.id);
await revertHunks(run, "crlf.txt", all2);
ok(fs.readFileSync(path.join(ws, "crlf.txt")).equals(Buffer.from("a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n")), "CRLF file restored byte for byte");
ok(!(await runChanges(run)).files.some((f) => f.file === "src/a.js" || f.file === "crlf.txt"), "restored files are no longer listed");

console.log("== folder name with a space");
const sp = fs.mkdtempSync(path.join(os.tmpdir(), "eta review sp-")); temps.push(sp);
W(sp, "f.txt", L("a", "b", "c", "d", "e", "f", "g")); const spSnap = await gitSnapshot(sp);
W(sp, "f.txt", L("A", "b", "c", "d", "e", "f", "G"));
const spRun = { workspace: sp, snapshot: spSnap, files: new Set(["f.txt"]), started: Date.now() };
const spList = await runChanges(spRun);
const r6 = spList.ok && await revertHunks(spRun, "f.txt", [spList.files[0].hunks[1].id]);
ok(r6?.ok && R(sp, "f.txt") === L("A", "b", "c", "d", "e", "f", "g"), "works in a folder with a space in its name", J(spList) + J(r6));

for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
ok(temps.every((t) => !fs.existsSync(t)), "temp folders removed");
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
