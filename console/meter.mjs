// Token meter: what the model is doing right now and how many tokens it read and wrote (Gokul, 2026-11-10:
// "token count matters"). Exact numbers come from the model server's own report after each call (usage / eval_count);
// while text is still streaming, received pieces are counted live and marked "about" until the exact number arrives.
const st = { active: new Map(), read: 0, written: 0, approx: 0, started: 0, genTok: 0, genMs: 0, lastEnd: 0 };
const subs = new Set();
let seq = 0, timer = null;

function notify() { const s = snapshot(); for (const f of subs) try { f(s); } catch {} }
function tick() { if (st.active.size && !timer) timer = setInterval(() => { if (!st.active.size) { clearInterval(timer); timer = null; } notify(); }, 1000); }

export function onMeter(f) { subs.add(f); return () => subs.delete(f); }
export function resetMeter() { st.read = 0; st.written = 0; st.approx = 0; st.approxKept = 0; st.started = 0; st.genTok = 0; st.genMs = 0; notify(); }

export function meterBegin() {
  const id = ++seq; const now = Date.now();
  if (!st.started) st.started = now;
  st.active.set(id, { t0: now, first: 0, live: 0 }); tick(); notify(); return id;
}
// one streamed piece arrived (about one token)
export function meterDelta(id) {
  const c = st.active.get(id); if (!c) return;
  if (!c.first) c.first = Date.now();
  c.live++; st.approx++;
  if (c.live % 8 === 0) notify();
}
// usage: { read, written, genMs? } from the server; missing -> the live count stays (as "about")
export function meterEnd(id, usage) {
  const c = st.active.get(id); if (!c) return;
  st.active.delete(id); st.lastEnd = Date.now();
  const w = usage && Number.isFinite(usage.written) ? usage.written : null;
  st.approx -= c.live;
  if (w != null) { st.written += w; st.read += usage.read || 0; }
  else { st.written += c.live; st.approxKept = (st.approxKept || 0) + c.live; }
  const tok = w ?? c.live;
  // speed: the server's own generation time when it reports one, else time from the first piece, else the whole call
  const ms = usage?.genMs || (c.first ? Date.now() - c.first : Date.now() - c.t0);
  if (tok > 0 && ms > 0) { st.genTok += tok; st.genMs += ms; }
  notify();
}

export function snapshot() {
  const now = Date.now(); const calls = [...st.active.values()];
  const writing = calls.some((c) => c.first);
  const liveRate = (() => { const c = calls.find((x) => x.first && x.live > 3); return c ? c.live / Math.max(0.5, (now - c.first) / 1000) : 0; })();
  const avgRate = st.genMs ? st.genTok / (st.genMs / 1000) : 0;
  return {
    busy: calls.length > 0, phase: calls.length ? (writing ? "writing" : "reading") : "done",
    written: st.written + st.approx, read: st.read, exact: st.approx === 0 && !st.approxKept,
    perSec: +(liveRate || avgRate).toFixed(1), seconds: st.started ? Math.round(((calls.length ? now : st.lastEnd || now) - st.started) / 1000) : 0,
    waitSec: calls.length && !writing ? Math.round((now - Math.min(...calls.map((c) => c.t0))) / 1000) : 0,
  };
}

// usage readers for each server type
export const usageOf = {
  openai: (j) => j?.usage ? { read: j.usage.prompt_tokens || 0, written: j.usage.completion_tokens ?? null, genMs: j.timings?.predicted_ms || 0 } : null,
  ollama: (j) => j && Number.isFinite(j.eval_count) ? { read: j.prompt_eval_count || 0, written: j.eval_count, genMs: (j.eval_duration || 0) / 1e6 } : null,
  anthropic: (j) => j?.usage ? { read: (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0), written: j.usage.output_tokens ?? null } : null,
  gemini: (j) => j?.usageMetadata ? { read: j.usageMetadata.promptTokenCount || 0, written: j.usageMetadata.candidatesTokenCount ?? null } : null,
};
