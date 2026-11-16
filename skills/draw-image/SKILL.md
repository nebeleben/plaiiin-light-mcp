---
name: draw-image
description: Use when the user wants a still picture, icon, pixel art, emoji, text or a PNG shown on a PlaiiinLight lamp, or wants saved lamp images listed, shown, copied or deleted — with the plaiiin-lamps image tools.
---

# Draw an image on a PlaiiinLight lamp

## Find the grid first

Call `lamp_info` (or `lamp_form_prompt`, which also describes the physical form) and use the
logical grid `{w, h}` — `grid` in the fleet entry, `logicalW`/`logicalH` in `info`. A drawing is
exactly that size; every pixel is one LED (or one LED group). Typical grids are tiny (16×8, 8×8,
16×16, 32×8): design for them, don't shrink a big picture in your head.

## Pixel-art guidance

- Few pixels: bold silhouettes, 1-pixel outlines, no gradients thinner than 3–4 steps.
- Black `#000000` is "off" — use it for background so the shape stands out.
- LEDs are bright and saturated: prefer full colours over pastels; dim with darker shades, not grey.
- Text: at most 2–3 characters per 8 rows (3×5 or 4×6 glyphs). On a wrapped tower the left and
  right edges meet — centre the subject.
- Sketch the rows as a small table to the user first if the subject is complex.

## Draw it

`image_draw` with `lamps` and either:

- `pixels`: rows top to bottom, each row `w` colours (`"#rrggbb"` or `[r, g, b]`), exactly `h` rows.
  A lamp with another grid fails with "needs a W×H grid" — draw per grid size.
- `pngPath`: an absolute path to a PNG on this computer; it is resized to each lamp's grid
  (transparent = off). Good for user-supplied pictures; for small grids hand-made `pixels` usually
  look better.

Tell the user before drawing: it **replaces the lamp's current drawing** (an unsaved drawing is
lost) and stops the playing effect or scene. With `save` (default true) it is also saved on the lamp
with your `label` and the result returns its `id`; an identical image already saved is reused
(`reused: true`). The lamp holds about 30 images (`images_list` shows `count`/`max`); when full the
image is drawn but not saved — ask the user which one to delete.

Then ask whether it looks right and adjust. To keep a copy on this computer use
`library_save_image`; `library_push_image` / `image_copy` put it on other lamps with the same grid.

## Other image tools

- `images_list` — saved images with `id`, `label`, size and `fitsGrid`. Ids (`img-001`, …) are per
  lamp: the same id on two lamps is usually a different picture.
- `image_get` — returns a saved image as a PNG so you can look at it.
- `image_show` — show a saved image (frame mode).
- `image_label` — rename a saved image (scenes keep working; they use the id).
- `image_delete` — two-step (see below); scenes that show the image can't be activated afterwards,
  so check `scenes_list` and mention any affected scene in your message to the user.

## Access

Drawing, saving, showing, labelling and deleting need the `images` permission on an AI key (creator
or admin otherwise). A refusal names the missing permission — tell the user (lamp-access skill).

## Confirmations

Every `needsConfirmation` answer: show its `summary` to the user and wait for an explicit yes before
calling again with `confirm`. Never pass `confirm` on your own.
