import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { writeNotices } from './scripts/notices.mjs';
import { mirrorDir, replaceFile } from './scripts/mirror-dir.mjs';
import { presentTargets } from './scripts/targets.mjs';

/** `import text from './file?raw'` → the file's text (the same suffix Vite/vitest understand). */
const raw = {
  name: 'raw',
  setup(b) {
    // path stays relative so the bundle doesn't carry this machine's directory names
    b.onResolve({ filter: /\?raw$/ }, (a) => {
      const abs = resolve(dirname(a.importer), a.path.slice(0, -4));
      return { path: relative(process.cwd(), abs), namespace: 'raw', pluginData: abs };
    });
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({ contents: await readFile(a.pluginData, 'utf8'), loader: 'text' }));
  },
};

// Every packaging folder in this tree gets the same three things: the bundle (dist/), the
// third-party notices and a copy of the shared skills. They are built once, into the first target,
// and copied to the others, so the targets cannot drift apart.
const targets = presentTargets(process.cwd());
if (!targets.length) throw new Error('build: no packaging folder (plugin/, plugin-chatgpt/) found in this tree');
const [first, ...others] = targets;

const server = await build({
  metafile: true,
  entryPoints: ['src/index.ts'],
  outfile: `${first.dir}/dist/index.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [raw],
  // CJS dependencies (pngjs, bonjour-service, …) call require() for Node built-ins.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
  legalComments: 'none',
});

// The preview worker runs as its own process (src/preview/shade.ts finds it next to index.js).
const worker = await build({
  metafile: true,
  entryPoints: ['src/preview/preview-worker.mjs'],
  outfile: `${first.dir}/dist/preview-worker.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
});

// Installed, dist/ has no package.json above it, and Node before 20.19 / 22.7 would then read
// index.js as CommonJS. This one says what it is. (Written like every other output: complete or not at all.)
await writeFile(`${first.dir}/dist/package.json.tmp-${process.pid}`, '{"type":"module"}\n');
await rename(`${first.dir}/dist/package.json.tmp-${process.pid}`, `${first.dir}/dist/package.json`);

// legalComments are stripped above; the bundled packages' licence notices ship in this file instead.
await writeNotices([server.metafile, worker.metafile], `${first.dir}/THIRD-PARTY-NOTICES.txt`);

for (const t of others) {
  await mirrorDir(`${first.dir}/dist`, `${t.dir}/dist`);
  await replaceFile(`${first.dir}/THIRD-PARTY-NOTICES.txt`, `${t.dir}/THIRD-PARTY-NOTICES.txt`);
}
// The skills have one source (skills/); each target ships a copy.
for (const t of targets) await mirrorDir('skills', `${t.dir}/skills`);
