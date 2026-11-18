// test-lang2.mjs: STRONG2 language gaps (A1-A8) and the new end-of-run watchdog rules wired into the REAL agent (B1-B6).
// NO real model, NO GPU. Only Python, Node and CMake are on this PC: other languages are tested with sample TEXT and with FAKE
// tools on a fake PATH (a gofmt.cmd that prints what gofmt prints). The only real compiler run here is tsc (installed) and
// node --test / python unittest. Nothing here proves that a real go / cargo / javac run behaves the same.
// Run: node test-lang2.mjs
import fs from "fs"; import os from "os"; import path from "path"; import http from "http";
import { isTestPathAny, langOfPath, isCodeFile, codeMask, braceTopBlocks, braceStubs, langStubMarker, pickTool, runSyntaxCheck, codeFrames, compiledFailNames } from "./langs.mjs";
import { Agent, setProvider, provider, isTestFile, detectTestCmd, detectTestCmdMore, topLevelDefs, droppedDefs, blockKind, braceDedupeRepeats, braceSalvageNewDefs, bracePreserveDroppedDefs, salvageNewDefs, salvageNewDefsFor, dedupeSelfRepeatedDefsFor, preserveDroppedDefsFor, preserveDroppedMethodsFor, gate, detectStubs, verifierScore, scoreTestOutput, failSignature, parseFailure, pickImplFile, dropBuiltinNames } from "./agent.mjs";
import { isTestPath, symbolMap, contractNamedFiles, vocabLocalize } from "./localize.mjs";
import { snapshotCode } from "./watchdog.mjs";

