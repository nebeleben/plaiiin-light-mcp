import { join } from 'node:path';

/** Keychain service of the default profile (the Claude Code plugin's, unchanged since 0.1.0). */
export const DEFAULT_KEYCHAIN_SERVICE = 'plaiiin-lamp-mcp';

const PROFILE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Where this server keeps its lamp list and keys.
 *
 * Each AI assistant's plugin names a profile in `PLAIIIN_LAMPS_PROFILE`, so a key handed to one
 * assistant is not automatically usable by another: profile `chatgpt` → `~/.plaiiin/lamps-chatgpt`
 * and Keychain service `plaiiin-lamp-mcp-chatgpt`. No profile is the original layout
 * (`~/.plaiiin/lamps`, `plaiiin-lamp-mcp`). `PLAIIIN_LAMPS_DIR` overrides the folder only (tests).
 *
 * The profile becomes part of a path and a Keychain service name, so anything but lowercase
 * letters, digits and inner hyphens is refused rather than cleaned up.
 */
export function resolveProfile(env: NodeJS.ProcessEnv, home: string): { stateDir: string; keychainService: string } {
  const profile = env.PLAIIIN_LAMPS_PROFILE;
  if (profile !== undefined && !PROFILE.test(profile)) {
    throw new Error('PLAIIIN_LAMPS_PROFILE must be 1–32 lowercase letters, digits or hyphens (not starting or ending with a hyphen)');
  }
  const suffix = profile === undefined ? '' : `-${profile}`;
  return {
    stateDir: env.PLAIIIN_LAMPS_DIR ?? join(home, '.plaiiin', `lamps${suffix}`),
    keychainService: `${DEFAULT_KEYCHAIN_SERVICE}${suffix}`,
  };
}
