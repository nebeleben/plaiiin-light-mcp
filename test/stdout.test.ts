import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { consoleToStderr } from '../src/util/stdout';

const saved = globalThis.console;
afterEach(() => { globalThis.console = saved; });

describe('consoleToStderr (stdout is the JSON-RPC channel)', () => {
  it('routes console.log/info/debug/warn of libraries (omggif, bonjour) to the given stream', () => {
    let out = '';
    const sink = new Writable({ write(c, _e, cb) { out += String(c); cb(); } });
    consoleToStderr(sink);
    console.log('Warning, gif stream longer than expected.');
    console.info('info');
    console.debug('debug');
    globalThis.console.log('via globalThis');
    expect(out).toContain('Warning, gif stream longer than expected.');
    expect(out).toContain('info');
    expect(out).toContain('debug');
    expect(out).toContain('via globalThis');
  });
});
