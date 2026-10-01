import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

// Mock git operations
vi.mock('../utils/git.js', () => ({
  createGit: vi.fn(() => ({
    clone: vi.fn(),
  })),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

import { deriveSourceName, getSourceManifestPath, getAllSourceSkillNames, getSourceSkillOrigins, pullSources, sourceSyncWarnings } from '../source.js';
import type { TeamaiConfig, LocalConfig, SourceInstallManifest } from '../types.js';

describe('source', () => {
  let tmpDir: string;
  let homeDir: string;
  let sourcesDir: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-test-'));
    homeDir = path.join(tmpDir, 'home');
    sourcesDir = path.join(homeDir, '.teamai', 'sources');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('deriveSourceName', () => {
    it('handles HTTPS, scp-style SSH, and ssh:// URLs with a port', () => {
      expect(deriveSourceName('https://git.example.com/group/sub/repo.git')).toBe('group');
      expect(deriveSourceName('git@git.example.com:group/sub/repo.git')).toBe('group');
      expect(deriveSourceName('ssh://git@git.example.com:2222/group/sub/repo.git')).toBe('group');
    });
  });

  describe('getAllSourceSkillNames', () => {
    it('quarantines legacy names from push without inventing scoped ownership', async () => {
      await fse.outputJson(path.join(sourcesDir, 'legacy', 'installed.json'), {
        lastPull: new Date().toISOString(), installedSkills: ['local-draft'],
      });
      expect(await getAllSourceSkillNames(localConfig)).toEqual(new Set(['local-draft']));
      expect(await getSourceSkillOrigins(localConfig)).toEqual(new Map());
      await fse.outputFile(path.join(homeDir, '.claude/skills/local-draft/SKILL.md'), '# Legacy copy');
      const { getHandler } = await import('../resources/index.js');
      expect((await getHandler('skills').scanLocalForPush(teamConfig, localConfig)).map((item) => item.name)).not.toContain('local-draft');
    });

    it('isolates manifests by destination and team checkout, including user scope and worktrees', async () => {
      const projectConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot: path.join(tmpDir, 'project') };
      const worktreeConfig: LocalConfig = { ...projectConfig, projectRoot: path.join(tmpDir, 'worktree') };
      const otherTeamConfig: LocalConfig = { ...projectConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') } };
      for (const [index, config] of [localConfig, projectConfig, worktreeConfig, otherTeamConfig].entries()) {
        await fse.outputJson(getSourceManifestPath('shared', config), {
          lastPull: new Date().toISOString(), installedSkills: [`skill-${index}`],
        });
      }
      for (const [index, config] of [localConfig, projectConfig, worktreeConfig, otherTeamConfig].entries()) {
        expect(await getAllSourceSkillNames(config)).toEqual(new Set([`skill-${index}`]));
      }
    });

    it.each(['same', 'symlink', 'different'])('quarantines foreign source files only at a matching physical target: %s', async (destination) => {
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      await fse.outputFile(path.join(homeDir, '.claude/skills/third-party/SKILL.md'), '# Visible copy');
      const otherRoot = destination === 'same' ? homeDir : path.join(tmpDir, 'other-root');
      await fse.ensureDir(otherRoot);
      if (destination === 'symlink') await fse.symlink(path.join(homeDir, '.claude'), path.join(otherRoot, '.claude'), 'dir');
      const otherConfig: LocalConfig = { ...localConfig, scope: 'project', projectRoot: otherRoot, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') } };
      await fse.outputJson(getSourceManifestPath('foreign-source', otherConfig), {
        destinationRoot: otherRoot, lastPull: new Date(0).toISOString(),
        installedSkills: ['third-party'], installedPaths: { 'third-party': ['.claude/skills/third-party'] },
      } satisfies SourceInstallManifest);
      const { getHandler } = await import('../resources/index.js');
      const candidates = await getHandler('skills').scanLocalForPush(teamConfig, localConfig);
      expect(candidates.some((item) => item.name === 'third-party')).toBe(destination === 'different');
      expect(await getSourceSkillOrigins(localConfig)).toEqual(new Map());
    });

    it.each(['shape', 'json', 'unreadable', 'legacy-json'])('fails closed for skill push when ownership metadata is invalid: %s', async (failure) => {
      await fse.outputFile(path.join(homeDir, '.claude/skills/private-copy/SKILL.md'), '# Do not publish');
      const manifestPath = failure === 'legacy-json' ? path.join(sourcesDir, 'broken', 'installed.json') : getSourceManifestPath('broken', localConfig);
      if (failure === 'unreadable') await fse.ensureDir(manifestPath);
      else if (failure === 'shape') await fse.outputJson(manifestPath, { installedSkills: 42 });
      else await fse.outputFile(manifestPath, '{truncated');
      const { getHandler } = await import('../resources/index.js');
      expect(await getHandler('skills').scanLocalForPush(teamConfig, localConfig)).toEqual([]);
    });

    it.each(['codex-shared', 'nested'])('excludes the actual scanned source path even when future destination differs: %s', async (layout) => {
      const tool = layout === 'codex-shared' ? 'codex' : 'claude';
      const toolDir = layout === 'codex-shared' ? '.codex/skills' : '.claude/skills';
      const ownedPath = layout === 'codex-shared' ? `${toolDir}/third-party` : `${toolDir}/group/third-party`;
      teamConfig.toolPaths = { [tool]: { skills: toolDir } };
      await fse.outputFile(path.join(homeDir, ownedPath, 'SKILL.md'), '# Foreign source');
      await fse.outputFile(path.join(homeDir, toolDir, 'local-draft/SKILL.md'), '# Local draft');
      if (layout === 'codex-shared') await fse.outputFile(path.join(homeDir, '.agents/skills/third-party/SKILL.md'), '# Different shared copy');
      const otherConfig: LocalConfig = { ...localConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') } };
      await fse.outputJson(getSourceManifestPath('foreign', otherConfig), {
        destinationRoot: homeDir, lastPull: new Date(0).toISOString(),
        installedSkills: ['third-party'], installedPaths: { 'third-party': [ownedPath] },
      } satisfies SourceInstallManifest);
      const { getHandler } = await import('../resources/index.js');
      const names = (await getHandler('skills').scanLocalForPush(teamConfig, localConfig)).map((item) => item.name);
      expect(names).not.toContain('third-party');
      expect(names).toContain('local-draft');
    });

    it('should return empty set when no sources exist', async () => {
      const names = await getAllSourceSkillNames(localConfig);
      expect(names.size).toBe(0);
    });

    it('should return skill names from installed manifests', async () => {
      const manifestDir = path.join(sourcesDir, 'other-team');
      await fse.ensureDir(manifestDir);

      const manifest: SourceInstallManifest = {
        lastPull: new Date().toISOString(),
        installedSkills: ['skill-a', 'skill-b'],
      };
      await fse.outputJson(getSourceManifestPath(path.basename(manifestDir), localConfig), manifest);

      const names = await getAllSourceSkillNames(localConfig);
      expect(names.has('skill-a')).toBe(true);
      expect(names.has('skill-b')).toBe(true);
      expect(names.size).toBe(2);
    });

    it('should aggregate skills across multiple sources', async () => {
      for (const source of ['team-a', 'team-b']) {
        const manifestDir = path.join(sourcesDir, source);
        await fse.ensureDir(manifestDir);
        const manifest: SourceInstallManifest = {
          lastPull: new Date().toISOString(),
          installedSkills: [`${source}-skill`],
        };
        await fse.outputJson(getSourceManifestPath(path.basename(manifestDir), localConfig), manifest);
      }

      const names = await getAllSourceSkillNames(localConfig);
      expect(names.has('team-a-skill')).toBe(true);
      expect(names.has('team-b-skill')).toBe(true);
      expect(names.size).toBe(2);
    });

    it('falls back to USERPROFILE when HOME is unavailable', async () => {
      vi.unstubAllEnvs();
      vi.stubEnv('USERPROFILE', homeDir);
      delete process.env.HOME;

      const manifestDir = path.join(sourcesDir, 'windows-team');
      await fse.ensureDir(manifestDir);
      await fse.outputJson(getSourceManifestPath(path.basename(manifestDir), localConfig), {
        lastPull: new Date().toISOString(),
        installedSkills: ['windows-skill'],
      } satisfies SourceInstallManifest);

      const names = await getAllSourceSkillNames(localConfig);
      expect(names).toContain('windows-skill');
    });
  });

  function fixtureSourceRepoDir(): string {
    const source = teamConfig.sources![0];
    return path.join(sourcesDir, source.name, 'repos', createHash('sha256').update(source.repo.trim()).digest('hex'), 'repo');
  }

  describe('pullSources', () => {
    it('uses a separate pull TTL for each repository even without a skill installation', async () => {
      const YAML = (await import('yaml')).default;
      const { pullRepo } = await import('../utils/git.js');
      vi.mocked(pullRepo).mockClear();
      for (const repo of ['https://source.test/alpha/repo.git', 'https://source.test/beta/repo.git']) {
        teamConfig.sources = [{ name: 'shared', repo }];
        await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
        const repoDir = fixtureSourceRepoDir();
        await fse.ensureDir(repoDir);
        await fse.writeFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({ team: 'source', repo }));
        await pullSources(localConfig, {});
        await pullSources(localConfig, {});
      }
      expect(pullRepo).toHaveBeenCalledTimes(2);
      expect(await fse.pathExists(path.join(sourcesDir, 'shared', 'installed.json'))).toBe(false);
    });

    it('respects a live shared source lock and releases its own lock on success and failure', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'https://source.test/platform/repo.git' }];
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      const repoDir = fixtureSourceRepoDir();
      await fse.outputFile(path.join(repoDir, 'skills/shared-skill/SKILL.md'), '# Source');
      await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({ team: 'platform', repo: teamConfig.sources[0].repo, publicSkills: ['shared-skill'] }));
      const lock = path.join(sourcesDir, '.lifecycle-lock');
      await fse.outputJson(lock, { pid: process.pid, startedAt: new Date().toISOString(), owner: 'test-holder' });
      const held = await fse.readFile(lock, 'utf8');
      const manifest = getSourceManifestPath('platform', localConfig);
      const target = path.join(homeDir, '.claude/skills/shared-skill/SKILL.md');
      await pullSources(localConfig, { force: true });
      await pullSources(localConfig, { dryRun: true });
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(manifest)).toBe(false);
      expect(await fse.readFile(lock, 'utf8')).toBe(held);
      await fse.outputFile(path.join(homeDir, '.claude/skills/local-draft/SKILL.md'), '# Draft');
      const { getHandler } = await import('../resources/index.js');
      expect(await getHandler('skills').scanLocalForPush(teamConfig, localConfig)).toEqual([]);
      expect(await fse.readFile(lock, 'utf8')).toBe(held);
      await fse.remove(lock);

      await pullSources(localConfig, { force: true });
      expect(await fse.readFile(target, 'utf8')).toBe('# Source');
      expect(await fse.pathExists(lock)).toBe(false);
      const goodManifest = await fse.readFile(manifest, 'utf8');
      await fse.writeFile(manifest, '{truncated');
      await pullSources(localConfig, {});
      expect(await fse.pathExists(lock)).toBe(false);
      expect(await fse.readFile(target, 'utf8')).toBe('# Source');
      await fse.writeFile(manifest, goodManifest);
      await pullSources(localConfig, { dryRun: true });
      expect(await fse.pathExists(lock)).toBe(false);
      expect(await fse.readFile(manifest, 'utf8')).toBe(goodManifest);
    });

    it('keeps source cache and ownership unchanged during uncached and forced cached previews', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'https://source.test/platform/repo.git' }];
      const YAML = (await import('yaml')).default;
      const { pullRepo } = await import('../utils/git.js');
      vi.mocked(pullRepo).mockClear();
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      await pullSources(localConfig, { dryRun: true, force: true });
      expect(await fse.pathExists(sourcesDir)).toBe(false);
      expect(pullRepo).not.toHaveBeenCalled();
      const repoDir = fixtureSourceRepoDir();
      await fse.outputFile(path.join(repoDir, 'skills/shared-skill/SKILL.md'), '# Cached source');
      await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({ team: 'platform', repo: teamConfig.sources[0].repo, publicSkills: ['shared-skill'] }));
      const stamp = path.join(path.dirname(repoDir), 'last-pull.json');
      await fse.outputJson(stamp, { lastPull: new Date(0).toISOString() });
      const before = await fse.readFile(stamp, 'utf8');
      await pullSources(localConfig, { dryRun: true, force: true });
      expect(pullRepo).not.toHaveBeenCalled();
      expect(await fse.readFile(stamp, 'utf8')).toBe(before);
      expect(await fse.pathExists(getSourceManifestPath('platform', localConfig))).toBe(false);
      expect(await fse.pathExists(path.join(homeDir, '.claude/skills/shared-skill'))).toBe(false);
      expect(await fse.pathExists(path.join(sourcesDir, '.lifecycle-lock'))).toBe(false);
    });

    it('should do nothing when no sources configured', async () => {
      await pullSources(localConfig, {});
      // No errors, no side effects
    });

    it('should skip source with no publicSkills', async () => {
      // Set up team config with a source
      teamConfig.sources = [{ name: 'other', repo: 'git@git.woa.com:other/repo.git' }];

      // Write teamai.yaml to team repo
      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Create source repo with no publicSkills
      const sourceRepoDir = fixtureSourceRepoDir();
      await fse.ensureDir(path.join(sourceRepoDir, 'skills'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({ team: 'other', repo: 'git@git.woa.com:other/repo.git' }),
      );

      await pullSources(localConfig, {});

      // No skills should be deployed
      const claudeSkills = await fse.readdir(path.join(homeDir, '.claude', 'skills'));
      expect(claudeSkills).toHaveLength(0);
    });

    it('should deploy public skills from source', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Create source repo with publicSkills
      const sourceRepoDir = fixtureSourceRepoDir();
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'cool-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'cool-skill', 'SKILL.md'),
        '---\nname: cool-skill\ndescription: A cool skill\n---\n# Cool Skill',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['cool-skill'],
        }),
      );

      await pullSources(localConfig, {});

      // Skill should be deployed to claude skills dir
      const deployed = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'cool-skill', 'SKILL.md'),
      );
      expect(deployed).toBe(true);

      // Manifest should be written
      const manifest = await fse.readJson(
        getSourceManifestPath('platform', localConfig),
      ) as SourceInstallManifest;
      expect(manifest.installedSkills).toContain('cool-skill');
    });

    it('deploys a source Codex skill to its existing shared location', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'https://example.test/platform/repo.git' }];
      teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
      const sharedSkill = path.join(homeDir, '.agents', 'skills', 'cool-skill');
      await fse.ensureDir(path.join(homeDir, '.codex'));
      await fse.ensureDir(sharedSkill);

      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      const sourceRepoDir = fixtureSourceRepoDir();
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'cool-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'cool-skill', 'SKILL.md'),
        '---\nname: cool-skill\ndescription: Shared\n---\n',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({ team: 'platform', repo: 'https://example.test/platform/repo.git', publicSkills: ['cool-skill'] }),
      );

      await pullSources(localConfig, {});

      expect(await fse.readFile(path.join(sharedSkill, 'SKILL.md'), 'utf8')).toContain('description: Shared');
      expect(await fse.pathExists(path.join(homeDir, '.codex', 'skills', 'cool-skill'))).toBe(false);

      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'next-skill'));
      await fse.writeFile(path.join(sourceRepoDir, 'skills', 'next-skill', 'SKILL.md'), '# Next');
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({ team: 'platform', repo: 'https://example.test/platform/repo.git', publicSkills: ['next-skill'] }),
      );
      await pullSources(localConfig, {});

      expect(await fse.pathExists(sharedSkill)).toBe(false);
    });

    it('should not deploy source skill that conflicts with local team skill', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;

      // Create a local team skill with the same name
      await fse.ensureDir(path.join(localConfig.repo.localPath, 'skills', 'shared-name'));
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'skills', 'shared-name', 'SKILL.md'),
        '# Local version',
      );

      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Create source repo with same skill name
      const sourceRepoDir = fixtureSourceRepoDir();
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'shared-name'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'shared-name', 'SKILL.md'),
        '# Source version',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['shared-name'],
        }),
      );

      await pullSources(localConfig, {});

      // Source skill should NOT be in the manifest (local takes priority)
      const manifestPath = getSourceManifestPath('platform', localConfig);
      if (await fse.pathExists(manifestPath)) {
        const manifest = await fse.readJson(manifestPath) as SourceInstallManifest;
        expect(manifest.installedSkills).not.toContain('shared-name');
      }
    });

    it('should clean up skills no longer in publicSkills', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Simulate a previous install with old-skill
      const oldManifest: SourceInstallManifest = {
        repositoryId: createHash('sha256').update(teamConfig.sources[0].repo.trim()).digest('hex'),
        lastPull: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        installedSkills: ['old-skill'],
      };
      await fse.ensureDir(path.join(sourcesDir, 'platform'));
      await fse.outputJson(getSourceManifestPath('platform', localConfig), oldManifest);

      // Deploy old-skill to claude dir
      await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'old-skill'));
      await fse.writeFile(
        path.join(homeDir, '.claude', 'skills', 'old-skill', 'SKILL.md'),
        '# Old',
      );

      // Source repo now only has new-skill (old-skill removed from publicSkills)
      const sourceRepoDir = fixtureSourceRepoDir();
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'new-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'new-skill', 'SKILL.md'),
        '# New',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['new-skill'],
        }),
      );

      await pullSources(localConfig, {});

      // old-skill should be removed
      const oldExists = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'old-skill'),
      );
      expect(oldExists).toBe(false);

      // new-skill should be deployed
      const newExists = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'new-skill', 'SKILL.md'),
      );
      expect(newExists).toBe(true);
    });

    it.each(['same', 'nested', 'ancestor', 'symlink', 'separate', 'prefix', 'inactive', 'unknown-root'])(
      'coordinates stale cleanup with another installation: %s', async (ownership) => {
        teamConfig.sources = [{ name: 'platform', repo: 'https://source.test/platform/repo.git' }];
        const YAML = (await import('yaml')).default;
        await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
        const ownPath = '.claude/skills/old-skill';
        await fse.outputFile(path.join(homeDir, ownPath, 'SKILL.md'), '# Shared source copy');
        await fse.outputJson(getSourceManifestPath('platform', localConfig), {
          destinationRoot: homeDir, lastPull: new Date(0).toISOString(),
          installedSkills: ['old-skill'], installedPaths: { 'old-skill': [ownPath] },
        } satisfies SourceInstallManifest);
        const otherRoot = ['separate', 'symlink'].includes(ownership) ? path.join(tmpDir, 'other-root') : homeDir;
        if (ownership === 'symlink') {
          await fse.ensureDir(otherRoot);
          await fse.symlink(path.join(homeDir, '.claude'), path.join(otherRoot, '.claude'), 'dir');
        }
        const otherPath = ownership === 'nested' ? `${ownPath}/nested`
          : ownership === 'ancestor' ? '.claude/skills'
          : ownership === 'prefix' ? `${ownPath}-other` : ownPath;
        await fse.ensureDir(path.join(otherRoot, otherPath));
        const otherConfig: LocalConfig = {
          ...localConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') },
        };
        const otherManifestPath = getSourceManifestPath('other-alias', otherConfig);
        await fse.outputJson(otherManifestPath, {
          ...(ownership === 'unknown-root' ? {} : { destinationRoot: otherRoot }),
          repositoryId: createHash('sha256').update(teamConfig.sources[0].repo.trim()).digest('hex'),
          lastPull: new Date(0).toISOString(),
          installedSkills: ownership === 'inactive' ? [] : ['old-skill'],
          installedPaths: { 'old-skill': [otherPath] },
        } satisfies SourceInstallManifest);
        const otherManifest = await fse.readFile(otherManifestPath, 'utf8');
        const repoDir = fixtureSourceRepoDir();
        await fse.outputFile(path.join(repoDir, 'skills', 'new-skill', 'SKILL.md'), '# New');
        await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({
          team: 'platform', repo: teamConfig.sources[0].repo, publicSkills: ['new-skill'],
        }));

        await pullSources(localConfig, { force: true });

        expect(await fse.pathExists(path.join(homeDir, ownPath, 'SKILL.md')))
          .toBe(['same', 'nested', 'ancestor', 'symlink'].includes(ownership));
        expect(await fse.readFile(otherManifestPath, 'utf8')).toBe(otherManifest);
        const current = await fse.readJson(getSourceManifestPath('platform', localConfig)) as SourceInstallManifest;
        expect(current.destinationRoot).toBe(homeDir);
        expect(current.teamCheckout).toBe(localConfig.repo.localPath);
        expect(current.installedSkills).toEqual(['new-skill']);
        expect(current.installedPaths?.['old-skill']).toBeUndefined();
      },
    );

    it.each(['different', 'unknown', 'same'])('checks %s-repository ownership before writing through a symlinked target', async (repository) => {
      teamConfig.sources = [{ name: 'platform', repo: 'https://source.test/platform/repo.git' }];
      teamConfig.toolPaths = { claude: { skills: '.linked-agent/skills' } };
      await fse.symlink(path.join(homeDir, '.claude'), path.join(homeDir, '.linked-agent'), 'dir');
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      const repositoryId = createHash('sha256').update(teamConfig.sources[0].repo).digest('hex');
      const otherConfig: LocalConfig = { ...localConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') } };
      const otherManifestPath = getSourceManifestPath('other-alias', otherConfig);
      await fse.outputJson(otherManifestPath, {
        destinationRoot: homeDir,
        ...(repository === 'unknown' ? {} : { repositoryId: repository === 'same' ? repositoryId : 'other-repository' }),
        lastPull: new Date(0).toISOString(), installedSkills: ['parent'],
        installedPaths: { parent: ['.claude/skills'] },
      } satisfies SourceInstallManifest);
      const otherManifest = await fse.readFile(otherManifestPath, 'utf8');
      const repoDir = fixtureSourceRepoDir();
      await fse.outputFile(path.join(repoDir, 'skills', 'new-skill', 'SKILL.md'), '# New source');
      await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({
        team: 'platform', repo: teamConfig.sources[0].repo, publicSkills: ['new-skill'],
      }));
      const target = path.join(homeDir, '.claude', 'skills', 'new-skill', 'SKILL.md');
      const manifestPath = getSourceManifestPath('platform', localConfig);
      await pullSources(localConfig, { force: true, dryRun: true });
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(manifestPath)).toBe(false);
      expect(await fse.readFile(otherManifestPath, 'utf8')).toBe(otherManifest);

      await pullSources(localConfig, { force: true });
      expect(await fse.pathExists(target)).toBe(repository === 'same');
      const manifest = await fse.readJson(manifestPath) as SourceInstallManifest;
      expect(manifest.repositoryId).toBe(repositoryId);
      expect(manifest.installedSkills).toEqual(repository === 'same' ? ['new-skill'] : []);
      expect(await fse.readFile(otherManifestPath, 'utf8')).toBe(otherManifest);
    });

    it.each(['same', 'changed', 'unknown'])('preserves prior installation on a destination conflict with %s repository identity', async (repository) => {
      const previousUrl = 'https://source.test/original/repo.git';
      const repo = repository === 'changed' ? 'https://source.test/replacement/repo.git' : previousUrl;
      teamConfig.sources = [{ name: 'platform', repo }];
      teamConfig.toolPaths = { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } };
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      const alphaSkill = path.join(homeDir, '.claude/skills/old-skill/SKILL.md');
      const betaSkill = path.join(homeDir, '.codex/skills/old-skill/SKILL.md');
      await fse.outputFile(alphaSkill, '# Alpha existing');
      await fse.outputFile(betaSkill, '# Beta existing');
      const manifestPath = getSourceManifestPath('platform', localConfig);
      await fse.outputJson(manifestPath, {
        destinationRoot: homeDir,
        ...(repository === 'unknown' ? {} : { repositoryId: createHash('sha256').update(previousUrl).digest('hex') }),
        lastPull: new Date(0).toISOString(), installedSkills: ['old-skill'],
        installedPaths: { 'old-skill': ['.claude/skills/old-skill'] },
      } satisfies SourceInstallManifest);
      const previousManifest = await fse.readFile(manifestPath, 'utf8');
      const betaConfig: LocalConfig = { ...localConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'beta-team') } };
      const betaManifestPath = getSourceManifestPath('beta-source', betaConfig);
      await fse.outputJson(betaManifestPath, {
        destinationRoot: homeDir, repositoryId: 'beta-repository',
        lastPull: new Date(0).toISOString(), installedSkills: ['old-skill'],
        installedPaths: { 'old-skill': ['.codex/skills/old-skill'] },
      } satisfies SourceInstallManifest);
      const betaManifest = await fse.readFile(betaManifestPath, 'utf8');
      const repoDir = fixtureSourceRepoDir();
      for (const name of ['free-skill', 'old-skill']) {
        await fse.outputFile(path.join(repoDir, 'skills', name, 'SKILL.md'), '# New source content');
      }
      await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({
        team: 'platform', repo, publicSkills: ['free-skill', 'old-skill'],
      }));

      await pullSources(localConfig, { force: true });

      expect(await fse.readFile(alphaSkill, 'utf8')).toBe('# Alpha existing');
      expect(await fse.readFile(betaSkill, 'utf8')).toBe('# Beta existing');
      expect(await fse.readFile(betaManifestPath, 'utf8')).toBe(betaManifest);
      if (repository === 'same') {
        const current = await fse.readJson(manifestPath) as SourceInstallManifest;
        expect(current.installedSkills).toEqual(['free-skill', 'old-skill']);
        expect(current.installedPaths?.['old-skill']).toEqual(['.claude/skills/old-skill']);
      } else {
        expect(await fse.readFile(manifestPath, 'utf8')).toBe(previousManifest);
      }
      for (const tool of ['.claude', '.codex']) {
        expect(await fse.pathExists(path.join(homeDir, tool, 'skills/free-skill'))).toBe(repository === 'same');
      }
    });

    it.each([false, true])('releases old repository paths on a successful retarget (other owner: %s)', async (hasOtherOwner) => {
      const previousUrl = 'https://source.test/original/repo.git';
      const repo = 'https://source.test/replacement/repo.git';
      teamConfig.sources = [{ name: 'platform', repo }];
      teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      await fse.ensureDir(path.join(homeDir, '.codex/skills'));
      const oldPath = '.claude/skills/shared-skill';
      await fse.outputFile(path.join(homeDir, oldPath, 'SKILL.md'), '# Original content');
      const previousId = createHash('sha256').update(previousUrl).digest('hex');
      const previousRecord: SourceInstallManifest = {
        destinationRoot: homeDir, repositoryId: previousId, lastPull: new Date(0).toISOString(),
        installedSkills: ['shared-skill'], installedPaths: { 'shared-skill': [oldPath] },
      };
      const manifestPath = getSourceManifestPath('platform', localConfig);
      await fse.outputJson(manifestPath, previousRecord);
      const otherConfig: LocalConfig = { ...localConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') } };
      if (hasOtherOwner) await fse.outputJson(getSourceManifestPath('platform', otherConfig), previousRecord);
      const repoDir = fixtureSourceRepoDir();
      await fse.outputFile(path.join(repoDir, 'skills/shared-skill/SKILL.md'), '# Replacement content');
      await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({ team: 'platform', repo, publicSkills: ['shared-skill'] }));

      await pullSources(localConfig, { force: true });

      const current = await fse.readJson(manifestPath) as SourceInstallManifest;
      expect(current.repositoryId).toBe(createHash('sha256').update(repo).digest('hex'));
      expect(current.installedPaths?.['shared-skill']).toEqual(['.codex/skills/shared-skill']);
      expect(await fse.pathExists(path.join(homeDir, oldPath))).toBe(hasOtherOwner);
      const newPath = path.join(homeDir, '.codex/skills/shared-skill/SKILL.md');
      expect(await fse.readFile(newPath, 'utf8')).toBe('# Replacement content');
      if (hasOtherOwner) {
        expect(await fse.readFile(path.join(homeDir, oldPath, 'SKILL.md'), 'utf8')).toBe('# Original content');
        const otherTeam = { ...teamConfig, sources: [{ name: 'platform', repo: previousUrl }], toolPaths: { claude: { skills: '.claude/skills' } } };
        await fse.outputFile(path.join(otherConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(otherTeam));
        const otherRepo = path.join(sourcesDir, 'platform', 'repos', previousId, 'repo');
        await fse.outputFile(path.join(otherRepo, 'skills/shared-skill/SKILL.md'), '# Original refreshed');
        await fse.outputFile(path.join(otherRepo, 'teamai.yaml'), YAML.stringify({ team: 'platform', repo: previousUrl, publicSkills: ['shared-skill'] }));
        await pullSources(otherConfig, { force: true });
        expect(await fse.readFile(path.join(homeDir, oldPath, 'SKILL.md'), 'utf8')).toBe('# Original refreshed');
        expect(await fse.readFile(newPath, 'utf8')).toBe('# Replacement content');
      }
    });

    it('does not overwrite files when a foreign scoped ownership record cannot be parsed', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'https://source.test/platform/repo.git' }];
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));
      const target = path.join(homeDir, '.claude/skills/shared-skill/SKILL.md');
      await fse.outputFile(target, '# Preserve existing owner');
      const otherConfig: LocalConfig = { ...localConfig, repo: { ...localConfig.repo, localPath: path.join(tmpDir, 'other-team') } };
      await fse.outputFile(getSourceManifestPath('foreign', otherConfig), '{truncated');
      const repoDir = fixtureSourceRepoDir();
      await fse.outputFile(path.join(repoDir, 'skills/shared-skill/SKILL.md'), '# Incoming overwrite');
      await fse.outputFile(path.join(repoDir, 'teamai.yaml'), YAML.stringify({ team: 'platform', repo: teamConfig.sources[0].repo, publicSkills: ['shared-skill'] }));

      await pullSources(localConfig, { force: true });

      expect(await fse.readFile(target, 'utf8')).toBe('# Preserve existing owner');
      expect(await fse.pathExists(getSourceManifestPath('platform', localConfig))).toBe(false);
    });

    it('should handle dry-run mode', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      const sourceRepoDir = fixtureSourceRepoDir();
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'cool-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'cool-skill', 'SKILL.md'),
        '# Cool',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['cool-skill'],
        }),
      );

      await pullSources(localConfig, { dryRun: true });

      // Skill should NOT be deployed in dry-run
      const deployed = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'cool-skill'),
      );
      expect(deployed).toBe(false);
    });

    it('removes a source skill from its recorded path when a shared Codex skill appears later', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];
      teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
      const YAML = (await import('yaml')).default;
      await fse.writeFile(path.join(localConfig.repo.localPath, 'teamai.yaml'), YAML.stringify(teamConfig));

      const sourceDir = path.join(sourcesDir, 'platform');
      await fse.ensureDir(sourceDir);
      await fse.outputJson(getSourceManifestPath('platform', localConfig), {
        repositoryId: createHash('sha256').update(teamConfig.sources[0].repo.trim()).digest('hex'),
        lastPull: new Date(0).toISOString(),
        installedSkills: ['old-skill'],
        installedPaths: { 'old-skill': ['.codex/skills/old-skill'] },
      } satisfies SourceInstallManifest);
      await fse.ensureDir(path.join(homeDir, '.codex', 'skills', 'old-skill'));
      await fse.writeFile(path.join(homeDir, '.codex', 'skills', 'old-skill', 'SKILL.md'), '# Source copy');
      await fse.ensureDir(path.join(homeDir, '.agents', 'skills', 'old-skill'));
      await fse.writeFile(path.join(homeDir, '.agents', 'skills', 'old-skill', 'SKILL.md'), '# User copy');
      await fse.ensureDir(path.join(fixtureSourceRepoDir(), 'skills', 'old-skill'));
      await fse.writeFile(path.join(fixtureSourceRepoDir(), 'skills', 'old-skill', 'SKILL.md'), '# Updated source');
      await fse.writeFile(path.join(fixtureSourceRepoDir(), 'teamai.yaml'), YAML.stringify({
        team: 'platform', repo: 'git@git.woa.com:platform/repo.git', publicSkills: ['old-skill'],
      }));

      await pullSources(localConfig, { force: true });

      const updatedManifest = await fse.readJson(getSourceManifestPath('platform', localConfig)) as SourceInstallManifest;
      expect(updatedManifest.installedPaths?.['old-skill']).toEqual([
        '.codex/skills/old-skill', '.agents/skills/old-skill',
      ]);

      await fse.ensureDir(path.join(fixtureSourceRepoDir(), 'skills', 'new-skill'));
      await fse.writeFile(path.join(fixtureSourceRepoDir(), 'skills', 'new-skill', 'SKILL.md'), '# New');
      await fse.writeFile(path.join(fixtureSourceRepoDir(), 'teamai.yaml'), YAML.stringify({
        team: 'platform', repo: 'git@git.woa.com:platform/repo.git', publicSkills: ['new-skill'],
      }));

      await pullSources(localConfig, { force: true });

      expect(await fse.pathExists(path.join(homeDir, '.codex', 'skills', 'old-skill'))).toBe(false);
      expect(await fse.pathExists(path.join(homeDir, '.agents', 'skills', 'old-skill'))).toBe(false);
    });
  });
});

