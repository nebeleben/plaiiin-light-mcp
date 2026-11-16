/** Which packaging folders this tree has. A public repo carries one; the mono-repo all of them. */
// @ts-expect-error — plain .mjs build helper, no types; the one list of targets lives there
import { TARGETS, presentTargets as present } from '../scripts/targets.mjs';

export interface TestTarget { name: string; dir: string; manifest: string; skills: boolean; copies: string[] }

export const ALL_TARGETS: TestTarget[] = TARGETS;
export const presentTargets = (root: string): TestTarget[] => present(root);
export const hasTarget = (root: string, name: string): boolean => presentTargets(root).some((t) => t.name === name);

/** The folder the shared checks (server, build, notices) run against: the first one present. */
export function firstTarget(root: string): TestTarget {
  const t = presentTargets(root)[0];
  if (!t) throw new Error('no packaging folder in this tree');
  return t;
}
