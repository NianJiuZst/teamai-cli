import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

it.each(['remove', 'withdrawal', 'refresh'])('retains ownership when a skill ancestor symlink is repointed (%s)', (operation) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-symlink-')));
  const home = path.join(root, 'home');
  const originalSkills = path.join(home, 'original', 'skills');
  const replacementSkills = path.join(home, 'replacement', 'skills');
  const skillsLink = path.join(home, '.claude', 'skills');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.dirname(skillsLink), { recursive: true });
  fs.mkdirSync(originalSkills, { recursive: true });
  fs.mkdirSync(path.join(replacementSkills, 'shared-skill'), { recursive: true });
  fs.writeFileSync(path.join(replacementSkills, 'shared-skill', 'SKILL.md'), '# Unrelated replacement skill\n');
  fs.writeFileSync(path.join(replacementSkills, 'shared-skill', 'local-notes.txt'), 'Keep these local notes\n');
  fs.symlinkSync(originalSkills, skillsLink, 'dir');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
    GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[], allowGuardFailure = false) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    if (allowGuardFailure) expect([0, 1], output).toContain(result.status);
    else expect(result.status, output).toBe(0);
    return output;
  };
  const commit = (cwd: string, message: string) => {
    git(['add', '-A'], cwd);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], cwd);
  };
  try {
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/symlink/skills.git';
    fs.mkdirSync(path.join(sourceSeed, 'skills', 'shared-skill'), { recursive: true });
    fs.writeFileSync(path.join(sourceSeed, 'skills', 'shared-skill', 'SKILL.md'), '# Original source skill\n');
    fs.writeFileSync(path.join(sourceSeed, 'skills', 'shared-skill', 'source-only.txt'), 'Original source payload\n');
    fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
      team: 'symlink-source', repo: sourceUrl, publicSkills: ['shared-skill'],
    }));
    git(['init', '-q', '-b', 'main'], sourceSeed);
    commit(sourceSeed, 'seed source');
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);

    const teamRepo = path.join(root, 'team-repo');
    const teamRemote = path.join(root, 'team.git');
    const teamYaml = path.join(teamRepo, 'teamai.yaml');
    fs.mkdirSync(teamRepo);
    fs.writeFileSync(teamYaml, YAML.stringify({
      team: 'symlink-consumer', repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: 'shared', repo: sourceUrl }],
      toolPaths: { claude: { skills: '.claude/skills' } },
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

    // A stable symlink is a legitimate deployment destination.
    run(['pull', '--force']);
    expect(fs.readFileSync(path.join(originalSkills, 'shared-skill', 'SKILL.md'), 'utf8')).toBe('# Original source skill\n');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    expect(JSON.parse(manifestBefore).installedSkills).toEqual(['shared-skill']);
    fs.appendFileSync(teamYaml, '# Keep configuration intact when ownership is ambiguous.\n');
    const yamlBefore = fs.readFileSync(teamYaml, 'utf8');

    fs.unlinkSync(skillsLink);
    fs.symlinkSync(replacementSkills, skillsLink, 'dir');
    if (operation === 'withdrawal') {
      fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
        team: 'symlink-source', repo: sourceUrl, publicSkills: [],
      }));
      commit(sourceSeed, 'withdraw source skill');
      git(['push', '-q', sourceRemote, 'main'], sourceSeed);
    } else if (operation === 'refresh') {
      fs.writeFileSync(path.join(sourceSeed, 'skills', 'shared-skill', 'SKILL.md'), '# Updated source skill\n');
      fs.writeFileSync(path.join(sourceSeed, 'skills', 'shared-skill', 'new-source-only.txt'), 'New source payload\n');
      commit(sourceSeed, 'update source skill');
      git(['push', '-q', sourceRemote, 'main'], sourceSeed);
    }
    const args = operation === 'remove' ? ['source', 'remove', 'shared'] : ['pull', '--force'];
    for (const command of [args, [...args, '--dry-run']]) {
      const output = run(command, true);
      // Check physical bytes before another CLI operation could repair them.
      expect(fs.readFileSync(path.join(replacementSkills, 'shared-skill', 'SKILL.md'), 'utf8')).toBe('# Unrelated replacement skill\n');
      expect(fs.readFileSync(path.join(replacementSkills, 'shared-skill', 'local-notes.txt'), 'utf8')).toBe('Keep these local notes\n');
      expect(fs.readdirSync(path.join(replacementSkills, 'shared-skill')).sort()).toEqual(['SKILL.md', 'local-notes.txt']);
      expect(fs.readFileSync(path.join(originalSkills, 'shared-skill', 'SKILL.md'), 'utf8')).toBe('# Original source skill\n');
      expect(fs.readFileSync(path.join(originalSkills, 'shared-skill', 'source-only.txt'), 'utf8')).toBe('Original source payload\n');
      expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
      expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
      expect(output.toLowerCase()).toContain('manual');
    }

    // Reconnecting the original physical destination makes the action safe again.
    fs.unlinkSync(skillsLink);
    fs.symlinkSync(originalSkills, skillsLink, 'dir');
    run(args);
    if (operation === 'remove') {
      expect(fs.existsSync(manifestPath)).toBe(false);
      expect(fs.existsSync(path.join(originalSkills, 'shared-skill'))).toBe(false);
      expect(YAML.parse(fs.readFileSync(teamYaml, 'utf8')).sources).toEqual([]);
    } else if (operation === 'withdrawal') {
      expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).installedSkills).toEqual([]);
      expect(fs.existsSync(path.join(originalSkills, 'shared-skill'))).toBe(false);
    } else {
      expect(fs.readFileSync(path.join(originalSkills, 'shared-skill', 'SKILL.md'), 'utf8')).toBe('# Updated source skill\n');
      expect(fs.readFileSync(path.join(originalSkills, 'shared-skill', 'new-source-only.txt'), 'utf8')).toBe('New source payload\n');
    }
    expect(fs.readFileSync(path.join(replacementSkills, 'shared-skill', 'SKILL.md'), 'utf8')).toBe('# Unrelated replacement skill\n');
    expect(fs.readFileSync(path.join(replacementSkills, 'shared-skill', 'local-notes.txt'), 'utf8')).toBe('Keep these local notes\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
