import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const SOURCE_SKILL = '---\nname: foo\ndescription: Source-owned Claude skill\n---\n\n# Source-owned Claude bytes\n';
const LOCAL_SKILL = '---\nname: foo\ndescription: Independent Codex skill\n---\n\n# Independent Codex bytes\n';

it.each(['pinned', 'unpinned', 'legacy'])('selects push candidates by physical ownership, retaining ambiguous name quarantine (%s)', (tracking) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-push-path-')));
  const home = path.join(root, 'home');
  const claudeSkill = path.join(home, '.claude', 'skills', 'foo');
  const codexSkill = path.join(home, '.codex', 'skills', 'foo');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(path.dirname(claudeSkill), { recursive: true });
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
  try {
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/push-path/skills.git';
    fs.mkdirSync(path.join(sourceSeed, 'skills', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(sourceSeed, 'skills', 'foo', 'SKILL.md'), SOURCE_SKILL);
    fs.writeFileSync(path.join(sourceSeed, 'skills', 'foo', 'source-only.txt'), 'Never publish these source bytes\n');
    fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
      team: 'source-owner', repo: sourceUrl, publicSkills: ['foo'],
    }));
    git(['init', '-q', '-b', 'main'], sourceSeed);
    commit(sourceSeed, 'seed source');
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);

    const teamRepo = path.join(root, 'team-repo');
    const teamRemote = path.join(root, 'team.git');
    fs.mkdirSync(teamRepo);
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
      team: 'push-path-consumer', repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: 'shared', repo: sourceUrl }],
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], teamRepo);
    commit(teamRepo, 'seed team');
    git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
    git(['remote', 'add', 'origin', teamRemote], teamRepo);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester', updatePolicy: 'skip', scope: 'user',
    }));

    // Only Claude is installed when source ownership is first recorded.
    run(['pull', '--force']);
    expect(fs.readFileSync(path.join(claudeSkill, 'SKILL.md'), 'utf8')).toBe(SOURCE_SKILL);
    expect(fs.existsSync(codexSkill)).toBe(false);
    const installationId = createHash('sha256').update(JSON.stringify([home, teamRepo])).digest('hex');
    const manifestPath = path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.installedPaths.foo).toEqual(['.claude/skills/foo']);
    expect(manifest.installedPhysicalPaths).toBeDefined();
    let trackingPath = manifestPath;
    if (tracking === 'unpinned') {
      delete manifest.installedPhysicalPaths;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } else if (tracking === 'legacy') {
      trackingPath = path.join(home, '.teamai', 'sources', 'shared', 'installed.json');
      fs.writeFileSync(trackingPath, JSON.stringify({
        lastPull: manifest.lastPull, installedSkills: ['foo'], installedPaths: manifest.installedPaths,
      }, null, 2));
      fs.unlinkSync(manifestPath);
    }
    const trackingBefore = fs.readFileSync(trackingPath, 'utf8');

    // Installing Codex later does not make its independent same-name bytes owned.
    fs.mkdirSync(codexSkill, { recursive: true });
    fs.writeFileSync(path.join(codexSkill, 'SKILL.md'), LOCAL_SKILL);
    fs.writeFileSync(path.join(codexSkill, 'codex-only.txt'), 'Publish only this local payload\n');
    const preview = run(['push', '--dry-run']);
    expect(fs.readFileSync(trackingPath, 'utf8')).toBe(trackingBefore);
    expect(fs.readFileSync(path.join(claudeSkill, 'SKILL.md'), 'utf8')).toBe(SOURCE_SKILL);
    expect(fs.readFileSync(path.join(codexSkill, 'SKILL.md'), 'utf8')).toBe(LOCAL_SKILL);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], teamRemote).trim()).toBe('main');
    if (tracking !== 'pinned') {
      expect(preview).not.toContain('[skills] foo (new)');
      expect(preview).not.toContain(`from: ${codexSkill}`);
      expect(preview).not.toContain(`from: ${claudeSkill}`);
      return;
    }

    expect(preview).toContain('[skills] foo (new)');
    expect(preview).toContain(`from: ${codexSkill}`);
    expect(preview).not.toContain(`from: ${claudeSkill}`);
    expect(preview).toContain('owned by another source installation and is excluded from push.');

    // Exercise normal candidate selection, without --skill bypassing the scanner.
    // The fixture's bare Git remote accepts the branch but cannot create a PR.
    const branch = 'verify-source-path-ownership';
    const pushed = run(['push', '--all', '--branch', branch], 1);
    expect(pushed).toContain(`Pushed branch ${branch}`);
    expect(pushed).toContain(`Branch ${branch} has been pushed. You can create a PR manually.`);
    expect(git(['show', `${branch}:skills/foo/SKILL.md`], teamRemote)).toBe(LOCAL_SKILL);
    expect(git(['show', `${branch}:skills/foo/codex-only.txt`], teamRemote)).toBe('Publish only this local payload\n');
    expect(git(['ls-tree', '-r', '--name-only', branch, '--', 'skills/foo'], teamRemote)).not.toContain('source-only.txt');
    expect(fs.readFileSync(path.join(claudeSkill, 'SKILL.md'), 'utf8')).toBe(SOURCE_SKILL);
    expect(fs.readFileSync(trackingPath, 'utf8')).toBe(trackingBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
