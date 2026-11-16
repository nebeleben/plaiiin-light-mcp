import { beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// These tests start git / npm / node processes; on a busy machine the default 10 s is too tight.
vi.setConfig({ testTimeout: 60_000 });

const script = resolve(__dirname, '../scripts/release-commit.sh');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
/** git against a bare repository. */
const git = (bare: string, ...args: string[]) => sh(bare, ...args);
const ls = (bare: string, ref: string) => git(bare, 'ls-tree', '-r', '--name-only', ref).split('\n');
type Target = 'claudecode' | 'chatgpt' | 'npm';
const LAYOUT = {
  claudecode: { dir: 'plugin', manifest: 'plugin/.claude-plugin/plugin.json' },
  chatgpt: { dir: 'plugin-chatgpt', manifest: 'plugin-chatgpt/.codex-plugin/plugin.json' },
  npm: { dir: 'npm', manifest: 'npm/package.json' },
} as const;
const run = (repo: string, version: string, remote: string, target: string = 'claudecode') => {
  const r = spawnSync(script, [version, remote, target], { cwd: repo, env: ENV, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
};

function write(repo: string, path: string, text: string) {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), text);
}
function setVersion(repo: string, version: string, target: Target = 'claudecode') {
  write(repo, 'package.json', JSON.stringify({ name: 'x', version }));
  write(repo, LAYOUT[target].manifest, JSON.stringify({ name: 'plaiiin-lamps', version }));
}
/** A repo shaped like one target's public tree after `npm run build`: build outputs present but git-ignored. */
function makeRepo(version: string, target: Target = 'claudecode'): string {
  const { dir } = LAYOUT[target];
  const repo = mkdtempSync(join(tmpdir(), 'relrepo-'));
  sh(repo, 'init', '-q', '-b', 'source');
  setVersion(repo, version, target);
  write(repo, '.gitignore', `node_modules/\n${dir}/dist/\n${dir}/skills/\n${dir}/THIRD-PARTY-NOTICES.txt\n${dir}/LICENSE\n`);
  write(repo, 'src/a.ts', 'export {};\n');
  write(repo, 'skills/x/SKILL.md', 'the shared source of the skill\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'source');
  write(repo, `${dir}/dist/index.js`, '// bundle\n');
  write(repo, `${dir}/dist/preview-worker.mjs`, '// worker\n');
  write(repo, `${dir}/dist/chunks/extra.js`, '// a build output added later\n');
  // the npm package ships no skills folder, but its own copy of the licence
  if (target === 'npm') write(repo, `${dir}/LICENSE`, 'licence\n');
  else write(repo, `${dir}/skills/x/SKILL.md`, 'the shared source of the skill\n');
  write(repo, `${dir}/THIRD-PARTY-NOTICES.txt`, 'notices\n');
  write(repo, 'node_modules/x/index.js', 'x\n');
  write(repo, 'scratch.txt', 'untracked, not a build output\n');
  return repo;
}
function makeRemote(): string {
  const bare = mkdtempSync(join(tmpdir(), 'relremote-'));
  sh(bare, 'init', '-q', '--bare');
  return bare;
}

describe('release-commit.sh', () => {
  let repo: string, remote: string;
  beforeAll(() => { repo = makeRepo('0.1.0'); remote = makeRemote(); return () => { rmSync(repo, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); }; });

  it('first release creates main', () => {
    const r = run(repo, '0.1.0', remote);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(git(remote, 'rev-list', '--count', 'main')).toBe('1');
    expect(git(remote, 'rev-parse', 'v0.1.0^{commit}')).toBe(git(remote, 'rev-parse', 'main'));
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('Release v0.1.0');
  });

  it('release tree has the bundle and no node_modules', () => {
    const files = ls(remote, 'main');
    expect(files).toEqual(expect.arrayContaining(['plugin/dist/index.js', 'plugin/dist/preview-worker.mjs', 'plugin/THIRD-PARTY-NOTICES.txt', 'src/a.ts', '.gitignore']));
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(files).not.toContain('scratch.txt');
  });

  it('release tree takes everything the build wrote to plugin/dist', () => {
    expect(ls(remote, 'main')).toContain('plugin/dist/chunks/extra.js');
    expect(ls(remote, 'main')).toContain('plugin/skills/x/SKILL.md');
  });

  it('leaves the source repo\'s own index and branch untouched', () => {
    expect(sh(repo, 'status', '--porcelain')).toBe('?? scratch.txt');
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('source');
  });

  it('second release fast-forwards main', () => {
    setVersion(repo, '0.1.1');
    sh(repo, 'commit', '-q', '-am', 'bump');
    expect(run(repo, '0.1.1', remote).status).toBe(0);
    expect(git(remote, 'rev-parse', 'main^')).toBe(git(remote, 'rev-parse', 'v0.1.0^{commit}'));
    expect(git(remote, 'rev-parse', 'v0.1.1^{commit}')).toBe(git(remote, 'rev-parse', 'main'));
  });

  it('refuses a version that is already published', () => {
    const before = git(remote, 'rev-parse', 'main');
    const r = run(repo, '0.1.1', remote);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-commit: v0.1.1 is already published');
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
  });

  it('refuses a version mismatch', () => {
    const repo2 = makeRepo('0.2.0'), remote2 = makeRemote();
    const r = run(repo2, '0.3.0', remote2);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-commit: version mismatch (tag 0.3.0, plugin.json 0.2.0, package.json 0.2.0)');
    expect(git(remote2, 'for-each-ref')).toBe('');
    rmSync(repo2, { recursive: true, force: true }); rmSync(remote2, { recursive: true, force: true });
  });

  it('chatgpt release takes plugin-chatgpt outputs and checks its manifest', () => {
    const repo2 = makeRepo('0.2.0', 'chatgpt'), remote2 = makeRemote();
    const r = run(repo2, '0.2.0', remote2, 'chatgpt');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(ls(remote2, 'main')).toEqual(expect.arrayContaining([
      'plugin-chatgpt/dist/index.js', 'plugin-chatgpt/dist/preview-worker.mjs', 'plugin-chatgpt/dist/chunks/extra.js',
      'plugin-chatgpt/skills/x/SKILL.md', 'plugin-chatgpt/THIRD-PARTY-NOTICES.txt', 'plugin-chatgpt/.codex-plugin/plugin.json', 'skills/x/SKILL.md',
    ]));
    // its own manifest decides: a tag that disagrees with it is refused
    setVersion(repo2, '0.2.1', 'chatgpt');
    write(repo2, 'package.json', JSON.stringify({ name: 'x', version: '0.3.0' }));
    sh(repo2, 'commit', '-q', '-am', 'bump');
    const bad = run(repo2, '0.3.0', remote2, 'chatgpt');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('release-commit: version mismatch (tag 0.3.0, plugin.json 0.2.1, package.json 0.3.0)');
    rmSync(repo2, { recursive: true, force: true }); rmSync(remote2, { recursive: true, force: true });
  });

  it('npm release takes the package outputs and needs no skills', () => {
    const repo2 = makeRepo('0.3.0', 'npm'), remote2 = makeRemote();
    write(repo2, 'npm/bin/x.mjs', '// entry\n');
    sh(repo2, 'add', 'npm/bin/x.mjs');
    sh(repo2, 'commit', '-q', '-m', 'entry');
    const r = run(repo2, '0.3.0', remote2, 'npm');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const files = ls(remote2, 'main');
    expect(files).toEqual(expect.arrayContaining([
      'npm/package.json', 'npm/bin/x.mjs', 'npm/dist/index.js', 'npm/dist/preview-worker.mjs', 'npm/dist/chunks/extra.js',
      'npm/THIRD-PARTY-NOTICES.txt', 'npm/LICENSE',
    ]));
    expect(files.some((f) => f.startsWith('npm/skills/'))).toBe(false);
    // the licence copy is part of what gets published: without it the release is refused
    const repo3 = makeRepo('0.3.0', 'npm'), remote3 = makeRemote();
    rmSync(join(repo3, 'npm/LICENSE'));
    const bad = run(repo3, '0.3.0', remote3, 'npm');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('release-commit: bundle missing');
    // a wrong tag names the npm manifest, not a plugin's
    const repo4 = makeRepo('0.3.0', 'npm');
    expect(run(repo4, '0.4.0', remote3, 'npm').stderr).toContain('release-commit: version mismatch (tag 0.4.0, package.json 0.3.0, package.json 0.3.0)');
    rmSync(repo4, { recursive: true, force: true });
    for (const d of [repo2, remote2, repo3, remote3]) rmSync(d, { recursive: true, force: true });
  });

  it('refuses an unknown target', () => {
    const repo2 = makeRepo('0.2.0'), remote2 = makeRemote();
    const r = run(repo2, '0.2.0', remote2, 'gemini');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-commit: unknown target');
    expect(git(remote2, 'for-each-ref')).toBe('');
    rmSync(repo2, { recursive: true, force: true }); rmSync(remote2, { recursive: true, force: true });
  });

  it('refuses when the target folder is not in this tree', () => {
    const repo2 = makeRepo('0.2.0', 'claudecode'), remote2 = makeRemote();
    const r = run(repo2, '0.2.0', remote2, 'chatgpt');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-commit: this tree has no chatgpt target');
    expect(git(remote2, 'for-each-ref')).toBe('');
    rmSync(repo2, { recursive: true, force: true }); rmSync(remote2, { recursive: true, force: true });
  });

  it('says so when the remote cannot be reached', () => {
    const repo2 = makeRepo('0.2.0');
    const r = run(repo2, '0.2.0', join(tmpdir(), 'no-such-remote-' + process.pid));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-commit: cannot reach the remote');
    rmSync(repo2, { recursive: true, force: true });
  });

  it('refuses when the bundle is missing', () => {
    const repo2 = makeRepo('0.2.0'), remote2 = makeRemote();
    rmSync(join(repo2, 'plugin/dist/index.js'));
    const r = run(repo2, '0.2.0', remote2);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('release-commit: bundle missing');
    expect(git(remote2, 'for-each-ref')).toBe('');
    rmSync(repo2, { recursive: true, force: true }); rmSync(remote2, { recursive: true, force: true });
  });
});
