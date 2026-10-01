import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const OLD_SKILLS = ['old-skill', 'recorded-skill'];

it.each(['missing', 'empty', 'mixed'].flatMap((paths) =>
  ['update', 'withdraw', 'remove'].map((operation) => ({ paths, operation })),
))('never infers historical destinations from changed toolPaths ($paths paths, $operation)', ({ paths, operation }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-unrecorded-tools-')));
  const home = path.join(root, 'home');
  const originalSkills = path.join(home, '.claude', 'skills');
  const movedSkills = path.join(home, '.moved-claude', 'skills');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(originalSkills, { recursive: true });
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
    const sourceUrl = 'https://source.test/unrecorded-tools/skills.git';
    const stageSource = (names: string[], revision: string) => {
      for (const name of names) {
        fs.mkdirSync(path.join(sourceSeed, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(sourceSeed, 'skills', name, 'SKILL.md'), `# ${revision} ${name}\n`);
      }
      fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
        team: 'source', repo: sourceUrl, publicSkills: names,
      }));
    };
    stageSource(OLD_SKILLS, 'original');
    git(['init', '-q', '-b', 'main'], sourceSeed);
    commit(sourceSeed, 'seed source');
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);

    const teamRepo = path.join(root, 'team-repo');
    const teamRemote = path.join(root, 'team.git');
    const teamYaml = path.join(teamRepo, 'teamai.yaml');
    fs.mkdirSync(teamRepo);
    fs.writeFileSync(teamYaml, YAML.stringify({
      team: 'consumer', repo: teamRemote, provider: 'git', reviewers: [],
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
    run(['pull', '--force']);
    const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
    const manifestPath = path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.installedPaths;
    delete manifest.installedPhysicalPaths;
    if (paths === 'empty') manifest.installedPaths = { 'old-skill': [], 'recorded-skill': [] };
    if (paths === 'mixed') manifest.installedPaths = { 'recorded-skill': ['.claude/skills/recorded-skill'] };
    const manifestBefore = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(manifestPath, manifestBefore);

    for (const name of OLD_SKILLS) {
      expect(fs.readFileSync(path.join(originalSkills, name, 'SKILL.md'), 'utf8')).toBe(`# original ${name}\n`);
      fs.mkdirSync(path.join(movedSkills, name), { recursive: true });
      fs.writeFileSync(path.join(movedSkills, name, 'SKILL.md'), `# Unrelated local ${name}\n`);
      fs.writeFileSync(path.join(movedSkills, name, 'local-only.txt'), 'Keep this local payload\n');
    }
    const teamConfig = YAML.parse(fs.readFileSync(teamYaml, 'utf8'));
    teamConfig.toolPaths.claude.skills = '.moved-claude/skills';
    const yamlBefore = YAML.stringify(teamConfig) + '# Preserve the changed tool path and subscription.\n';
    fs.writeFileSync(teamYaml, yamlBefore);
    if (operation !== 'remove') {
      stageSource(operation === 'update' ? ['new-skill', ...OLD_SKILLS] : [], 'updated');
      commit(sourceSeed, operation);
      git(['push', '-q', sourceRemote, 'main'], sourceSeed);
    }

    const args = operation === 'remove' ? ['source', 'remove', 'shared'] : ['pull', '--force'];
    for (const command of [args, [...args, '--dry-run']]) {
      const output = run(command);
      for (const name of OLD_SKILLS) {
        expect(fs.readFileSync(path.join(originalSkills, name, 'SKILL.md'), 'utf8')).toBe(`# original ${name}\n`);
        expect(fs.readFileSync(path.join(movedSkills, name, 'SKILL.md'), 'utf8')).toBe(`# Unrelated local ${name}\n`);
        expect(fs.readFileSync(path.join(movedSkills, name, 'local-only.txt'), 'utf8')).toBe('Keep this local payload\n');
      }
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
      expect(fs.existsSync(path.join(originalSkills, 'new-skill'))).toBe(false);
      expect(fs.existsSync(path.join(movedSkills, 'new-skill'))).toBe(false);
      expect(output.toLowerCase()).toContain('manual');
    }
    const preview = run(['push', '--dry-run']);
    for (const name of OLD_SKILLS) {
      expect(preview).not.toContain(`[skills] ${name} (new)`);
      expect(preview).not.toContain(`from: ${path.join(movedSkills, name)}`);
    }
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
