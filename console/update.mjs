// Update check (2026-11-10). Once at start (after a short wait) and then once a day, Eta asks GitHub for the newest
// PUBLIC release of 26iotechlab/eta-ide. If it is newer than this copy, the panel shows a small notice with a link to
// the release page. Nothing is downloaded or installed automatically (there is no signing certificate yet, so the user
// downloads the installer from the official page). No key, no account, no user data: GitHub only sees a normal request
// from this PC (address and the program name "Eta-IDE"). Every failure (offline, no release yet, GitHub limit) is silent.
// Turn it off with "updateCheck": false in ~/.eta-ide/config.json, or ETA_NO_UPDATE_CHECK=1.
export const UPDATE_REPO = process.env.ETA_UPDATE_REPO || "26iotechlab/eta-ide";

// "v0.2.0", "0.2.0", "eta-ide-0.2.0" -> [0,2,0]; anything else -> null
export function parseVersion(v) {
  const m = String(v || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}
export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return false;
}

// Returns { available, current, latest, url, name, notes, published } or null when nothing could be learned.
export async function checkForUpdate({ current, repo = UPDATE_REPO, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { "User-Agent": "Eta-IDE", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null; // 404 = no release yet, 403 = limit reached: try again tomorrow
    const j = await r.json();
    if (!j || j.draft || j.prerelease || !j.tag_name) return null;
    // only a link to GitHub's own release page is ever shown, never an address taken from the text
    const url = /^https:\/\/github\.com\//.test(j.html_url || "") ? j.html_url : `https://github.com/${repo}/releases/latest`;
    return { available: isNewer(j.tag_name, current), current, latest: String(j.tag_name).replace(/^v/i, ""), url,
      name: String(j.name || j.tag_name).slice(0, 80), notes: String(j.body || "").replace(/\r/g, "").slice(0, 600), published: j.published_at || "" };
  } catch { return null; }
}

// Runs the check now (after firstDelayMs) and then every intervalMs; calls onResult only with a real answer.
export function startUpdateChecks({ current, enabled = () => true, onResult, firstDelayMs = 20000, intervalMs = 24 * 3600 * 1000, ...opts }) {
  if (process.env.ETA_NO_UPDATE_CHECK === "1") return () => {};
  const run = async () => { try { if (!(await enabled())) return; const res = await checkForUpdate({ current, ...opts }); if (res) onResult(res); } catch {} };
  const t1 = setTimeout(run, firstDelayMs), t2 = setInterval(run, intervalMs);
  t1.unref?.(); t2.unref?.();
  return () => { clearTimeout(t1); clearInterval(t2); };
}
