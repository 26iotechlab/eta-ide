// Tests for the built-in local code search (localsearch.mjs). Run: node test-localsearch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tokenize, indexWorkspace, queryWorkspace } from "./localsearch.mjs";
import { askKnowledge } from "./agent.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; console.log("FAIL:", name, detail); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eta-ls-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "auth.js"), "function handleLogin(user, password) {\n  // check the password hash and start a session\n  return startSession(user);\n}\n".repeat(3));
fs.writeFileSync(path.join(root, "src", "billing.js"), "function chargeCard(amount, currency) {\n  return stripe.charge(amount, currency);\n}\n".repeat(3));
fs.writeFileSync(path.join(root, "node_modules", "dep", "x.js"), "function handleLogin() { /* must be ignored */ }\n".repeat(3));

// tokenizer splits camelCase and snake_case but keeps the whole word
const t = tokenize("handleLoginRequest user_name");
check("tokenize keeps whole word", t.includes("handleloginrequest"), t.join());
check("tokenize splits camelCase", t.includes("handle") && t.includes("login") && t.includes("request"), t.join());
check("tokenize splits snake_case", t.includes("user") && t.includes("name"), t.join());

const st = await indexWorkspace(root);
check("indexes 2 source files, ignores node_modules", st.files === 2, JSON.stringify(st));

const hits = await queryWorkspace(root, "where is the login handled");
check("login question ranks auth.js first", hits[0]?.file === "src/auth.js", JSON.stringify(hits.map((h) => h.file)));
check("never returns node_modules", !hits.some((h) => h.file.includes("node_modules")));
check("hit carries line numbers", hits[0] && hits[0].start >= 1 && hits[0].end >= hits[0].start);
const hits2 = await queryWorkspace(root, "charge a card currency");
check("billing question ranks billing.js first", hits2[0]?.file === "src/billing.js", JSON.stringify(hits2.map((h) => h.file)));
check("nonsense query returns nothing", (await queryWorkspace(root, "zzqqxx")).length === 0);

// index refreshes when a file changes
await new Promise((r) => setTimeout(r, 20));
fs.writeFileSync(path.join(root, "src", "mail.js"), "function sendNewsletter(list) {\n  return smtp.deliver(list);\n}\n");
const hits3 = await queryWorkspace(root, "send newsletter smtp");
check("new file is found after refresh", hits3[0]?.file === "src/mail.js", JSON.stringify(hits3.map((h) => h.file)));
fs.rmSync(path.join(root, "src", "mail.js"));
check("deleted file disappears", !(await queryWorkspace(root, "send newsletter smtp")).some((h) => h.file === "src/mail.js"));

// the agent tool uses it and makes no network call
const out = await askKnowledge({ root, log: () => {} }, "where is the login handled", null);
check("ask_codebase answers with file:line", /src\/auth\.js:\d+-\d+/.test(out) && /local workspace index/.test(out), out.slice(0, 120));
const none = await askKnowledge({ root, log: () => {} }, "zzqqxx", null);
check("ask_codebase says honestly when nothing matches", /no matching code/.test(none), none);

fs.rmSync(root, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
