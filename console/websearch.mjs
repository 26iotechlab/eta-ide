// websearch.mjs — built-in web search + polite page fetching, shared by ALL agents in this process.
//
// Design (why it looks like this):
//  * Several search providers in a list (your own SearXNG servers, Brave API with your own key,
//    DuckDuckGo HTML as the keyless default). A query goes to the next healthy provider; when one
//    fails or is rate-limited it is put on a cooldown and the next one is tried.
//  * ONE shared cache and ONE shared per-website queue. Ten research agents that ask the same thing
//    cost one request. Requests to the same website are spaced out, so the total traffic stays small.
//  * Polite by default: honest User-Agent, robots.txt is obeyed (including Crawl-delay), a 429/503
//    makes the whole site wait (Retry-After first, else 2s doubling up to 60s, plus jitter).
//  * It does NOT hide who it is and does NOT switch address to get around a block. A site that
//    refuses is skipped and reported.

const DEFAULT_UA = "EtaIDE-research/0.1 (local research agent; respects robots.txt)";
const cfg = { proxy: { url: "", noProxy: [] }, providers: [{ type: "ddg" }, { type: "stackoverflow" }, { type: "wikipedia" }], minGapMs: 1000, userAgent: DEFAULT_UA, searchTtlMs: 10 * 60_000, pageTtlMs: 30 * 60_000, timeoutMs: 10_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * Math.min(500, ms * 0.25));

