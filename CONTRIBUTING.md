# Working on the plugin

The plugin is developed in a private mono-repo and mirrored here; issues and pull requests are
welcome here all the same.

It is a local [MCP](https://modelcontextprotocol.io) server (stdio, Node ≥ 20) plus skills,
packaged three ways. The same source is published to three repositories, each carrying only its
own packaging folder:

| | repository | packaging folder | manifest |
|---|---|---|---|
| Claude Code | `nebeleben/plaiiin-light-claudecode` | `plugin/` | `plugin/.claude-plugin/plugin.json` |
| ChatGPT app, codex CLI | `nebeleben/plaiiin-light-chatgpt` | `plugin-chatgpt/` | `plugin-chatgpt/.codex-plugin/plugin.json` |
| any MCP program (npm `plaiiinlight-mcp`) | `nebeleben/plaiiin-light-mcp` | `npm/` | `npm/package.json` |

```
src/                     server source (TypeScript)
skills/                  the five skills — one source for every target
test/                    vitest suites (fake lamp, stdio, packaging, release commit)
vendor/shade-runtime.js  the lamps' script runtime, copied from the firmware's web portal
scripts/                 targets, build helpers, notices generator, release commit, vendor check, smoke test
plugin/                  Claude Code packaging: manifest, .mcp.json, commands/
plugin-chatgpt/          ChatGPT packaging: manifest, .mcp.json, bin/launch, assets/
npm/                     the npm package: package.json, bin/plaiiinlight-mcp.mjs, README.md
  …in each: dist/, THIRD-PARTY-NOTICES.txt, and skills/ (plugins) or LICENSE (npm) — written by
  the build, git-ignored on the source branch
```

A checkout of one public repository has only one of the three packaging folders. The build and the
tests work on whichever are present (`scripts/targets.mjs`); the tests for an absent target are
skipped.

## Build and test

```sh
npm ci
npm test            # checks the vendored runtime, then all vitest suites (builds too)
npm run typecheck
npm run build       # → <packaging folder>/dist, /skills and /THIRD-PARTY-NOTICES.txt, for each target present
```

Each packaging folder ships the bundled `dist/` and no `package.json`/`node_modules`: Node is the
only runtime requirement. The build is reproducible: the same source gives the same bytes on macOS
and Linux, and both targets get the identical bundle.

`npm test` starts with `scripts/check-vendor.mjs`, which compares `vendor/shade-runtime.js` with
the firmware's copy. Outside the mono-repo that copy is absent and the check only prints a warning.

## Install from a checkout

Claude Code:

```sh
npm ci && npm run build
claude plugin validate ./plugin && claude plugin validate .
claude plugin marketplace add "$PWD"
claude plugin install plaiiin-lamps@plaiiin-lamps
```

ChatGPT app / codex CLI:

```sh
npm ci && npm run build
codex plugin marketplace add "$PWD"
codex plugin add plaiiin-lamps@plaiiin-lamps
```

Any MCP program, from the npm folder of a checkout:

```sh
npm ci && npm run build
node npm/bin/plaiiinlight-mcp.mjs --profile dev        # or: (cd npm && npm pack) and npx the tarball
```

Both copy the plugin, with the built files, into the assistant's plugin cache; after rebuilding,
bump the version and install again. A marketplace of the same name from GitHub must be removed
first.

Two things about the ChatGPT packaging that are easy to break:

- **Only `.codex-plugin/plugin.json`.** With a `plugin.json` or `mcp.json` at the root of the
  packaging folder, the host (codex-cli 0.169) loads the skills but silently registers no server.
- **`"cwd": "."` in `.mcp.json`.** The host resolves it to the installed plugin folder; placeholders
  such as `${PLUGIN_ROOT}` are not expanded there.

Neither shows in the tests here — only in the host. After changing the ChatGPT packaging, install
it from the checkout and make one real tool call (`codex exec "call lamps_list …"`) before
releasing.

## State and profiles

Each assistant's plugin keeps its own lamp list and keys, so a key given to one assistant is not
automatically usable by another. The server reads its profile from `PLAIIIN_LAMPS_PROFILE`:

| profile | set by | state folder | Keychain service |
|---|---|---|---|
| none | Claude Code plugin | `~/.plaiiin/lamps` | `plaiiin-lamp-mcp` |
| `chatgpt` | `plugin-chatgpt/bin/launch` | `~/.plaiiin/lamps-chatgpt` | `plaiiin-lamp-mcp-chatgpt` |
| `<name>` | the user, with `--profile <name>` on the npm package | `~/.plaiiin/lamps-<name>` | `plaiiin-lamp-mcp-<name>` |

The npm package's entry (`npm/bin/plaiiinlight-mcp.mjs`) refuses to start without a profile; there
is no default there. It also sets `PLAIIIN_LAMPS_GUIDANCE=1`, which makes the server offer the
skills as MCP prompts and resources (`src/guidance.ts`) — generic MCP programs have no skills, the
plugins do and leave it off.

`PLAIIIN_LAMPS_DIR` overrides the state folder (the tests and the smoke script use a temporary
one). On systems other than macOS, keys go to `secrets.json` (mode 0600) in that folder instead of
a keychain.

## Live smoke test

```sh
npm run build
node scripts/smoke.mjs <lamp-address>
```

Spawns the built server with a temporary `PLAIIIN_LAMPS_DIR`, discovers the lamp at that address
(it must be unpaired), reads info/scenes/swarm/firmware, previews and validates a tiny script, and
changes brightness and restores it. It uploads, deletes, pairs, renames and updates nothing.

## Releasing

Releases are cut in the private mono-repo. There is **one version** for everything here; it lives
in five places, and `npm test` fails while they disagree:

- `package.json` (then `npm install --package-lock-only` to carry it into `package-lock.json`)
- `SERVER_VERSION` in `src/server.ts`
- `plugin/.claude-plugin/plugin.json`
- `plugin-chatgpt/.codex-plugin/plugin.json`
- `npm/package.json`

1. Set the new version in those five places. Commit.
2. Tag that commit for each target you want to release, and push the tag:
   `claudecode-vX.Y.Z`, `chatgpt-vX.Y.Z` and/or `mcp-vX.Y.Z`.

For each tag, that target's mirror workflow filters the history to its repository's `source`
branch (leaving out the other target's folder), runs the type check and the tests, builds, and
calls `scripts/release-commit.sh`, which pushes one commit (source plus the built files) to `main`
together with the tag `vX.Y.Z`. In the public repository, `ci` and `release` rebuild and compare;
`release` then creates the GitHub Release. For the npm target, `release` in the public repository
also publishes the `npm/` folder of the release commit to npm, after the comparison passed, using
npm trusted publishing — no npm token exists in either repository.

The tag must match the version in that target's manifest and in `package.json`, or nothing is
published. A published version is never released again: fix forward with a new version. A target
that is not tagged for a version simply skips that number. Users only receive a release when the
version in their plugin's manifest changes.
