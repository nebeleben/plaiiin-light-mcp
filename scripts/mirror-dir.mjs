// Copy helpers for the build. The test suite runs the build from several processes at once, and
// tests read the outputs while another build rewrites them, so every step here is idempotent and
// every file appears complete or not at all.
import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

let counter = 0;
/** Names this module gives its in-flight files; another process's must not be pruned. */
const TEMP = /\.tmp-\d+(-\d+)?$/;

/** Copy, then rename into place: a reader never sees a half-written file. */
export async function replaceFile(from, to) {
  const tmp = `${to}.tmp-${process.pid}-${counter++}`;
  await copyFile(from, tmp);
  await rename(tmp, to);
}

/** Make `to` hold exactly the files of `from` (mkdir -p, replace, delete what the source lacks). */
export async function mirrorDir(from, to) {
  await mkdir(to, { recursive: true });
  const want = new Set();
  for (const e of await readdir(from, { withFileTypes: true })) {
    want.add(e.name);
    if (e.isDirectory()) await mirrorDir(join(from, e.name), join(to, e.name));
    else await replaceFile(join(from, e.name), join(to, e.name));
  }
  for (const e of await readdir(to)) if (!want.has(e) && !TEMP.test(e)) await rm(join(to, e), { recursive: true, force: true });
}
