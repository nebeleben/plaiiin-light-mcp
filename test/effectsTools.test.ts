import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { makeHarness, type Harness } from './harness';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
const harness = async () => (h = await makeHarness());

const SRC = '// @param speed 0..10 = 3 how fast\nfunction shade(x, y, idx, frame, base, params) { emit(255, 0, 0); }';
const puts = (l: { state: { requests: Array<{ method: string; path: string }> } }, path: string) =>
  l.state.requests.filter((r) => r.method === 'PUT' && r.path === path).length;

describe('effects tools: read side', () => {
  it('effects_list marks built-ins', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    l.state.effects.set('mine', SRC);
    const r = await t.call('effects_list', { lamp: 'Alpha' });
    expect(r).toMatchObject({ lamp: 'Alpha', ok: true });
    expect(r.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'rainbow', builtIn: true }),
      expect.objectContaining({ name: 'mine', builtIn: false }),
    ]));
  });

  it('effect_read returns the source; a built-in has none', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    l.state.effects.set('mine', SRC);
    expect(await t.call('effect_read', { lamp: 'Alpha', name: 'mine' })).toMatchObject({ ok: true, name: 'mine', source: SRC });
    const b = await t.call('effect_read', { lamp: 'Alpha', name: 'rainbow' });
    expect(b).toMatchObject({ ok: false, reason: 'rainbow is a built-in effect (compiled into the firmware, no source)' });
  });

  it('lamp_form_prompt returns the effective prompt and grid', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 16, h: 16 } });
    l.state.formPrompt = 'A 16x16 matrix.';
    const r = await t.call('lamp_form_prompt', { lamp: 'Alpha' });
    expect(r).toMatchObject({ ok: true, form: 'display', prompt: 'A 16x16 matrix.', grid: { w: 16, h: 16 } });
  });
});

describe('lamp grid sanity', () => {
  it('lamp_form_prompt and effect_preview refuse a lamp grid with a side over 4096', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 5000, h: 1 } });
    expect(await t.call('lamp_form_prompt', { lamp: 'Alpha' })).toMatchObject({ ok: false, reason: expect.stringMatching(/grid 5000×1.*at most 4096/) });
    const p = await t.raw('effect_preview', { lamp: 'Alpha', source: SRC });
    expect(p).toMatch(/grid 5000×1.*at most 4096/);
  });
});

describe('effect_validate / effect_compile', () => {
  it("returns the lamp's error text verbatim", async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    expect(await t.call('effect_validate', { lamp: 'Alpha', source: 'SYNTAXERR' }))
      .toMatchObject({ ok: true, valid: false, error: 'script error: SyntaxError' });
    expect(await t.call('effect_validate', { lamp: 'Alpha', source: SRC })).toMatchObject({ ok: true, valid: true });
    expect(await t.call('effect_compile', { lamp: 'Alpha', source: SRC })).toMatchObject({ ok: true, valid: true, bytecodeBytes: 4 });
    expect(await t.call('effect_compile', { lamp: 'Alpha', source: 'SYNTAXERR' })).toMatchObject({ ok: true, valid: false, error: 'script error: SyntaxError' });
  });

  it('needs effects on AI keys and creator otherwise', async () => {
    const t = await harness();
    const ai = await t.addFake({ deviceId: 'ai0000000001', name: 'Desk', role: 'ai', perms: ['control'] });
    await t.addFake({ deviceId: 'uuuuuuuuuuuu', name: 'User', role: 'user' });
    const before = ai.state.requests.length;
    expect(await t.call('effect_validate', { lamp: 'Desk', source: SRC })).toMatchObject({ ok: false, reason: "not permitted by this lamp's AI key (needs effects)" });
    // only the whoami re-check reaches the lamp, never the refused request
    expect(ai.state.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/whoami']);
    expect(await t.call('effect_validate', { lamp: 'User', source: SRC })).toMatchObject({ ok: false, reason: "not permitted: needs creator access, this lamp's key is user" });
  });
});

describe('effect_preview', () => {
  it('returns a PNG strip and a summary', async () => {
    const t = await harness();
    const r = await t.client.callTool({ name: 'effect_preview', arguments: { source: SRC, w: 4, h: 2, frames: 3 } });
    const content = r.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    const img = content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    const png = PNG.sync.read(Buffer.from(img.data!, 'base64'));
    expect(png.width).toBeGreaterThanOrEqual(256);
    expect(png.width % 12).toBe(0);
    const summary = JSON.parse(content.find((c) => c.type === 'text')!.text!);
    expect(summary).toMatchObject({ ok: true, grid: { w: 4, h: 2 }, frames: 3, fps: 10 });
    expect(summary.params).toEqual([expect.objectContaining({ name: 'speed', min: 0, max: 10, default: 3, value: 3 })]);
  });

  it('uses the lamp grid when given a lamp', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', grid: { w: 5, h: 3 } });
    const r = await t.call('effect_preview', { source: SRC, lamp: 'Alpha', frames: 2 });
    expect(r).toMatchObject({ ok: true, grid: { w: 5, h: 3 }, frames: 2 });
  });

  it('a syntax error is ok:false with the message', async () => {
    const t = await harness();
    const r = await t.call('effect_preview', { source: 'function shade( {', w: 2, h: 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SyntaxError|Unexpected/);
    expect(await t.call('effect_preview', { source: SRC })).toMatchObject({ ok: false, reason: 'pass `lamp` or both `w` and `h`' });
  });
});

