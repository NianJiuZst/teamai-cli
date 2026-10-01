import { createHash } from 'node:crypto';
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

it.each([false, true])('keeps installation ownership separate (shared team checkout: %s)', (sharedCheckout) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-manifest-')));
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
  const skill = (project: string, name: string) => path.join(project, '.claude', 'skills', name, 'SKILL.md');
  try {
    const legacyPath = path.join(home, '.teamai', 'sources', 'shared', 'installed.json');
    const legacyManifest = JSON.stringify({
      lastPull: '2026-01-01T00:00:00Z', installedSkills: ['legacy-local'],
      installedPaths: { 'legacy-local': ['.claude/skills/legacy-local'] },
    });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, legacyManifest);
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/shared/skills.git';
    for (const name of ['old-skill', 'new-skill']) {
      fs.mkdirSync(path.join(sourceSeed, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(sourceSeed, 'skills', name, 'SKILL.md'), `# Source ${name}\n`);
    }
    const publish = (names: string[]) => fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({ team: 'shared', repo: sourceUrl, publicSkills: names }));
    publish(['old-skill']);
    git(['init', '-q', '-b', 'main'], sourceSeed);
    git(['add', '-A'], sourceSeed);
    git(['commit', '-q', '-m', 'seed source'], sourceSeed);
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);
    const projects: string[] = [];
    const manifests: string[] = [];
    for (const name of ['alpha', 'beta']) {
      const project = path.join(root, name);
      const teamRepo = sharedCheckout ? path.join(root, 'shared-team-repo') : path.join(project, '.teamai', 'team-repo');
      const teamRemote = path.join(root, `${sharedCheckout ? 'shared' : name}-team.git`);
      const seedTeam = !fs.existsSync(teamRepo);
      fs.mkdirSync(teamRepo, { recursive: true });
      fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
      fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      fs.mkdirSync(path.dirname(skill(project, 'legacy-local')), { recursive: true });
      fs.writeFileSync(skill(project, 'legacy-local'), `# ${name} legacy local draft\n`);
      if (seedTeam) {
        fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
          team: name, repo: teamRemote, provider: 'git', reviewers: [],
          sources: [{ name: 'shared', repo: sourceUrl }],
          toolPaths: { claude: { skills: '.claude/skills' } },
        }));
        git(['init', '-q', '-b', 'main'], teamRepo);
        git(['add', '-A'], teamRepo);
        git(['commit', '-q', '-m', 'seed team'], teamRepo);
        git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
        git(['remote', 'add', 'origin', teamRemote], teamRepo);
        git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
      }
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester',
        updatePolicy: 'auto', scope: 'project', projectRoot: project,
      }));
      projects.push(project);
      const installationId = createHash('sha256').update(JSON.stringify([project, teamRepo])).digest('hex');
      manifests.push(path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`));
    }
    run(['pull', '--force'], projects[0]);
    expect(fs.readFileSync(skill(projects[0], 'old-skill'), 'utf8')).toBe('# Source old-skill\n');
    expect(fs.readFileSync(skill(projects[0], 'legacy-local'), 'utf8')).toBe('# alpha legacy local draft\n');
    fs.mkdirSync(path.dirname(skill(projects[1], 'old-skill')), { recursive: true });
    fs.writeFileSync(skill(projects[1], 'old-skill'), '# Beta local draft\n');
    publish(['new-skill']);
    git(['add', '-A'], sourceSeed);
    git(['commit', '-q', '-m', 'replace public skill'], sourceSeed);
    git(['push', '-q', sourceRemote, 'main'], sourceSeed);
    run(['pull', '--force'], projects[1]);
    expect(fs.existsSync(skill(projects[1], 'old-skill'))).toBe(true);
    expect(fs.readFileSync(skill(projects[1], 'old-skill'), 'utf8')).toBe('# Beta local draft\n');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyManifest);
    expect(fs.readFileSync(skill(projects[0], 'legacy-local'), 'utf8')).toBe('# alpha legacy local draft\n');
    expect(fs.readFileSync(skill(projects[1], 'legacy-local'), 'utf8')).toBe('# beta legacy local draft\n');
    expect(fs.readFileSync(skill(projects[1], 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    fs.mkdirSync(path.dirname(skill(projects[0], 'new-skill')), { recursive: true });
    fs.writeFileSync(skill(projects[0], 'new-skill'), '# Alpha local draft\n');
    const betaManifest = fs.readFileSync(manifests[1], 'utf8');
    run(['source', 'remove', 'shared'], projects[0]);
    expect(fs.existsSync(manifests[0])).toBe(false);
    expect(fs.readFileSync(manifests[1], 'utf8')).toBe(betaManifest);
    expect(fs.existsSync(skill(projects[0], 'old-skill'))).toBe(false);
    expect(fs.readFileSync(skill(projects[0], 'new-skill'), 'utf8')).toBe('# Alpha local draft\n');
    expect(fs.readFileSync(skill(projects[1], 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    const betaConfig = YAML.parse(fs.readFileSync(path.join(projects[1], '.teamai', 'config.yaml'), 'utf8'));
    const betaTeamYaml = path.join(betaConfig.repo.localPath, 'teamai.yaml');
    if (sharedCheckout) fs.appendFileSync(betaTeamYaml, '# Preserve this shared configuration comment.\n');
    const beforeBetaRemoval = fs.readFileSync(betaTeamYaml, 'utf8');
    if (sharedCheckout) expect(YAML.parse(beforeBetaRemoval).sources).toEqual([]);
    expect(run(['source', 'remove', 'shared', '--dry-run'], projects[1])).toContain('[dry-run] Would remove source "shared"');
    expect(fs.readFileSync(skill(projects[1], 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    expect(fs.readFileSync(betaTeamYaml, 'utf8')).toBe(beforeBetaRemoval);
    expect(fs.readFileSync(manifests[1], 'utf8')).toBe(betaManifest);
    const removeOutput = run(['source', 'remove', 'shared'], projects[1]);
    expect(removeOutput).toContain('Removed source "shared"');
    if (sharedCheckout) expect(removeOutput).not.toContain('Run `teamai push`');
    expect(fs.existsSync(manifests[1])).toBe(false);
    if (sharedCheckout) expect(fs.readFileSync(betaTeamYaml, 'utf8')).toBe(beforeBetaRemoval);
    expect(fs.existsSync(skill(projects[1], 'new-skill'))).toBe(false);
    expect(fs.readFileSync(skill(projects[1], 'old-skill'), 'utf8')).toBe('# Beta local draft\n');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyManifest);
    expect(run(['source', 'remove', 'shared'], projects[1])).toContain('Source "shared" not found.');
    expect(fs.readFileSync(skill(projects[1], 'legacy-local'), 'utf8')).toBe('# beta legacy local draft\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
