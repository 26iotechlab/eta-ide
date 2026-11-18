// Pure helpers for Tab completion (D1) and inline edit with preview (D2). No VS Code import on purpose:
// they can be tested with plain Node (see console/test-ext-logic.mjs, which builds this file with esbuild).

export const GHOST_BEFORE = 2000;   // characters before the cursor sent to the engine
export const GHOST_AFTER = 500;     // characters after the cursor
export const EDIT_CONTEXT_LINES = 40; // lines of the file shown as read-only context around a selection

export function ghostContext(text: string, offset: number): { prefix: string; suffix: string } {
  const o = Math.max(0, Math.min(offset, text.length));
  return { prefix: text.slice(Math.max(0, o - GHOST_BEFORE), o), suffix: text.slice(o, o + GHOST_AFTER) };
}

// Should we even ask the model? Saves model time on places where a suggestion is noise.
export function worthAsking(prefix: string, suffix: string, lang: string): boolean {
  if (!prefix.trim()) return false;                                   // empty file / nothing typed yet
  const curLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const restOfLine = suffix.slice(0, suffix.indexOf("\n") < 0 ? suffix.length : suffix.indexOf("\n"));
  if (/^(plaintext|markdown|log|json|jsonc|csv|ini)$/i.test(lang) && curLine.trim().length < 3) return false;
  if (/\S/.test(restOfLine) && !/^[\s)\]}>,;:"'`]*$/.test(restOfLine)) return false; // text continues right after the cursor
  return true;
}

// The engine already removes an echo of the typed line. Last safety net before showing grey text.
export function cleanGhost(raw: unknown, prefix: string, suffix: string): string {
  let t = typeof raw === "string" ? raw.replace(/\r/g, "") : "";
  if (!t.trim()) return "";
  if (t.length > 1200) t = t.slice(0, 1200);
  // do not repeat what already follows the cursor
  const head = suffix.replace(/^\s+/, "").slice(0, 40);
  if (head && t.trimEnd().endsWith(head)) t = t.trimEnd().slice(0, -head.length);
  // do not repeat the end of what was typed (the whole typed line, when it is at least 3 characters)
  const typed = prefix.slice(prefix.lastIndexOf("\n") + 1).trim();
  if (typed.length >= 3 && t.trimStart().startsWith(typed)) t = t.trimStart().slice(typed.length);
  t = t.replace(/\s+$/, "");
  // the typed text already ends with a space or tab: a leading space in the answer would double it
  if (/[ 	]$/.test(prefix)) t = t.replace(/^[ 	]+/, "");
  return t.trim() ? t : "";
}

// Offsets in the text -> the lines around them, as read-only context for the edit request.
export function contextAround(text: string, start: number, end: number, lines = EDIT_CONTEXT_LINES): { before: string; after: string } {
  const s = Math.max(0, Math.min(start, text.length)), e = Math.max(s, Math.min(end, text.length));
  const head = text.slice(0, s).split("\n"), tail = text.slice(e).split("\n");
  // `head`'s last piece is the start of the line the selection begins on, `tail`'s first piece is the rest of the last selected line
  const before = head.slice(-(lines + 1)).join("\n");
  const after = tail.slice(0, lines + 1).join("\n");
  return { before: head.length > lines + 1 ? "…\n" + before : before, after: tail.length > lines + 1 ? after + "\n…" : after };
}

export function applyReplacement(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

// "+3 −1 lines" style summary for the question under the preview
export function describeChange(oldText: string, newText: string): string {
  const a = oldText.split("\n"), b = newText.split("\n");
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const removed = a.length - i - j, added = b.length - i - j;
  if (removed <= 0 && added <= 0) return "no change";
  return `+${Math.max(0, added)} −${Math.max(0, removed)} lines`;
}

// Is it still safe to put the edit in? The text of the selected span must be exactly what it was when we asked.
export function stillSame(currentSpan: string, spanAtRequest: string, versionNow: number, versionAtRequest: number): boolean {
  return versionNow === versionAtRequest || currentSpan === spanAtRequest;
}
