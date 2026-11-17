---
name: compose-effect
description: Use when the user wants a new light effect, animation or pattern on a PlaiiinLight lamp, or wants an existing effect script changed or fixed — writing, previewing, uploading, playing and tuning `shade()` scripts with the plaiiin-lamps tools.
---

# Compose an effect for a PlaiiinLight lamp

An effect is a small JavaScript-like script that the lamp compiles to its own bytecode and runs
once per LED per frame. Work on one lamp first; copy to others only after the user likes it.

## The loop

1. **Pick the lamp.** If the user didn't name one, call `lamps_list` and ask (or use the only one).
2. **Always call `lamp_form_prompt` first.** It returns the lamp's physical form and pixel layout in
   words (`prompt` — the owner may have customised it), its `grid` `{w, h}`, and the script
   `contract`. Design for exactly that grid: a 16×8 tower wraps around (x = 0 and x = w−1 are
   neighbours), a strip is `w×1`, a panel is flat. Read the prompt; it says what looks good.
3. **Write the script** (contract below). Keep it small.
4. **Preview locally with `effect_preview`** (`source`, `lamp` — or `w`/`h` —, `frames`, `fps`,
   `params`). Nothing is sent to the lamp. It returns one picture of the frames, already enlarged
   (each frame about 192 px; frames in reading order, left to right then top to bottom, (0,0)
   top-left of each frame) — **look at the image** and check it matches the idea: motion between
   frames, colours, nothing stuck or black (a warning appears when every frame is black). Fix and
   preview again until it looks right. Use enough frames/fps to see the motion (e.g. 16 frames at
   10 fps). When you show the user a preview, show this picture as it came back: it is sized for
   viewing. Do not redraw the frames yourself at lamp resolution — a 16×16 image is a speck. If you
   must make your own picture (a single frame, a file to hand over), enlarge it the same way: every
   lamp pixel a square block, no smoothing, at least 256 px on the long side.
5. **`effect_validate`** on the lamp (its own validator, nothing stored), then **`effect_compile`**
   (reports `bytecodeBytes`). On `{valid: false, error}` fix the script with the lamp's error text
   and go back to step 4.
6. **`effect_upload`** with a `name` (see Naming). If an effect of that name already exists with a
   different script, the call returns `{needsConfirmation, summary, confirm}` and changes nothing:
   show the summary to the user, wait for an explicit yes, then repeat the identical call with
   `confirm`. A name that is a built-in on that lamp is skipped — pick another name.
7. **`lamp_play`** `{action: "play", effect: name}`. The lamp may be off — `lamp_state` shows `on`;
   ask before switching it on with `lamp_power`.
8. **Tune.** `effect_tunes_get` lists the `@param`s with their live values; `effect_tunes_set` changes
   them live (partial, clamped to range, persisted). Ask the user what they see and adjust; for
   bigger changes edit the script and repeat from step 4.
9. Optional: `library_save_effect` keeps it on this computer; `effect_copy` / `library_push_effect`
   put it on other lamps (same confirm rule as upload).

## Script contract

```js
// @description One line: what it looks like (shown in the apps' effect lists)
// @tags calm,slow,ambient
// @param speed 0.1..5 = 1 Animation speed
// @param trail switch = 1 Leave a fading trail
// @state head : 0
// @state.pixel glow : 0

function shade(x, y, idx, frame, base, params) {
  let t = time * 0.001 * params.speed;          // seconds since play, scaled
  let v = 0.5 + 0.5 * sinLUT(x * 0.6 + t * 3);  // 0..1
  emit(base.r * v, base.g * v, base.b * v);     // or emitBright(v)
}
```

- Exactly one `function shade(x, y, idx, frame, base, params)`. It must call `emit(r, g, b)`
  (0–255 each) or `emitBright(v)` (0–1, times the lamp's base colour) **once** per call.
- In scope: `x`, `y` (grid position, 0,0 = top-left), `idx` (= y·w + x), `frame` (frame counter),
  `w`, `h` (grid size), `time` (ms since play started), `playStart`, `base` (`{r, g, b}`, the
  colour the user picked — tint with it so the effect follows the lamp colour), `params`.
- Built-ins only: `sinLUT`, `cosLUT` (256-entry table, input in radians), `floor`, `ceil`,
  `round`, `abs`, `sqrt`, `pow`, `min`, `max`, `clamp01`, `hash` (int → 0..1, deterministic),
  `random`, `emit`, `emitBright`. No other globals, no `Math.*`, no helper functions. Division or
  modulo by zero gives 0.
- Annotations (each on its own `//` line):
  - `// @param NAME MIN..MAX = DEF description` → `params.NAME`, a tune the user can change.
  - `// @param NAME switch = 0|1 description` → a 0/1 toggle.
  - `// @state NAME : DEF` → a variable `NAME` that keeps its value across frames (shared by all
    pixels; update it e.g. only when `idx == 0`).
  - `// @state.pixel NAME : DEF` → per-LED value, used as `NAME.pixel`.
  - `// @description …` and `// @tags a,b` → shown in effect lists.
- Prefer `time` over `frame` for speed so the look doesn't depend on fps.

The lamp compiles a **small JS subset**, so plain JavaScript habits fail validation:

- Statements: `let NAME = expr;` (always initialised; no `var`/`const`), `NAME = expr;`
  (no `+=`, `-=`, `++` outside a for-step — write `a = a + 1;`), `if (…) { … } else { … }` (braces
  required), `for (let i = 0; i < n; i++) { … }` (step `i++` or `i += N` only), and calls to
  `emit`/`emitBright`. No `return`, `while`, `switch`, ternary `?:`, strings, arrays or objects.
- Operators: `+ - * / %`, comparisons, `&&`, `||`, unary `-` and `!`. No bitwise `& | ^ << >>`.
- `min`/`max`/`pow` take exactly two arguments; `random()` none.
- Member access only as `params.NAME`, `base.r|g|b` and `NAME.pixel`.

## Limits (keep scripts small)

The lamp caps a program at 12 `@param`s, 32 `@state`, 8 `@state.pixel`, 32 locals and 4096 bytes
of bytecode (`effect_compile` reports the size; "bytecode too large" means simplify). Source is at
most 32 KB here. The script runs for every LED every frame on a microcontroller: avoid loops over
the whole grid inside `shade()` — compute each pixel from `x`, `y`, `time` and state instead.

## Naming

1–32 characters of letters, digits, `_` or `-`, lower-case and descriptive (`ocean-drift`,
`ember_glow`). Check `effects_list` first so you don't collide with an existing or built-in effect
by accident; replacing one needs the user's yes.

## Access

Uploading, validating and compiling need the `effects` permission on an AI key (creator or admin
otherwise); playing needs `control`. A refusal says which permission is missing — tell the user
(see the lamp-access skill); never try to work around it. `effect_preview` needs no access at all,
so you can always show a preview.

## Confirmations

Every `needsConfirmation` answer: show its `summary` to the user in plain words and wait for an
explicit yes before calling again with `confirm`. Never pass `confirm` on your own.
