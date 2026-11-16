import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Library } from '../src/store/library';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
const lib = () => new Library((dir = mkdtempSync(join(tmpdir(), 'lamp-lib-'))));

describe('Library', () => {
  it('lists nothing in a fresh directory', () => {
    const l = lib();
    expect(l.list('effects')).toEqual([]);
    expect(l.list('images')).toEqual([]);
    expect(l.list('scenes')).toEqual([]);
  });

  it('stores effects as .js with optional tune values', () => {
    const l = lib();
    l.writeEffect('zeta', 'function shade(){}');
    l.writeEffect('alpha', 'function shade(){ emit(1,2,3); }', { speed: 2 });
    expect(l.list('effects')).toEqual(['alpha', 'zeta']);
    expect(l.readEffect('alpha')).toEqual({ source: 'function shade(){ emit(1,2,3); }', params: { speed: 2 } });
    expect(l.readEffect('zeta')).toEqual({ source: 'function shade(){}' });
    expect(readdirSync(join(dir!, 'effects')).sort()).toEqual(['alpha.js', 'alpha.params.json', 'zeta.js']);
    l.writeEffect('alpha', 'x');           // rewriting without params drops the old ones
    expect(l.readEffect('alpha')).toEqual({ source: 'x' });
  });

  it('round-trips images and scenes', () => {
    const l = lib();
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6]);
    l.writeImage('heart', { w: 2, h: 1, pixels, label: 'Heart' });
    const img = l.readImage('heart');
    expect(img).toMatchObject({ w: 2, h: 1, label: 'Heart' });
    expect([...img.pixels]).toEqual([...pixels]);
    expect(() => l.writeImage('bad', { w: 2, h: 2, pixels })).toThrow(/2×2/);
    l.writeScene('evening', { script: 'fire', brightness: 80 });
    expect(l.readScene('evening')).toEqual({ script: 'fire', brightness: 80 });
    expect(l.list('images')).toEqual(['heart']);
    expect(l.list('scenes')).toEqual(['evening']);
  });

  it('rejects bad names and reports missing entries', () => {
    const l = lib();
    for (const bad of ['', '../x', 'a b', 'x'.repeat(33), 'a.js']) expect(() => l.writeEffect(bad, 's')).toThrow(/invalid name/);
    expect(() => l.readEffect('nope')).toThrow(/no effect "nope" in the library/);
    expect(() => l.readScene('nope')).toThrow(/no scene "nope" in the library/);
  });
});
