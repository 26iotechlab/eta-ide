// failtext.mjs: read a test run's output and pull out the FIRST failing tests with their exact text.
// Plain code, no model. Each entry: { name, expected, received, message, line }.
// Why: a repair prompt that only says "tests fail" gives a small model nothing to aim at. Live benchmark (2026-11-16):
// retries never saw "Expected: 2 Received: NaN" or the exact toThrow('...') message, so the model guessed.
// Fail-open: any parser problem falls back to the last 30 lines of the output; never throws.
// Supported: jest, vitest, mocha, node:test (spec and TAP), pytest, unittest, go test, cargo test, maven/junit.

const FIELD_MAX = 300;
const FALLBACK_LINES = 30;

function clip(s, n = FIELD_MAX) {
  s = String(s == null ? "" : s).trim();
  return s.length <= n ? s : s.substring(0, n) + " [cut]";
}
function stripAnsi(s) { return String(s || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""); }
// a code location that is NOT inside node_modules or the runtime itself
function firstLocation(text) {
  for (const m of String(text).matchAll(/([\w./\\@-]+\.(?:m?js|cjs|ts|tsx|jsx|py|go|rs|java|kt)):(\d+)(?::\d+)?/g)) {
    const f = m[1];
    if (/node_modules|node:internal|[\\/]lib[\\/]python|site-packages|_pytest[\\/]|unittest[\\/]case\.py/i.test(f)) continue;
    return `${f.split(/[\\/]/).pop()}:${m[2]}`;
  }
  return "";
}
function entry(name, o = {}) {
  return { name: clip(name, 200), expected: clip(o.expected || ""), received: clip(o.received || ""), message: clip(o.message || ""), line: clip(o.line || "", 120) };
}

// ---- jest / vitest ----
function parseJest(out) {
  const res = [];
  const lines = out.split(/\r?\n/);
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^\s*●\s+(?!Console\b)/.test(lines[i])) heads.push(i);
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h], end = h + 1 < heads.length ? heads[h + 1] : lines.length;
    const name = lines[start].replace(/^\s*●\s+/, "").trim();
    const body = lines.slice(start + 1, end);
    const text = body.join("\n");
    const o = {};
    if (/Test suite failed to run/i.test(name)) {
      const syn = body.find((l) => /\b(SyntaxError|TypeError|ReferenceError|Error):/.test(l));
      const why = body.find((l) => l.trim() && !/^\s*$/.test(l));
      o.message = (syn || why || "").trim().replace(/^.*?([A-Z]\w*Error:)/, "$1");
      // a parse error names the file:line inside the message: "file.js: Unexpected token (2:25)"
      const pm = /([\w.-]+\.(?:m?js|cjs|ts|tsx|jsx)):\s.*\((\d+):\d+\)/.exec(syn || "");
      o.line = pm ? `${pm[1]}:${pm[2]}` : firstLocation(text);
      res.push(entry(name, o));
      continue;
    }
    const get = (re) => { for (const l of body) { const m = re.exec(l); if (m) return m[1].trim(); } return ""; };
    o.expected = get(/^\s*Expected(?: message| substring| pattern| value| constructor| name)?:\s*(.*)$/);
    o.received = get(/^\s*Received(?: message| value| constructor| name)?:\s*(.*)$/);
    if (!o.received && body.some((l) => /Received function did not throw/.test(l))) o.received = "(the function did not throw)";
    // the first real line under the header: the matcher ("expect(received).toEqual(expected)") or the thrown error text
    o.message = (body.find((l) => l.trim() && !/^\s*(Expected|Received)/.test(l)) || "").trim();
    // vitest: "AssertionError: expected NaN to deeply equal 2"
    const vm = /AssertionError:\s*expected (.+?) to (?:deeply )?(?:equal|be|strictly equal) (.+)$/.exec(text);
    if (vm && !o.expected) { o.received = vm[1]; o.expected = vm[2]; }
    o.line = firstLocation(body.filter((l) => /\bat\b|\(/.test(l)).join("\n")) || firstLocation(text);
    res.push(entry(name, o));
  }
  return res;
}
// vitest prints " FAIL  file > suite > name" and then "AssertionError: expected 0 to be 2"
function parseVitest(out) {
  if (!/\bvitest\b|⎯⎯/i.test(out)) return [];
  const res = [];
  const parts = out.split(/^\s*FAIL\s+/m).slice(1);
  for (const p of parts) {
    const lines = p.split(/\r?\n/);
    const name = lines[0].trim();
    if (!/>/.test(name)) continue;
    const text = lines.slice(1, 40).join("\n");
    const o = {};
    const vm = /AssertionError:\s*expected (.+?) to (?:deeply )?(?:equal|be|strictly equal) (.+)$/m.exec(text);
    if (vm) { o.received = vm[1]; o.expected = vm[2]; }
    const em = /^\s*(\w*Error:.*)$/m.exec(text); if (em) o.message = em[1];
    const ex = /^-\s*Expected\s*[:]?\s*(.+)$/m.exec(text), rc = /^\+\s*Received\s*[:]?\s*(.+)$/m.exec(text);
    if (ex && !o.expected) o.expected = ex[1]; if (rc && !o.received) o.received = rc[1];
    o.line = firstLocation(text);
    res.push(entry(name, o));
  }
  return res;
}

