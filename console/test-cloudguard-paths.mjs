// test-cloudguard-paths.mjs (2026-11-15j) — secret files must not reach a CLOUD model through the other paths
// (run_command / git, ask_codebase index, chat retrieval, @-mentions, task context, edit_file / write_file, outline).
// With a model on this PC nothing changes. NO model, NO GPU, NO network (the "cloud" address is never called).
// Run: node test-cloudguard-paths.mjs
import fs from "fs"; import os from "os"; import path from "path";
import { guardCommand } from "./cloudguard.mjs";
import { setProvider, provider, cloudModelActive, execTool, askKnowledge, retrieveForQuestion, Agent } from "./agent.mjs";
import { expandMentions } from "./mentions.mjs";

let pass = 0, fail = 0;
const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : " (got " + JSON.stringify(g)?.slice(0, 400) + ")"}`); };
const LOCAL = "http://127.0.0.1:8080", CLOUD = "https://api.cloud.invalid/v1";
const origBase = provider.base;
const useCloud = () => setProvider({ base: CLOUD }); const useLocal = () => setProvider({ base: LOCAL });

const T = fs.mkdtempSync(path.join(os.tmpdir(), "eta-cgp-"));
const put = (rel, text) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
put(".env", "API_KEY=sk-zebra-SECRET-111\n");
put("credentials.json", '{ "zebratoken": "SECRET-222", "zebra_config": "x" }\n');
put(".aws/helper.js", "function zebraHelper() { return 'SECRET-333'; }\n");
put("src/app.js", "// uses the zebratoken from the config\nfunction zebraHelperApp() { return zebra_config; }\nmodule.exports = { zebraHelperApp };\n");
put("README.md", "zebra project\n");

console.log("1. cloudModelActive");
useLocal(); ok(cloudModelActive() === false, "a model on 127.0.0.1 is not cloud");
useCloud(); ok(cloudModelActive() === true, "a model on a remote address is cloud");

console.log("2. guardCommand (the run_command / start_process / git deny-list)");
const blocked = ["type .env", "cat ~/.ssh/id_rsa", "Get-Content .env.local", "powershell -c \"gc $env:USERPROFILE\\.aws\\credentials\"",
  "copy .env con", "more < secrets.yml", "git show HEAD:.env", "git log -p -- .env", "npm test && type config\\server.pem", "C:\\Windows\\System32\\findstr.exe KEY .env"];
for (const c of blocked) ok(/^BLOCKED/.test(guardCommand(c, true) || ""), `cloud: refuses "${c}"`, guardCommand(c, true));
const allowed = ["npm test", "type README.md", "copy .env.example .env", "git add .env", "cat .env.example", "python app.py", "git status", "cat id_rsa.pub", "node build.js --env.production"];
for (const c of allowed) ok(guardCommand(c, true) === null, `cloud: allows "${c}"`, guardCommand(c, true));
ok(blocked.every((c) => guardCommand(c, false) === null), "local model: nothing is refused");

console.log("3. execTool");
const ctx = { root: T, log: () => {}, approve: async () => { throw new Error("approve must not be asked"); }, autoApprove: false };
useCloud();
let r = await execTool("run_command", { command: "type .env" }, ctx); ok(/^BLOCKED/.test(r) && !r.includes("SECRET"), "cloud: run_command 'type .env' is refused before it runs", r);
r = await execTool("start_process", { command: "cat .env" }, ctx); ok(/^BLOCKED/.test(r), "cloud: start_process 'cat .env' is refused", r);
r = await execTool("git", { command: "show HEAD:.env" }, ctx); ok(/^BLOCKED/.test(r), "cloud: git tool 'show HEAD:.env' is refused", r);
r = await execTool("outline", { path: ".aws/helper.js" }, ctx); ok(/^BLOCKED/.test(r) && !r.includes("zebraHelper"), "cloud: outline of a secret file is refused", r);
useLocal();
r = await execTool("outline", { path: ".aws/helper.js" }, ctx); ok(/zebraHelper/.test(r), "local: outline of the same file works as before", r);

console.log("4. ask_codebase (local index)");
useCloud();
r = await askKnowledge({ root: T, log: () => {} }, "zebratoken zebra_config", null);
ok(!r.includes("credentials.json") && !r.includes("SECRET-222") && r.includes("src/app.js"), "cloud: hits from credentials.json are hidden, code hits stay", r);
useLocal();
r = await askKnowledge({ root: T, log: () => {} }, "zebratoken zebra_config", null);
ok(r.includes("credentials.json"), "local: credentials.json is still found (unchanged)", r);

console.log("5. chat retrieval (retrieveForQuestion)");
const oldRg = process.env.ETA_NO_RG; process.env.ETA_NO_RG = "1"; // the JS walk also looks inside dot folders
useCloud(); r = await retrieveForQuestion(T, "where is zebraHelper");
ok(!r.includes(".aws/helper.js") && r.includes("src/app.js"), "cloud: a definition inside .aws/ is hidden", r);
useLocal(); r = await retrieveForQuestion(T, "where is zebraHelper");
ok(r.includes(".aws/helper.js"), "local: it is still found (unchanged)", r);
if (oldRg === undefined) delete process.env.ETA_NO_RG; else process.env.ETA_NO_RG = oldRg;

console.log("6. @-mentions");
let m = await expandMentions("look at @.env and @src/app.js", T, undefined, { cloud: true });
ok(!m.block.includes("SECRET-111") && m.files.map((f) => f.path).join() === "src/app.js" && m.skipped.some((s) => s.word === ".env" && /secret/.test(s.why)), "cloud: @.env is not attached and is named as skipped", m);
m = await expandMentions("look at @.env and @src/app.js", T);
ok(m.block.includes("SECRET-111") && m.files.length === 2, "local (no option): @.env is attached as before", m.files);

console.log("7. task context (retrieveContext) and edit_file / write_file");
const stub = () => { const a = Object.create(Agent.prototype); a.root = T; a.files = new Set(); a.task = "t"; a.plan = ""; return a; };
const task = "update zebra_config in credentials.json and src/app.js";
useCloud(); let fc = await Agent.prototype.retrieveContext.call(stub(), task, () => {});
ok(!fc.files.includes("credentials.json") && !fc.brief.includes("SECRET-222") && fc.files.includes("src/app.js"), "cloud: a named secret file is left out of the context and its text is not in the brief", fc);
useLocal(); fc = await Agent.prototype.retrieveContext.call(stub(), task, () => {});
ok(fc.files.includes("credentials.json") && fc.brief.includes("SECRET-222"), "local: the named file is in the context as before", fc.files);
useCloud();
r = await stub().editFile({ path: ".env" }, [], () => {}, ctx, "");
ok(/^BLOCKED/.test(r), "cloud: edit_file on .env is refused before any model call", r);
r = await stub().writeFile({ path: ".env" }, [], () => {}, ctx, "");
ok(/^BLOCKED/.test(r) && fs.readFileSync(path.join(T, ".env"), "utf8").includes("SECRET-111"), "cloud: write_file over an existing .env is refused and the file is unchanged", r);

setProvider({ base: origBase });
try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
