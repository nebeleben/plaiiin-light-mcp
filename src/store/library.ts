import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LibraryKind = 'effects' | 'images' | 'scenes';
export interface LibraryEffect { source: string; params?: Record<string, number> }
export interface LibraryImage { w: number; h: number; pixels: Uint8Array; label?: string }

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const SUFFIX: Record<LibraryKind, string> = { effects: '.js', images: '.json', scenes: '.json' };
const SINGULAR: Record<LibraryKind, string> = { effects: 'effect', images: 'image', scenes: 'scene' };

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid name "${name}": use 1–32 letters, digits, _ or -`);
}

/** Atomic write (tmp file + rename), like fleet.json. */
function put(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/**
 * The local library under `<dir>/effects|images|scenes/` (normally `~/.plaiiin/lamps/library`).
 * Effects: `<name>.js` (+ `<name>.params.json` with tune values). Images: `<name>.json`
 * `{w, h, label?, pixels: base64 RGB}`. Scenes: `<name>.json` (the lamp's scene document).
 */
export class Library {
  constructor(private readonly dir: string) {}

  list(kind: LibraryKind): string[] {
    const d = join(this.dir, kind);
    if (!existsSync(d)) return [];
    const suffix = SUFFIX[kind];
    return readdirSync(d)
      .filter((f) => f.endsWith(suffix) && !f.endsWith('.params.json'))
      .map((f) => f.slice(0, -suffix.length))
      .filter((n) => NAME.test(n))
      .sort();
  }

  readEffect(name: string): LibraryEffect {
    const source = this.read('effects', name, '.js');
    const pf = this.file('effects', name, '.params.json');
    if (!existsSync(pf)) return { source };
    return { source, params: JSON.parse(readFileSync(pf, 'utf8')) as Record<string, number> };
  }

  writeEffect(name: string, source: string, params?: Record<string, number>): void {
    checkName(name);
    put(this.file('effects', name, '.js', true), source);
    const pf = this.file('effects', name, '.params.json');
    if (params && Object.keys(params).length) put(pf, JSON.stringify(params, null, 2));
    else rmSync(pf, { force: true });
  }

  readImage(name: string): LibraryImage {
    const j = JSON.parse(this.read('images', name, '.json')) as { w: number; h: number; label?: string; pixels: string };
    return { w: j.w, h: j.h, pixels: new Uint8Array(Buffer.from(j.pixels, 'base64')), ...(j.label ? { label: j.label } : {}) };
  }

  writeImage(name: string, img: LibraryImage): void {
    checkName(name);
    if (img.pixels.length !== img.w * img.h * 3) throw new Error(`pixels don't fit a ${img.w}×${img.h} image (need ${img.w * img.h * 3} bytes)`);
    const doc = { w: img.w, h: img.h, ...(img.label ? { label: img.label } : {}), pixels: Buffer.from(img.pixels).toString('base64') };
    put(this.file('images', name, '.json', true), JSON.stringify(doc));
  }

  readScene(name: string): object {
    return JSON.parse(this.read('scenes', name, '.json')) as object;
  }

  writeScene(name: string, doc: object): void {
    checkName(name);
    put(this.file('scenes', name, '.json', true), JSON.stringify(doc, null, 2));
  }

  private file(kind: LibraryKind, name: string, suffix: string, create = false): string {
    const d = join(this.dir, kind);
    if (create) mkdirSync(d, { recursive: true });
    return join(d, name + suffix);
  }

  private read(kind: LibraryKind, name: string, suffix: string): string {
    checkName(name);
    const f = this.file(kind, name, suffix);
    if (!existsSync(f)) throw new Error(`no ${SINGULAR[kind]} "${name}" in the library`);
    return readFileSync(f, 'utf8');
  }
}
