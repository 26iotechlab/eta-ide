// Small helper for slow tests: collects the engine's live events (/events) as short text lines.
export function captureEvents(base) {
  const lines = []; const ctl = new AbortController();
  fetch(base + "/events", { signal: ctl.signal }).then(async (r) => {
    const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value);
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = ev.match(/data: (.*)/);
        if (m) try { const j = JSON.parse(m[1]); if (j.type !== "host" && j.type !== "modelPull") lines.push((j.type || "?") + ": " + String(j.text || j.name || j.error || j.message || "").replace(/\s+/g, " ").slice(0, 200)); } catch {}
      }
    }
  }).catch(() => {});
  return { lines, stop: () => ctl.abort() };
}
