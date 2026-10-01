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
  { paths: 'missing', knownProducer: true },
  { paths: 'empty', knownProducer: true },
  { paths: 'missing', knownProducer: false },
])('retains unrecorded claims before replacing a producer ($paths paths, known producer: $knownProducer)', ({ paths, knownProducer }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-unrecorded-')));
  const home = path.join(root, 'home');
  const skills = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
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
  const createSource = (name: string, names: string[]) => {
    const seed = path.join(root, `${name}-seed`);
    const remote = path.join(root, `${name}.git`);
    const url = `https://source.test/${name}/skills.git`;
    for (const skill of names) {
      fs.mkdirSync(path.join(seed, 'skills', skill), { recursive: true });
      fs.writeFileSync(path.join(seed, 'skills', skill, 'SKILL.md'), `# ${name} ${skill}\n`);
    }
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: name, repo: url, publicSkills: names }));
    git(['init', '-q', '-b', 'main'], seed);
    commit(seed, 'seed source');
    git(['clone', '-q', '--bare', seed, remote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${remote}.insteadOf`, url], root);
    return url;
  };
  try {
    const originalUrl = createSource('original', ['old-skill']);
    const replacementUrl = createSource('replacement', ['new-first', 'new-second']);
    const teamRepo = path.join(root, 'team-repo');
    const teamRemote = path.join(root, 'team.git');
    const teamYaml = path.join(teamRepo, 'teamai.yaml');
    fs.mkdirSync(teamRepo);
    fs.writeFileSync(teamYaml, YAML.stringify({
      team: 'unrecorded-consumer', repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: 'shared', repo: originalUrl }], toolPaths: { claude: { skills: '.claude/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], teamRepo);
    commit(teamRepo, 'seed team');
    git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
    git(['remote', 'add', 'origin', teamRemote], teamRepo);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester', updatePolicy: 'skip', scope: 'user',
    }));
    run(['pull', '--force']);
    const oldSkill = path.join(skills, 'old-skill', 'SKILL.md');
    expect(fs.readFileSync(oldSkill, 'utf8')).toBe('# original old-skill\n');
    const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
    const manifestPath = path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Older scoped records can have valid skill claims without destination maps.
    delete manifest.installedPaths;
    delete manifest.installedPhysicalPaths;
    if (paths === 'empty') manifest.installedPaths = { 'old-skill': [] };
    if (!knownProducer) delete manifest.repositoryId;
    const manifestBefore = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(manifestPath, manifestBefore);

    const teamConfig = YAML.parse(fs.readFileSync(teamYaml, 'utf8'));
    teamConfig.sources = [{ name: 'shared', repo: replacementUrl }];
    const yamlBefore = YAML.stringify(teamConfig) + '# Keep this new source subscription.\n';
    fs.writeFileSync(teamYaml, yamlBefore);
    for (const args of [['pull', '--force'], ['pull', '--force', '--dry-run']]) {
      const output = run(args);
      expect(fs.readFileSync(oldSkill, 'utf8')).toBe('# original old-skill\n');
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
      expect(fs.existsSync(path.join(skills, 'new-first'))).toBe(false);
      expect(fs.existsSync(path.join(skills, 'new-second'))).toBe(false);
      expect(output.toLowerCase()).toContain('manual');
    }
    const preview = run(['push', '--dry-run']);
    expect(preview).not.toContain('[skills] old-skill (new)');
    expect(preview).not.toContain(`from: ${path.dirname(oldSkill)}`);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);

    // Current tool settings cannot establish an unrecorded historical destination.
    for (const args of [['source', 'remove', 'shared'], ['source', 'remove', 'shared', '--dry-run']]) {
      const output = run(args);
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(fs.readFileSync(oldSkill, 'utf8')).toBe('# original old-skill\n');
      expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
      expect(fs.existsSync(path.join(skills, 'new-first'))).toBe(false);
      expect(fs.existsSync(path.join(skills, 'new-second'))).toBe(false);
      expect(output.toLowerCase()).toContain('manual');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