// ---------------- configuration ----------------
export function parseProviderLines(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim(); if (!line) continue;
    const [kind, ...rest] = line.split(/\s+/); const arg = rest.join(" ").trim();
    const k = kind.toLowerCase();
    if (k === "ddg" || k === "duckduckgo") out.push({ type: "ddg" });
    else if (k === "searxng" && /^https?:\/\//i.test(arg)) out.push({ type: "searxng", url: arg.replace(/\/+$/, "") });
    else if (k === "brave") out.push({ type: "brave", key: arg || "" });
    else if (k === "stackoverflow" || k === "stackexchange") out.push({ type: "stackoverflow", site: arg || "stackoverflow" });
    else if (k === "wikipedia") out.push({ type: "wikipedia" });
    else throw new Error(`Cannot read line: "${line}". Use: searxng https://host | brave YOUR_KEY | stackoverflow | wikipedia | ddg`);
  }
  return out;
}
export function configureSearch(next = {}) {
  if (Array.isArray(next.providers)) {
    cfg.providers = next.providers.filter((p) => p && (p.type === "ddg" || p.type === "brave" || p.type === "stackoverflow" || p.type === "wikipedia" || (p.type === "searxng" && /^https?:\/\//i.test(p.url || ""))))
      .map((p) => ({ ...p, _until: 0, _fails: 0, _err: "" }));
    if (!cfg.providers.length) cfg.providers = [{ type: "ddg" }, { type: "stackoverflow" }, { type: "wikipedia" }].map((p) => ({ ...p, _until: 0, _fails: 0, _err: "" }));
    rr = 0;
  }
  if (next.proxy && typeof next.proxy === "object") {
    const u = String(next.proxy.url || "").trim();
    if (u && !/^https?:\/\/[^\s/]+/i.test(u)) throw new Error("Proxy address must look like http://host:port");
    cfg.proxy = { url: u, noProxy: Array.isArray(next.proxy.noProxy) ? next.proxy.noProxy.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : String(next.proxy.noProxy || "").split(/[,\s]+/).map((x) => x.toLowerCase()).filter(Boolean) };
    proxyAgents.clear();
  }
  if (typeof next.minGapMs === "number" && next.minGapMs >= 0) cfg.minGapMs = Math.min(next.minGapMs, 30_000);
  if (typeof next.userAgent === "string" && next.userAgent.trim()) cfg.userAgent = next.userAgent.trim();
  if (typeof next.timeoutMs === "number" && next.timeoutMs >= 1000) cfg.timeoutMs = next.timeoutMs;
  if (typeof next.searchTtlMs === "number") cfg.searchTtlMs = next.searchTtlMs;
  if (typeof next.pageTtlMs === "number") cfg.pageTtlMs = next.pageTtlMs;
}
let rr = 0;
configureSearch({ providers: cfg.providers });

const label = (p) => p.type === "stackoverflow" ? "stackoverflow" : p.type === "wikipedia" ? "wikipedia" : p.type === "searxng" ? "searxng " + p.url : p.type === "brave" ? "brave" + (p.key ? " (key set)" : " (NO KEY)") : "duckduckgo";
export function searchStatus() {
  const now = Date.now();
  return {
    providers: cfg.providers.map((p) => ({ label: label(p), type: p.type, cooldownSec: Math.max(0, Math.ceil((p._until - now) / 1000)), failures: p._fails, lastError: p._err || "" })),
    cache: { searches: searchCache.size, pages: pageCache.size, robots: robotsCache.size },
    minGapMs: cfg.minGapMs,
    proxy: proxyLabel(),
  };
}
export function clearSearchCaches() { searchCache.clear(); pageCache.clear(); robotsCache.clear(); }

// ---------------- optional proxy (for company networks) ----------------
// Applies ONLY to web search and page fetching in this file — never to model traffic (Ollama, llama.cpp).
// One proxy, set by the user, or the standard HTTPS_PROXY / HTTP_PROXY variables. Local addresses are never proxied.
// It is NOT a pool of addresses and it never switches address because a site refused.
const proxyAgents = new Map();
function envProxyFor(u) {
  const e = process.env, https = u.protocol === "https:";
  const v = https ? (e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) : (e.HTTP_PROXY || e.http_proxy);
  const no = String(e.NO_PROXY || e.no_proxy || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return { url: v || "", noProxy: no };
}
function isLocalHost(h) { return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local") || h.endsWith(".internal"); }
function bypassed(host, list) { return list.some((n) => n === "*" || host === n.replace(/^\./, "") || host.endsWith("." + n.replace(/^\./, ""))); }
function proxyFor(url) {
  let u; try { u = new URL(url); } catch { return ""; }
  const host = u.hostname.toLowerCase();
  if (isLocalHost(host)) return "";
  const c = cfg.proxy.url ? cfg.proxy : envProxyFor(u);
  if (!c.url || bypassed(host, c.noProxy)) return "";
  return c.url;
}
export function proxyLabel() { // never shows a password
  const c = cfg.proxy.url ? cfg.proxy : envProxyFor(new URL("https://x"));
  if (!c.url) return { url: "", source: "none", hasAuth: false, noProxy: [] };
  try { const u = new URL(c.url); return { url: u.protocol + "//" + u.host, source: cfg.proxy.url ? "settings" : "environment", hasAuth: !!(u.username || u.password), noProxy: c.noProxy }; } catch { return { url: "(invalid)", source: "settings", hasAuth: false, noProxy: [] }; }
}
let _undici = null;
async function doFetch(url, init) {
  const px = proxyFor(url);
  if (!px) return fetch(url, init);
  _undici ||= await import("undici");
  let agent = proxyAgents.get(px);
  if (!agent) { agent = new _undici.ProxyAgent(px); proxyAgents.set(px, agent); }
  return _undici.fetch(url, { ...init, dispatcher: agent });
}

// ---------------- shared cache + "same question at the same time = one request" ----------------
const searchCache = new Map(), pageCache = new Map(), robotsCache = new Map(), inflight = new Map();
function cacheGet(map, key) { const e = map.get(key); if (!e) return undefined; if (e.exp < Date.now()) { map.delete(key); return undefined; } return e.val; }
function cachePut(map, key, val, ttl) { if (ttl <= 0) return; if (map.size > 500) map.delete(map.keys().next().value); map.set(key, { val, exp: Date.now() + ttl }); }
async function once(key, fn) { // single-flight
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p); return p;
}

// ---------------- per-website spacing + pause ----------------
const hosts = new Map(); // host -> { tail, nextAt }
function hostState(h) { let s = hosts.get(h); if (!s) { s = { tail: Promise.resolve(), nextAt: 0, gap: cfg.minGapMs }; hosts.set(h, s); } return s; }
async function slot(host) {
  const st = hostState(host);
  const p = st.tail.then(async () => {
    const wait = st.nextAt - Date.now(); if (wait > 0) await sleep(wait);
    st.nextAt = Date.now() + Math.max(st.gap, cfg.minGapMs);
  });
  st.tail = p.catch(() => {});
  await p;
}
function pauseHost(host, ms) { const st = hostState(host); st.nextAt = Math.max(st.nextAt, Date.now() + ms); }
function retryAfterMs(res) {
  const v = res.headers.get("retry-after"); if (!v) return 0;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const t = Date.parse(v); return Number.isNaN(t) ? 0 : Math.max(0, t - Date.now());
}

// ---------------- robots.txt ----------------
function parseRobots(txt) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false; if (!cur) continue;
    if (k === "allow" || k === "disallow") cur.rules.push({ allow: k === "allow", path: v });
    else if (k === "crawl-delay") { const d = parseFloat(v); if (d > 0) cur.delay = d; }
  }
  return groups;
}
function robotsVerdict(groups, ua, pathAndQuery) {
  const token = ua.split(/[\/\s]/)[0].toLowerCase();
  const g = groups.find((x) => x.agents.some((a) => a !== "*" && token.includes(a))) || groups.find((x) => x.agents.includes("*"));
  if (!g) return { allowed: true, delay: 0 };
  let best = null;
  for (const r of g.rules) {
    if (!r.path) continue; // empty Disallow = allow everything
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return { allowed: best ? best.allow : true, delay: g.delay };
}
async function robotsFor(u) {
  const origin = u.origin; let groups = cacheGet(robotsCache, origin);
  if (groups !== undefined) return groups;
  groups = await once("robots:" + origin, async () => {
    try {
      await slot(u.host);
      const res = await doFetch(origin + "/robots.txt", { headers: { "user-agent": cfg.userAgent }, signal: AbortSignal.timeout(cfg.timeoutMs), redirect: "follow" });
      // 4xx (no file) or 5xx / network trouble => no usable rules => allowed (the common crawler convention)
      return res.ok ? parseRobots(await res.text()) : [];
    } catch { return []; }
  });
  cachePut(robotsCache, origin, groups, 60 * 60_000);
  return groups;
}

// ---------------- polite fetch ----------------
let globalActive = 0; const MAX_GLOBAL = 8;
async function globalGate() { while (globalActive >= MAX_GLOBAL) await sleep(25); globalActive++; }
export async function politeFetch(url, o = {}) {
  let u; try { u = new URL(url); } catch { return { ok: false, status: 0, error: "bad url" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, status: 0, error: "only http(s) urls" };
  if (o.robots !== false) {
    const groups = await robotsFor(u);
    const v = robotsVerdict(groups, cfg.userAgent, u.pathname + u.search);
    if (v.delay) hostState(u.host).gap = Math.min(30_000, Math.max(cfg.minGapMs, v.delay * 1000));
    if (!v.allowed) return { ok: false, status: 0, blocked: "robots", error: `robots.txt of ${u.host} does not allow this page — skipped` };
  }
  const maxRetries = o.maxRetries ?? 2;
  let last = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await slot(u.host);
    await globalGate();
    let res;
    try {
      res = await doFetch(url, { headers: { "user-agent": cfg.userAgent, accept: o.accept || "text/html,*/*", ...(o.headers || {}) }, signal: AbortSignal.timeout(o.timeoutMs || cfg.timeoutMs), redirect: "follow" });
    } catch (e) { globalActive--; last = { ok: false, status: 0, error: String(e?.name === "TimeoutError" ? "timed out" : e?.message || e).slice(0, 140) }; if (attempt < maxRetries) { await sleep(jitter(1000 * 2 ** attempt)); continue; } return last; }
    globalActive--;
    if (res.status === 429 || res.status === 503) {
      const ra = retryAfterMs(res);
      const wait = ra || jitter(Math.min(60_000, 2000 * 2 ** attempt));
      last = { ok: false, status: res.status, rateLimited: true, retryAfterMs: wait, error: `${u.host} says "too many requests" (HTTP ${res.status})` };
      if (wait > 60_000) { pauseHost(u.host, Math.min(wait, 15 * 60_000)); return last; } // asked for a long wait: respect it, do not hammer
      pauseHost(u.host, wait);
      if (attempt < maxRetries) { await sleep(wait); continue; }
      return last;
    }
    const text = await res.text().catch(() => "");
    return { ok: res.ok ?? (res.status >= 200 && res.status < 300), status: res.status, ct: (res.headers && res.headers.get("content-type")) || "", text, url: res.url || url };
  }
  return last;
}

// ---------------- page fetch (cached) ----------------
// Stack Overflow forbids robots on its web pages (403) but offers a free official API for answers.
async function stackAnswers(id, site) {
  const r = await politeFetch(`https://api.stackexchange.com/2.3/questions/${id}/answers?order=desc&sort=votes&site=${site}&filter=withbody&pagesize=2`, { robots: false, accept: "application/json" });
  if (!r.ok) return r;
  let j; try { j = JSON.parse(r.text); } catch { return { ok: false, status: 0, error: "Stack Exchange did not return JSON" }; }
  if (j.backoff) pauseHost("api.stackexchange.com", j.backoff * 1000);
  const items = j.items || [];
  if (!items.length) return { ok: true, status: 200, ct: "text/html", text: "<main>(no answers yet for this question)</main>" };
  return { ok: true, status: 200, ct: "text/html", text: "<main>" + items.map((a, i) => `<h3>Answer ${i + 1} (score ${a.score}${a.is_accepted ? ", accepted" : ""})</h3>${a.body}`).join("\n") + "</main>" };
}
export async function fetchPage(url) {
  const hit = cacheGet(pageCache, url); if (hit) return { ...hit, fromCache: true };
  return once("page:" + url, async () => {
    const so = url.match(/^https?:\/\/(?:www\.)?(stackoverflow|serverfault|superuser|askubuntu)\.com\/questions\/(\d+)/i);
    const r = so ? await stackAnswers(so[2], so[1].toLowerCase()) : await politeFetch(url);
    if (r.ok) cachePut(pageCache, url, r, cfg.pageTtlMs);
    return r;
  });
}

// ---------------- providers ----------------
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
const strip = (s) => decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

function parseDdg(html, max) {
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  const ms = [...html.matchAll(titleRe)], out = [];
  for (let i = 0; i < ms.length && out.length < max; i++) {
    const m = ms[i], title = strip(m[2]); if (!title) continue;
    const block = html.slice(m.index + m[0].length, i + 1 < ms.length ? ms[i + 1].index : html.length);
    const sm = block.match(snipRe);
    let href = m[1]; const w = href.match(/[?&]uddg=([^&]+)/);
    if (w) { try { href = decodeURIComponent(w[1]); } catch {} } else if (href.startsWith("//")) href = "https:" + href;
    out.push({ title, url: href, snippet: sm ? strip(sm[1]) : "" });
  }
  return out;
}
async function runProvider(p, query, max) {
  if (p.type === "ddg") {
    const r = await politeFetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), { robots: false });
    if (!r.ok) throw Object.assign(new Error(r.error || "HTTP " + r.status), { status: r.status, rateLimited: r.rateLimited, retryAfterMs: r.retryAfterMs });
    if (/anomaly|unusual traffic|captcha/i.test(r.text.slice(0, 4000)) && !/result__a/.test(r.text)) throw Object.assign(new Error("DuckDuckGo asked for a human check"), { status: 429, retryAfterMs: 5 * 60_000 });
    return parseDdg(r.text, max);
  }
  if (p.type === "searxng") {
    const r = await politeFetch(`${p.url}/search?q=${encodeURIComponent(query)}&format=json`, { robots: false, accept: "application/json" });
    if (!r.ok) throw Object.assign(new Error(r.status === 403 ? "this SearXNG has JSON output turned off (403)" : (r.error || "HTTP " + r.status)), { status: r.status, retryAfterMs: r.status === 403 ? 10 * 60_000 : r.retryAfterMs });
    let j; try { j = JSON.parse(r.text); } catch { throw Object.assign(new Error("SearXNG did not return JSON"), { status: 0, retryAfterMs: 10 * 60_000 }); }
    return (j.results || []).slice(0, max).map((x) => ({ title: strip(x.title), url: x.url, snippet: strip(x.content) })).filter((x) => x.url);
  }
  if (p.type === "stackoverflow") {
    const site = /^[a-z.]+$/.test(p.site || "") ? p.site : "stackoverflow";
    const r = await politeFetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=${Math.min(max, 10)}&site=${site}&q=${encodeURIComponent(query)}`, { robots: false, accept: "application/json" });
    if (!r.ok) throw Object.assign(new Error(r.error || "HTTP " + r.status), { status: r.status, retryAfterMs: r.retryAfterMs });
    let j; try { j = JSON.parse(r.text); } catch { throw new Error("Stack Exchange did not return JSON"); }
    if (j.backoff) throw Object.assign(new Error("Stack Exchange asked us to back off " + j.backoff + "s"), { retryAfterMs: j.backoff * 1000 });
    return (j.items || []).slice(0, max).map((x) => ({ title: strip(x.title), url: x.link, snippet: (x.is_answered ? "answered" : "no accepted answer") + " · score " + x.score + (x.tags ? " · " + x.tags.slice(0, 4).join(", ") : "") })).filter((x) => x.url);
  }
  if (p.type === "wikipedia") {
    const r = await politeFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${Math.min(max, 10)}&srsearch=${encodeURIComponent(query)}`, { robots: false, accept: "application/json" });
    if (!r.ok) throw Object.assign(new Error(r.error || "HTTP " + r.status), { status: r.status, retryAfterMs: r.retryAfterMs });
    let j; try { j = JSON.parse(r.text); } catch { throw new Error("Wikipedia did not return JSON"); }
    return ((j.query && j.query.search) || []).slice(0, max).map((x) => ({ title: strip(x.title), url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(x.title).replace(/ /g, "_")), snippet: strip(x.snippet) }));
  }
  if (p.type === "brave") {
    if (!p.key) throw Object.assign(new Error("Brave has no API key"), { status: 401, retryAfterMs: 60 * 60_000 });
    const r = await politeFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(max, 20)}`, { robots: false, accept: "application/json", headers: { "x-subscription-token": p.key } });
    if (!r.ok) throw Object.assign(new Error(r.error || "HTTP " + r.status), { status: r.status, retryAfterMs: r.status === 401 || r.status === 403 ? 60 * 60_000 : r.retryAfterMs });
    let j; try { j = JSON.parse(r.text); } catch { throw new Error("Brave did not return JSON"); }
    return ((j.web && j.web.results) || []).slice(0, max).map((x) => ({ title: strip(x.title), url: x.url, snippet: strip(x.description) })).filter((x) => x.url);
  }
  throw new Error("unknown provider");
}

// Search the web. Returns { results: [{title,url,snippet}], provider, tried: [...] }
export async function searchWeb(query, max = 5) {
  const q = String(query || "").trim();
  if (!q) return { results: [], provider: null, tried: [], error: "empty search query" };
  const key = `${max}:${q.toLowerCase()}`;
  const hit = cacheGet(searchCache, key); if (hit) return { ...hit, fromCache: true };
  return once("search:" + key, async () => {
    const now = Date.now(), n = cfg.providers.length, tried = [];
    const order = Array.from({ length: n }, (_, i) => cfg.providers[(rr + i) % n]);
    rr = (rr + 1) % n; // spread queries over providers
    const ready = order.filter((p) => p._until <= now);
    if (!ready.length) {
      const soonest = Math.ceil((Math.min(...cfg.providers.map((p) => p._until)) - now) / 1000);
      return { results: [], provider: null, tried, error: `all search providers are cooling down (next try in ~${soonest}s)` };
    }
    for (const p of ready) {
      try {
        const results = await runProvider(p, q, max);
        p._fails = 0; p._err = "";
        if (!results.length) { tried.push(`${label(p)}: no results`); continue; }
        const out = { results, provider: label(p), tried };
        cachePut(searchCache, key, out, cfg.searchTtlMs);
        return out;
      } catch (e) {
        p._fails++; p._err = String(e?.message || e).slice(0, 140);
        const cool = e.retryAfterMs || jitter(Math.min(10 * 60_000, 5000 * 2 ** Math.min(p._fails - 1, 7)));
        p._until = Date.now() + cool;
        tried.push(`${label(p)}: ${p._err}`);
      }
    }
    return { results: [], provider: null, tried, error: tried.length ? "no provider returned results: " + tried.join("; ") : "no results" };
  });
}