// ---- mocha ----
function parseMocha(out) {
  if (!/\d+ failing/.test(out)) return [];
  const after = out.substring(out.search(/\d+ failing/));
  const res = [];
  const blocks = after.split(/^\s{2}\d+\)\s+/m).slice(1);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/);
    let i = 0; const nameParts = [];
    while (i < lines.length && lines[i].trim() && !/Error\b|^\s*\w*Error/.test(lines[i])) { nameParts.push(lines[i].trim().replace(/:$/, "")); i++; }
    while (i < lines.length && !lines[i].trim()) i++;
    const text = lines.slice(i).join("\n");
    const o = { message: (lines[i] || "").trim() };
    const ne = /^\s*(.+?)\s+!==?\s+(.+?)\s*$/m.exec(text);
    if (ne && !/expected|actual/i.test(ne[0])) { o.received = ne[1]; o.expected = ne[2]; }
    const exp = /^\s*expected:\s*(.+)$/m.exec(text), act = /^\s*actual:\s*(.+)$/m.exec(text);
    if (exp) o.expected = exp[1].replace(/,\s*$/, ""); if (act) o.received = act[1].replace(/,\s*$/, "");
    o.line = firstLocation(text);
    res.push(entry(nameParts.join(" ") || "(mocha test)", o));
  }
  return res;
}

// ---- node:test (spec reporter and TAP) ----
function parseNodeTest(out) {
  const res = [];
  // spec reporter: after "✖ failing tests:" each failure is "test at file:L:C\n✖ name (ms)\n  Error..."
  const fi = out.indexOf("failing tests:");
  if (fi >= 0) {
    const blocks = out.substring(fi).split(/^test at /m).slice(1);
    for (const b of blocks) {
      const lines = b.split(/\r?\n/);
      const loc = lines[0].trim();
      const nm = /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(lines[1] || "");
      const text = lines.slice(2).join("\n");
      const o = { line: (/([\w.-]+\.\w+:\d+)/.exec(loc) || [])[1] || firstLocation(text) };
      o.message = ((lines[2] || "").trim());
      const ne = /^\s*(.+?)\s+!==\s+(.+?)\s*$/m.exec(text);
      if (ne) { o.received = ne[1]; o.expected = ne[2]; }
      const act = /^\s*actual:\s*(.+?),?\s*$/m.exec(text), exp = /^\s*expected:\s*(.+?),?\s*$/m.exec(text);
      if (act) o.received = act[1]; if (exp) o.expected = exp[1];
      res.push(entry(nm ? nm[1] : loc, o));
    }
    if (res.length) return res;
  }
  // TAP: "not ok 1 - name" + yaml block
  const tap = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)];
  for (const m of tap) {
    const rest = out.substring(m.index + m[0].length, m.index + m[0].length + 3000);
    const stop = rest.search(/^\s*(?:not )?ok \d+ /m);
    const text = stop >= 0 ? rest.substring(0, stop) : rest;
    if (/^\s*#\s*Subtest/m.test(m[1])) continue;
    const o = {};
    const err = /error:\s*\|?-?\s*\n?\s*['"]?(.+?)['"]?\s*$/m.exec(text); if (err) o.message = err[1];
    const exp = /^\s*expected:\s*(.+)$/m.exec(text), act = /^\s*actual:\s*(.+)$/m.exec(text);
    if (exp) o.expected = exp[1]; if (act) o.received = act[1];
    const loc = /location:\s*'?([^'\n]+)'?/.exec(text); o.line = loc ? firstLocation(loc[1]) || loc[1] : firstLocation(text);
    res.push(entry(m[1], o));
  }
  return res;
}

