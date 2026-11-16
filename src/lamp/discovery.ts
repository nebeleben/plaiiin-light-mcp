import { Bonjour } from 'bonjour-service';

/** A lamp seen on mDNS (`_plaiiinlight._tcp`, TXT `id` = deviceId). */
export interface Discovered { deviceId: string; name: string; host: string; port: number; paired: boolean }

export interface ServiceLike { name: string; host?: string; port: number; addresses?: string[]; txt?: Record<string, string> }
export interface BrowserLike { on(ev: 'up', cb: (svc: ServiceLike) => void): void; stop(): void }
export interface BonjourLike { find(opts: { type: string; protocol: 'tcp' }): BrowserLike; destroy(): void }
export type BonjourFactory = () => BonjourLike;

const defaultBonjour: BonjourFactory = () => new Bonjour() as unknown as BonjourLike;

function toDiscovered(svc: ServiceLike): Discovered | undefined {
  const id = svc.txt?.id;
  const host = svc.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? svc.host;
  if (!id || !host) return undefined; // no id = firmware before 2.2.0: can't be tracked
  return { deviceId: id, name: svc.txt?.node || svc.name, host, port: svc.port, paired: svc.txt?.paired === '1' };
}

/** Browse for `timeoutMs`, or until `stopWhen` says enough. Always tears the socket down. */
function browse(timeoutMs: number, make: BonjourFactory, stopWhen?: (d: Discovered) => boolean): Promise<Map<string, Discovered>> {
  return new Promise((resolve) => {
    const found = new Map<string, Discovered>();
    const bonjour = make();
    const browser = bonjour.find({ type: 'plaiiinlight', protocol: 'tcp' });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { browser.stop(); } finally { bonjour.destroy(); }
      resolve(found);
    };
    const timer = setTimeout(finish, timeoutMs);
    browser.on('up', (svc) => {
      const d = toDiscovered(svc);
      if (!d || done) return;
      found.set(d.deviceId, d);
      if (stopWhen?.(d)) finish();
    });
  });
}

/** All lamps answering within `timeoutMs`, one per deviceId. */
export async function discover(timeoutMs = 3000, make: BonjourFactory = defaultBonjour): Promise<Discovered[]> {
  return [...(await browse(timeoutMs, make)).values()];
}

/** Find one lamp by deviceId (returns as soon as it answers). */
export async function resolveDevice(deviceId: string, timeoutMs = 3000, make: BonjourFactory = defaultBonjour): Promise<Discovered | undefined> {
  return (await browse(timeoutMs, make, (d) => d.deviceId === deviceId)).get(deviceId);
}
