// Test: @-mentions (D3, 2026-11-13). Plain files in a temp folder. NO model, NO server, NO network.
// Run: node test-mentions.mjs
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import { findMentions, resolveInside, expandMentions, searchFiles, LIMITS } from "./mentions.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "eta-mention-"));
const W = (rel, txt) => { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
W("src/app.js", "export const a = 1;\n"); W("src/util/math.js", "export const add = (x, y) => x + y;"); W("README.md", "# hi\n");
W("notes/my notes.md", "spaces in name\n"); W("big.txt", "x".repeat(20000)); W("huge.bin", Buffer.alloc(10, 0)); W("src/fence.md", "```js\ncode\n```\n");
W(".git/config", "secret"); W(".eta/snapshots.git/x", "secret"); W("node_modules/pkg/index.js", "dep");
fs.writeFileSync(path.join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
fs.writeFileSync(path.join(ws, "toobig.txt"), "y".repeat(LIMITS.maxBytes + 1));

// 1) finding words
ok(JSON.stringify(findMentions("look at @src/app.js please")) === '["src/app.js"]', "finds a path");
ok(JSON.stringify(findMentions("@README.md what is this?")) === '["README.md"]', "finds one at the start of the message");
ok(JSON.stringify(findMentions("see @src/app.js, and @README.md.")) === '["src/app.js","README.md"]', "trailing comma and full stop are not part of the path");
ok(JSON.stringify(findMentions('open @"notes/my notes.md" now')) === '["notes/my notes.md"]', "quotes allow spaces");
ok(findMentions("mail me at bob@example.com").length === 0, "an e-mail address is not a mention");
ok(JSON.stringify(findMentions("@a.js @a.js @b.js")) === '["a.js","b.js"]', "the same word twice counts once");
ok(JSON.stringify(findMentions("(@src\\app.js)")) === '["src/app.js"]', "backslashes become slashes, brackets are dropped");
ok(findMentions("").length === 0 && findMentions(null).length === 0, "empty input is fine");

// 2) safe paths
ok(resolveInside(ws, "../secret.txt") === null, "going up out of the folder is refused");
ok(resolveInside(ws, "src/../../x") === null, "a hidden way up is refused");
ok(resolveInside(ws, "/etc/passwd") === null && resolveInside(ws, "C:/Windows/win.ini") === null, "absolute paths are refused");
ok(resolveInside(ws, ".git/config") === null && resolveInside(ws, "src/.git/x") === null && resolveInside(ws, ".ETA/x") === null, ".git and .eta are refused (any depth, any case)");
ok(resolveInside(ws, "src/app.js")?.rel === "src/app.js", "a normal path is accepted");
ok(resolveInside(ws, "a\0b") === null, "a zero byte is refused");

// 3) expanding
let r = await expandMentions("explain @src/app.js and @src/util/math.js", ws);
ok(r.files.length === 2 && r.block.includes("### file src/app.js") && r.block.includes("export const add"), "two files are attached with their text", r);
ok(r.block.startsWith("\n\n[Files the user attached with @"), "the block starts with a clear heading");
r = await expandMentions("what about @nothing.js and @someagent?", ws); ok(r.block === "" && r.files.length === 0 && r.skipped.length === 0, "words that are not files are ignored quietly", r);
r = await expandMentions("read @.git/config", ws); ok(r.block === "" && r.files.length === 0, "the .git folder cannot be read through a mention", r);
r = await expandMentions("read @../x and @..\\y", ws); ok(r.block === "", "paths outside the folder give nothing");
r = await expandMentions('read @"notes/my notes.md"', ws); ok(r.files.length === 1 && r.block.includes("spaces in name"), "a quoted path with spaces works", r);
r = await expandMentions("read @big.txt", ws); ok(r.files[0].cut === true && r.files[0].chars === LIMITS.perFile && /first 12000 of 20000/.test(r.block), "a long file is cut and says so", r.files);
r = await expandMentions("read @bin.dat @huge.bin", ws); ok(r.block === "" && r.skipped.length === 2 && r.skipped.every((s) => s.why === "binary file"), "binary files are skipped with a reason", r.skipped);
r = await expandMentions("read @toobig.txt", ws); ok(r.block === "" && r.skipped[0]?.why === "file is too large", "a file over the byte limit is skipped with a reason", r.skipped);
r = await expandMentions("read @src", ws); ok(r.folders[0] === "src" && /### folder src\//.test(r.block) && /app\.js\n/.test(r.block) && /util\//.test(r.block), "a folder gives its list of names", r);
r = await expandMentions("read @src/fence.md", ws); ok(/````\n```js/.test(r.block) || /^````/m.test(r.block), "a file that contains ``` gets a longer fence", r.block);
r = await expandMentions("read @src/app.js", ""); ok(r.block === "", "no open folder: nothing is attached");
{ const many = Array.from({ length: 10 }, (_, i) => { W(`m/f${i}.txt`, "hello " + i); return `@m/f${i}.txt`; }).join(" ");
  r = await expandMentions(many, ws); ok(r.files.length === LIMITS.files && r.skipped.length === 10 - LIMITS.files, "at most 6 files per message; the rest are named as skipped", { f: r.files.length, s: r.skipped.length }); }
r = await expandMentions("@big.txt @big.txt2 @src/app.js", ws, { ...LIMITS, total: 12100 }); ok(r.files.length === 1 && r.skipped.length === 1 && r.skipped[0].why === "no room left", "when the room is nearly used up, the next file is skipped and named", { f: r.files, s: r.skipped });
{ const lim = { ...LIMITS, total: 12100 }; const a = await expandMentions("@big.txt @src/util/math.js @README.md", ws, lim); const sum = a.files.reduce((s, f) => s + f.chars, 0); ok(sum <= 12100, "the sum of attached characters never goes over the total limit", sum); }

// 4) the list while typing
let l = await searchFiles(ws, "app"); ok(l[0] === "src/app.js", "name starts with the text: first", l);
l = await searchFiles(ws, "math"); ok(l.includes("src/util/math.js") && l.length === 1, "finds a file in a deeper folder", l);
l = await searchFiles(ws, ""); ok(l.length > 3 && !l.some((p) => /^(\.git|\.eta|node_modules)\//.test(p)), "empty text lists files, never .git, .eta or node_modules", l);
l = await searchFiles(ws, "config"); ok(!l.includes(".git/config"), "files inside .git are never offered", l);
l = await searchFiles(ws, "smj"); ok(l.length === 0 || !l.includes(".git/config"), "letters in order can match (src/util/math.js has s..m..j)", l);
l = await searchFiles(ws, "SRC/UTIL"); ok(l.includes("src/util/math.js"), "capital letters do not matter, a path part matches", l);
l = await searchFiles(ws, "", 2); ok(l.length === 2, "the limit is respected", l);
l = await searchFiles("", "a"); ok(l.length === 0, "no folder: empty list");
l = await searchFiles(path.join(ws, "does-not-exist"), "a"); ok(Array.isArray(l) && l.length === 0, "a missing folder gives an empty list");

fs.rmSync(ws, { recursive: true, force: true });
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exit(fail ? 1 : 0);