describe('TeamaiConfig sources schema', () => {
  it('should parse config without sources field (backward compat)', async () => {
    const { TeamaiConfigSchema } = await import('../types.js');
    const config = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
    });
    // sources is optional, so it should be undefined
    expect(config.sources).toBeUndefined();
  });

  it('should parse config with sources', async () => {
    const { TeamaiConfigSchema } = await import('../types.js');
    const config = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
      sources: [{ name: 'other', repo: 'git@git.woa.com:other/repo.git' }],
    });
    expect(config.sources).toHaveLength(1);
    expect(config.sources![0].name).toBe('other');
  });

  it('should parse config with publicSkills', async () => {
    const { TeamaiConfigSchema } = await import('../types.js');
    const config = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
      publicSkills: ['skill-a', 'skill-b'],
    });
    expect(config.publicSkills).toEqual(['skill-a', 'skill-b']);
  });
});

describe('sourceSyncWarnings', () => {
  async function makeConfig(overrides: Record<string, unknown>): Promise<TeamaiConfig> {
    const { TeamaiConfigSchema } = await import('../types.js');
    return TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
      ...overrides,
    });
  }

  it('warns that a source with no teamai.yaml will sync 0 skills', () => {
    const lines = sourceSyncWarnings('acme', null);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('has no teamai.yaml');
    expect(lines[0]).toContain('"acme"');
    expect(lines[1]).toContain('sync 0 skills');
  });

  it('warns that a source with an empty publicSkills list will sync 0 skills', async () => {
    const config = await makeConfig({ publicSkills: [] });
    const lines = sourceSyncWarnings('acme', config);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('declares no publicSkills');
    expect(lines[1]).toContain('sync 0 skills');
  });

  it('warns when publicSkills is absent (undefined) just like an empty list', async () => {
    const config = await makeConfig({});
    expect(config.publicSkills).toBeUndefined();
    const lines = sourceSyncWarnings('acme', config);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('declares no publicSkills');
  });

  it('is silent when the source declares at least one public skill', async () => {
    const config = await makeConfig({ publicSkills: ['cool-skill'] });
    expect(sourceSyncWarnings('acme', config)).toEqual([]);
  });
});