describe('effect_upload / effect_delete', () => {
  it('uploads a new effect without confirmation', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const r = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC });
    expect(r.results).toEqual([expect.objectContaining({ lamp: 'Alpha', ok: true, replaced: false })]);
    expect(l.state.effects.get('red')).toBe(SRC);
  });

  it('overwriting an existing name needs confirmation, bound to the arguments', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.effects.set('red', 'old');
    const ask = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC });
    expect(ask).toMatchObject({ needsConfirmation: true });
    expect(ask.summary).toBe('Replace the existing effect "red" on Alpha with the new script; also write it to Beta.');
    expect(puts(a, '/api/js/red') + puts(b, '/api/js/red')).toBe(0);
    const wrong = await t.call('effect_upload', { lamps: 'all', name: 'red', source: 'other', confirm: ask.confirm });
    expect(wrong).toMatchObject({ needsConfirmation: true, refused: expect.stringMatching(/invalid, expired/) });
    expect(wrong.confirm).not.toBe(ask.confirm);
    expect(a.state.effects.get('red')).toBe('old');
    const ask2 = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC });
    const done = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC, confirm: ask2.confirm });
    expect(done.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ lamp: 'Alpha', ok: true, replaced: true }),
      expect.objectContaining({ lamp: 'Beta', ok: true, replaced: false }),
    ]));
    expect(a.state.effects.get('red')).toBe(SRC);
    expect(b.state.effects.get('red')).toBe(SRC);
  });

  it('skips a target where the name is a built-in, and reports the lamp error text', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const r = await t.call('effect_upload', { lamps: 'Alpha', name: 'rainbow', source: SRC });
    expect(r.results[0]).toMatchObject({ ok: false, skipped: true, reason: 'rainbow is a built-in effect on this lamp; pick another name' });
    const bad = await t.call('effect_upload', { lamps: 'Alpha', name: 'broken', source: 'SYNTAXERR' });
    expect(bad.results[0]).toMatchObject({ ok: false, reason: 'script error: SyntaxError' });
  });

  it('a confirm is refused when what gets replaced changed in between; a fresh request comes back', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.effects.set('red', 'old');
    const ask = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC });
    b.state.effects.set('red', 'someone else uploaded this meanwhile');
    const r = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC, confirm: ask.confirm });
    expect(r).toMatchObject({ needsConfirmation: true, refused: expect.any(String) });
    expect(r.summary).toBe('Replace the existing effect "red" on Alpha, Beta with the new script.');
    expect(a.state.effects.get('red')).toBe('old');
    expect(b.state.effects.get('red')).toBe('someone else uploaded this meanwhile');
    const done = await t.call('effect_upload', { lamps: 'all', name: 'red', source: SRC, confirm: r.confirm });
    expect(done.results.every((x: any) => x.ok && x.replaced)).toBe(true);
  });

  it('effect_delete always confirms', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    l.state.effects.set('red', SRC);
    const ask = await t.call('effect_delete', { lamps: 'all', name: 'red' });
    expect(ask).toMatchObject({ needsConfirmation: true });
    expect(l.state.effects.has('red')).toBe(true);
    const r = await t.call('effect_delete', { lamps: 'all', name: 'red', confirm: ask.confirm });
    expect(r.results[0]).toMatchObject({ ok: true });
    expect(l.state.effects.has('red')).toBe(false);
  });

  it('effect_delete binds the confirmed lamps: a lamp added after the ask is not deleted from', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    a.state.effects.set('red', SRC);
    const ask = await t.call('effect_delete', { lamps: 'all', name: 'red' });
    expect(ask.summary).toContain('Alpha');
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    b.state.effects.set('red', SRC);
    const r = await t.call('effect_delete', { lamps: 'all', name: 'red', confirm: ask.confirm });
    expect(r).toMatchObject({ needsConfirmation: true, refused: expect.stringMatching(/invalid, expired/) });
    expect(r.summary).toContain('Beta');
    expect(a.state.effects.has('red')).toBe(true);
    expect(b.state.effects.has('red')).toBe(true);
    const done = await t.call('effect_delete', { lamps: 'all', name: 'red', confirm: r.confirm });
    expect(done.results).toHaveLength(2);
    expect(b.state.effects.has('red')).toBe(false);
  });
});