// ---- pytest ----
function parsePytest(out) {
  const res = [];
  const lines = out.split(/\r?\n/);
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^_{3,}\s+(.+?)\s+_{3,}\s*$/.test(lines[i])) heads.push(i);
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h];
    let end = h + 1 < heads.length ? heads[h + 1] : lines.length;
    for (let k = start + 1; k < end; k++) if (/^={5,}/.test(lines[k])) { end = k; break; }
    const name = /^_{3,}\s+(.+?)\s+_{3,}\s*$/.exec(lines[start])[1];
    const body = lines.slice(start + 1, end);
    const eLines = body.filter((l) => /^E\s/.test(l)).map((l) => l.replace(/^E\s+/, ""));
    const o = { message: eLines[0] || "" };
    const ae = /^assert (.+?) == (.+)$/.exec(eLines[0] || "");
    if (ae) { o.received = ae[1]; o.expected = ae[2]; }
    const ue = /^AssertionError: (.+?) != (.+)$/.exec(eLines[0] || "");
    if (ue) { o.received = ue[1]; o.expected = ue[2]; }
    const rx = eLines.find((l) => /^Expected (regex|message|pattern):/.test(l)); const am = eLines.find((l) => /^(Actual|Input) message:|^Input:/.test(l));
    if (rx) o.expected = rx.replace(/^Expected \w+:\s*/, ""); if (am) o.received = am.replace(/^[\w ]+:\s*/, "");
    if (!o.message) { const tb = body.filter((l) => l.trim()).pop(); o.message = tb || ""; }
    const loc = body.map((l) => /^([\w./\\-]+\.py):(\d+):/.exec(l)).filter(Boolean).pop();
    o.line = loc ? `${loc[1].split(/[\\/]/).pop()}:${loc[2]}` : firstLocation(body.join("\n"));
    res.push(entry(name, o));
  }
  if (res.length) return res;
  // only the short summary is there (-q -rf): "FAILED file.py::Class::test - message"
  for (const m of out.matchAll(/^FAILED\s+(\S+?)(?:\s+-\s+(.*))?$/gm)) res.push(entry(m[1].split("::").pop(), { message: m[2] || "", line: m[1].split("::")[0] }));
  // collection errors: "ERROR collecting x.py" + "E   ImportError: ..."
  if (!res.length) for (const m of out.matchAll(/^_{3,}\s*ERROR collecting (\S+)\s*_{3,}$/gm)) {
    const e = /^E\s+(.+)$/m.exec(out.substring(m.index)); res.push(entry(`collecting ${m[1]}`, { message: e ? e[1] : "collection error", line: m[1] }));
  }
  return res;
}