let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.substring(0, 500) + ")"}`); };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), "eta-lang2-" + p + "-"));
const w = (root, f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
const rd = (root, f) => fs.readFileSync(path.join(root, f), "utf8");
const names = (s, rel) => [...topLevelDefs(s, rel)].sort().join(",");

console.log("A1. test files of every language (one table), and normal source files stay source files");
{
  const yes = ["spec/calc_spec.rb", "calc_spec.rb", "test_calc.rb", "tests/CalcTest.php", "CalcTest.php", "Tests/CalcTests/CalcTests.swift", "CalcTests.swift",
    "src/__tests__/calc.js", "calc_test.go", "tests/it.rs", "src/test/java/a/CalcTest.java", "CalcTest.kt", "CalcSpec.kt", "Calc.Tests/CalcTests.cs",
    "calc_test.cc", "calc_unittest.cpp", "calc_tests.cpp", "TESTS/a.py", "Spec/a.rb", "test_data/fixture.json", "app.test.ts", "app.spec.js"];
  const no = ["src/calc.rb", "Contest.java", "src/latest.py", "src/testing.go", "lib/spec_helper_lib.js", "Attest.php", "src/main.rs", "src/Calc.cs", "calc.cpp", "contest.swift", "ResponseSpec.java", "testsuite.c", "protest/x.py"];
  ok(yes.every((f) => isTestPathAny(f) && isTestFile(f) && isTestPath(f)), "all known test names are tests (engine, finder and table agree)", yes.filter((f) => !(isTestPathAny(f) && isTestFile(f) && isTestPath(f))));
  ok(no.every((f) => !isTestPathAny(f) && !isTestPath(f)), "normal source files are NOT tests", no.filter((f) => isTestPathAny(f) || isTestPath(f)));
  ok(isTestFile("tests\\win\\a.py") && isTestPathAny("Tests\\A.swift"), "Windows separators work");
  ok(!isTestPathAny("") && !isTestPathAny(null), "empty input: not a test (fail-open)");
}

console.log("A2. test command detection: more languages, Python/JS unchanged");
{
  const mk = (files) => { const d = tmp("dtc"); for (const [f, s] of Object.entries(files)) w(d, f, s); return d; };
  const cases = [
    [{ "Gemfile": "gem 'rspec'", "spec/calc_spec.rb": "x", "lib/calc.rb": "x" }, "bundle exec rspec"],
    [{ ".rspec": "", "spec/a_spec.rb": "x" }, "rspec"],
    [{ "Rakefile": "x", "test/calc_test.rb": "x", "calc.rb": "x" }, "rake test"],
    [{ "two_fer.rb": "x", "two_fer_test.rb": "x" }, "ruby two_fer_test.rb"],
    [{ "composer.json": "{}", "phpunit.xml": "<x/>", "src/A.php": "x" }, "phpunit"],
    [{ "Calc.php": "x", "CalcTest.php": "x" }, "phpunit ."],
    [{ "Package.swift": "x" }, "swift test"],
    [{ "Makefile": "all:\n\tcc a.c\n\ntest: all\n\t./a\n", "a.c": "x" }, "make test"],
    [{ "backend/go.mod": "module x", "backend/a.go": "x", "README.md": "x" }, 'cd "backend" && go test ./...'],
    [{ "server/Cargo.toml": "x" }, 'cd "server" && cargo test'],
    [{ "api/pom.xml": "x" }, 'cd "api" && mvn -q test'],
  ];
  for (const [files, want] of cases) { const d = mk(files); const got = await detectTestCmd(d); ok(got === want, `${Object.keys(files).join(" + ")} -> ${want}`, got); fs.rmSync(d, { recursive: true, force: true }); }
  { const d = mk({ "a/go.mod": "x", "b/Cargo.toml": "x" }); ok((await detectTestCmd(d)) === null, "two sub-folders with build files: no guess (null)"); fs.rmSync(d, { recursive: true, force: true }); }
  { const d = mk({ "Makefile": "all:\n\tcc a.c\n" }); ok((await detectTestCmd(d)) === null, "a Makefile without a test target: null"); fs.rmSync(d, { recursive: true, force: true }); }
  { const d = mk({ "node_modules/x/go.mod": "x" }); ok((await detectTestCmdMore(d)) === "", "node_modules is never read as a sub-project"); fs.rmSync(d, { recursive: true, force: true }); }
  // Python / JavaScript: the old answers
  { const d = mk({ "test_a.py": "x", "Gemfile": "x" }); ok((await detectTestCmd(d)) === 'python -m unittest discover -p "test*.py"', "Python test file + a Gemfile: Python still wins (old order)"); fs.rmSync(d, { recursive: true, force: true }); }
  { const d = mk({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "Package.swift": "x" }); ok((await detectTestCmd(d)) === "npm test --silent", "package.json test script still wins"); fs.rmSync(d, { recursive: true, force: true }); }
  { const d = mk({ "tests/README.md": "x" }); ok((await detectTestCmd(d)) === null, "a tests/ folder with no tests: still null"); fs.rmSync(d, { recursive: true, force: true }); }
  const srv = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  ok(/async function detectBaseline\(ws\) \{\s*try \{ const shared = await detectTestCmd\(ws\)/.test(srv) && /import \{[^}]*detectTestCmd[^}]*\} from "\.\/agent\.mjs"/.test(srv), "server.mjs detectBaseline calls the shared detectTestCmd");
}

console.log("A3. definition guard for Java, C#, Kotlin, Swift, PHP, Ruby, C/C++; unknown language = guard off");
{
  const JAVA = "package a;\n\nimport java.util.*;\n\npublic class Calc {\n    private final Map<String, Integer> cache = new HashMap<>();\n    public int add(int a, int b) {\n        return a + b;\n    }\n    public static List<Integer> range(int n) {\n        return helper(n);\n    }\n    int packagePrivate() { return 1; }\n}\n\ninterface Shape { double area(); }\n";
  ok(names(JAVA, "Calc.java") === "Calc,Shape,add,range", "Java: class, interface, methods with a modifier (not fields, not calls)", names(JAVA, "Calc.java"));
  ok(droppedDefs(JAVA, JAVA.replace("public int add(", "public int plus("), "Calc.java").join() === "add", "Java: a renamed method is reported");
  ok(droppedDefs(JAVA, JAVA.replace("return a + b;", "return b + a;"), "Calc.java").length === 0, "Java: a body edit reports nothing");
  const CS = "namespace App {\n  public sealed class Account {\n    public decimal Balance { get; private set; }\n    public async Task<bool> Deposit(decimal x) { return true; }\n    private static (int, int) Pair() => (1, 2);\n  }\n  public record Point(int X, int Y);\n  internal enum Kind { A, B }\n}\n";
  ok(names(CS, "Account.cs") === "Account,Deposit,Kind,Pair,Point", "C#: class, record, enum, methods (async, tuple return)", names(CS, "Account.cs"));
  const KT = "package a\n\ndata class User(val name: String)\nobject Registry {\n    fun find(id: Int): User? = null\n}\nsuspend fun <T> List<T>.firstOrWait(): T = first()\nprivate fun helper() {}\n";
  ok(names(KT, "a.kt") === "Registry,User,firstOrWait,helper,find".split(",").sort().join(","), "Kotlin: data class, object, fun (extension + generic)", names(KT, "a.kt"));
  const SW = "import Foundation\n\npublic struct Stack<T> {\n    var items: [T] = []\n    mutating func push(_ x: T) { items.append(x) }\n    static func empty() -> Stack { Stack() }\n}\nextension Stack {\n    func peek() -> T? { items.last }\n}\nclass func notAName() {}\nprotocol Shape {\n    func area() -> Double\n}\n";
  ok(names(SW, "Stack.swift") === "Shape,Stack,area,empty,notAName,peek,push", "Swift: struct, extension, protocol, funcs; 'class func' is not a type named func", names(SW, "Stack.swift"));
  const PHP = "<?php\nnamespace App;\n\nfinal class Calc\n{\n    public function add(int $a, int $b): int { return $a + $b; }\n    private static function helper() {}\n}\n\nfunction topLevel() { return 1; }\n$fn = function ($x) { return $x; };\n";
  ok(names(PHP, "Calc.php") === "Calc,add,helper,topLevel", "PHP: class, methods, top-level function, not a closure", names(PHP, "Calc.php"));
  const RB = "module Bank\n  class Account\n    def initialize(b)\n      @b = b\n    end\n\n    def deposit!(x)\n      @b += x\n    end\n\n    def self.open\n    end\n  end\nend\n";
  ok(names(RB, "account.rb") === "Account,Bank,deposit!,initialize,open", "Ruby: module, class, def (bang + self.)", names(RB, "account.rb"));
  const C = "#include <stdio.h>\n#define MAX 10\n\nstruct point {\n  int x;\n};\n\nstatic int helper(int a);\n\nint add(int a, int b)\n{\n  return a + b;\n}\n\nconst char *name(void) {\n  return \"x\";\n}\n\nint Calc::mul(int a, int b) const {\n  return a * b;\n}\n";
  ok(names(C, "calc.cpp") === "Calc::mul,MAX,add,name,point", "C/C++: definitions (not the prototype), struct, #define, A::f", names(C, "calc.cpp"));
  ok(droppedDefs(C, C.replace("int add(int a, int b)", "int sum(int a, int b)"), "calc.c").join() === "add", "C: a renamed function is reported");
  ok(topLevelDefs("x = 1\nfunction f() end\n", "a.lua").size === 0 && droppedDefs("X = 1\n", "", "run.sh").length === 0, "unknown code language (.lua, .sh): guard off, nothing reported");
  ok(names("X = 1\ndef f():\n    pass\n", "m.py") === "X,f" && names("X = 1\n") === "X", "Python with and without a path: unchanged");

  console.log("A3b. which block helpers may touch a file, and the { } block helpers");
  ok(blockKind("a.py") === "py" && blockKind(undefined) === "py" && blockKind("notes.txt") === "py" && blockKind("A.java") === "brace" && blockKind("a.js") === "brace" && blockKind("a.rb") === "none" && blockKind("a.lua") === "none", "blockKind table");
  const JS = "export class Box {\n  constructor(v) { this.v = v; }\n}\n";
  const TPL = "const x = 1;\nclass Box {\n  m() { return `}`; }\n}\n";
  const pyCut = salvageNewDefs("const x = 1;\n", TPL);
  ok(pyCut && /m\(\) \{ return `\}`; \}\s*$/.test(pyCut), "(contrast) the OLD Python salvage on a JS class with a `}` in a template cuts the class's closing brace away", pyCut);
  ok(salvageNewDefsFor("box.js", "const x = 1;\n", TPL).endsWith("class Box {\n  m() { return `}`; }\n}\n"), "the brace salvage keeps the class whole");
  const merged = salvageNewDefsFor("box.js", "const x = 1;\n", "const x = 1;\n" + JS + "\nfunction helper() {\n  return '}';\n}\n");
  ok(merged && merged.includes("export class Box {\n  constructor(v) { this.v = v; }\n}") && merged.includes("function helper() {\n  return '}';\n}"), "brace salvage keeps each new block WHOLE (closing braces, a '}' inside a string)", merged);
  const goOld = "package m\n\nfunc Keep() int {\n\treturn 1\n}\n\nfunc Drop() int {\n\treturn 2\n}\n";
  const goNew = "package m\n\nfunc Keep() int {\n\treturn 1\n}\n\nfunc Added() int {\n\treturn 3\n}\n";
  const kept = preserveDroppedDefsFor("m.go", goOld, goNew);
  ok(kept && kept.names.join() === "Drop" && kept.text.includes("func Drop() int {\n\treturn 2\n}") && kept.text.includes("func Added()"), "brace preserve: a lost Go function comes back whole, the new one stays", kept);
  const dup = "fn a() -> i32 {\n    1\n}\n\nfn a() -> i32 {\n    1\n}\n\nfn b(x: i32) -> i32 { x }\nfn b(x: i32) -> i32 { x + 1 }\n";
  const dd = dedupeSelfRepeatedDefsFor("lib.rs", dup);
  ok(dd && dd.names.join() === "a" && (dd.text.match(/fn a\(\)/g) || []).length === 1 && (dd.text.match(/fn b\(/g) || []).length === 2, "brace dedupe drops only an EXACT repeat (two different b's stay)", dd);
  ok(braceTopBlocks("function f() {\n  return '{';\n", "a.js", (t) => topLevelDefs(t, "a.js")) === null && salvageNewDefsFor("a.js", "x", "function g() {\n  if (a) {\n}\n") === null, "unbalanced braces: null, nothing touched");
  ok(salvageNewDefsFor("a.rb", "def a\nend\n", "def b\nend\n") === null && preserveDroppedMethodsFor("A.java", "class A {}", "class B {}") === null, "Ruby and Java never go through the Python helpers");
  const rsTricky = "fn longest<'a>(x: &'a str) -> &'a str {\n    let c = '{';\n    let s = r#\"}\"#;\n    x\n}\n";
  const rb = braceTopBlocks(rsTricky, "a.rs", (t) => topLevelDefs(t, "a.rs"));
  ok(rb && rb.length === 1 && rb[0].text === rsTricky.trimEnd(), "Rust: lifetimes, a '{' char and a raw string do not confuse the brace matcher", rb);
  const jsRe = "const re = /[{'\"]/g;\nfunction f(a) {\n  return `${a}}` + \"{\";\n}\n";
  const jb = braceTopBlocks(jsRe, "a.js", (t) => topLevelDefs(t, "a.js"));
  ok(jb && jb.length === 1 && jb[0].name === "f" && jb[0].text.endsWith("\"{\";\n}"), "JS: regex literal, template and strings with braces", jb);
  const csV = "class A {\n  string p = @\"C:\\dir\\\";\n  void F() { }\n}\n";
  ok((braceTopBlocks(csV, "A.cs", (t) => topLevelDefs(t, "A.cs")) || []).length === 1, "C#: verbatim string ending in a backslash");
}

console.log("A4. syntax checker per language, picked from the PATH (fake tools; the only real one is tsc)");
{
  const fake = tmp("fakebin");
  const isWin = process.platform === "win32";
  const tool = (name, body) => { const f = path.join(fake, name + (isWin ? ".cmd" : "")); fs.writeFileSync(f, isWin ? "@echo off\r\n" + body.replace(/\n/g, "\r\n") + "\r\n" : "#!/bin/sh\n" + body + "\n"); if (!isWin) fs.chmodSync(f, 0o755); return f; };
  tool("gofmt", isWin ? 'findstr /c:"BROKEN" %3 >nul && (echo %~nx3:3:1: expected \'}\', found \'EOF\' 1>&2 & exit /b 2)\nexit /b 0' : 'grep -q BROKEN "$3" && { echo "x.go:3:1: expected }" >&2; exit 2; }\nexit 0');
  tool("g++", isWin ? 'echo a.cpp:1:10: fatal error: foo.h: No such file or directory 1>&2\necho a.cpp:2:5: error: expected \';\' before \'}\' token 1>&2\nexit /b 1' : 'echo "fatal error: foo.h: No such file" >&2; echo "error: expected ;" >&2; exit 1');
  const PATHV = fake + (isWin ? ";" : ":") + (process.env.PATH || "");
  ok(pickTool("gofmt", PATHV) && pickTool("gofmt", PATHV).startsWith(fake), "pickTool finds a tool on a (fake) PATH");
  ok(pickTool("rustfmt", fake) === "" && pickTool("no-such-tool-xyz", PATHV) === "", "pickTool: missing tool = ''");
  const d = tmp("syn");
  w(d, "good.go", "package m\n\nfunc A() int { return 1 }\n"); w(d, "bad.go", "package m\n\nfunc A() int { // BROKEN\n");
  ok((await runSyntaxCheck(path.join(d, "good.go"), "good.go", { pathEnv: PATHV }))?.ok === true, "fake gofmt: a good file passes");
  const bad = await runSyntaxCheck(path.join(d, "bad.go"), "bad.go", { pathEnv: PATHV });
  ok(bad && bad.ok === false && /gofmt syntax check FAILED/.test(bad.msg) && /expected/.test(bad.msg), "fake gofmt: a broken file fails with the tool's message", bad);
  ok((await runSyntaxCheck(path.join(d, "bad.go"), "bad.go", { pathEnv: "" })) === null, "no gofmt on the PATH: null (skipped, fail-open)");
  { const fake2 = tmp("fakebin2"); const f = path.join(fake2, "gofmt" + (isWin ? ".cmd" : "")); fs.writeFileSync(f, isWin ? "@echo off\r\necho 'go' is not recognized as an internal or external command 1>&2\r\nexit /b 1\r\n" : "#!/bin/sh\necho 'go: not found' >&2\nexit 1\n"); if (!isWin) fs.chmodSync(f, 0o755);
    const br = await runSyntaxCheck(path.join(d, "bad.go"), "bad.go", { pathEnv: fake2 });
    ok(br && br.ok === true, "a BROKEN gofmt install (exit 1, no file:line message) is never read as a syntax error", br); fs.rmSync(fake2, { recursive: true, force: true }); }
  w(d, "a.cpp", "#include <foo.h>\nint x\n");
  const cpp = await runSyntaxCheck(path.join(d, "a.cpp"), "a.cpp", { pathEnv: PATHV });
  ok(cpp && cpp.ok === true, "fake g++: 'fatal error: foo.h missing' is NOT a syntax verdict (a missing header is not our syntax error)", cpp);
  w(d, "a.rs", "fn x( {\n");
  ok((await runSyntaxCheck(path.join(d, "a.rs"), "a.rs", { pathEnv: PATHV })) === null, "rustfmt not installed: null");
  ok((await runSyntaxCheck(path.join(d, "a.h"), "a.h", { pathEnv: PATHV })) === null, ".h (C or C++?): no guess");
  // gate() itself, with the fake PATH
  const savedPath = process.env.PATH; process.env.PATH = PATHV; if (isWin) process.env.Path = PATHV;
  try {
    const g1 = await gate(d, "bad.go"), g2 = await gate(d, "good.go");
    ok(!g1.ok && /gofmt/.test(g1.msg) && g2.ok, "gate(): a Go syntax error now fails the gate (fake gofmt), a good file passes", { g1, g2 });
  } finally { process.env.PATH = savedPath; if (isWin) process.env.Path = savedPath; }
  const g3 = await gate(d, "bad.go");
  ok(g3.ok && /no checker for \.go/.test(g3.msg), "gate() without gofmt: the old answer ('no checker for .go')", g3);
  // the REAL tsc (installed on this PC): syntax codes fail, a missing import does not
  if (pickTool("tsc")) {
    w(d, "bad.ts", "const x: number = ;\n"); w(d, "imp.ts", "import y from './nope';\nexport const x: number = 1;\n");
    const tb = await gate(d, "bad.ts"), ti = await gate(d, "imp.ts");
    ok(!tb.ok && /TS1109|tsc syntax check FAILED/.test(tb.msg), "REAL tsc: a syntax error fails the gate", tb);
    ok(ti.ok, "REAL tsc: a missing import (TS2307, not syntax) does not fail the gate", ti);
  } else ok(true, "SKIPPED real tsc check (tsc not installed)");
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(fake, { recursive: true, force: true });
}

console.log("A5. stubs in every language (brace matching for the body)");
{
  const S = {
    "lib.rs": "pub fn add(a: i32, b: i32) -> i32 {\n    todo!()\n}\npub fn ok() -> i32 { 1 }\nfn later() { unimplemented!(\"soon\") }\n",
    "calc.go": "package calc\n\n// Add adds.\nfunc Add(a, b int) int {\n\tpanic(\"Please implement the Add function\")\n}\n\nfunc Real() int {\n\tpanic(\"real error: bad state\")\n}\n",
    "Calc.cs": "public class Calc {\n    public int Add(int a, int b)\n    {\n        throw new NotImplementedException(\"You need to implement this method.\");\n    }\n    public int Sub(int a, int b) => a - b;\n}\n",
    "Calc.java": "public class Calc {\n    public int add(int a, int b) {\n        throw new UnsupportedOperationException(\"Delete this statement and write your own implementation.\");\n    }\n    public java.util.List<Integer> view() {\n        throw new UnsupportedOperationException(\"read-only\");\n    }\n}\n",
    "calc.js": "export const add = (a, b) => {\n  throw new Error('Remove this statement and implement this function');\n};\nexport function sub(a, b) {\n  // TODO maybe later\n  return a - b;\n}\n",
    "calc.ts": "export function add(a: number, b: number): number {\n  throw new Error(\"Not implemented\");\n}\n",
    "Calc.kt": "fun add(a: Int, b: Int): Int {\n    TODO(\"Implement this function\")\n}\nfun sub(a: Int, b: Int): Int { return a - b }\n",
    "Calc.swift": "func add(_ a: Int, _ b: Int) -> Int {\n    fatalError(\"Please implement add\")\n}\n",
    "Calc.php": "<?php\nfunction add(int $a, int $b): int\n{\n    throw new \\BadFunctionCallException(\"Implement the add function\");\n}\n",
    "calc.rb": "class Calc\n  def add(a, b)\n    raise NotImplementedError, 'Please implement the add method.'\n  end\n\n  def empty\n  end\nend\n",
  };
  const want = { "lib.rs": "add,later", "calc.go": "Add", "Calc.cs": "Add", "Calc.java": "add", "calc.js": "add", "calc.ts": "add", "Calc.kt": "add", "Calc.swift": "add", "Calc.php": "add", "calc.rb": "add" };
  for (const [f, src] of Object.entries(S)) {
    const got = detectStubs(f, src).map((s) => s.name).join();
    ok(got === want[f], `${f}: stubs = ${want[f]}`, got);
  }
  ok(detectStubs("x.py", "def a(self):\n    pass").length === 1, "Python stubs: unchanged");
  ok(langStubMarker("lib.rs", S["lib.rs"]) && langStubMarker("calc.go", S["calc.go"]) && !langStubMarker("calc.go", "panic(\"real error\")") && !langStubMarker("a.py", "raise NotImplementedError"), "whole-file stub markers (rerank)");
  ok(verifierScore("lib.rs", S["lib.rs"], true) < verifierScore("lib.rs", S["lib.rs"].replace(/todo!\(\)|unimplemented!\("soon"\)/g, "0"), true), "verifierScore ranks a todo!() file lower");
  // the completion loop on a REAL JavaScript project (node --test), with a fake model that answers with the body
  const d = tmp("complete");
  w(d, "package.json", JSON.stringify({ name: "x", type: "module" }));
  w(d, "math.js", "export function add(a, b) {\n  throw new Error('Remove this statement and implement this function');\n}\n\nexport function keep() {\n  return 'k';\n}\n");
  w(d, "math.test.js", "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add, keep } from './math.js';\ntest('add', () => { assert.strictEqual(add(2, 3), 5); });\ntest('keep', () => { assert.strictEqual(keep(), 'k'); });\n");
  const ag = new Agent(d, { model: "fake", numCtx: 16384, autoApprove: true });
  ag.task = "Implement add in math.js"; ag.files = new Set(["math.js"]);
  const replies = ["function add(a, b) {\n  return a - b;\n}", "return a + b;"];
  ag.eta = { chat: async () => ({ content: replies.shift() || "return a + b;" }), model: "fake" };
  ag.overBudget = () => false;
  const gaps = await ag.completenessGaps();
  ok(gaps.length === 1 && gaps[0].name === "add" && gaps[0].file === "math.js", "completenessGaps sees the JS stub (was .py only)", gaps);
  const r = await ag._completeOneStub(gaps[0], "node --test", 1, 2);
  const after = rd(d, "math.js");
  ok(r.changed && r.resolved && r.score === 0 && /return a \+ b;/.test(after) && /export function keep\(\) \{\n  return 'k';\n\}/.test(after), "REAL node --test: the stub body was filled, the best candidate kept, the rest of the file untouched", { r, after });
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("A6. test output of compiled languages: score, failure names, culprit frames");
{
  const GO = "--- FAIL: TestAdd (0.00s)\n    calc_test.go:9: got 1 want 2\n--- FAIL: TestSub (0.00s)\n--- PASS: TestMul (0.00s)\nFAIL\nFAIL\tcalc\t0.01s\n⚠ COMMAND FAILED (exit 1)";
  ok(scoreTestOutput(GO) === 2, "go test: 2 failing (was the flat 999)", scoreTestOutput(GO));
  ok(scoreTestOutput("test result: FAILED. 4 passed; 2 failed; 0 ignored;\ntest result: FAILED. 1 passed; 1 failed; 0 ignored;\n⚠ COMMAND FAILED") === 3, "cargo: failures of every test binary are summed");
  ok(scoreTestOutput("[ERROR] Tests run: 5, Failures: 1, Errors: 1, Skipped: 0\n⚠ COMMAND FAILED") === 2, "maven: failures + errors");
  ok(scoreTestOutput("Test Suites: 1 failed, 1 total\nTests:       13 failed, 2 passed, 15 total\n⚠ COMMAND FAILED") === 13, "jest: the Tests line (13), not the suite line (1)");
  ok(scoreTestOutput("./a.go:5:2: undefined: foo\nFAIL\tdemo [build failed]\n⚠ COMMAND FAILED") === 999, "go build failure stays the uncounted 999 (worse than any counted failure)");
  ok(scoreTestOutput("3 failed, 480 passed in 1.02s") === 3 && scoreTestOutput("Ran 6 tests in 0.01s\n\nOK") === 0, "Python scores unchanged");
  const s1 = failSignature(GO), s2 = failSignature(GO.replace("--- FAIL: TestSub (0.00s)\n", ""));
  ok(s1 === "go:TestAdd,go:TestSub" && s1 !== s2, "go: the failing SET is the signature, so progress is seen", { s1, s2 });
  ok(failSignature("test tests::adds ... FAILED\ntest tests::subs ... ok\n") === "rust:tests::adds", "cargo test names");
  ok(failSignature("[ERROR]   CalcTest.testAdd:12 expected:<3> but was:<2>\n[ERROR] Tests run: 2, Failures: 1") === "junit:CalcTest.testAdd", "maven surefire names");
  ok(failSignature("  ● Calc › adds\n\n    expect(received).toBe(expected)\n") === "jest:Calc › adds", "jest names");
  ok(failSignature("FAILED test_calc.py::test_x - AssertionError\nFAILED test_calc.py::test_y") === "test_calc.py::test_x,test_calc.py::test_y", "pytest names unchanged");
  const fr = codeFrames("goroutine 1 [running]:\nmain.Add()\n\t/home/u/p/calc.go:12 +0x1d\n    at add (D:\\p\\src\\calc.js:4:11)\n    at node:internal/main:1:1\n\tat com.x.Calc.add(Calc.java:12)\n   in C:\\p\\Calc.cs:line 7\nPHP Fatal error: x in /var/www/a.php on line 3\nsrc/lib.rs:12:5\n/usr/lib/go/src/runtime/panic.go:9\n");
  ok(JSON.stringify(fr.map((f) => f.file + ":" + f.line)) === JSON.stringify(["/home/u/p/calc.go:12", "D:\\p\\src\\calc.js:4", "Calc.java:12", "src/lib.rs:12", "C:\\p\\Calc.cs:7", "/var/www/a.php:3"]), "frames: Go, JS, Rust, Java, C#, PHP; runtime frames skipped", fr);
  const d = tmp("culprit"); w(d, "calc.go", "package calc\n"); w(d, "util.go", "package calc\n");
  const diag = parseFailure(`--- FAIL: TestAdd (0.00s)\npanic: boom\n\t${d}${path.sep}util.go:7 +0x1d\n\t${d}${path.sep}calc_test.go:9 +0x2\n`, d);
  ok(/the error is in util\.go at line 7/.test(diag), "parseFailure: the Go frame names the culprit (innermost project file, not the test)", diag);
  const pick = await pickImplFile("\tat com.x.Util.helper(Util.java:12)\n\tat com.x.CalcTest.t(CalcTest.java:5)\n", d, ["src/Calc.java", "src/Util.java", "src/CalcTest.java"], "");
  ok(pick === "src/Util.java", "pickImplFile: a Java frame (file name only) picks the right project file", pick);
  const pick2 = await pickImplFile("nothing useful", d, ["a.kt", "b.swift"], "");
  ok(pick2 === "a.kt", "pickImplFile: Kotlin/Swift files are candidates now (was: none)", pick2);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log("A7/A8. shared code-file list, localize, builtins by language");
{
  const d = tmp("loc");
  w(d, "build.gradle.kts", "plugins {}\n"); w(d, "src/Calc.java", "public class Calc {\n    public int add(int a, int b) { return a + b; }\n    private static String fmt(double d) { return \"\"; }\n}\n");
  w(d, "src/Calc.kt", "fun multiply(a: Int, b: Int) = a * b\n"); w(d, "src/geo.cpp", "int area(int w) {\n  return w;\n}\n"); w(d, "web/app.php", "<?php\nfunction render() {}\n"); w(d, "web/view.vue", "<script>export default {}</script>\n");
  const map = await symbolMap(d);
  ok(/src\/Calc\.java: .*\badd\b.*\bfmt\b/.test(map) && /src\/Calc\.kt: .*multiply/.test(map) && /web\/view\.vue/.test(map), "symbolMap: Java/Kotlin typed methods, and .vue files are listed", map);
  const named = await contractNamedFiles(d, "**src/geo.cpp**: add a function\n- web/app.php: render the page\n");
  ok(named.join() === "src/geo.cpp,web/app.php", "contractNamedFiles: .cpp is no longer read as .c, .php is found", named);
  ok(isCodeFile("a.kts") && isCodeFile("a.mts") && isCodeFile("b.vue") && isCodeFile("c.hh") && !isCodeFile("a.md"), "isCodeFile");
  ok(dropBuiltinNames(["sum", "parse"], ["calc.js"]).join() === "sum,parse" && dropBuiltinNames(["sum", "parse"], ["calc.py"]).join() === "parse" && dropBuiltinNames(["sum", "parse"]).join() === "parse", "dropBuiltinNames: Python builtins dropped only for Python files (old behaviour without files)");
  fs.rmSync(d, { recursive: true, force: true });
  const src = fs.readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
  ok((src.match(/\(isCodeFile\(f\) \|\| \/\\\.html\?\$\/\.test\(f\)\) && !isTestFile\(f\)/g) || []).length === 2, "srcText (missing quoted literals) reads every language, in both places");
}

console.log("B. the new end-of-run rules inside the REAL agent (fake model, real files)");
// fake model server: the executor never writes (the rest-api failure), the file writer answers with good code
let MODE = "lazy";
const GOOD = "def add(a, b):\n    return a + b\n";
const STUB = "def add(a, b):\n    raise NotImplementedError('Remove this statement and implement this function')\n";
const TESTS = "import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n    def test_neg(self):\n        self.assertEqual(add(-1, 1), 0)\n\nif __name__ == '__main__':\n    unittest.main()\n";
const UCMD = 'python -B -m unittest discover -p "test*.py"';
let fileReply = GOOD;
function reply(messages) {
  const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : "");
  const sys = messages[0]?.role === "system" ? text(messages[0]) : "";
  const last = text(messages[messages.length - 1]);
  const all = messages.map(text).join("\n");
  if (/You are the Planner/.test(all)) return "1. Edit calc.py so the tests pass.";
  if (/You are the Reviewer/.test(all)) return "APPROVED";
  if (/Now output the COMPLETE content of the file/.test(last) || /You are an expert programmer writing a source file/.test(sys)) return fileReply;
  if (sys.startsWith("You are Eta's Executor")) return JSON.stringify({ say: "All tests passed, done.", tool: "finish", args: { summary: "All tests passed: `add` now uses `fastAdder` from `numutils`." } });
  return "OK";
}
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: [{ id: "fake" }] })); }
    if (!req.url.endsWith("/chat/completions")) { res.statusCode = 404; return res.end("{}"); }
    let body = {}; try { body = JSON.parse(b); } catch {}
    const out = reply(body.messages || []);
    if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\n`); res.write("data: [DONE]\n\n"); return res.end(); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const saved = { ...provider }; const savedKeeper = process.env.ETA_PROMPT_KEEPER; process.env.ETA_PROMPT_KEEPER = "0";
