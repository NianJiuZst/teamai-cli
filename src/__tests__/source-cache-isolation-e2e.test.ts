import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

it('keeps same-named source repos separate across teams, including removal and cached fallback', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-cache-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[], cwd: string) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(0);
    return output;
  };
  try {
    const legacyRepo = path.join(home, '.teamai', 'sources', 'shared', 'repo');
    fs.mkdirSync(path.join(legacyRepo, 'skills', 'shared-skill'), { recursive: true });
    fs.writeFileSync(path.join(legacyRepo, 'skills', 'shared-skill', 'SKILL.md'), '# Unverified legacy copy\n');
    fs.writeFileSync(path.join(legacyRepo, 'teamai.yaml'), YAML.stringify({
      team: 'legacy', repo: 'https://source.test/legacy/skills.git', publicSkills: ['shared-skill'],
    }));
    const projects: string[] = [];
    const sourceRemotes: string[] = [];
    for (const name of ['alpha', 'beta']) {
      const project = path.join(root, name);
      const teamRepo = path.join(project, '.teamai', 'team-repo');
      const sourceSeed = path.join(root, `${name}-source-seed`);
      const sourceRemote = path.join(root, `${name}-source.git`);
      const sourceUrl = `https://source.test/${name}/skills.git`;
      fs.mkdirSync(path.join(sourceSeed, 'skills', 'shared-skill'), { recursive: true });
      fs.writeFileSync(path.join(sourceSeed, 'skills', 'shared-skill', 'SKILL.md'), `# ${name} source\n`);
      fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({ team: name, repo: sourceUrl, publicSkills: ['shared-skill'] }));
      git(['init', '-q', '-b', 'main'], sourceSeed);
      git(['add', '-A'], sourceSeed);
      git(['commit', '-q', '-m', 'seed source'], sourceSeed);
      git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
      git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);
      fs.mkdirSync(teamRepo, { recursive: true });
      fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      const teamRemote = path.join(root, `${name}-team.git`);
      fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
        team: name, repo: teamRemote, provider: 'git', reviewers: [],
        toolPaths: { claude: { skills: '.claude/skills' } },
      }));
      git(['init', '-q', '-b', 'main'], teamRepo);
      git(['add', '-A'], teamRepo);
      git(['commit', '-q', '-m', 'seed team'], teamRepo);
      git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
      git(['remote', 'add', 'origin', teamRemote], teamRepo);
      git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester',
        updatePolicy: 'auto', scope: 'project', projectRoot: project,
      }));
      expect(run(['source', 'add', sourceUrl, '--name', 'shared'], project)).toContain('Added source "shared"');
      expect(run(['source', 'browse', 'shared'], project)).toContain('shared-skill');
      run(['pull', '--force'], project);
      expect(fs.readFileSync(path.join(project, '.claude', 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).toBe(`# ${name} source\n`);
      projects.push(project);
      sourceRemotes.push(sourceRemote);
    }
    const caches = path.join(home, '.teamai', 'source-repos');
    expect(fs.readdirSync(caches)).toHaveLength(2);
    run(['source', 'remove', 'shared'], projects[0]);
    expect(fs.readdirSync(caches)).toHaveLength(2);
    expect(fs.existsSync(legacyRepo)).toBe(true);
    fs.renameSync(sourceRemotes[1], `${sourceRemotes[1]}.offline`);
    expect(run(['pull', '--force'], projects[1])).toContain('[source:shared] Pull failed:');
    expect(fs.readFileSync(path.join(projects[1], '.claude', 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).toBe('# beta source\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
