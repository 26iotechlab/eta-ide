// Safe defaults (UPGRADE B4, Gokul's choice 2026-11-13): the agent ASKS before it edits files or runs commands.
// A user who wants it hands-free ticks "Edit automatically" in the panel. A caller of the HTTP API that sends
// `autoApprove: true` in its request still gets it. ETA_AUTO_APPROVE=1 in the environment restores the old
// "on by default" for scripts and tests that start the engine without a panel.
export function autoApproveDefault(env = process.env) {
  return String(env?.ETA_AUTO_APPROVE ?? "") === "1";
}
