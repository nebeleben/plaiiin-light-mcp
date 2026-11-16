import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs build helper, no types
import { mirrorDir } from '../scripts/mirror-dir.mjs';

function tree(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'mirror-'));
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), text); }
  return d;
}
const list = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(d.length + 1)).sort();

describe('mirrorDir', () => {
  it('makes the target hold exactly the source files', async () => {
    const from = tree({ 'a/SKILL.md': 'A', 'b/SKILL.md': 'B' });
    const to = tree({ 'a/SKILL.md': 'old', 'gone/SKILL.md': 'x', 'stale.txt': 'x' });
    await mirrorDir(from, to);
    expect(list(to)).toEqual(['a/SKILL.md', 'b/SKILL.md']);
    expect(readFileSync(join(to, 'a/SKILL.md'), 'utf8')).toBe('A');
  });

  it('creates a missing target', async () => {
    const from = tree({ 'a/SKILL.md': 'A' });
    const to = join(mkdtempSync(join(tmpdir(), 'mirror-')), 'new', 'deeper');
    await mirrorDir(from, to);
    expect(list(to)).toEqual(['a/SKILL.md']);
  });

  it('leaves another build\'s in-flight temp files alone', async () => {
    const from = tree({ 'a.txt': 'A' });
    const to = tree({ 'a.txt.tmp-4242': 'half written by another process' });
    await mirrorDir(from, to);
    expect(list(to)).toEqual(['a.txt', 'a.txt.tmp-4242']);
  });

  it('survives several builds mirroring at once', async () => {
    const from = tree(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}/SKILL.md`, `skill ${i}`])));
    const to = tree({ 'old/SKILL.md': 'x' });
    await Promise.all(Array.from({ length: 8 }, () => mirrorDir(from, to)));
    expect(list(to)).toEqual(list(from));
  });
});
