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

it.each([
  { cleanup: 'remove', sameAlias: true },
  { cleanup: 'remove', sameAlias: false },
  { cleanup: 'stale', sameAlias: true },
  { cleanup: 'stale', sameAlias: false },
])('preserves a shared user-scope destination until its last owner leaves ($cleanup, same alias: $sameAlias)', ({ cleanup, sameAlias }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-shared-destination-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const env = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    return output;
  };
  const skill = (name: string) => path.join(home, '.claude', 'skills', name, 'SKILL.md');
  try {
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/shared/skills.git';
    for (const name of ['old-skill', 'new-skill']) {
      fs.mkdirSync(path.join(sourceSeed, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(sourceSeed, 'skills', name, 'SKILL.md'), `# Source ${name}\n`);
    }
    const publish = (names: string[]) => fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
      team: 'shared', repo: sourceUrl, publicSkills: names,
    }));
    publish(['old-skill']);
    git(['init', '-q', '-b', 'main'], sourceSeed);
    git(['add', '-A'], sourceSeed);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed source'], sourceSeed);
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);

    const teams = ['alpha', 'beta'].map((name) => {
      const alias = sameAlias ? 'shared' : `${name}-source`;
      const teamRepo = path.join(root, `${name}-team-repo`);
      const teamRemote = path.join(root, `${name}-team.git`);
      fs.mkdirSync(teamRepo);
      fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
        team: name, repo: teamRemote, provider: 'git', reviewers: [],
        sources: [{ name: alias, repo: sourceUrl }],
        toolPaths: { claude: { skills: '.claude/skills' } },
      }));
      git(['init', '-q', '-b', 'main'], teamRepo);
      git(['add', '-A'], teamRepo);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed team'], teamRepo);
      git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
      git(['remote', 'add', 'origin', teamRemote], teamRepo);
      git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
      const config = {
        repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester',
        updatePolicy: 'skip', scope: 'user',
      };
      const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
      const manifest = path.join(home, '.teamai', 'sources', alias, 'installations', `${installationId}.json`);
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify(config));
      run(['pull', '--force']);
      expect(fs.readFileSync(skill('old-skill'), 'utf8')).toBe('# Source old-skill\n');
      expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).installedSkills).toEqual(['old-skill']);
      return { alias, config, manifest };
    });
    const [alpha, beta] = teams;
    expect(alpha.manifest).not.toBe(beta.manifest);
    const betaManifest = fs.readFileSync(beta.manifest, 'utf8');
    fs.mkdirSync(path.dirname(skill('local-draft')), { recursive: true });
    fs.writeFileSync(skill('local-draft'), '# Unrelated local draft\n');
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify(alpha.config));

    if (cleanup === 'stale') {
      publish(['new-skill']);
      git(['add', '-A'], sourceSeed);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'replace public skill'], sourceSeed);
      git(['push', '-q', sourceRemote, 'main'], sourceSeed);
      run(['pull', '--force']);
      const alphaManifest = JSON.parse(fs.readFileSync(alpha.manifest, 'utf8'));
      expect(alphaManifest.installedSkills).toEqual(['new-skill']);
      expect(alphaManifest.installedPaths).not.toHaveProperty('old-skill');
      expect(fs.readFileSync(skill('new-skill'), 'utf8')).toBe('# Source new-skill\n');
    } else {
      expect(run(['source', 'remove', alpha.alias])).toContain(`Removed source "${alpha.alias}"`);
      expect(fs.existsSync(alpha.manifest)).toBe(false);
    }

    // Check before another pull could silently reinstall a wrongly deleted skill.
    expect(fs.readFileSync(skill('old-skill'), 'utf8')).toBe('# Source old-skill\n');
    expect(fs.readFileSync(beta.manifest, 'utf8')).toBe(betaManifest);
    expect(fs.readFileSync(skill('local-draft'), 'utf8')).toBe('# Unrelated local draft\n');
    const remainingAlphaManifest = cleanup === 'stale' ? fs.readFileSync(alpha.manifest, 'utf8') : undefined;

    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify(beta.config));
    expect(run(['source', 'remove', beta.alias])).toContain(`Removed source "${beta.alias}"`);
    expect(fs.existsSync(beta.manifest)).toBe(false);
    expect(fs.existsSync(path.dirname(skill('old-skill')))).toBe(false);
    expect(fs.readFileSync(skill('local-draft'), 'utf8')).toBe('# Unrelated local draft\n');
    if (cleanup === 'stale') {
      expect(fs.readFileSync(alpha.manifest, 'utf8')).toBe(remainingAlphaManifest);
      expect(fs.readFileSync(skill('new-skill'), 'utf8')).toBe('# Source new-skill\n');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
