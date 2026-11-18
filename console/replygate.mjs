// replygate.mjs - ONE place that judges a model reply before it has any effect,
// and ONE list of the named ways a step can end. Pure functions, no I/O, no GPU.
//
// Rule 1 (border): a reply is judged before use. Cut off, empty, refusal text or
//   tool-call JSON where a file was expected are all caught here.
// Rule 2 (true state): every step ending has a name. Only some names mean "done".
//
// ETA_GATE=off|warn|enforce  (default enforce). In warn mode the verdict is only logged.

export function gateMode() {
  const m = String(process.env.ETA_GATE || "enforce").toLowerCase();
  return m === "off" || m === "warn" ? m : "enforce";
}

const REFUSAL = /^\s*(I cannot|I can't|I can not|I'm sorry|I am sorry|Sorry,|As an AI|I'm unable|I am unable|Unfortunately, I)/i;
const ACTION_JSON = /^\s*\{\s*"(tool|args)"/;            // a tool call is never file content
const ACTION_JSON_DATA = /^\s*\{\s*"(tool|say)"\s*:/;    // for .json files: only when it parses as a tool call

// kind: "file" (content will be written to disk), "code", "text" (prose answer), "json" (structured)
// opts: { ext, minChars }
export function judgeReply(reply, kind = "text", opts = {}) {
  const content = String((reply && reply.content) ?? "");
  const finish = String((reply && reply.finish) ?? "");
  const trimmed = content.trim();
  const calls = (reply && (reply.toolCalls || reply.tool_calls)) || [];
  if (finish === "length") return bad("cut_off", "The reply was cut off by the token limit.", true);
  if (!trimmed && !calls.length) return bad("empty", "The reply was empty.", true);
  if (kind === "file" || kind === "code") {
    const ext = String(opts.ext || "").toLowerCase();
    if (ext === "json") {
      if (ACTION_JSON_DATA.test(trimmed)) { try { const o = JSON.parse(trimmed); if (o && typeof o.tool === "string" && ("args" in o || "say" in o)) return bad("action_json", "The reply is a tool-call, not the file content.", true); } catch {} }
    } else if (ACTION_JSON.test(trimmed)) return bad("action_json", "The reply is a tool-call, not the file content.", true);
    if (!/^(md|txt|rst|html?)$/.test(ext) && REFUSAL.test(trimmed)) return bad("refusal", "The reply is refusal text, not file content.", true);
    if (opts.minChars && trimmed.length < opts.minChars) return bad("too_short", `The reply is only ${trimmed.length} characters.`, true);
  }
  return { ok: true };
}
function bad(reason, text, retry) { return { ok: false, reason, text, retry }; }

// Apply the mode: returns the verdict to ACT on (warn mode never blocks).
export function actOn(verdict, log) {
  if (verdict.ok) return verdict;
  const mode = gateMode();
  if (log) try { log(`[gate:${mode}] ${verdict.reason}`); } catch {}
  return mode === "enforce" ? verdict : { ok: true, warned: verdict.reason };
}

// ---- Named step endings -------------------------------------------------
// done=true only when the step really reached its goal.
export const ENDINGS = {
  finished:         { done: true,  text: "the model finished and the checks agreed" },
  verified:         { done: true,  text: "a check proved the step" },
  loop:             { done: false, text: "stuck repeating the same actions" },
  invalid_actions:  { done: false, text: "the model gave invalid actions several times" },
  model_failed:     { done: false, text: "the model call failed" },
  step_limit:       { done: false, text: "the step used all its turns" },
  timeout:          { done: false, text: "the time budget ended" },
  cancelled:        { done: false, text: "the user stopped the run" },
  cut_off:          { done: false, text: "the model reply was cut off" },
  unknown:          { done: false, text: "the step ended for an unknown reason" },
};
export function endingDone(name) { return !!(ENDINGS[name] || ENDINGS.unknown).done; }
export function endingText(name) { return (ENDINGS[name] || ENDINGS.unknown).text; }
export function normEnding(name) { return ENDINGS[name] ? name : "unknown"; }

// ---- Cut helper: never cut silently ---------------------------------------
export function cutText(s, n, label = "") {
  s = String(s ?? "");
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n[cut${label ? " " + label : ""}: showing ${n} of ${s.length} characters]`;
}
