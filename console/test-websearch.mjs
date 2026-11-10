// Tests for websearch.mjs using local mock servers (no internet needed). Run: node test-websearch.mjs
import http from "node:http";
import net from "node:net";
import { configureSearch, parseProviderLines, searchWeb, fetchPage, politeFetch, searchStatus, clearSearchCaches } from "./websearch.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { if (ok) pass++; else { fail++; console.log("FAIL:", name, detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const serve = (handler) => new Promise((res) => { const s = http.createServer(handler); s.hits = []; const orig = handler; s.removeAllListeners("request"); s.on("request", (req, rsp) => { s.hits.push(req.url); orig(req, rsp, s); }); s.listen(0, "127.0.0.1", () => res({ s, url: "http://127.0.0.1:" + s.address().port })); });
const json = (rsp, obj) => { rsp.writeHead(200, { "content-type": "application/json" }); rsp.end(JSON.stringify(obj)); };

// ---- config parsing
const parsed = parseProviderLines("# my sources\nsearxng http://a.local:8080/\nbrave KEY123\nddg\n");
check("parse: 3 providers", parsed.length === 3 && parsed[0].url === "http://a.local:8080" && parsed[1].key === "KEY123" && parsed[2].type === "ddg", JSON.stringify(parsed));
let threw = false; try { parseProviderLines("bing xyz"); } catch { threw = true; }
check("parse: unknown line is an error", threw);

configureSearch({ minGapMs: 0 });

// ---- search provider + cache + single-flight
const A = await serve((req, rsp) => json(rsp, { results: [{ title: "Node fs docs", url: "http://docs.example/fs", content: "read a file <b>fast</b>" }] }));
configureSearch({ providers: [{ type: "searxng", url: A.url }] });
const r1 = await searchWeb("how to read a file in node");
check("searxng result parsed", r1.results[0]?.title === "Node fs docs" && r1.results[0].snippet === "read a file fast", JSON.stringify(r1));
await searchWeb("how to read a file in node");
check("second identical search comes from cache (1 request)", A.s.hits.length === 1, String(A.s.hits.length));
await Promise.all(Array.from({ length: 6 }, () => searchWeb("same question many agents")));
check("6 agents asking at once = 1 request", A.s.hits.filter((u) => u.includes("many")).length === 1, JSON.stringify(A.s.hits));

// ---- fallback between providers
const BAD = await serve((req, rsp) => { rsp.writeHead(500); rsp.end("boom"); });
configureSearch({ providers: [{ type: "searxng", url: BAD.url }, { type: "searxng", url: A.url }] });
clearSearchCaches();
const f1 = await searchWeb("fallback test one");
check("falls back to the working provider", f1.results.length === 1 && f1.tried.length >= 0 && /127\.0\.0\.1/.test(f1.provider), JSON.stringify(f1));
const st = searchStatus();
check("failed provider is on cooldown", st.providers.some((p) => p.cooldownSec > 0 && p.failures >= 1), JSON.stringify(st.providers));
const badHitsBefore = BAD.s.hits.length;
for (let i = 0; i < 4; i++) await searchWeb("fallback again " + i);
check("cooling provider is not hammered", BAD.s.hits.length === badHitsBefore, `${badHitsBefore} -> ${BAD.s.hits.length}`);

// ---- every provider down: honest error, no crash
configureSearch({ providers: [{ type: "searxng", url: BAD.url }] });
const dead = await searchWeb("nobody answers");
check("all providers down -> empty + clear message", dead.results.length === 0 && /no provider|cooling/.test(dead.error || ""), JSON.stringify(dead));

// ---- 429 + Retry-After: waits, then succeeds
let n429 = 0;
const L = await serve((req, rsp) => { if (req.url === "/robots.txt") { rsp.writeHead(404); return rsp.end(); } if (n429++ === 0) { rsp.writeHead(429, { "retry-after": "1" }); return rsp.end("slow down"); } rsp.writeHead(200, { "content-type": "text/html" }); rsp.end("<main>ok page</main>"); });
let t0 = Date.now();
const p429 = await fetchPage(L.url + "/page");
const took = Date.now() - t0;
check("429 with Retry-After: waits >= 1s then succeeds", p429.ok && took >= 950, `ok=${p429.ok} took=${took}`);
check("the 429 made only 1 retry", n429 === 2, String(n429));
t0 = Date.now(); const p2 = await fetchPage(L.url + "/page");
check("fetched page is cached", p2.fromCache === true && Date.now() - t0 < 100);

