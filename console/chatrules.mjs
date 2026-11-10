// Honesty rules for the chat (questions) path. Measured with test-hallucination.mjs: open models explain functions,
// options and packages that do not exist as if they were real. Kept short: every chat turn pays for it.
export function CHAT_RULES(now = new Date()) {
  return [
    `TODAY is ${now.toISOString().slice(0, 10)} (year ${now.getFullYear()}).`,
    "HONESTY RULES (more important than being helpful):",
    "- Before explaining a function, method, option, flag, package, tag, property, command, menu or setting, ask yourself: does it really exist? If it does not exist, say so in the FIRST sentence and show the real alternative.",
    "- If you are not sure it exists, say \"I am not sure this exists\" and say how to check (docs, --help, a quick test). Never guess.",
    "- Never invent names, versions, links, numbers, quotes or file contents. About this project, only say what the shown code or files support.",
  ].join("\n");
}
