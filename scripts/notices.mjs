// Writes the licence notices of every npm package that esbuild bundled into plugin/dist/.
// The bundle is built with legalComments: 'none', so this file is where those notices ship.
// The output depends only on the packages' own files: no dates, no absolute paths, fixed order.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MARK = 'node_modules/';

/** `a/node_modules/@scope/pkg/lib/x.js` → `a/node_modules/@scope/pkg` (the innermost package). */
function packageDir(input) {
  const at = input.lastIndexOf(MARK);
  if (at < 0) return undefined;
  const parts = input.slice(at + MARK.length).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return input.slice(0, at + MARK.length) + name;
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The comment block a source file opens with, without its comment markers ('' when there is none). */
function leadingComment(source) {
  const text = source.replace(/\r\n/g, '\n').replace(/^#!.*\n/, '').trimStart();
  if (text.startsWith('/*')) {
    const end = text.indexOf('*/');
    return end < 0 ? '' : text.slice(2, end).split('\n').map((l) => l.replace(/^\s*\*? ?/, '')).join('\n').trim();
  }
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('//')) break;
    lines.push(line.replace(/^\/\/ ?/, ''));
  }
  return lines.join('\n').trim();
}

/**
 * The package's licence text: its LICENSE/LICENCE/COPYING file, or — for packages that keep the
 * notice only in a source header, which the bundler strips — the comment that opens its main file.
 */
async function licenceText(dir, pkg) {
  const names = (await readdir(dir)).filter((n) => /^(licen[sc]e|copying)/i.test(n)).sort(byCodeUnit);
  if (names.length) return (await readFile(join(dir, names[0]), 'utf8')).replace(/\r\n/g, '\n').trim();
  const main = typeof pkg.main === 'string' ? pkg.main : 'index.js';
  const header = leadingComment(await readFile(join(dir, main), 'utf8').catch(() => ''));
  return /permission|licen[sc]e|copyright|\(c\)/i.test(header) ? header : undefined;
}

/**
 * @param {import('esbuild').Metafile[]} metafiles  from every build that lands in plugin/dist/
 * @param {string} outFile
 */
export async function writeNotices(metafiles, outFile) {
  const dirs = new Set();
  for (const m of metafiles) for (const input of Object.keys(m.inputs)) {
    const d = packageDir(input.replace(/\\/g, '/'));
    if (d) dirs.add(d);
  }
  const packages = new Map();   // name@version → { licence, text }
  for (const dir of dirs) {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.version) continue;   // a nested package.json that only sets "type"
    const id = `${pkg.name}@${pkg.version}`;
    if (packages.has(id)) continue;
    const text = await licenceText(dir, pkg);
    // Shipping a bundled package without its notice would break its licence: stop the build instead.
    if (!text) throw new Error(`notices: no licence text found for ${id} (${dir}) — add a rule for it in scripts/notices.mjs`);
    packages.set(id, { licence: typeof pkg.license === 'string' ? pkg.license : 'see below', text });
  }
  const rule = '-'.repeat(78);
  const out = ['The files in dist/ bundle the following third-party packages. Their licence notices follow.', ''];
  for (const id of [...packages.keys()].sort(byCodeUnit)) {
    const p = packages.get(id);
    out.push(rule, id, `License: ${p.licence}`, '', p.text, '');
  }
  await writeFile(outFile, out.join('\n'));
}
