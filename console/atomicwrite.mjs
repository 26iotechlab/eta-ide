// atomicwrite.mjs — write a file so a crash or power cut never leaves it half-written (2026-11-15c).
// The text goes to a temporary file next to the target first, then one rename puts it in place.
// If the rename fails (Windows: another program holds the file open, a virus scanner, a network drive),
// we fall back to a plain direct write, so a write never fails only because of this safety step.
// A symbolic link is followed (the real file is replaced, the link stays). The old file's mode is kept.
import * as fsp from "fs/promises";

let _seq = 0;
export async function atomicWrite(full, content, options) {
  let target = full, mode = null;
  try { target = await fsp.realpath(full); } catch {} // new file: no real path yet
  try { mode = (await fsp.stat(target)).mode & 0o7777; } catch {}
  // a unique name per write: two writers of the same file at the same time never share a temporary file
  const tmp = `${target}.${process.pid}-${++_seq}.eta-tmp`;
  try {
    await fsp.writeFile(tmp, content, options);
    if (mode != null) { try { await fsp.chmod(tmp, mode); } catch {} }
    await fsp.rename(tmp, target);
  } catch {
    try { await fsp.unlink(tmp); } catch {}
    await fsp.writeFile(target, content, options); // fallback: the old direct write (its error, if any, is the real one)
  }
}