// ---- unittest ----
function parseUnittest(out) {
  const res = [];
  const blocks = out.split(/^={20,}\s*$/m).slice(1);
  for (const b of blocks) {
    const hm = /^(FAIL|ERROR):\s+(\S+)(?:\s+\(([^)]*)\))?/m.exec(b);
    if (!hm) continue;
    const lines = b.split(/\r?\n/).filter((l) => l.trim() && !/^-{20,}$/.test(l));
    const last = [...lines].reverse().find((l) => /^\w[\w.]*(Error|Exception|Failure)\b|^AssertionError/.test(l.trim())) || lines[lines.length - 1] || "";
    const o = { message: last.trim() };
    const ue = /AssertionError: (.+?) != (.+)$/.exec(last);
    if (ue) { o.received = ue[1]; o.expected = ue[2]; }
    const frames = [...b.matchAll(/File "([^"]+)", line (\d+)/g)].filter((m) => !/[\\/]unittest[\\/]|[\\/]lib[\\/]python/i.test(m[1]));
    const fr = frames.pop();
    o.line = fr ? `${fr[1].split(/[\\/]/).pop()}:${fr[2]}` : "";
    res.push(entry(hm[2], o));
  }
  return res;
}

// ---- go test ----
function parseGo(out) {
  const res = [];
  for (const m of out.matchAll(/^\s*--- FAIL: (\S+)/gm)) {
    const rest = out.substring(m.index + m[0].length).split(/\r?\n/).slice(1, 12);
    const msgLine = rest.find((l) => /^\s+\S+\.go:\d+:/.test(l)) || "";
    const lm = /^\s+(\S+\.go):(\d+):\s*(.*)$/.exec(msgLine);
    const o = { message: lm ? lm[3] : "", line: lm ? `${lm[1]}:${lm[2]}` : "" };
    const gw = /got:?\s*(.+?)[,;]?\s+want:?\s*(.+)$/i.exec(o.message); if (gw) { o.received = gw[1]; o.expected = gw[2]; }
    const eg = /expected:?\s*(.+?)[,;]?\s+(?:got|but got|actual):?\s*(.+)$/i.exec(o.message); if (eg && !gw) { o.expected = eg[1]; o.received = eg[2]; }
    res.push(entry(m[1], o));
  }
  return res;
}

// ---- cargo test ----
function parseCargo(out) {
  const res = [];
  for (const m of out.matchAll(/^---- (\S+) stdout ----$/gm)) {
    const text = out.substring(m.index + m[0].length, m.index + m[0].length + 2000);
    const stop = text.search(/^---- |^failures:$/m);
    const t = stop >= 0 ? text.substring(0, stop) : text;
    const o = {};
    const pm = /panicked at ([^\s:]+):(\d+):\d+:?\s*\n?(.*)/.exec(t);
    if (pm) { o.line = `${pm[1].split(/[\\/]/).pop()}:${pm[2]}`; o.message = (pm[3] || "").trim(); }
    const left = /^\s*left:\s*`?(.+?)`?,?\s*$/m.exec(t), right = /^\s*right:\s*`?(.+?)`?\s*$/m.exec(t);
    if (left) o.received = left[1]; if (right) o.expected = right[1];
    if (!o.message) o.message = (t.split(/\r?\n/).find((l) => l.trim()) || "").trim();
    res.push(entry(m[1], o));
  }
  return res;
}

