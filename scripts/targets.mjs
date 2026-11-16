// The packaging folders this tree can build. Every target ships the same server bundle, the same
// third-party notices and the same skills; what differs is the manifest each assistant reads.
// A public repo carries only its own target's folder, so everything here works on "the targets
// that are present" and never assumes both.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `skills`: plugin hosts load a skills/ folder, so those targets ship a copy; the npm package has
 * no such host and offers the same text through MCP instead (src/guidance.ts).
 * `copies`: files copied from the root of this tree into the folder at build time.
 * @typedef {{ name: string, dir: string, manifest: string, skills: boolean, copies: string[] }} Target
 */

/** @type {Target[]} */
export const TARGETS = [
  { name: 'claudecode', dir: 'plugin', manifest: 'plugin/.claude-plugin/plugin.json', skills: true, copies: [] },
  { name: 'chatgpt', dir: 'plugin-chatgpt', manifest: 'plugin-chatgpt/.codex-plugin/plugin.json', skills: true, copies: [] },
  // An npm tarball must carry its own licence file.
  { name: 'npm', dir: 'npm', manifest: 'npm/package.json', skills: false, copies: ['LICENSE'] },
];

/** The targets whose manifest exists under `root`. @returns {Target[]} */
export function presentTargets(root) {
  return TARGETS.filter((t) => existsSync(join(root, t.manifest)));
}
