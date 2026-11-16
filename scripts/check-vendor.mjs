#!/usr/bin/env node
// vendor/shade-runtime.js is a copy of the lamp firmware's script runtime (portal/shade-runtime.js
// in nebeleben/plaiiin-light). This check fails when the copy differs from the firmware's file.
// It can only compare inside the development mono-repo, where the firmware sits next to this
// directory as ../lampos; anywhere else it prints a warning and passes.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mcp = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendored = join(mcp, 'vendor', 'shade-runtime.js');
const canonical = join(mcp, '..', 'lampos', 'portal', 'shade-runtime.js');

if (!existsSync(canonical)) {
  console.warn('check-vendor: skipped — the firmware sources are not next to this directory');
  process.exit(0);
}
if (!existsSync(vendored) || !readFileSync(vendored).equals(readFileSync(canonical))) {
  console.error('check-vendor: vendor/shade-runtime.js differs from the firmware\'s portal/shade-runtime.js — copy the canonical file over it (never edit the copy)');
  process.exit(1);
}
console.log('check-vendor: vendor/shade-runtime.js is identical to the firmware\'s portal/shade-runtime.js');
