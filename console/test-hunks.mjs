// Test: hunks.mjs (line diff in blocks, undo chosen blocks). Pure, no files, no model. 2026-11-13 (job B2).
import { diffHunks, applySelection, splitLines } from "./hunks.mjs";

let pass = 0, fail = 0;
const ok = (c, n, g = "") => { c ? pass++ : fail++; if (!c || process.env.VERBOSE) console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${String(g).slice(0, 300)}`}`); };
const J = JSON.stringify;
const L = (...a) => a.join("\n") + "\n";
const ids = (h) => h.map((x) => x.id);
const ident = (o, n, name) => {
  const h = diffHunks(o, n);
  ok(applySelection(o, n, []) === n, `${name}: undo none gives the new text`, J(applySelection(o, n, [])));
  ok(applySelection(o, n, ids(h)) === o, `${name}: undo all gives the old text`, J(applySelection(o, n, ids(h))));
  return h;
};

console.log("== basic cases");
{ const h = ident(L("a", "b", "c"), L("a", "B", "c"), "single change");
  ok(h.length === 1 && h[0].oldStart === 2 && h[0].newStart === 2 && J(h[0].oldLines) === '["b"]' && J(h[0].newLines) === '["B"]', "single change: one block at line 2", J(h));
  ok(J(h[0].before) === '["a"]' && J(h[0].after) === '["c"]', "single change: context lines", J(h[0]));
  ok(/^2-[0-9a-f]{8}$/.test(h[0].id), "id looks like 2-xxxxxxxx", h[0].id); }
{ const o = L("1", "2", "3", "4", "5", "6", "7", "8", "9"), n = L("1", "TWO", "3", "4", "5", "6", "7", "EIGHT", "9");
  const h = ident(o, n, "two separate changes");
  ok(h.length === 2 && h[0].oldStart === 2 && h[1].oldStart === 8, "two separate blocks", J(h));
  ok(applySelection(o, n, [h[0].id]) === L("1", "2", "3", "4", "5", "6", "7", "EIGHT", "9"), "undo first keeps second");
  ok(applySelection(o, n, [h[1].id]) === L("1", "TWO", "3", "4", "5", "6", "7", "8", "9"), "undo second keeps first"); }
{ const h = ident(L("a", "b", "c", "d"), L("a", "X", "Y", "d"), "adjacent changes");
  ok(h.length === 1 && h[0].oldLines.length === 2 && h[0].newLines.length === 2, "adjacent changed lines are one block", J(h)); }
{ const h = ident(L("a", "b", "c"), L("A", "b", "c"), "first line"); ok(h.length === 1 && h[0].oldStart === 1 && h[0].before.length === 0, "change at the first line", J(h)); }
{ const h = ident(L("a", "b", "c"), L("a", "b", "C"), "last line"); ok(h.length === 1 && h[0].oldStart === 3 && h[0].after.length === 0, "change at the last line", J(h)); }
{ const h = ident(L("a", "c"), L("a", "b", "c"), "pure insert"); ok(h.length === 1 && h[0].oldLines.length === 0 && J(h[0].newLines) === '["b"]' && h[0].oldStart === 2 && h[0].newStart === 2, "pure insert", J(h)); }
{ const h = ident(L("a", "b", "c"), L("a", "c"), "pure delete"); ok(h.length === 1 && h[0].newLines.length === 0 && J(h[0].oldLines) === '["b"]', "pure delete", J(h)); }
{ const h = ident(L("a", "b"), L("a", "b", "c", "d"), "insert at end"); ok(h.length === 1 && h[0].oldStart === 3, "insert at the end", J(h)); }
{ const h = ident("", L("a", "b"), "empty old"); ok(h.length === 1 && h[0].oldLines.length === 0 && h[0].newLines.length === 2, "empty old: one insert block", J(h)); }
{ const h = ident(L("a", "b"), "", "empty new"); ok(h.length === 1 && h[0].newLines.length === 0, "empty new: one delete block", J(h)); }
ok(diffHunks("", "").length === 0 && diffHunks(L("x"), L("x")).length === 0, "equal texts: no blocks");

console.log("== line endings");
{ const o = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n", n = "a\r\nB\r\nc\r\nd\r\ne\r\nf\r\nG\r\n";
  const h = ident(o, n, "CRLF");
  ok(h.length === 2 && !h[0].newLines[0].includes("\r"), "CRLF: lines have no CR", J(h));
  ok(applySelection(o, n, [h[0].id]) === "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\nG\r\n", "CRLF: partial undo keeps CRLF", J(applySelection(o, n, [h[0].id]))); }
{ const o = "a\nb\nc\nd\ne\nf\ng", n = "a\nB\nc\nd\ne\nf\nG";
  const h = ident(o, n, "no final newline");
  ok(applySelection(o, n, [h[0].id]) === "a\nb\nc\nd\ne\nf\nG", "no final newline stays without one", J(applySelection(o, n, [h[0].id]))); }
{ const o = "a\nb\nc\nd\ne\nf\ng", n = "a\nB\nc\nd\ne\nf\ng\nh\n"; // new adds a final newline and a line
  const h = ident(o, n, "final newline added");
  const r = applySelection(o, n, [h[0].id]);
  ok(r === "a\nb\nc\nd\ne\nf\ng\nh\n", "partial undo follows the new text's final newline", J(r)); }
{ const o = "a\nb\nc\nd\ne\nf\ng\n", n = "a\r\nB\r\nc\r\nd\r\ne\r\nf\r\nG\r\n"; // the run also changed LF to CRLF
  const h = diffHunks(o, n); const r = applySelection(o, n, [h[0].id]);
  ok(r === "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\nG\r\n", "restored lines take the new text's main line ending", J(r)); }
