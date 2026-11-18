// redact.mjs — hide secret keys in text before it is shown, streamed to the panel or saved (2026-11-15c).
// Masks the known key shapes. It keeps the first 4 characters so a person can still tell WHICH key it was.
// It is a safety net, not a guarantee: a secret with an unknown shape and no "key"/"token"/"secret" word near it
// is not found. Keep the patterns specific so normal code and output are not changed.
const MASK = (s, keep = 4) => s.slice(0, keep) + "…[hidden]";
const RULES = [
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, (m) => "sk-ant-…[hidden]"],               // Anthropic
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, (m) => MASK(m, 3)],         // OpenAI and look-alikes
  [/\bAIza[0-9A-Za-z_-]{30,}/g, (m) => MASK(m)],                              // Google / Gemini
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, (m) => MASK(m)],            // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, (m) => "github_pat_…[hidden]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, (m) => MASK(m, 5)],                    // Slack
  [/\bhf_[A-Za-z0-9]{30,}/g, (m) => MASK(m, 3)],                              // Hugging Face
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi, (m, p) => p + "…[hidden]"],     // Authorization: Bearer <token>
  // key=..., api_key: "...", token ... after a word that names a secret: long hex or base64-like values only
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([A-Za-z0-9+\/_.=-]{20,})/gi,
    (m, p, v) => /^[0-9a-f]{20,}$/i.test(v) || /[0-9]/.test(v) && /[A-Za-z]/.test(v) ? p + "…[hidden]" : m],
];
export function redact(text) {
  if (text == null) return text;
  let s = typeof text === "string" ? text : String(text);
  if (s.length < 16) return s;
  for (const [re, fn] of RULES) s = s.replace(re, fn);
  return s;
}
// Child process environment without secrets: drops *_KEY, *_TOKEN, *SECRET*, *PASSWORD* (any case).
// `keep` = names the caller asked for explicitly (an MCP server's own "env" block); those stay.
export const SECRET_ENV = /(_KEY|_TOKEN)$|SECRET|PASSWORD|PASSWD/i;
export function safeEnv(env = process.env, keep = []) {
  const allow = new Set(keep.map((k) => String(k).toUpperCase()));
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!SECRET_ENV.test(k) || allow.has(k.toUpperCase())) out[k] = v;
  return out;
}