setProvider({ base: `http://127.0.0.1:${server.address().port}`, kind: "openai", model: "fake", key: "", noGrammar: true });
const quiet = () => {};
try {
  console.log("B1 untouched stub: the executor never writes; one forced write with the real failing tests");
  {
    const p = tmp("b1"); w(p, "calc.py", STUB); w(p, "test_calc.py", TESTS);
    const ag = new Agent(p, { autoApprove: true, timeBudgetMs: 90000, numCtx: 16384, model: "fake", testCmd: UCMD, testBaselineOk: true, leanPath: false }); // LEAN1: this case tests the OLD executor path (forced write); the lean path has its own tests in test-lean1.mjs
    ag.resolveHelperModel = async function () { this._helperBase = null; this._helperKind = null; this._helperModel = this.memModel; return this.memModel; };
    const ev = []; await ag.run("Implement add() in calc.py. The test file test_calc.py is already in this folder: do NOT change it; your code must make every test pass.", (e) => ev.push(e), async () => true);
    const logs = ev.filter((e) => e.type === "log").map((e) => e.text);
    const done = ev.filter((e) => e.type === "done").pop();
    ok(logs.some((t) => /watchdog: the target calc\.py is unchanged since the start, still a stub \(add\)/.test(t)), "the untouched stub is reported", logs.filter((t) => /watchdog/.test(t)));
    ok(logs.some((t) => /one forced attempt to write calc\.py now/.test(t)) && rd(p, "calc.py").includes("return a + b"), "one forced write landed the real code", rd(p, "calc.py"));
    ok(done && done.status === "done", "the run then ends DONE (green + changed), measured by the red gate", done && { status: done.status, verdict: done.verdict, w: done.warnings });
    ok(logs.some((t) => /^watchdog corrected .*untouched-stub x1.*forced-write x1/s.test(t) && /\n {2}- untouched-stub: calc\.py/.test(t)), "the watchdog report lists both rules with their text", logs.filter((t) => /^watchdog corrected/.test(t)));
    ok(logs.some((t) => /the final message names fastAdder, numutils/.test(t)), "B7: names in the final message that no file contains are reported", logs.filter((t) => /final message/.test(t)));
    fs.rmSync(p, { recursive: true, force: true });
  }
  {
    const p = tmp("b1worse"); w(p, "calc.py", STUB); w(p, "test_calc.py", TESTS);
    fileReply = "def add(a, b:\n    return a +\n";
    const ag = new Agent(p, { autoApprove: true, timeBudgetMs: 90000, numCtx: 16384, model: "fake", testCmd: UCMD, testBaselineOk: true, leanPath: false }); // LEAN1: old executor path on purpose
    ag.resolveHelperModel = async function () { this._helperBase = null; this._helperKind = null; this._helperModel = this.memModel; return this.memModel; };
    const ev = []; await ag.run("Implement add() in calc.py. The test file test_calc.py is already in this folder: do NOT change it.", (e) => ev.push(e), async () => true);
    const done = ev.filter((e) => e.type === "done").pop();
    ok(rd(p, "calc.py") === STUB && done && done.status === "not-done", "a forced write that breaks the file is NOT kept (stub back, run not done)", { file: rd(p, "calc.py"), status: done && done.status });
    fileReply = GOOD;
    fs.rmSync(p, { recursive: true, force: true });
  }

  console.log("B2/B3/B6 at the end of a run (agent._strong2End on real folders)");
  {
    const p = tmp("b23"); w(p, "package.json", "{}"); w(p, "calc.js", "export function add(a, b) { return a + b; }\n");
    w(p, "calc.test.js", "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './calc.js';\ntest('adds', () => { assert.strictEqual(add(2, 3), 5); });\ntest('neg', () => { assert.strictEqual(add(-1, 1), 0); });\ntest('seven', () => { assert.strictEqual(seven(1), 7); });\n");
    const ag = new Agent(p, { model: "fake", numCtx: 16384 }); ag.task = "Fix add in calc.js"; ag._startSnap = await snapshotCode(p);
    const { projectLangs } = await import("./watchdog.mjs"); ag._projLangs = await projectLangs(p, ag._startSnap); ag.files = new Set();
    const weak = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './calc.js';\ntest.skip('adds', () => { assert.strictEqual(add(2, 3), 5); });\ntest('neg', () => { assert.ok(true); });\ntest('seven', () => { assert.strictEqual(seven(1), 7); });\n";
    w(p, "calc.test.js", weak); w(p, "helper.py", "print('hi')\n"); w(p, "calc.js", "export function add(a, b) { return a + b; }\nexport function seven(x) { return 7; }\n");
    const logs = []; await ag._strong2End(ag.task, null, {}, (e) => logs.push(e.text || ""));
    ok(rd(p, "calc.test.js").includes("test('adds'") && !rd(p, "calc.test.js").includes("test.skip"), "B3: the weakened test file got its old text back", rd(p, "calc.test.js"));
    ok(fs.readdirSync(path.join(p, ".eta", "drafts")).some((f) => /^calc\.test\.js\.\d+$/.test(f)), "B3: the weakened version is kept as a draft");
    ok(!fs.existsSync(path.join(p, "helper.py")) && logs.some((t) => /helper\.py is a python file, but this project uses javascript/.test(t)), "B2: a Python file created in a JS project (task does not ask for Python) was removed", logs);
    ok(logs.some((t) => /calc\.js: seven\(\) returns the constant 7/.test(t)), "B6: a constant return equal to a test's expected value is a hint", logs.filter((t) => /hint/.test(t)));
    fs.rmSync(p, { recursive: true, force: true });
  }
  {
    const p = tmp("b3ok"); w(p, "test_a.py", "def test_a():\n    assert 1 + 1 == 2\n\ndef test_b():\n    assert 2 * 2 == 4\n");
    const ag = new Agent(p, { model: "fake", numCtx: 16384 }); ag.task = "Remove the obsolete test_b test from test_a.py"; ag._startSnap = await snapshotCode(p); ag.files = new Set();
    w(p, "test_a.py", "def test_a():\n    assert 1 + 1 == 2\n");
    await ag._strong2End(ag.task, null, {}, quiet);
    ok(!rd(p, "test_a.py").includes("test_b"), "B3: the task asked to remove a test - the change stays");
    w(p, "notes_tool.py", "x = 1\n"); // same language: never judged
    fs.rmSync(p, { recursive: true, force: true });
  }

  console.log("B4 secrets and B5 destructive commands in the real write path and hook");
  {
    const p = tmp("b45"); w(p, "app.py", "x = 1\n");
    const ag = new Agent(p, { model: "fake", numCtx: 16384, autoApprove: true }); ag.task = "add a config loader to config.py"; ag.files = new Set(); ag._startSnap = await snapshotCode(p);
    fileReply = "AWS_KEY = 'AKIAZ7Q2MNB4XKW9LPTR'\n";
    const r = await ag._writeFile({ path: "config.py" }, [], quiet, { autoApprove: true }, "");
    ok(/^REFUSED: config\.py would contain what looks like a real secret \(an AWS access key\)/.test(r) && !fs.existsSync(path.join(p, "config.py")), "B4: a file with an AWS key is not written", r);
    fileReply = "import os\nAWS_KEY = os.environ['AWS_KEY']\n";
    const r2 = await ag._writeFile({ path: "config.py" }, [], quiet, { autoApprove: true }, "");
    ok(/^Wrote config\.py/.test(r2), "B4: the env-var version is written", r2);
    fileReply = GOOD;
    const h1 = await ag.runHooks("before", { tool: "run_command", args: { command: "git reset --hard HEAD~1" } }, quiet);
    const h2 = await ag.runHooks("before", { tool: "run_command", args: { command: "python -m pytest -q > out.txt" } }, quiet);
    const h3 = await ag.runHooks("before", { tool: "run_command", args: { command: "echo hi > ..\\..\\escape.txt" } }, quiet);
    ok(h1.blocked && /git reset --hard/.test(h1.reason) && !h2.blocked && h3.blocked && /outside the project folder/.test(h3.reason), "B5: git reset --hard and a write outside the project are blocked; a normal test command is not", { h1, h2, h3 });
    ag.task = "Undo my last commit with git reset --hard HEAD~1";
    const h4 = await ag.runHooks("before", { tool: "run_command", args: { command: "git reset --hard HEAD~1" } }, quiet);
    ok(!h4.blocked, "B5: the task itself asks for that exact command - allowed", h4);
    const h5 = await ag.runHooks("before", { tool: "run_command", args: { command: "rm -rf /" } }, quiet);
    ok(h5.blocked, "the old built-in rule still blocks rm -rf / (never overridable)");
    fs.rmSync(p, { recursive: true, force: true });
  }
  {
    const p = tmp("b2w"); w(p, "go.mod", "module x\n"); w(p, "main.go", "package main\nfunc main() {}\n");
    const ag = new Agent(p, { model: "fake", numCtx: 16384, autoApprove: true }); ag.task = "add a Sum function to main.go"; ag.files = new Set();
    ag._startSnap = await snapshotCode(p); const { projectLangs } = await import("./watchdog.mjs"); ag._projLangs = await projectLangs(p, ag._startSnap);
    const r = await ag._writeFile({ path: "sum.py" }, [], quiet, { autoApprove: true }, "");
    ok(/^REFUSED: sum\.py is a python file, but this project uses go/.test(r) && !fs.existsSync(path.join(p, "sum.py")), "B2 at write time: a new Python file in a Go project is refused", r);
    fs.rmSync(p, { recursive: true, force: true });
  }
} finally {
  setProvider(saved); if (savedKeeper === undefined) delete process.env.ETA_PROMPT_KEEPER; else process.env.ETA_PROMPT_KEEPER = savedKeeper;
  server.close();
}

console.log(`lang2: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
