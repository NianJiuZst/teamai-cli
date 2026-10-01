import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

it.each(['inside', 'outside'])('materializes only source-root aliases contained in their repository (%s)', (target) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-root-alias-')));
  const home = path.join(root, 'home');
  const destination = path.join(home, '.claude', 'skills', 'foo');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
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
  try {
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/root-alias/skills.git';
    const referent = target === 'inside' ? path.join(sourceSeed, 'payload') : path.join(home, 'unrelated');
    const body = target === 'inside' ? '# In-repository source payload\n' : '# Unrelated private payload\n';
    fs.mkdirSync(referent, { recursive: true });
    fs.writeFileSync(path.join(referent, 'SKILL.md'), body);
    fs.writeFileSync(path.join(referent, 'keep.txt'), 'Preserve the input payload\n');
    fs.mkdirSync(path.join(sourceSeed, 'skills', 'safe'), { recursive: true });
    fs.writeFileSync(path.join(sourceSeed, 'skills', 'safe', 'SKILL.md'), '# Safe source skill\n');
    fs.symlinkSync(target === 'inside' ? '../payload' : referent, path.join(sourceSeed, 'skills', 'foo'), 'dir');
    fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
      team: 'root-alias', repo: sourceUrl, publicSkills: target === 'inside' ? ['foo'] : ['safe', 'foo'],
    }));
    git(['init', '-q', '-b', 'main'], sourceSeed);
    commit(sourceSeed, 'seed source alias');
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);

    const teamRepo = path.join(root, 'team-repo');
    const teamRemote = path.join(root, 'team.git');
    const teamYaml = path.join(teamRepo, 'teamai.yaml');
    fs.mkdirSync(teamRepo);
    fs.writeFileSync(teamYaml, YAML.stringify({
      team: 'alias-consumer', repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: 'shared', repo: sourceUrl }], toolPaths: { claude: { skills: '.claude/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], teamRepo);
    commit(teamRepo, 'seed team');
    git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
    git(['remote', 'add', 'origin', teamRemote], teamRepo);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester', updatePolicy: 'skip', scope: 'user',
    }));
    const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
    const manifestPath = path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`);
    const yamlBefore = fs.readFileSync(teamYaml, 'utf8');

    const output = run(['pull', '--force']);
    if (target === 'outside') {
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'safe'))).toBe(false);
      expect(fs.existsSync(manifestPath)).toBe(false);
      expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
      expect(output.toLowerCase()).toContain('repository');
      expect(output.toLowerCase()).toContain('manual');
      expect(run(['pull', '--force', '--dry-run']).toLowerCase()).toContain('manual');
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.existsSync(manifestPath)).toBe(false);
    } else {
      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toBe(body);
      expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('Preserve the input payload\n');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      expect(manifest.installedSkills).toEqual(['foo']);
      expect(manifest.installedPhysicalPaths['.claude/skills/foo']).toBe(destination);
      const repoId = createHash('sha256').update(sourceUrl).digest('hex');
      const cachedInput = path.join(home, '.teamai', 'source-repos', repoId, 'repo', 'payload');
      expect(fs.readFileSync(path.join(cachedInput, 'SKILL.md'), 'utf8')).toBe(body);
      run(['source', 'remove', 'shared']);
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.existsSync(manifestPath)).toBe(false);
      expect(fs.readFileSync(path.join(cachedInput, 'SKILL.md'), 'utf8')).toBe(body);
      expect(fs.readFileSync(path.join(cachedInput, 'keep.txt'), 'utf8')).toBe('Preserve the input payload\n');
    }
    expect(fs.readFileSync(path.join(referent, 'SKILL.md'), 'utf8')).toBe(body);
    expect(fs.readFileSync(path.join(referent, 'keep.txt'), 'utf8')).toBe('Preserve the input payload\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