// ---- maven / junit ----
function parseJava(out) {
  const res = [];
  for (const m of out.matchAll(/^(?:\[ERROR\]\s+)?(\S+?)\((\S+?)\)\s+Time elapsed:.*?<<<\s*(?:FAILURE|ERROR)!\s*\r?\n(.+)$/gm)) {
    const o = { message: m[3].trim() };
    const ex = /expected:\s*<(.*?)>\s*but was:\s*<(.*?)>/.exec(m[3]); if (ex) { o.expected = ex[1]; o.received = ex[2]; }
    const at = new RegExp(`at ${m[2].replace(/[.$]/g, "\\$&")}\\.${m[1]}\\((\\w+\\.java):(\\d+)\\)`).exec(out.substring(m.index));
    o.line = at ? `${at[1]}:${at[2]}` : "";
    res.push(entry(`${m[2].split(".").pop()}.${m[1]}`, o));
  }
  if (res.length) return res;
  // surefire summary lines: "[ERROR]   CalcTest.testAdd:12 expected:<2> but was:<3>"
  for (const m of out.matchAll(/^\[ERROR\]\s{2,}(\w+)\.(\w+):(\d+)\s+(.+)$/gm)) {
    const o = { message: m[4], line: `${m[1]}.java:${m[3]}` };
    const ex = /expected:\s*<(.*?)>\s*but was:\s*<(.*?)>/.exec(m[4]); if (ex) { o.expected = ex[1]; o.received = ex[2]; }
    res.push(entry(`${m[1]}.${m[2]}`, o));
  }
  return res;
}

function fallback(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-FALLBACK_LINES).join("\n");
  return tail ? [{ name: "(could not read single failures; last lines of the output)", expected: "", received: "", message: tail, line: "", fallback: true }] : [];
}

export function extractFailures(out, max = 2) {
  try {
    const s = stripAnsi(out);
    if (!s.trim()) return [];
    const order = [];
    if (/^\s*●\s/m.test(s)) order.push(parseJest);
    if (/vitest|⎯⎯/i.test(s)) order.unshift(parseVitest);
    if (/failing tests:|^\s*not ok \d+ /m.test(s)) order.push(parseNodeTest);
    if (/\d+ failing/.test(s)) order.push(parseMocha);
    if (/^_{3,} .+ _{3,}$|^FAILED \S+::|ERROR collecting/m.test(s)) order.push(parsePytest);
    if (/^(FAIL|ERROR): \w+/m.test(s)) order.push(parseUnittest);
    if (/^\s*--- FAIL: /m.test(s)) order.push(parseGo);
    if (/^---- \S+ stdout ----$/m.test(s)) order.push(parseCargo);
    if (/<<<\s*(FAILURE|ERROR)!|^\[ERROR\]\s{2,}\w+\.\w+:\d+/m.test(s)) order.push(parseJava);
    for (const p of order) {
      let r = [];
      try { r = p(s); } catch { r = []; }
      if (r.length) return r.slice(0, Math.max(1, max));
    }
    return fallback(s);
  } catch {
    try { return fallback(String(out || "")); } catch { return []; }
  }
}

