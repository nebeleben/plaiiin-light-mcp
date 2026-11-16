import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_KEYCHAIN_SERVICE } from '../profile';

/** Share keys / tokens per deviceId. Values never appear in errors. */
export interface Secrets {
  get(deviceId: string): Promise<string | undefined>;
  set(deviceId: string, secret: string): Promise<void>;
  delete(deviceId: string): Promise<void>;
}

/** Run `cmd` with an argument array (no shell); `input` is written to its stdin. */
export type Runner = (cmd: string, args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const SECURITY = '/usr/bin/security';
const NOT_FOUND = 44; // errSecItemNotFound exit status of `security`

/** A double-quoted word for `security -i` (backslash escapes `"` and `\`). Control characters can't be quoted. */
function quote(v: string, what: string): string {
  if (/[\x00-\x1f\x7f]/.test(v)) throw new Error(`keychain: the ${what} contains a control character`);
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The `security -i` stdin line that stores a secret. The secret goes on stdin, never in argv, where
 * any local user could read it (`ps`). The error for a bad value never contains the value.
 */
export function keychainSetCommand(id: string, secret: string, service: string = DEFAULT_KEYCHAIN_SERVICE): string {
  return `add-generic-password -U -s ${quote(service, 'service')} -a ${quote(id, 'account')} -w ${quote(secret, 'secret')}\n`;
}

/** get/delete carry no secret, so they stay plain argument arrays. */
export const keychainArgs = {
  get: (id: string, service: string = DEFAULT_KEYCHAIN_SERVICE) => ['find-generic-password', '-s', service, '-a', id, '-w'],
  delete: (id: string, service: string = DEFAULT_KEYCHAIN_SERVICE) => ['delete-generic-password', '-s', service, '-a', id],
};

/** Spawn with an argument array (no shell), collect output. */
const spawnRunner: Runner = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (input !== undefined) { p.stdin!.on('error', () => { /* reported via exit code */ }); p.stdin!.end(input, 'utf8'); }
  let stdout = '', stderr = '';
  p.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  p.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  p.on('error', (e) => reject(new Error(`keychain: cannot run ${cmd}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`)));
  p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
});

class KeychainSecrets implements Secrets {
  constructor(private readonly run: Runner, private readonly service: string) {}

  async get(deviceId: string): Promise<string | undefined> {
    const r = await this.run(SECURITY, keychainArgs.get(deviceId, this.service));
    if (r.code === NOT_FOUND) return undefined;
    if (r.code !== 0) throw fail('find-generic-password', r.code);
    return r.stdout.replace(/\r?\n$/, '');
  }

  async set(deviceId: string, secret: string): Promise<void> {
    const r = await this.run(SECURITY, ['-i'], keychainSetCommand(deviceId, secret, this.service));
    if (r.code !== 0) throw fail('add-generic-password', r.code);
  }

  async delete(deviceId: string): Promise<void> {
    const r = await this.run(SECURITY, keychainArgs.delete(deviceId, this.service));
    if (r.code !== 0 && r.code !== NOT_FOUND) throw fail('delete-generic-password', r.code);
  }
}

/** The error names the subcommand and exit code only — never the arguments or stderr (could echo the secret). */
function fail(sub: string, code: number): Error {
  return new Error(`keychain: security ${sub} failed (exit ${code})`);
}

/** `<dir>/secrets.json`, mode 0600, rewritten atomically. */
class FileSecrets implements Secrets {
  private readonly file: string;
  constructor(private readonly dir: string) { this.file = join(dir, 'secrets.json'); }

  async get(deviceId: string): Promise<string | undefined> {
    return this.read()[deviceId];
  }

  async set(deviceId: string, secret: string): Promise<void> {
    const all = this.read();
    all[deviceId] = secret;
    this.write(all);
  }

  async delete(deviceId: string): Promise<void> {
    const all = this.read();
    if (!(deviceId in all)) return;
    delete all[deviceId];
    this.write(all);
  }

  private read(): Record<string, string> {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return {};
      // Anything else must not read as "no secrets": a later write would drop every stored key.
      throw new Error(`cannot read secrets file ${this.file}: ${code ?? 'error'}`);
    }
    try {
      const j = JSON.parse(text) as unknown;
      return j && typeof j === 'object' ? { ...(j as Record<string, string>) } : {};
    } catch {
      throw new Error(`secrets file ${this.file} is not valid JSON`);
    }
  }

  private write(all: Record<string, string>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600); // mode is masked by umask on create
    renameSync(tmp, this.file);
  }
}

/**
 * darwin → macOS Keychain via `security` (one entry per lamp: service = the profile's, account =
 * deviceId); else a 0600 file in `dir`, which is per profile already.
 */
export function makeSecrets(dir: string, platform: NodeJS.Platform = process.platform, run: Runner = spawnRunner, service: string = DEFAULT_KEYCHAIN_SERVICE): Secrets {
  return platform === 'darwin' ? new KeychainSecrets(run, service) : new FileSecrets(dir);
}
