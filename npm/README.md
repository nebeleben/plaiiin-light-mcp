# plaiiinlight-mcp

The [PlaiiinLight](https://plaiiin-light.com) lamp server for any program that speaks
[MCP](https://modelcontextprotocol.io): switch and colour your lamps, write and preview light
effects, draw pictures, save scenes and check for firmware updates, from a conversation with your
AI assistant. It runs on your computer and talks to the lamps over your own network.

Add this command to your AI program's MCP settings (a local, "stdio" server):

```
npx -y plaiiinlight-mcp --profile <name>
```

`--profile` is required. Give each AI program its own name, for example `gemini` or `cursor`: every
profile keeps its own lamp list and its own keys, so a key you gave to one program is not used by
another.

Requirements, examples for popular programs, how to give an assistant access to a lamp, what the
server talks to and where it stores things: **https://github.com/nebeleben/plaiiin-light-mcp**

Node.js 20 or newer. Developed and tested on macOS; it also runs on Linux and Windows. Apache-2.0.
