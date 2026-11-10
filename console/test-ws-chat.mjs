// Test: each folder keeps its own open chat (2026-11-10).
import { spawn, spawnSync } from "child_process"; import fs from "fs"; import os from "os"; import path from "path";
const PORT = 8798, home = fs.mkdtempSync(path.join(os.tmpdir(), "eta-ws-"));
fs.mkdirSync(path.join(home, ".eta-ide"), { recursive: true });
fs.writeFileSync(path.join(home, ".eta-ide", "state-" + PORT + ".json"), JSON.stringify({ nextId: 1, currentWs: "D:\\projA", chatMsgs: [], history: [{ kind: "user", text: "chat of folder A", ts: 1 }], archive: [], runs: [] }));
const eng = spawn(process.execPath, ["server.mjs"], { cwd: "D:/eta-ide-release/console", env: { ...process.env, PORT: String(PORT), USERPROFILE: home, HOME: home }, stdio: "ignore" });
const get = async (p) => { for (let i = 0; i < 40; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); } catch { await new Promise((r) => setTimeout(r, 500)); } } };
const texts = (d) => (d.history || []).map((h) => h.text).join("|");
let pass = 0, fail = 0; const ok = (c, n, g) => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n} (got "${g}")`); };
let d = await get("/api/history?ws=" + encodeURIComponent("d:\\PROJA")); ok(texts(d) === "chat of folder A", "same folder (other letter case) keeps its chat", texts(d));
d = await get("/api/history?ws=" + encodeURIComponent("D:\\projB")); ok(texts(d) === "", "a new folder starts with an empty chat", texts(d));
let c = await get("/api/chats?ws=" + encodeURIComponent("D:\\projB")); ok(!(c.chats || []).some((x) => x.title.includes("folder A")), "folder A's chat is not in folder B's History", (c.chats || []).map((x) => x.title).join(","));
d = await get("/api/history?ws=" + encodeURIComponent("D:\\projA")); ok(texts(d) === "chat of folder A", "back in folder A, its chat comes back", texts(d));
d = await get("/api/history"); ok(texts(d) === "chat of folder A", "no folder given: nothing changes", texts(d));
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
spawnSync("taskkill", ["/F", "/T", "/PID", String(eng.pid)], { stdio: "ignore" }); process.exit(fail ? 1 : 0);


