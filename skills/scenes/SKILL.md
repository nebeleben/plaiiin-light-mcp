---
name: scenes
description: Use when the user wants to save, recall, edit, copy or delete a scene ("mood", "preset", "good night look") on PlaiiinLight lamps, or to sync scenes between lamps or swarms — with the plaiiin-lamps scene tools.
---

# Scenes on PlaiiinLight lamps

A **scene** is a named snapshot stored on the lamp (up to 32 per lamp), recalled in one call by
every app, Home Assistant, the swarm and you. Its document has optional fields — an absent field
means "leave as is":

```json
{ "script": "blaze", "params": { "speed": 2 }, "image": "img-003",
  "color": [255, 140, 40], "brightness": 120, "mode": "js" }
```

- `script` (an effect on that lamp) implies js mode; `image` (a saved image id **of that lamp**)
  implies frame mode; `mode` is used only when neither is given (e.g. `api` + `color` = solid).
- **Power is not part of a scene.** Activating leaves the lamp on or off; on an off lamp the content
  shows at the next power-on. Capture never records power. Only write `on` when the user
  explicitly wants a "good night" / "wake up" scene that switches power.
- Names: 1–32 of letters, digits, `_`, `-`.

## Tools

- `scenes_list` — scenes with their documents and which one is `active`. `scene_get` — one document.
- `scene_capture` — save what the lamp shows right now (effect + tunes, image, colour, brightness).
  The easiest way: set the lamp up, then capture.
- `scene_put` — write a document directly. The script must exist on the lamp; the image id must be
  one of its saved images. More than 32 fails with "scene store full".
- `scene_activate` — apply it (needs `control`). Lamps in one swarm mirror a scene: per swarm one
  member gets the request and the others report `viaSwarm` — that is success, not a skip.
- `scene_copy` — copy a scene from one lamp to others the way the apps' swarm sync does:
  - an uploaded script travels along (source + its tune values); a built-in script must already
    exist on the target;
  - the scene's image is saved on the target (deduped: an identical image is reused) and the copied
    scene points at the target's new image id; a target with a different grid gets the scene
    **without** the image plus a `warning` — say so;
  - the copy is written without power.
- `library_save_scene` / `library_push_scene` — keep a scene (with script and image pixels) on this
  computer and write it to lamps later, with the same rules as `scene_copy`.
- `scene_delete` — two-step, names the lamps that actually have it.

Use `swarms_list` before copying across lamps: lamps already in one swarm share scenes by name
when activated, but each still needs its own copy of the scene to exist.

## Confirmations

Overwriting a scene (put / capture / copy / push onto an existing name, or a copy that would replace
a different script of the same name) and every delete first return
`{needsConfirmation, summary, confirm}`. Show the summary to the user, wait for an explicit yes, then
repeat the identical call with `confirm`. Never pass `confirm` on your own.

## Access

Writing, capturing and deleting need `scenes` on an AI key (creator or admin otherwise); activating
needs `control`. A refusal names the missing permission — tell the user (lamp-access skill).
