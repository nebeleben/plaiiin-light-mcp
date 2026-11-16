---
name: lamp-access
description: Use when a PlaiiinLight lamp tool is refused ("not permitted by this lamp's AI key", "needs <perm>", key revoked), when a lamp is paired and must be added, or when the user asks how to give the assistant access to a lamp or what an AI access key allows.
---

# Access to PlaiiinLight lamps

Each lamp in the fleet has one access level on this computer (`lamps_list` shows `role`, and for AI
keys `perms`, `maxBrightness`, `onlyWhenOn`):

- **admin** — an unpaired lamp (no owner yet): everything. `lamps_discover` adds these by itself.
- **ai** — an AI access key the owner made for an AI assistant: exactly the permissions they granted.
- **creator / user** — an ordinary share key (see "Older firmware").

## Adding a paired lamp: an AI access key

`lamps_discover` lists paired lamps it can't use under `needsKey`. The owner creates a key in the
PlaiiinLight app (firmware 2.8.0 or newer):

1. **Share** tab → **New Share** → pick the lamp.
2. **Access: AI** ("For an AI assistant such as Claude").
3. Choose the permissions (below), optionally **Limit brightness** and **Only while the lamp is on**.
4. Create → the app shows a QR code and a link (on Linux/Windows: **Copy link**).

Then add it **without the key passing through the chat**:

- Preferred (macOS): the user copies the link, you call `lamp_add_shared` with `fromClipboard: true`.
- Or: the user saves/screenshots the QR code and gives you the file path → `lamp_add_shared` with
  `qrImagePath`.
- Only if neither works: the user pastes the link and you pass it as `url`.

Share links are always `http://` (lamps serve plain http on the LAN); an `https://` link is refused.
Ask the user for the `http://` link the app shows.

The key goes into the macOS Keychain (on other systems a `secrets.json` readable only by the user)
and is never returned. **Never ask the user to paste a key into the chat if another way works,
never repeat, print or log a key or share link**, and never write one into a file.

## What each permission allows

| Permission | Allows |
|---|---|
| `control` | power, colour, brightness, mode, play/next/prev/stop, activating scenes |
| `effects` | upload/delete effect scripts, validate/compile, set tunes |
| `images` | draw, save, show, label, delete images |
| `scenes` | create, capture, overwrite, delete scenes (activating is `control`) |
| `stream` | live streaming — a stream can also switch the lamp on and off |
| `ota` | firmware updates — **effectively full control**: new firmware can read every secret on the lamp. Suggest it only when the user wants the assistant to update firmware. |
| `rename` | rename the lamp (it restarts) |
| `swarm` | read which swarm the lamp is in (never join/leave) |

Reads (state, effects list, images, scenes, info) always work with any key. Pairing, keys, Wi-Fi,
MQTT, limits, grid, orientation, Bluetooth, the lamp's AI provider key and factory reset can never be
granted — this server has no tools for them. `maxBrightness` caps brightness set through this key (the result shows the applied value);
`onlyWhenOn` refuses everything but reads and power while the lamp is off.

## When a tool is refused

The reason names the missing permission, e.g. `not permitted by this lamp's AI key (needs effects)`.
Tell the user which permission is missing and that the owner can add it in the app (Share tab →
the AI key → Edit; no new key needed). **Never try to work around a refusal** (another tool, another
lamp in the swarm, streaming instead of uploading). "The lamp no longer accepts the stored key" means
it was revoked or deleted: the user needs a new share link; offer `lamp_forget` for the old entry.

## Older firmware (< 2.8.0)

Lamps before 2.8.0 have no AI keys. The owner can share a **creator** key instead (Share → New
Share → Access: Creator) and you add it the same way. Creator covers control, effects, images and
scenes; a **user** key covers control, tunes and activating scenes. Firmware updates, rename and
swarm membership need the owner (admin) — or updating the lamp to 2.8.0+ in the app and then an AI
key.

## Confirmations

`lamp_forget` and `lamp_rename` are two-step: show the `summary` to the user and wait for an
explicit yes before calling again with `confirm`. Forgetting only removes the lamp from this
computer; revoking the key is done in the app.
