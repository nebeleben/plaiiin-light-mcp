---
name: fleet-ota
description: Use when the user asks whether their PlaiiinLight lamps are up to date, or wants lamp firmware updated (one lamp or the whole fleet) — firmware_check first, one lamp first, explicit confirmation before every update.
---

# Firmware updates for PlaiiinLight lamps

Firmware comes from the newest PlaiiinLight release on GitHub. The server picks the build for each
lamp's form and chip, verifies it against the release's `SHA256SUMS` (a release without one is
refused) and installs it over the network.

## Always in this order

1. **`firmware_check`** with `lamps: "all"` (or the lamps the user named). Per lamp you get
   `current`, `latest`, `update: true` with the `asset`, `upToDate`, or a `reason` (e.g. "no build
   for <form>/<target>", or firmware too old to report its form — those need the PlaiiinLight app).
   Show the user a short table. Never call `firmware_update` without a check first.
2. **One lamp first.** Suggest the least important lamp. Call `firmware_update` with just that lamp
   and no `confirm`: it returns `{needsConfirmation, summary, confirm}` listing `current → new`.
   Show the summary, say that the lamp reboots and is unavailable for up to a minute, and **wait
   for an explicit yes**. Then repeat the identical call with `confirm`.
3. The tool uploads, waits for the lamp to come back on the new version (≤ 90 s) and returns
   `{ok: true, from, to, verified}`. Check with the user that the lamp works (`lamp_state`, or ask
   them to look).
4. **Then the rest** — again: call without `confirm`, show the summary, wait for yes, call with
   `confirm`. Lamps are updated one at a time; the first failure stops the run and later lamps are
   reported `skipped`. On a failure stop and report the reason; don't retry blindly.

Confirmation tokens are valid for 120 s and bound to the exact arguments — if the user takes
longer or changes the lamp list, call again without `confirm` for a fresh summary.

## Access

`firmware_check` only reads. `firmware_update` needs admin (an unpaired lamp) or an AI key with the
`ota` permission. `ota` is effectively full control of a lamp (new firmware can read every secret on
it), so owners often leave it off — then the user updates that lamp in the PlaiiinLight app
instead. Don't ask for `ota` casually.

## Never

Never update several lamps in one go without having done one first, never pass `confirm` without
the user's yes in this conversation, and never try to downgrade or flash files from elsewhere — the
tool only installs the newest release.
