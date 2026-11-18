// Test: editCode sends the lines around the selection as read-only context (D2, 2026-11-13).
// A tiny fake model server on a random local port records the request. NO real model, NO GPU, NO engine server.
// Run: node test-editcode.mjs
import http from "http";
import { editCode, setProvider } from "./agent.mjs";
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g) + ")"}`); };
let seen = null, reply = "    return a + b\n";
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    try { seen = JSON.parse(b); } catch { seen = null; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
setProvider({ kind: "openai", base: `http://127.0.0.1:${srv.address().port}`, model: "fake" });
const user = () => seen?.messages?.find((m) => m.role === "user")?.content || "";

let out = await editCode("    return a+b", "add spaces", "python", "m.py");
ok(out === "    return a + b", "without context it works as before and keeps the indentation of the first line", out);
ok(!/BEFORE the selection|AFTER the selection/.test(user()), "no context lines: the prompt has no context parts", user());
ok(/Selected code \(rewrite ONLY this\):\n    return a\+b/.test(user()), "the selected code is clearly marked", user());

out = await editCode("    return a+b", "add spaces", "python", "m.py", { before: "def add(a, b):\n", after: "\n\ndef sub(a, b):\n    return a - b" });
ok(/Code BEFORE the selection \(context only, do NOT output it\):\ndef add\(a, b\):/.test(user()), "the lines before are sent as read-only context", user());
ok(/Code AFTER the selection \(context only, do NOT output it\):\n\n\ndef sub/.test(user()), "the lines after are sent as read-only context");
ok(out === "    return a + b", "the answer is still only the replacement", out);
ok(user().indexOf("BEFORE") < user().indexOf("Selected code") && user().indexOf("AFTER") < user().indexOf("Selected code"), "the context comes before the selected code");

await editCode("x", "y", "js", "", { before: "b".repeat(9000), after: "a".repeat(9000) });
ok(user().includes("b".repeat(3000)) && !user().includes("b".repeat(3001)), "very long text before the selection is cut to 3,000 characters (the end of it, nearest the selection)");
ok(user().includes("a".repeat(2000)) && !user().includes("a".repeat(2001)), "very long text after the selection is cut to 2,000 characters");

await editCode("x", "y", "js", "", { before: "   \n", after: "" });
ok(!/BEFORE the selection/.test(user()), "blank context is left out");
await editCode("x", "y", "js", "", undefined); ok(!/BEFORE the selection/.test(user()), "missing context object is fine");
await editCode("x", "y", "js", "", null); ok(true, "a null context object does not crash");

reply = "```python\n    new_line()\n```";
out = await editCode("old()", "change", "python", "", { before: "x", after: "y" }); ok(out === "    new_line()", "a fenced answer is cleaned as before (indentation kept)", out);
ok((await editCode("code", "   ", "js")) === "code", "an empty instruction returns the code unchanged");
reply = "";
ok((await editCode("keep", "do it", "js", "", { before: "x" })) === "keep", "an empty model answer keeps the original code");

srv.closeAllConnections?.(); srv.close();
console.log(`========== ${pass} passed, ${fail} failed ==========`); process.exitCode = fail ? 1 : 0; setTimeout(() => process.exit(), 100);
