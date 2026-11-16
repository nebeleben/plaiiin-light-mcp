import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { decodeQrImage, parseShareLink } from '../src/lamp/shareLink';

describe('parseShareLink', () => {
  it('parses a bare link (default port 80)', () => {
    expect(parseShareLink('http://192.168.1.5/config?t=abc')).toEqual({ host: '192.168.1.5', port: 80, key: 'abc' });
  });
  it('finds the link inside a sentence, with a port', () => {
    expect(parseShareLink('Here is my lamp: http://kitchen.local:8080/config?t=k-1_2. Enjoy!'))
      .toEqual({ host: 'kitchen.local', port: 8080, key: 'k-1_2' });
  });
  it('t may follow other params', () => {
    expect(parseShareLink('http://10.0.0.2/config?x=1&t=zz')).toEqual({ host: '10.0.0.2', port: 80, key: 'zz' });
  });
  it('an https link is refused (lamps serve http only), without echoing the key', () => {
    expect(() => parseShareLink('https://10.0.0.2/config?x=1&t=SECRETKEY')).toThrow(/lamps use http — use the http:\/\/ link/);
    expect(() => parseShareLink('https://10.0.0.2/config?t=SECRETKEY')).not.toThrow(/SECRETKEY/);
  });
  it('non-matching text → undefined', () => {
    expect(parseShareLink('http://192.168.1.5/api')).toBeUndefined();
    expect(parseShareLink('no link here')).toBeUndefined();
    expect(parseShareLink('http://192.168.1.5/config?t=')).toBeUndefined();
  });
});

describe('decodeQrImage', () => {
  const fx = (n: string) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
  it('decodes a PNG QR code', () => {
    expect(decodeQrImage(fx('share-qr.png'))).toBe('http://192.168.1.77:8080/config?t=qrkey123');
  });
  it('decodes a JPEG QR code', () => {
    expect(decodeQrImage(fx('share-qr.jpg'))).toBe('http://192.168.1.77:8080/config?t=qrkey123');
  });
  it('PNG without a QR code → undefined', () => {
    const png = new PNG({ width: 40, height: 40 });
    png.data.fill(255);
    const p = join(mkdtempSync(join(tmpdir(), 'lamp-mcp-')), 'blank.png');
    writeFileSync(p, PNG.sync.write(png));
    expect(decodeQrImage(p)).toBeUndefined();
  });
  it('a PNG is checked before decoding: oversized or interlaced → refused with the reason', () => {
    const d = mkdtempSync(join(tmpdir(), 'lamp-mcp-'));
    // A valid-looking IHDR claiming 100000×100000 px (never decoded)
    const head = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'ascii');
    head.writeUInt32BE(100000, 16); head.writeUInt32BE(100000, 20); head[24] = 8; head[25] = 6;
    writeFileSync(join(d, 'huge.png'), head);
    expect(() => decodeQrImage(join(d, 'huge.png'))).toThrow(/at most 4096/);
    const inter = Buffer.from(head); inter.writeUInt32BE(40, 16); inter.writeUInt32BE(40, 20); inter[28] = 1;
    writeFileSync(join(d, 'inter.png'), inter);
    expect(() => decodeQrImage(join(d, 'inter.png'))).toThrow(/interlaced/);
  });
  it('non-image or missing file → undefined', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lamp-mcp-')), 'x.txt');
    writeFileSync(p, 'hello');
    expect(decodeQrImage(p)).toBeUndefined();
    expect(decodeQrImage(p + '.missing')).toBeUndefined();
  });
});
