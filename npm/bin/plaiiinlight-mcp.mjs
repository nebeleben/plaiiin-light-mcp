#!/usr/bin/env node
// Entry of the npm package plaiiinlight-mcp: the PlaiiinLight lamp server for any MCP program.
//
//   npx -y plaiiinlight-mcp --profile <name>
//
// It does one thing before handing over to the server in ../dist: it insists on a profile.
// The profile names where this program's lamp list and keys live (~/.plaiiin/lamps-<name>, Keychain
// service plaiiin-lamp-mcp-<name>), so a key you gave to one AI program is not silently used by
// another. There is no default: without a profile nothing is read, written or started.
import { readFileSync } from 'node:fs';

const NAME = 'plaiiinlight-mcp';
const REPO = 'https://github.com/nebeleben/plaiiin-light-mcp';
const PROFILE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;   // the server checks it again

/** One line on stderr, exit 2. stdout stays untouched: it is the protocol channel. */
function refuse(what) {
  process.stderr.write(`${NAME}: ${what} — the command is: npx -y ${NAME} --profile <name>, for example --profile gemini (one name per AI program; see ${REPO})\n`);
  process.exit(2);
}
/** A value as it may appear in a message: quoted, on one line, of bounded length. */
const shown = (v) => JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v);

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(`${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`);
  process.exit(0);
}
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stderr.write([
    `${NAME} — MCP server (stdio) for PlaiiinLight lamps on your local network.`,
    '',
    'Put this command into your AI program\'s MCP settings; it is not meant to be run by hand:',
    '',
    `  npx -y ${NAME} --profile <name>`,
    '',
    '  --profile <name>   required. A name for this AI program (lowercase letters, digits, hyphens),',
    '                     for example gemini or cursor. Each profile has its own lamp list and keys.',
    '                     PLAIIIN_LAMPS_PROFILE in the environment works too; the option wins.',
    '  --version          print the version',
    '',
    `Setup, examples and source: ${REPO}`,
    '',
  ].join('\n'));
  process.exit(0);
}

let fromArgs;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  let value;
  if (a === '--profile') {
    if (i + 1 >= args.length) refuse('--profile needs a name');
    value = args[++i];
  } else if (a.startsWith('--profile=')) {
    value = a.slice('--profile='.length);
  } else {
    refuse(`unknown argument ${shown(a)}`);
  }
  if (fromArgs !== undefined) refuse('--profile given more than once');
  fromArgs = value;
}

const profile = fromArgs ?? process.env.PLAIIIN_LAMPS_PROFILE;
if (profile === undefined) refuse('no profile given');
if (!PROFILE.test(profile)) refuse(`${shown(profile)} is not a usable profile name (1–32 lowercase letters, digits or hyphens)`);

process.env.PLAIIIN_LAMPS_PROFILE = profile;
// Clients of this package have no "skills": offer the same guides as MCP prompts and resources.
process.env.PLAIIIN_LAMPS_GUIDANCE = '1';

try {
  await import('../dist/index.js');
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  process.stderr.write(`${NAME}: the server bundle (dist/index.js) is missing — in a checkout, run npm run build first\n`);
  process.exit(1);
}