// How many tests failed, from the runner's own summary line. null = not known.
// Jest prints "Test Suites: 1 failed" BEFORE "Tests: 13 failed", so the generic "N failed" match would read 1: read the Tests line first.
export function countFailing(out) {
  try {
    const s = stripAnsi(out);
    let m = /^\s*Tests:\s+(?:(\d+) failed)?/m.exec(s); if (m && m[1]) return +m[1];
    if (m) return 0;
    m = /FAILED \((?:failures=(\d+))?,?\s*(?:errors=(\d+))?\)/.exec(s); if (m) return (+(m[1] || 0)) + (+(m[2] || 0));
    m = /^[ \t]*(?:ℹ|#)[ \t]+fail[ \t]+(\d+)\b/m.exec(s); if (m) return +m[1];
    m = /^[ \t]*(\d+) failing\b/m.exec(s); if (m) return +m[1];
    // pytest: only its own summary line ("2 failed, 1 passed in 0.15s"), never words a program printed ("3 errors found")
    const sum = s.split(/\r?\n/).reverse().find((l) => /\b\d+ (?:failed|passed|errors?)\b.*\bin [\d.]+s\b/.test(l));
    if (sum) { const f = /(\d+) failed\b/.exec(sum), e = /(\d+) errors?\b/.exec(sum); return (f ? +f[1] : 0) + (e ? +e[1] : 0); }
    const go = (s.match(/^\s*--- FAIL: /gm) || []).length; if (go) return go;
    m = /test result: FAILED\.\s+\d+ passed;\s+(\d+) failed/.exec(s); if (m) return +m[1];
    m = /Tests run:\s*\d+,\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/.exec(s); if (m) return +m[1] + +m[2];
    return null;
  } catch { return null; }
}

// The block that goes at the TOP of a repair prompt. "" when there is nothing to show.
export function failuresBlock(out, max = 2) {
  try {
    const fs = extractFailures(out, max);
    if (!fs.length) return "";
    if (fs[0].fallback) return `LAST LINES OF THE REAL TEST OUTPUT (read them first):\n${fs[0].message}\n\n`;
    const rows = fs.map((f, i) => {
      const parts = [`${i + 1}. ${f.name}`];
      if (f.expected) parts.push(`   expected: ${f.expected}`);
      if (f.received) parts.push(`   received: ${f.received}`);
      if (f.message && f.message !== f.expected) parts.push(`   message: ${f.message}`);
      if (f.line) parts.push(`   at: ${f.line}`);
      return parts.join("\n");
    });
    return `FIRST FAILING TEST${fs.length > 1 ? "S" : ""} (exact text from the real test run - use these exact values and messages):\n${rows.join("\n")}\n\n`;
  } catch { return ""; }
}

// STRONG2 B8 (2026-11-16): the exact error messages a TEST file expects, read from the test text itself (no run needed), so a
// retry can be told the message character for character. jest/vitest toThrow('...'), rejects.toThrow, chai .throw('...'),
// unittest assertRaisesRegex(E, '...') and assertRaises ... str(e) == '...', pytest.raises(E, match='...'), JUnit
// assertThrows(...) + getMessage() equals, RSpec raise_error(E, '...'), PHPUnit expectExceptionMessage('...'), Go err.Error() == "...".
// Regex-looking matches (pytest match=, assertRaisesRegex) are kept only when they contain no regex syntax. Returns unique strings.
export function expectedErrorStrings(testText) {
  const out = [];
  try {
    const s = String(testText || "");
    const lit = String.raw`("(?:[^"\\\n]|\\.){3,160}"|'(?:[^'\\\n]|\\.){3,160}'|` + "`[^`\\n]{3,160}`" + ")";
    const pats = [
      String.raw`\.(?:toThrow|toThrowError|rejects\.toThrow|throw|throws)\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?` + lit,
      String.raw`assertRaisesRegexp?\s*\(\s*[\w.]+\s*,\s*r?` + lit,
      String.raw`pytest\.raises\s*\([^)]*?match\s*=\s*r?` + lit,
      String.raw`raise_error\s*\(\s*[\w:]+\s*,\s*` + lit,
      String.raw`expectExceptionMessage\s*\(\s*` + lit,
      String.raw`(?:getMessage|message|Message)\s*\(?\)?\s*(?:==|===|\.equals\s*\(|,)\s*` + lit,
      String.raw`assertEquals\s*\(\s*` + lit + String.raw`\s*,\s*[\w.]+\.getMessage\s*\(\s*\)`,
      String.raw`str\s*\(\s*\w+(?:\.exception)?\s*\)\s*,?\s*(?:==)?\s*` + lit,
      String.raw`\.Error\s*\(\s*\)\s*(?:!=|==)\s*` + lit,
      String.raw`assertEqual\s*\(\s*str\s*\(\s*[\w.]+\s*\)\s*,\s*` + lit,
    ];
    for (const p of pats) {
      for (const m of s.matchAll(new RegExp(p, "g"))) {
        const raw = m[1]; if (!raw) continue;
        let v = raw.slice(1, -1).replace(/\\(["'`\\])/g, "$1");
        if (/^assertRaisesRegex|^pytest/.test(p) && /[\\^$*+?()[\]{}|]/.test(v)) continue; // a real regex: not an exact text
        if (/[A-Za-z]{2}/.test(v) && !out.includes(v)) out.push(v);
      }
    }
  } catch {}
  return out.slice(0, 10);
}