describe('effect tunes', () => {
  it('effect_tunes_get lists params with live values', async () => {
    const t = await harness();
    const l = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    l.state.effects.set('red', SRC);
    l.state.params.set('red', { speed: 7 });
    const r = await t.call('effect_tunes_get', { lamp: 'Alpha', name: 'red' });
    expect(r).toMatchObject({ ok: true, name: 'red', values: { speed: 7 } });
    expect(r.params).toEqual([expect.objectContaining({ name: 'speed', min: 0, max: 10, default: 3, value: 7 })]);
  });

  it("effect_tunes_set({lamps:'all'}) sends one PUT per swarm and reports the others viaSwarm", async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', swarmId: 'sw1' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', swarmId: 'sw1' });
    const c = await t.addFake({ deviceId: 'cccccccccccc', name: 'Solo' });
    const r = await t.call('effect_tunes_set', { lamps: 'all', name: 'rainbow', values: { speed: 5 } });
    const path = '/api/js/rainbow/params';
    expect(puts(a, path) + puts(b, path)).toBe(1);
    expect(puts(c, path)).toBe(1);
    expect(r.results).toHaveLength(3);
    const sent = r.results.find((x: any) => x.ok && !x.viaSwarm && x.lamp !== 'Solo');
    const other = r.results.find((x: any) => x.viaSwarm);
    expect(sent).toBeDefined();
    expect(other).toMatchObject({ ok: true, viaSwarm: sent.lamp });
    expect(r.results.find((x: any) => x.lamp === 'Solo')).toMatchObject({ ok: true });
  });
});

describe('effect_tunes_set swarm grouping', () => {
  it('re-reads membership: a lamp that left the swarm since it was added gets its own request', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', swarmId: 'sw1' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', swarmId: 'sw1' });
    expect(t.fleet.get('bbbbbbbbbbbb')!.swarmId).toBe('sw1');
    b.state.swarm = { member: false, id: '', enabled: false, channel: 1 };
    const r = await t.call('effect_tunes_set', { lamps: ['Alpha', 'Beta'], name: 'rainbow', values: { speed: 2 } });
    const path = '/api/js/rainbow/params';
    expect(puts(a, path)).toBe(1);
    expect(puts(b, path)).toBe(1);
    expect(r.results.some((x: any) => x.viaSwarm)).toBe(false);
    expect(t.fleet.get('bbbbbbbbbbbb')!.swarmId).toBeNull();
  });

  it('when the first member fails and the next succeeds, the failed one is reached viaSwarm', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha', swarmId: 'sw1' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta', swarmId: 'sw1' });
    a.state.override = (req, res, path) => {
      if (req.method !== 'PUT') return false;
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('busy'); return true;
    };
    const r = await t.call('effect_tunes_set', { lamps: ['Alpha', 'Beta'], name: 'rainbow', values: { speed: 2 } });
    expect(r.results).toEqual([
      { lamp: 'Alpha', deviceId: 'aaaaaaaaaaaa', ok: true, viaSwarm: 'Beta' },
      expect.objectContaining({ lamp: 'Beta', ok: true, values: { speed: 2 } }),
    ]);
    expect(puts(b, '/api/js/rainbow/params')).toBe(1);
  });
});

describe('effect_copy', () => {
  it('copies source and tune values', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.effects.set('red', SRC);
    a.state.params.set('red', { speed: 8 });
    const r = await t.call('effect_copy', { from: 'Alpha', name: 'red', to: 'Beta' });
    expect(r.results).toEqual([expect.objectContaining({ lamp: 'Beta', ok: true, source: true, tunes: { speed: 8 } })]);
    expect(b.state.effects.get('red')).toBe(SRC);
    expect(b.state.params.get('red')).toEqual({ speed: 8 });
  });

  it('a built-in is not copied: missing on the target fails, present gets the tunes', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    const c = await t.addFake({ deviceId: 'cccccccccccc', name: 'Gamma' });
    a.state.params.set('rainbow', { speed: 4 });
    b.state.effects.delete('rainbow'); b.state.hardcoded.delete('rainbow');
    const r = await t.call('effect_copy', { from: 'Alpha', name: 'rainbow', to: ['Beta', 'Gamma'] });
    expect(r.results.find((x: any) => x.lamp === 'Beta')).toMatchObject({ ok: false, reason: "script rainbow isn't on this lamp" });
    expect(r.results.find((x: any) => x.lamp === 'Gamma')).toMatchObject({ ok: true, source: false });
    expect(c.state.params.get('rainbow')).toEqual({ speed: 4 });
    expect(b.state.requests.some((x) => x.method === 'PUT')).toBe(false);
  });

  it('a built-in copy never tunes an uploaded script of the same name', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.params.set('rainbow', { speed: 4 });
    b.state.hardcoded.delete('rainbow'); b.state.effects.set('rainbow', '// @param speed 0..10 = 1\nfunction shade(){}');
    const r = await t.call('effect_copy', { from: 'Alpha', name: 'rainbow', to: 'Beta' });
    expect(r.results[0]).toMatchObject({ ok: false, reason: 'rainbow on this lamp is an uploaded script, not the built-in; tunes not copied' });
    expect(b.state.params.get('rainbow')).toBeUndefined();
  });

  it('overwriting a different script on the target needs confirmation', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.effects.set('red', SRC);
    b.state.effects.set('red', 'different');
    const ask = await t.call('effect_copy', { from: 'Alpha', name: 'red', to: 'Beta' });
    expect(ask).toMatchObject({ needsConfirmation: true });
    expect(b.state.effects.get('red')).toBe('different');
    await t.call('effect_copy', { from: 'Alpha', name: 'red', to: 'Beta', confirm: ask.confirm });
    expect(b.state.effects.get('red')).toBe(SRC);
  });

  it('an effect missing on the source fails the call', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    expect(await t.call('effect_copy', { from: 'Alpha', name: 'nope', to: 'Beta' })).toMatchObject({ ok: false, reason: "script nope isn't on Alpha" });
  });
});

