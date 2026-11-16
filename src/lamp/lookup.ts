import { lookup as dnsLookup, type LookupOptions } from 'node:dns';

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void;
type LookupFn = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

/**
 * DNS lookup for lamps. Share links name the lamp by its mDNS name (`<lamp>.local`); on macOS the
 * default lookup asks for IPv4 and IPv6 and waits ~5 s for an IPv6 answer that lamps never give,
 * which eats the whole request timeout. `.local` names are therefore resolved IPv4-only first, with
 * the normal lookup as the fallback. Other names go straight to the normal lookup.
 */
export function makeLanLookup(base: LookupFn = dnsLookup as unknown as LookupFn): LookupFn {
  return (hostname, options, callback) => {
    if (!/\.local\.?$/i.test(hostname)) { base(hostname, options, callback); return; }
    base(hostname, { ...options, family: 4 }, (err, address, family) => {
      if (!err) { callback(null, address, family); return; }
      base(hostname, options, callback);
    });
  };
}

export const lanLookup = makeLanLookup();
