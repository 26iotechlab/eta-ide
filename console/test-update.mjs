// Test: the update check finds a newer release, stays silent on every failure, and never shows a foreign link. 2026-11-10.
import { parseVersion, isNewer, checkForUpdate } from "./update.mjs";
let pass = 0, fail = 0;
const ok = (c, n, g = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  (got ${g})`}`); };
const fake = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
const rel = (tag, extra = {}) => ({ tag_name: tag, name: "Eta IDE " + tag, html_url: "https://github.com/26iotechlab/eta-ide/releases/tag/" + tag, body: "notes", published_at: "2026-12-01", ...extra });

console.log("== version numbers");
ok(JSON.stringify(parseVersion("v0.2.10")) === "[0,2,10]", "reads v0.2.10");
ok(isNewer("v0.2.0", "0.1.0") && isNewer("0.1.1", "0.1.0") && isNewer("1.0", "0.9.9"), "newer versions are seen as newer");
ok(!isNewer("v0.1.0", "0.1.0") && !isNewer("0.0.9", "0.1.0") && !isNewer("0.1.10", "0.2.0"), "same or older is not newer (10 is more than 9)");
ok(!isNewer("nightly", "0.1.0"), "a tag without a number is ignored");

console.log("== answers from GitHub");
let r = await checkForUpdate({ current: "0.1.0", fetchImpl: fake(200, rel("v0.2.0")) });
ok(r && r.available && r.latest === "0.2.0" && r.url.startsWith("https://github.com/26iotechlab/eta-ide/"), "a newer release is reported with its page", JSON.stringify(r));
r = await checkForUpdate({ current: "0.2.0", fetchImpl: fake(200, rel("v0.2.0")) });
ok(r && !r.available, "the same version: nothing to show");
ok((await checkForUpdate({ current: "0.1.0", fetchImpl: fake(404, { message: "Not Found" }) })) === null, "no release yet (404): silent");
ok((await checkForUpdate({ current: "0.1.0", fetchImpl: fake(403, { message: "rate limit" }) })) === null, "GitHub limit (403): silent");
ok((await checkForUpdate({ current: "0.1.0", fetchImpl: async () => { throw new Error("offline"); } })) === null, "offline: silent");
ok((await checkForUpdate({ current: "0.1.0", fetchImpl: fake(200, rel("v0.3.0", { prerelease: true })) })) === null, "a test (pre-)release is not offered");
r = await checkForUpdate({ current: "0.1.0", fetchImpl: fake(200, rel("v0.3.0", { html_url: "https://evil.example/download" })) });
ok(r && r.url === "https://github.com/26iotechlab/eta-ide/releases/latest", "a link outside github.com is replaced by the official page", r?.url);

console.log("== real GitHub (read only)");
r = await checkForUpdate({ current: "0.1.0" });
ok(r === null || typeof r.available === "boolean", "the real project answers or stays silent (no crash)", JSON.stringify(r));

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exitCode = fail ? 1 : 0;