ok(J(splitLines("a\r\nb\nc")) === J({ lines: ["a", "b", "c"], eols: ["\r\n", "\n", ""], finalNL: false }), "splitLines keeps each ending");

console.log("== duplicates, three blocks, stable ids");
{ const o = L("x", "x", "x", "y", "x", "x"), n = L("x", "x", "y", "x", "x", "x"); ident(o, n, "duplicate lines"); }
{ const o = L("}", "}", "a", "}", "}", "b", "}", "}"), n = L("}", "}", "A", "}", "}", "}", "}", "B", "}"); ident(o, n, "duplicate braces"); }
{ const o = L("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"), n = L("1", "X", "3", "4", "5", "Y", "7", "8", "9", "Z", "11");
  const h = ident(o, n, "three blocks"); ok(h.length === 3, "three blocks", J(h));
  const r = applySelection(o, n, [h[1].id]);
  ok(r === L("1", "X", "3", "4", "5", "6", "7", "8", "9", "Z", "11"), "undo one of three keeps the other two", J(r));
  const h2 = diffHunks(o, r);
  ok(J(ids(h2)) === J([h[0].id, h[2].id]), "ids of the other blocks stay the same after one undo", J(ids(h2)) + " vs " + J(ids(h)));
  ok(applySelection(o, r, [h[0].id]) === applySelection(o, n, [h[0].id, h[1].id]), "second undo on the result = undoing both at once");
  ok(applySelection(o, n, ["nope-00000000"]) === n, "unknown id changes nothing"); }
{ // insert shifts lines: later block ids use OLD coordinates, so they stay
  const o = L("a", "b", "c", "d", "e", "f", "g"), n = L("NEW1", "NEW2", "a", "b", "c", "d", "e", "F", "g");
  const h = diffHunks(o, n); const r = applySelection(o, n, [h[0].id]);
  ok(J(ids(diffHunks(o, r))) === J([h[1].id]), "id stays when an earlier insert is undone", J(ids(diffHunks(o, r)))); }

console.log("== huge input");
{ const N = 30000, a = [], b = [];
  for (let i = 0; i < N; i++) { a.push("line " + i); b.push(i % 2 ? "changed " + i : "line " + i); }
  const t = Date.now(); const h = diffHunks(a.join("\n"), b.join("\n")); const ms = Date.now() - t;
  ok(ms < 8000, `huge diff ends fast (${ms} ms)`, ms);
  ok(h.length === 1 && h[0].oldStart === 2, "huge diff falls back to ONE block for the changed middle", h.length);
  ok(applySelection(a.join("\n"), b.join("\n"), []) === b.join("\n") && applySelection(a.join("\n"), b.join("\n"), ids(h)) === a.join("\n"), "huge: undo none / all still exact"); }
{ const a = [], b = []; for (let i = 0; i < 20000; i++) { a.push("l" + i); b.push("l" + i); } b[100] = "x"; b[19000] = "y";
  const t = Date.now(); const h = diffHunks(a.join("\n"), b.join("\n"));
  ok(h.length === 2 && Date.now() - t < 3000, "big file with two small changes: exact and fast", h.length); }

console.log("== random round trip (300 files)");
{ let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ["a", "b", "c", "d", "", "}", "x"];
  let bad = 0, badStable = 0, total = 0;
  for (let f = 0; f < 300; f++) {
    const ol = []; for (let i = rnd(15); i > 0; i--) ol.push(words[rnd(words.length)]);
    const nl = []; for (const l of ol) { const r = rnd(10); if (r === 0) continue; if (r === 1) nl.push(words[rnd(words.length)]); else if (r === 2) { nl.push(l); nl.push(words[rnd(words.length)]); } else nl.push(l); }
    if (rnd(4) === 0) nl.unshift("start");
    const eol = rnd(3) === 0 ? "\r\n" : "\n";
    const fin = rnd(2) === 0;
    const o = ol.join(eol) + (ol.length && fin ? eol : ""), n = nl.join(eol) + (nl.length && fin ? eol : "");
    const h = diffHunks(o, n);
    for (let t = 0; t < 4; t++) {
      const pick = h.filter(() => rnd(2) === 0), set = new Set(ids(pick));
      // build the expected text by hand: walk the new lines, swap chosen blocks for their old lines
      const NL = splitLines(n).lines, out = []; let p = 0;
      for (const x of h) { while (p < x.newStart - 1) out.push(NL[p++]); out.push(...(set.has(x.id) ? x.oldLines : x.newLines)); p = x.newStart - 1 + x.newLines.length; }
      while (p < NL.length) out.push(NL[p++]);
      let exp;
      if (set.size === 0) exp = n; else if (set.size === h.length) exp = o;
      else exp = out.join(eol) + (out.length && splitLines(n).finalNL ? eol : "");
      total++;
      const got = applySelection(o, n, [...set]);
      if (got !== exp) { bad++; if (bad < 4) console.log("    mismatch", J({ o, n, pick: [...set], got, exp })); }
      // the old lines of the hunks must rebuild the old text
      const left = diffHunks(o, got).map((x) => x.id), want = ids(h).filter((id) => !set.has(id));
      if (J(left) !== J(want)) badStable++;
    }
    const OL = splitLines(o).lines, back = []; let q = 0;
    for (const x of h) { while (q < x.oldStart - 1) back.push(OL[q++]); back.push(...x.oldLines); q = x.oldStart - 1 + x.oldLines.length; }
    while (q < OL.length) back.push(OL[q++]);
    if (J(back) !== J(OL)) bad++;
  }
  ok(bad === 0, `random: ${total} selections give the hand-built text`, bad);
  console.log(`    (remaining ids equal the not-chosen ids in ${total - badStable} of ${total} cases)`);
  ok(badStable <= total * 0.05, "random: remaining ids almost always stable", badStable); }

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