// ---- very long Retry-After is respected, not waited out
const LONG = await serve((req, rsp) => { if (req.url === "/robots.txt") { rsp.writeHead(404); return rsp.end(); } rsp.writeHead(429, { "retry-after": "600" }); rsp.end(); });
t0 = Date.now();
const pl = await politeFetch(LONG.url + "/x");
check("Retry-After 600s: gives up fast and says so", pl.rateLimited === true && Date.now() - t0 < 3000 && LONG.s.hits.filter((u) => u === "/x").length === 1, JSON.stringify({ rl: pl.rateLimited, ms: Date.now() - t0, hits: LONG.s.hits }));

// ---- robots.txt
const R = await serve((req, rsp) => {
  if (req.url === "/robots.txt") { rsp.writeHead(200, { "content-type": "text/plain" }); return rsp.end("User-agent: *\nDisallow: /private\nAllow: /private/open\nCrawl-delay: 0.3\n"); }
  rsp.writeHead(200, { "content-type": "text/html" }); rsp.end("<main>hello " + req.url + "</main>");
});
const blocked = await fetchPage(R.url + "/private/secret");
check("robots Disallow is obeyed", blocked.blocked === "robots" && !R.s.hits.includes("/private/secret"), JSON.stringify(blocked));
const allowedOpen = await fetchPage(R.url + "/private/open");
check("robots longer Allow wins over Disallow", allowedOpen.ok === true, JSON.stringify(allowedOpen));
t0 = Date.now();
await Promise.all([fetchPage(R.url + "/a"), fetchPage(R.url + "/b"), fetchPage(R.url + "/c")]);
check("robots Crawl-delay spaces requests to one site", Date.now() - t0 >= 550, `took ${Date.now() - t0}ms`);

// ---- identity is honest
let ua = "";
const U = await serve((req, rsp) => { if (req.url !== "/robots.txt") ua = req.headers["user-agent"]; rsp.writeHead(200, { "content-type": "text/html" }); rsp.end("<main>x</main>"); });
await fetchPage(U.url + "/who");
check("User-Agent says what it is", /^EtaIDE-research/.test(ua), ua);


// ---- proxy (company network): only web fetches go through it; local addresses never do
const seen = [];
// A real company proxy tunnels with CONNECT. This mock records the CONNECT request, then forwards
// the tunnel to a local "website" so we can prove the page really travelled through the proxy.
const SITE = await serve((req, rsp) => {
  if (/robots\.txt$/.test(req.url)) { rsp.writeHead(404); return rsp.end(); }
  rsp.writeHead(200, { "content-type": "text/html" }); rsp.end("<main>via proxy: " + req.headers.host + req.url + "</main>");
});
const sitePort = Number(SITE.url.split(":").pop());
const pxServer = http.createServer((q, r) => { r.writeHead(405); r.end(); });
pxServer.on("connect", (req, sock) => {
  seen.push({ url: req.url, auth: req.headers["proxy-authorization"] || "" });
  const up = net.connect(sitePort, "127.0.0.1", () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.pipe(sock); sock.pipe(up); });
  up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
});
await new Promise((r) => pxServer.listen(0, "127.0.0.1", r));
const PX = { url: "http://127.0.0.1:" + pxServer.address().port, s: pxServer };
configureSearch({ proxy: { url: PX.url.replace("http://", "http://alice:s3cret@"), noProxy: "skip.test" } });
clearSearchCaches();
const viaProxy = await fetchPage("http://target.test/page");
check("remote site is fetched THROUGH the proxy", viaProxy.ok && /via proxy: target\.test\/page/.test(viaProxy.text), JSON.stringify(viaProxy).slice(0, 200));
check("proxy was asked for the right destination", seen.some((x) => x.url === "target.test:80"), JSON.stringify(seen));
check("proxy credentials are sent as Proxy-Authorization", seen.some((x) => /^Basic /.test(x.auth)), JSON.stringify(seen));
const lab = searchStatus().proxy;
check("status shows the proxy but never the password", lab.url.startsWith("http://127.0.0.1") && lab.hasAuth === true && !JSON.stringify(lab).includes("s3cret"), JSON.stringify(lab));
const seenBefore = seen.length;
const direct = await fetchPage(R.url + "/direct-local");
check("local address bypasses the proxy", direct.ok && seen.length === seenBefore, `seen ${seenBefore} -> ${seen.length}`);
const skipped = await politeFetch("http://skip.test/x", { robots: false, maxRetries: 0, timeoutMs: 1500 });
check("NO_PROXY host is not sent through the proxy", !seen.some((x) => /skip\.test/.test(x.url)) && skipped.ok === false, JSON.stringify(skipped).slice(0, 120));
let bad = false; try { configureSearch({ proxy: { url: "not a url" } }); } catch { bad = true; }
check("bad proxy address is rejected", bad);
configureSearch({ proxy: { url: "", noProxy: "" } });
PX.s.close(); SITE.s.close();

for (const x of [A, BAD, L, LONG, R, U]) x.s.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
