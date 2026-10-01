import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

function treeContents(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(item);
      else files[path.relative(root, item)] = fs.readFileSync(item, 'utf8');
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files;
}

it.each([
  { previous: 'group/child', next: 'group', owner: 'self' },
  { previous: 'group', next: 'group/child', owner: 'self' },
  { previous: 'group/child', next: 'group', owner: 'same-repo-alias' },
  { previous: 'group', next: 'group/child', owner: 'same-repo-alias' },
  { previous: 'group/child', next: 'group', owner: 'other-repo' },
  { previous: 'group', next: 'group/child', owner: 'other-repo' },
])('preserves nested ownership until explicitly removed ($owner: $previous → $next)', ({ previous, next, owner }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-nested-')));
  const home = path.join(root, 'home');
  const skillsDir = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'local-draft'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'local-draft', 'SKILL.md'), '# Local draft\n');
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
  const writePublication = (seed: string, url: string, names: string[], revision: string) => {
    fs.rmSync(path.join(seed, 'skills'), { recursive: true, force: true });
    for (const name of names) {
      const dir = path.join(seed, 'skills', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${revision} ${name}\n`);
      fs.writeFileSync(path.join(dir, 'revision.txt'), `${revision}\n`);
      if (name === 'group') {
        fs.mkdirSync(path.join(dir, 'child'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'child', 'SKILL.md'), `# ${revision} embedded child\n`);
      }
    }
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'nested-source', repo: url, publicSkills: names }));
  };
  const createSource = (name: string, names: string[]) => {
    const seed = path.join(root, `${name}-source-seed`);
    const remote = path.join(root, `${name}-source.git`);
    const url = `https://source.test/${name}/skills.git`;
    writePublication(seed, url, names, 'initial');
    git(['init', '-q', '-b', 'main'], seed);
    commit(seed, 'seed source');
    git(['clone', '-q', '--bare', seed, remote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${remote}.insteadOf`, url], root);
    return { seed, remote, url };
  };
  const publish = (source: ReturnType<typeof createSource>, names: string[], revision: string) => {
    writePublication(source.seed, source.url, names, revision);
    commit(source.seed, `publish ${revision}`);
    git(['push', '-q', source.remote, 'main'], source.seed);
  };
  const createTeam = (name: string, sourceUrl: string) => {
    const teamRepo = path.join(root, name, 'team-repo');
    const teamRemote = path.join(root, `${name}-team.git`);
    const alias = `${name}-source`;
    fs.mkdirSync(teamRepo, { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: name, repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: alias, repo: sourceUrl }],
      toolPaths: { claude: { skills: '.claude/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], teamRepo);
    commit(teamRepo, 'seed team');
    git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
    git(['remote', 'add', 'origin', teamRemote], teamRepo);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
    const config = {
      repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester',
      updatePolicy: 'skip', scope: 'user',
    };
    const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
    const manifest = path.join(home, '.teamai', 'sources', alias, 'installations', `${installationId}.json`);
    return { alias, config, manifest };
  };
  const activate = (team: ReturnType<typeof createTeam>) => fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify(team.config));

  try {
    const source = createSource('alpha', [previous]);
    const alpha = createTeam('alpha', source.url);
    activate(alpha);
    run(['pull', '--force']);
    expect(fs.readFileSync(path.join(skillsDir, previous, 'SKILL.md'), 'utf8')).toBe(`# initial ${previous}\n`);
    expect(JSON.parse(fs.readFileSync(alpha.manifest, 'utf8')).installedSkills).toEqual([previous]);

    // Canonical nested names remain valid, including updates at the same boundary.
    publish(source, [previous], 'updated');
    run(['pull', '--force']);
    expect(fs.readFileSync(path.join(skillsDir, previous, 'SKILL.md'), 'utf8')).toBe(`# updated ${previous}\n`);
    const alphaManifest = fs.readFileSync(alpha.manifest, 'utf8');
    const groupBefore = treeContents(path.join(skillsDir, 'group'));

    let targetSource = source;
    let targetTeam = alpha;
    if (owner !== 'self') {
      if (owner === 'other-repo') targetSource = createSource('beta', ['beta-existing']);
      else publish(source, ['beta-existing'], 'beta-baseline');
      targetTeam = createTeam('beta', targetSource.url);
      activate(targetTeam);
      run(['pull', '--force']);
      expect(JSON.parse(fs.readFileSync(targetTeam.manifest, 'utf8')).installedSkills).toEqual(['beta-existing']);
      expect(treeContents(path.join(skillsDir, 'group'))).toEqual(groupBefore);
    }
    const targetManifest = fs.readFileSync(targetTeam.manifest, 'utf8');
    const betaBefore = treeContents(path.join(skillsDir, 'beta-existing'));
    publish(targetSource, ['unrelated-new', next], 'replacement');

    // The first pull refreshes the cache; dry-run previews that same revision.
    for (const args of [['pull', '--force'], ['pull', '--force', '--dry-run']]) {
      const output = run(args).toLowerCase();
      expect(treeContents(path.join(skillsDir, 'group'))).toEqual(groupBefore);
      expect(treeContents(path.join(skillsDir, 'beta-existing'))).toEqual(betaBefore);
      expect(fs.readFileSync(alpha.manifest, 'utf8')).toBe(alphaManifest);
      expect(fs.readFileSync(targetTeam.manifest, 'utf8')).toBe(targetManifest);
      expect(fs.existsSync(path.join(skillsDir, 'unrelated-new'))).toBe(false);
      expect(output).toContain('overlap');
      expect(output).toContain('manual');
    }

    // Explicitly retire the old boundary before installing the replacement.
    activate(alpha);
    expect(run(['source', 'remove', alpha.alias])).toContain(`Removed source "${alpha.alias}"`);
    expect(fs.existsSync(alpha.manifest)).toBe(false);
    expect(treeContents(path.join(skillsDir, 'group'))).toEqual({});
    activate(targetTeam);
    if (owner === 'self') {
      expect(run(['source', 'add', targetSource.url, '--name', targetTeam.alias])).toContain(`Added source "${targetTeam.alias}"`);
    }
    run(['pull', '--force']);
    expect(treeContents(path.join(skillsDir, 'group'))).toEqual(treeContents(path.join(targetSource.seed, 'skills', 'group')));
    expect(fs.readFileSync(path.join(skillsDir, next, 'SKILL.md'), 'utf8')).toBe(`# replacement ${next}\n`);
    expect(fs.readFileSync(path.join(skillsDir, 'unrelated-new', 'SKILL.md'), 'utf8')).toBe('# replacement unrelated-new\n');
    expect(JSON.parse(fs.readFileSync(targetTeam.manifest, 'utf8')).installedSkills).toEqual(['unrelated-new', next]);
    expect(fs.existsSync(path.join(skillsDir, 'beta-existing'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, 'local-draft', 'SKILL.md'), 'utf8')).toBe('# Local draft\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
