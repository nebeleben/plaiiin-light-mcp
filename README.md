# plaiiinlight-mcp — PlaiiinLight lamps for any MCP program

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant work with your
[PlaiiinLight](https://plaiiin-light.com) lamps from a conversation: switch and colour them, write
and preview new light effects, draw pictures, save scenes, keep several lamps in step and check
them for firmware updates.

It runs entirely on your computer and talks to the lamps over your own network. You decide, per
lamp, what the assistant is allowed to do.

It is listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.nebeleben/plaiiinlight-mcp`, so MCP programs that browse the registry can find it by name.

Using Claude Code or the ChatGPT app? They have their own plugins, which install in one step:
[plaiiin-light-claudecode](https://github.com/nebeleben/plaiiin-light-claudecode) and
[plaiiin-light-chatgpt](https://github.com/nebeleben/plaiiin-light-chatgpt). This package is for
everything else that speaks MCP.

## Requirements

- **macOS, Linux or Windows.** It is developed and tested on macOS. On Linux and Windows it runs
  with two differences, which we have not tested ourselves: lamp keys are kept in a file only you
  can read instead of the Keychain, and a share link cannot be read from the clipboard — give the
  assistant the link itself or a screenshot of the QR code.
- Node.js 20 or newer (`node --version`).
- An AI program that can start a local MCP server (often called a "stdio" or "command" server).
- A PlaiiinLight lamp with firmware 2.8 or newer, on the same network as your computer.
- No PlaiiinLight app is needed to start: lamps that nobody has paired yet are found on the network
  and can be used right away. To give the assistant access to a lamp that is paired, you need the
  PlaiiinLight app (macOS, iPhone, iPad or Android) to create a key for it.

## Setup — the one thing every program needs

Every MCP program has a place where you list servers. Add one that runs this command:

```
npx -y plaiiinlight-mcp --profile <name>
```

In most programs that is an entry with the command `npx` and the arguments
`-y`, `plaiiinlight-mcp`, `--profile`, `<name>`. Where the entry goes, and its exact form, is up to
your program; see its documentation on MCP servers. A few examples follow below.

**`--profile` is required**, and the server will not start without it. Pick a short name for the
program you are setting up — `gemini`, `cursor`, anything in lowercase letters, digits and hyphens.
Each profile has its own lamp list and its own keys, so a lamp key you gave to one AI program is
not quietly used by another. Use a different name in each program.

If the server does not start, the program probably cannot find Node.js: on a Mac, programs started
from the Finder do not see your shell's `PATH`. Run `which npx` in a terminal, use that full path as the
command, and also put its folder on the entry's `PATH` — `npx` itself needs to find `node` there.
In the JSON forms below that is one more line, for example:

```json
"env": { "PATH": "/opt/homebrew/bin:/usr/bin:/bin" }
```

with `/opt/homebrew/bin` replaced by the folder `which npx` printed.

To stay on one version, name it: `plaiiinlight-mcp@0.3.0`. Without a version, a current npm picks
up a new release the next time the server starts (very old npm keeps the first one it downloaded).

## Examples

These are taken from each program's own documentation as of November 2026. **We have not tested
them in these programs**, and settings formats change — if one does not work, your program's
documentation is right and this page is out of date.

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "plaiiinlight": {
      "command": "npx",
      "args": ["-y", "plaiiinlight-mcp", "--profile", "gemini"]
    }
  }
}
```

Check with `/mcp`. (Its successor, Antigravity CLI, reads the same `mcpServers` entry from
`~/.gemini/config/mcp_config.json`.)

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "plaiiinlight": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "plaiiinlight-mcp", "--profile", "cursor"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Command Palette → **MCP: Add Server** → Command (stdio), or `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "plaiiinlight": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "plaiiinlight-mcp", "--profile", "vscode"],
      "tools": ["*"]
    }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config
(`~/Library/Application Support/Claude/claude_desktop_config.json`), then quit Claude Desktop
completely and open it again:

```json
{
  "mcpServers": {
    "plaiiinlight": {
      "command": "npx",
      "args": ["-y", "plaiiinlight-mcp", "--profile", "claude-desktop"]
    }
  }
}
```

### LM Studio

Program tab → Install → Edit `mcp.json`:

```json
{
  "mcpServers": {
    "plaiiinlight": {
      "command": "npx",
      "args": ["-y", "plaiiinlight-mcp", "--profile", "lmstudio"]
    }
  }
}
```

With a local model, mind the context size: the server has about fifty tools.

## Giving an assistant access to a lamp

A lamp that nobody has paired yet is found on the network and can be used right away, with full
access.

For a lamp you have paired in the PlaiiinLight app, you create a key for the assistant:

1. In the app: **Share** → **New Share** → pick the lamp.
2. **Access: AI**.
3. Choose what the assistant may do. Each of these is a separate switch: control (power, colour,
   brightness, modes), scripts, drawings, scenes, live streaming, firmware update, rename, and
   reading the swarm.
4. Optionally limit the brightness, and allow the assistant to act only while the lamp is switched
   on.
5. Create. The app shows a link and a QR code.

Copy the link and tell the assistant to add the lamp; the server reads the link from the
clipboard, so the key does not pass through the chat. A saved screenshot of the QR code works too. (Reading the clipboard works on macOS; elsewhere use the
screenshot, or paste the link — a pasted link does pass through the chat.)

The lamp itself enforces these permissions. You can change them, or revoke the key, in the app's
Share tab at any time. An AI key cannot be used by the apps.

**Keys are not shared between profiles.** A key added under `--profile gemini` is not available
under `--profile cursor`, nor to the Claude Code or ChatGPT plugins. Create a separate AI share
for each program.

## What it does and what it talks to

- **Lamps and access** — find lamps, list them with their state, add a shared lamp, forget one.
- **Control** — power, colour, brightness, mode, play, next, previous, stop.
- **Effects** — write an effect script, preview it locally as a picture of its first frames, check and compile
  it on the lamp, upload it, tune it, copy it to other lamps, keep a local library.
- **Images** — draw pixel art or send a PNG, save, show, label, copy, delete.
- **Scenes** — capture what a lamp shows, edit, activate, copy between lamps.
- **Streaming** — GIFs, PNG frames or a script, live to the lamp.
- **Firmware** — compare lamps with the newest release and install it, one lamp at a time, with a
  checksum check.

**Guides.** Doing these jobs well takes some know-how — how an effect script is written and
tested, how access works. The server carries five guides (compose-effect, draw-image, scenes,
fleet-ota, lamp-access) and offers them three ways, because programs differ in what they support:
through the tool `lamps_guide`, as MCP prompts, and as MCP resources
(`plaiiin-lamps://skills/<name>`). The assistant is told to read the matching guide before it
starts such a job.

The server talks to exactly two things:

- your lamps, over plain HTTP and WebSocket on your local network;
- GitHub, to read and download the firmware releases of `nebeleben/plaiiin-light`, and only when
  you ask about or install firmware.

There is no hosted service, no account and no telemetry. Your conversation with the assistant
itself goes wherever your AI program sends it; that includes what the tools report back, such as
lamp names, states and preview pictures. Lamp keys are not part of that, unless you paste a share
link into the chat yourself.

## Where things are stored

With `--profile <name>`:

- Keys: the macOS Keychain, service `plaiiin-lamp-mcp-<name>`, one entry per lamp. On Linux and
  Windows: `~/.plaiiin/lamps-<name>/secrets.json`, readable only by you.
- `~/.plaiiin/lamps-<name>/fleet.json` — the lamps this profile knows. No secrets.
- `~/.plaiiin/lamps-<name>/library/` — effects, images and scenes you saved to the local library.

## Safety

- **Two steps for anything destructive.** Deleting, overwriting, renaming, forgetting a lamp and
  firmware updates first return a summary; the assistant shows it to you and acts only after you
  agree. Whether your AI program additionally asks before a tool runs is that program's setting.
- **An AI key only allows what you granted**, and the lamp firmware enforces it, not just this
  server.
- **Effect preview sandbox.** `effect_preview` runs untrusted scripts in a separate Node process
  under the Node permission model (`--permission`, reading only its own worker file), with a heap
  cap and a timeout; the script itself runs in a `vm` context holding only the shade runtime (no
  `require`, `process` or `fetch`). The permission model blocks file-system access, child processes
  and worker threads, but it does **not** restrict network access: a script that escaped the `vm`
  context could still open sockets. Treat previews of scripts from strangers accordingly.
- **Share links are `http://` only.** Lamps serve plain http on the LAN, so an `https://` share link
  is refused ("lamps use http — use the http:// link") rather than guessed at port 443 or 80.
- **Moved lamps.** When a lamp is found at a new address (mDNS re-resolve or `lamps_discover`), the
  new host must report the same `deviceId` on the open `GET /api` before the stored key is sent to it.
- **Keys.** The key is passed to `security -i` on stdin, never on its command line.

## Uninstall

Remove the server entry from your AI program's settings. The downloaded package stays in npm's
cache (`~/.npm/_npx`) until you clear it. Optionally, for each profile you used:

```sh
rm -rf ~/.plaiiin/lamps-<name>                                   # lamp list and library
security delete-generic-password -s plaiiin-lamp-mcp-<name>      # macOS: repeat until none are left
```

Revoke the AI keys themselves in the app's Share tab.

## How releases are built, and how to check one

What `npx` runs is the npm package `plaiiinlight-mcp`: a small entry script and one bundled file,
`dist/index.js`. Nobody reads a bundle, so this repository is arranged to let you check it against
the source instead:

- **`main`** (this branch) has one commit per release. Each holds that release's source code *and*
  what was built from it, in the folder `npm/` — exactly the files of the npm package.
- **`source`** has the full commit history of the code, without built files.
- The **`ci`** workflow runs on every release commit. It rebuilds everything from the source in
  the same commit and fails if the result is not byte-for-byte what was published.
- The **`release`** workflow repeats that comparison and only then publishes `npm/` to npm, from
  GitHub's runners, without any stored npm password or token. The package page on npm shows this
  as *provenance*: the repository, the commit and the workflow run it came from.

To check a version yourself:

```sh
git clone https://github.com/nebeleben/plaiiin-light-mcp && cd plaiiin-light-mcp
git checkout v0.3.0
npm ci && npm run build && git diff --exit-code -- npm      # the source builds exactly these files
npm pack plaiiinlight-mcp@0.3.0 && tar -xzf plaiiinlight-mcp-0.3.0.tgz
diff -r package npm && echo "npm delivers exactly this folder"
```

Versions starting with `0.0.0` on npm are empty placeholders from before the first release (npm
needs a package to exist before it can be published this way). Every other version comes from here.

The version number is shared with the two plugins, so a number may be skipped here when only a
plugin was released.

More on building and testing in [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Apache-2.0, see [LICENSE](LICENSE).
