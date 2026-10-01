import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const SOURCE_SKILL = '---\nname: foo\ndescription: Published source skill\n---\n\n# Source-owned bytes\n';
const LOCAL_SKILL = '---\nname: foo\ndescription: Independent local skill\n---\n\n# Different local bytes\n';

it.each(['identical', 'different', 'foreign-configured', 'foreign-shared'])(
  'reconciles Codex source duplicates only after ownership checks (%s)',
  (scenario) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-codex-')));
    const home = path.join(root, 'home');
    const configured = path.join(home, '.codex', 'skills', 'foo');
    const shared = path.join(home, '.agents', 'skills', 'foo');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.mkdirSync(path.dirname(configured), { recursive: true });
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), FORCE_COLOR: '0',
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    };
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
      const output = result.stdout + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(0);
      return output;
    };
    const commit = (cwd: string, message: string) => {
      git(['add', '-A'], cwd);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], cwd);
    };
    const contents = (dir: string) => Object.fromEntries(fs.readdirSync(dir).sort()
      .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
    const createSource = (name: string) => {
      const seed = path.join(root, `${name}-source-seed`);
      const remote = path.join(root, `${name}-source.git`);
      const url = `https://source.test/${name}/skills.git`;
      const skill = path.join(seed, 'skills', 'foo');
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), SOURCE_SKILL);
      fs.writeFileSync(path.join(skill, 'source-only.txt'), 'Source payload\n');
      fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: name, repo: url, publicSkills: ['foo'] }));
      git(['init', '-q', '-b', 'main'], seed);
      commit(seed, 'seed source');
      git(['clone', '-q', '--bare', seed, remote], root);
      git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${remote}.insteadOf`, url], root);
      return { url, skill };
    };
    const createTeam = (name: string, sourceUrl: string) => {
      const teamRepo = path.join(root, name, 'team-repo');
      const teamRemote = path.join(root, `${name}-team.git`);
      const alias = `${name}-source`;
      fs.mkdirSync(teamRepo, { recursive: true });
      fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
        team: name, repo: teamRemote, provider: 'git', reviewers: [],
        sources: [{ name: alias, repo: sourceUrl }], toolPaths: { codex: { skills: '.codex/skills' } },
      }));
      git(['init', '-q', '-b', 'main'], teamRepo);
      commit(teamRepo, 'seed team');
      git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
      git(['remote', 'add', 'origin', teamRemote], teamRepo);
      git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
      const config = {
        repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester', updatePolicy: 'skip', scope: 'user',
      };
      const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
      const manifest = path.join(home, '.teamai', 'sources', alias, 'installations', `${installationId}.json`);
      return { alias, config, manifest };
    };
    const activate = (team: ReturnType<typeof createTeam>) => fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify(team.config));
    try {
      const incoming = createSource('incoming');
      let ownerManifest: string | undefined;
      let ownerBefore: string | undefined;
      if (scenario.startsWith('foreign-')) {
        const producer = createSource('owner');
        const owner = createTeam('owner', producer.url);
        if (scenario === 'foreign-shared') fs.cpSync(producer.skill, shared, { recursive: true });
        activate(owner);
        run(['pull', '--force']);
        ownerManifest = owner.manifest;
        ownerBefore = fs.readFileSync(ownerManifest, 'utf8');
        expect(JSON.parse(ownerBefore).installedPaths.foo).toEqual([
          scenario === 'foreign-shared' ? '.agents/skills/foo' : '.codex/skills/foo',
        ]);
      }
      if (!fs.existsSync(shared)) fs.cpSync(incoming.skill, shared, { recursive: true });
      if (!fs.existsSync(configured)) fs.cpSync(incoming.skill, configured, { recursive: true });
      if (scenario === 'different') {
        fs.writeFileSync(path.join(configured, 'SKILL.md'), LOCAL_SKILL);
        fs.unlinkSync(path.join(configured, 'source-only.txt'));
        fs.writeFileSync(path.join(configured, 'local-only.txt'), 'Independent local payload\n');
      }
      const sharedBefore = contents(shared);
      const configuredBefore = contents(configured);
      const consumer = createTeam('consumer', incoming.url);
      activate(consumer);

      // Warm the cache without deployment so dry-run can inspect incoming bytes.
      expect(run(['source', 'browse', consumer.alias])).toContain('foo');
      run(['pull', '--force', '--dry-run']);
      expect(contents(shared)).toEqual(sharedBefore);
      expect(contents(configured)).toEqual(configuredBefore);
      expect(fs.existsSync(consumer.manifest)).toBe(false);
      if (ownerManifest) expect(fs.readFileSync(ownerManifest, 'utf8')).toBe(ownerBefore);

      const output = run(['pull', '--force']);
      expect(contents(shared)).toEqual(sharedBefore);
      if (ownerManifest) expect(fs.readFileSync(ownerManifest, 'utf8')).toBe(ownerBefore);
      if (scenario === 'foreign-shared') {
        expect(output).toContain('another source repository owns');
        expect(contents(configured)).toEqual(configuredBefore);
        expect(JSON.parse(fs.readFileSync(consumer.manifest, 'utf8')).installedSkills).toEqual([]);
        return;
      }

      const manifest = JSON.parse(fs.readFileSync(consumer.manifest, 'utf8'));
      expect(manifest.installedSkills).toEqual(['foo']);
      expect(manifest.installedPaths.foo).toEqual(['.agents/skills/foo']);
      if (scenario === 'identical') expect(fs.existsSync(configured)).toBe(false);
      else expect(contents(configured)).toEqual(configuredBefore);

      const preview = run(['push', '--dry-run']);
      if (scenario === 'different') {
        expect(output).toContain('Codex skill conflict for foo');
        expect(preview).toContain('[skills] foo (new)');
        expect(preview).toContain(`from: ${configured}`);
        expect(fs.readFileSync(path.join(configured, 'SKILL.md'), 'utf8')).toBe(LOCAL_SKILL);
      } else {
        expect(preview).not.toContain('[skills] foo (new)');
        expect(preview).not.toContain(`from: ${configured}`);
      }
      expect(preview).not.toContain(`from: ${shared}`);
      expect(contents(shared)).toEqual(sharedBefore);
      if (ownerManifest) expect(fs.readFileSync(ownerManifest, 'utf8')).toBe(ownerBefore);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
