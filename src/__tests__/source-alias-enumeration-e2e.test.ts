import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

it.each([
  { alias: 'node_modules', operation: 'foreign-pull' },
  { alias: '.git', operation: 'global-push' },
])('honors accepted alias $alias during $operation', ({ alias, operation }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-alias-cli-')));
  const home = path.join(root, 'home');
  const skills = path.join(home, '.claude/skills');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
    GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[], expectedStatus = 0) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(expectedStatus);
    return output;
  };
  const commit = (cwd: string, message: string) => {
    git(['add', '-A'], cwd);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], cwd);
  };
  const createSource = (name: string, names: string[]) => {
    const seed = path.join(root, `${name}-seed`);
    const remote = path.join(root, `${name}.git`);
    const url = `https://source.test/alias-${name}/skills.git`;
    for (const skill of names) {
      fs.mkdirSync(path.join(seed, 'skills', skill), { recursive: true });
      fs.writeFileSync(path.join(seed, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${name} skill\n---\n\n# ${name} ${skill}\n`);
      fs.writeFileSync(path.join(seed, 'skills', skill, 'source-only.txt'), `Private source payload from ${name}\n`);
    }
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: name, repo: url, publicSkills: names }));
    git(['init', '-q', '-b', 'main'], seed);
    commit(seed, 'seed source');
    git(['clone', '-q', '--bare', seed, remote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${remote}.insteadOf`, url], root);
    return url;
  };
  const createTeam = (name: string, source?: string) => {
    const repo = path.join(root, name);
    const remote = path.join(root, `${name}.git`);
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), YAML.stringify({
      team: name, repo: remote, provider: 'git', reviewers: [],
      sources: source ? [{ name: 'current', repo: source }] : [], toolPaths: { claude: { skills: '.claude/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], repo);
    commit(repo, 'seed team');
    git(['clone', '-q', '--bare', repo, remote], root);
    git(['remote', 'add', 'origin', remote], repo);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], repo);
    return { repo, remote };
  };
  const selectTeam = (team: { repo: string; remote: string }) => {
    fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: team.repo, remote: team.remote }, username: 'tester', updatePolicy: 'skip', scope: 'user',
    }));
  };
  try {
    const originalUrl = createSource('original', ['foo']);
    const teamA = createTeam('team-a');
    selectTeam(teamA);
    expect(run(['source', 'add', originalUrl, '--name', alias])).toContain(`Added source "${alias}"`);
    run(['pull', '--force']);
    const skillPath = path.join(skills, 'foo/SKILL.md');
    const originalBytes = fs.readFileSync(skillPath, 'utf8');
    expect(originalBytes).toContain('# original foo');
    const installationId = createHash('sha256').update(JSON.stringify([home, teamA.repo])).digest('hex');
    const manifestPath = path.join(home, '.teamai/sources', alias, 'installations', `${installationId}.json`);
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');

    if (operation === 'foreign-pull') {
      const otherUrl = createSource('other', ['foo', 'free']);
      const teamB = createTeam('team-b', otherUrl);
      selectTeam(teamB);

      run(['pull', '--force']);

      expect(fs.readFileSync(skillPath, 'utf8')).toBe(originalBytes);
      expect(fs.readFileSync(path.join(skills, 'foo/source-only.txt'), 'utf8')).toBe('Private source payload from original\n');
      expect(fs.readFileSync(path.join(skills, 'free/SKILL.md'), 'utf8')).toContain('# other free');
      const preview = run(['push', '--dry-run']);
      expect(preview).not.toContain('[skills] foo (new)');
      expect(preview).not.toContain(`from: ${path.join(skills, 'foo')}`);
      run(['source', 'remove', 'current']);
      expect(fs.readFileSync(skillPath, 'utf8')).toBe(originalBytes);
      expect(fs.existsSync(path.join(skills, 'free'))).toBe(false);
    } else {
      // A different checkout must discover the alias without a local subscription.
      const teamB = createTeam('team-b');
      selectTeam(teamB);
      const draft = '---\nname: local-draft\ndescription: Independent local skill\n---\n\n# Local draft\n';
      fs.mkdirSync(path.join(skills, 'local-draft'));
      fs.writeFileSync(path.join(skills, 'local-draft/SKILL.md'), draft);
      const preview = run(['push', '--dry-run']);
      const branch = 'verify-alias-global-push';

      // The bare Git fixture accepts the branch and reports manual PR creation.
      const pushed = run(['push', '--all', '--branch', branch], 1);

      expect(pushed).toContain(`Pushed branch ${branch}`);
      expect(git(['show', `${branch}:skills/local-draft/SKILL.md`], teamB.remote)).toBe(draft);
      expect(git(['ls-tree', '-r', '--name-only', branch, '--', 'skills/foo'], teamB.remote).trim()).toBe('');
      expect(preview).toContain('[skills] local-draft (new)');
      expect(preview).not.toContain('[skills] foo (new)');
      expect(preview).not.toContain(`from: ${path.join(skills, 'foo')}`);
      expect(fs.readFileSync(skillPath, 'utf8')).toBe(originalBytes);
    }
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