describe('effect library tools', () => {
  it('saves from a lamp, lists, and pushes to other lamps', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.effects.set('red', SRC);
    a.state.params.set('red', { speed: 6 });
    expect(await t.call('library_save_effect', { lamp: 'Alpha', name: 'red' })).toMatchObject({ ok: true, name: 'red', tunes: { speed: 6 } });
    expect(await t.call('library_list', { kind: 'effects' })).toEqual({ kind: 'effects', names: ['red'] });
    const r = await t.call('library_push_effect', { name: 'red', lamps: 'Beta' });
    expect(r.results[0]).toMatchObject({ lamp: 'Beta', ok: true });
    expect(b.state.effects.get('red')).toBe(SRC);
    expect(b.state.params.get('red')).toEqual({ speed: 6 });
    expect((await t.call('library_push_effect', { name: 'red', lamps: 'Alpha' })).results[0]).toMatchObject({ ok: true, replaced: false }); // identical: no confirm
    a.state.effects.set('red', 'changed on the lamp');
    const again = await t.call('library_push_effect', { name: 'red', lamps: 'Alpha' });
    expect(again).toMatchObject({ needsConfirmation: true });
    expect(again.summary).toMatch(/Replace the existing effect "red" on Alpha/);
  });

  it('library_save_effect asks before replacing a different library entry; a library change voids the push confirm', async () => {
    const t = await harness();
    const a = await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    const b = await t.addFake({ deviceId: 'bbbbbbbbbbbb', name: 'Beta' });
    a.state.effects.set('red', SRC);
    await t.call('library_save_effect', { lamp: 'Alpha', name: 'red' });
    expect(await t.call('library_save_effect', { lamp: 'Alpha', name: 'red' })).toMatchObject({ ok: true, replaced: false }); // identical
    a.state.effects.set('red', 'function shade(){ emit(0,0,255); }');
    const ask = await t.call('library_save_effect', { lamp: 'Alpha', name: 'red' });
    expect(ask).toMatchObject({ needsConfirmation: true, summary: 'Replace the library effect "red" with the version from Alpha.' });
    expect(await t.call('library_save_effect', { lamp: 'Alpha', name: 'red', confirm: ask.confirm })).toMatchObject({ ok: true, replaced: true });

    b.state.effects.set('red', 'old on Beta');
    const push = await t.call('library_push_effect', { name: 'red', lamps: 'Beta' });
    expect(push).toMatchObject({ needsConfirmation: true });
    // the library content changes between the two calls
    const { Library } = await import('../src/store/library');
    new Library(`${t.dir}/library`).writeEffect('red', 'function shade(){ emit(9,9,9); }');
    const r = await t.call('library_push_effect', { name: 'red', lamps: 'Beta', confirm: push.confirm });
    expect(r).toMatchObject({ needsConfirmation: true, refused: expect.any(String) });
    expect(b.state.effects.get('red')).toBe('old on Beta');
  });

  it('library_save_effect refuses a built-in and unknown library names fail', async () => {
    const t = await harness();
    await t.addFake({ deviceId: 'aaaaaaaaaaaa', name: 'Alpha' });
    expect(await t.call('library_save_effect', { lamp: 'Alpha', name: 'rainbow' })).toMatchObject({ ok: false });
    expect(await t.call('library_push_effect', { name: 'nope', lamps: 'all' })).toMatchObject({ ok: false, reason: 'no effect "nope" in the library' });
  });
});
