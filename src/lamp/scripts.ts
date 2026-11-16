/** Low-level script (effect) calls on one lamp: `/api/js`, sources and tune values. */
import type { LampClient } from './client';

export interface EffectItem { name: string; description?: string; tags?: string[]; source?: 'hardcoded' | 'script' }
export interface Listing { scripts?: string[]; playing?: string | null; effects?: EffectItem[] }
export interface ParamItem { name: string; min: number; max: number; default: number; value: number; description?: string }
export interface ParamSchema { items?: ParamItem[]; mode?: string; modeSwitch?: boolean }

const enc = (n: string) => encodeURIComponent(n);

export const listing = (c: LampClient) => c.get<Listing>('/api/js');
export const builtIn = (l: Listing, name: string) => l.effects?.find((e) => e.name === name)?.source === 'hardcoded';
export const present = (l: Listing, name: string) => (l.effects?.some((e) => e.name === name) ?? false) || (l.scripts?.includes(name) ?? false);
export const values = (s: ParamSchema): Record<string, number> => Object.fromEntries((s.items ?? []).map((i) => [i.name, i.value]));

export function putSource(c: LampClient, name: string, src: string) {
  return c.sendRaw('PUT', `/api/js/${enc(name)}`, src, 'text/javascript');
}
export function putTunes(c: LampClient, name: string, v: Record<string, number>) {
  return c.send<ParamSchema>('PUT', `/api/js/${enc(name)}/params`, v);
}
/** The lamp's tune values for a script (undefined when it has none or can't say), as SwarmSync's `tunes`. */
export async function readTunes(c: LampClient, name: string): Promise<Record<string, number> | undefined> {
  const s = await c.get<ParamSchema>(`/api/js/${enc(name)}/params`).catch(() => undefined);
  return s?.items?.length ? values(s) : undefined;
}
