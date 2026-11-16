/** Which packaging folders this tree has. A public repo carries one; the mono-repo all of them. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TestTarget { name: string; dir: string; manifest: string; skills: boolean }

const ALL: TestTarget[] = [
  { name: 'claudecode', dir: 'plugin', manifest: 'plugin/.claude-plugin/plugin.json', skills: true },
  { name: 'chatgpt', dir: 'plugin-chatgpt', manifest: 'plugin-chatgpt/.codex-plugin/plugin.json', skills: true },
  { name: 'npm', dir: 'npm', manifest: 'npm/package.json', skills: false },
];

export const presentTargets = (root: string): TestTarget[] => ALL.filter((t) => existsSync(join(root, t.manifest)));
export const hasTarget = (root: string, name: string): boolean => presentTargets(root).some((t) => t.name === name);

/** The folder the shared checks (server, build, notices) run against: the first one present. */
export function firstTarget(root: string): TestTarget {
  const t = presentTargets(root)[0];
  if (!t) throw new Error('no packaging folder in this tree');
  return t;
}
