import path from 'node:path';
import { createHash } from 'node:crypto';
import fse from 'fs-extra';
import YAML from 'yaml';
import { loadTeamConfig, autoDetectInit, loadLocalConfig, detectProjectConfig } from './config.js';
import { pullRepo } from './utils/git.js';
import { parseFrontmatter } from './utils/frontmatter.js';
import { detectProvider, getProvider } from './providers/index.js';
import { log, spinner } from './utils/logger.js';
import {
  pathExists,
  readFileSafe,
  readJson,
  writeJson,
  listDirs,
  listFiles,
  copyDir,
  remove,
  ensureDir,
} from './utils/fs.js';
import { getHandler } from './resources/index.js';
import { ResourceHandler } from './resources/base.js';
import { CODEX_TOOL, resolveSkillDestination } from './resources/skills.js';
import { BUILTIN_SKILL_NAMES, LEGACY_BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import { getUserHome } from './utils/home.js';
import { acquireLock, releaseLock } from './update.js';
import { assertSafeResourceName, assertWithinRoot } from './utils/path-safety.js';
import type {
  TeamaiConfig,
  LocalConfig,
  SourceConfig,
  SourceInstallManifest,
  GlobalOptions,
} from './types.js';
import { resolveBaseDir, scopedToolPaths, SOURCE_PULL_TTL_MS } from './types.js';

// ─── Source repo management ──────────────────────────────

function sourceLockPath(): string {
  return path.join(getUserHome(), '.teamai', '.source-lifecycle-lock');
}

async function withSourceLock(options: GlobalOptions, action: () => Promise<void>): Promise<void> {
  const lock = sourceLockPath();
  if (!await acquireLock(lock, { dryRun: options.dryRun })) {
    throw new Error('Could not acquire the shared source lock. Retry after other source operations finish and check cache permissions.');
  }
  try {
    await action();
  } finally {
    if (!options.dryRun) await releaseLock(lock);
  }
}

function getSourceDir(sourceName: string): string {
  assertSafeResourceName(sourceName);
  return path.join(getUserHome(), '.teamai', 'sources', sourceName);
}

function getSourceRepoId(source: SourceConfig): string {
  return createHash('sha256').update(source.repo.trim()).digest('hex');
}

function getSourceRepoCacheDir(source: SourceConfig): string {
  // Aliases sharing a producer must share its revision and TTL as well.
  return path.join(getUserHome(), '.teamai', 'source-repos', getSourceRepoId(source));
}

function getSourceRepoDir(source: SourceConfig): string {
  return path.join(getSourceRepoCacheDir(source), 'repo');
}

export function getSourceManifestPath(sourceName: string, localConfig: LocalConfig): string {
  const installationId = createHash('sha256').update(JSON.stringify([
    path.resolve(resolveBaseDir(localConfig)),
    path.resolve(localConfig.repo.localPath),
  ])).digest('hex');
  return path.join(getSourceDir(sourceName), 'installations', `${installationId}.json`);
}

/** Portable lexical check: a tracking record can never authorize its root. */
function isRelativeDescendant(value: string): boolean {
  const portable = value.replaceAll('\\', '/');
  const normalized = path.posix.normalize(portable).replace(/\/+$/, '');
  return value.length > 0 && !value.includes('\0') && !path.posix.isAbsolute(portable)
    && !path.win32.isAbsolute(value) && !/^[a-z]:/i.test(value)
    && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

/** Skill identity must match the exact path used for local-team priority. */
function isCanonicalSkillName(value: string): boolean {
  return isRelativeDescendant(value) && !value.includes('\\')
    && !value.endsWith('/') && path.posix.normalize(value) === value;
}

/** Resolve missing leaves without treating inaccessible/dangling links as identity. */
async function resolveSourcePhysicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fse.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Cannot verify source destination: ${absolute}. Manual review is required (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
    // A missing leaf is safe to append; an existing dangling link is not.
    try {
      await fse.lstat(absolute);
      throw new Error(`Cannot determine source destination through a dangling symlink: ${absolute}. Manual review is required.`);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await resolveSourcePhysicalPath(parent), path.basename(absolute));
  }
}

/** copyDir unlinks a leaf symlink before copying into its lexical location. */
async function resolveSourceCopyDestination(target: string): Promise<{ path: string; replacesSymlink: boolean }> {
  try {
    if ((await fse.lstat(target)).isSymbolicLink()) {
      return { path: path.join(await resolveSourcePhysicalPath(path.dirname(target)), path.basename(target)), replacesSymlink: true };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { path: await resolveSourcePhysicalPath(target), replacesSymlink: false };
}

async function readSourceManifest(manifestPath: string): Promise<SourceInstallManifest | null> {
  let raw: string;
  try {
    raw = await fse.readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read source ownership record: ${manifestPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in source ownership record: ${manifestPath}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid source ownership record: ${manifestPath}`);
  }
  const manifest = value as SourceInstallManifest;
  if (!Array.isArray(manifest.installedSkills) || !manifest.installedSkills.every((skill) => typeof skill === 'string' && isCanonicalSkillName(skill))
    || (manifest.installedPaths !== undefined && (!manifest.installedPaths || typeof manifest.installedPaths !== 'object'
      || Array.isArray(manifest.installedPaths) || !Object.values(manifest.installedPaths).every((paths) => Array.isArray(paths) && paths.every((target) => typeof target === 'string' && isRelativeDescendant(target)))))
    || (manifest.destinationRoot !== undefined && (typeof manifest.destinationRoot !== 'string' || !path.isAbsolute(manifest.destinationRoot)))
    || (manifest.installedPhysicalPaths !== undefined && (!manifest.installedPaths || !manifest.installedPhysicalPaths
      || typeof manifest.installedPhysicalPaths !== 'object' || Array.isArray(manifest.installedPhysicalPaths)
      || !Object.entries(manifest.installedPhysicalPaths).every(([target, physical]) => isRelativeDescendant(target)
        && typeof physical === 'string' && !physical.includes('\0') && path.isAbsolute(physical) && path.resolve(physical) === physical && path.parse(physical).root !== physical)))
    || (manifest.repositoryId !== undefined && typeof manifest.repositoryId !== 'string')) {
    throw new Error(`Invalid source ownership record: ${manifestPath}`);
  }
  return manifest;
}

async function loadSourceManifest(sourceName: string, localConfig: LocalConfig): Promise<SourceInstallManifest | null> {
  return readSourceManifest(getSourceManifestPath(sourceName, localConfig));
}

async function saveSourceManifest(sourceName: string, localConfig: LocalConfig, manifest: SourceInstallManifest): Promise<void> {
  await writeJson(getSourceManifestPath(sourceName, localConfig), manifest);
}

/**
 * Check if a source repo needs pulling based on TTL.
 * Returns true if the last pull was more than SOURCE_PULL_TTL_MS ago.
 */
async function shouldPullSource(source: SourceConfig): Promise<boolean> {
  const stamp = await readJson<{ lastPull: string }>(path.join(getSourceRepoCacheDir(source), 'last-pull.json'));
  if (!stamp) return true;
  const elapsed = Date.now() - new Date(stamp.lastPull).getTime();
  return !Number.isFinite(elapsed) || elapsed > SOURCE_PULL_TTL_MS;
}

async function recordSourcePull(source: SourceConfig): Promise<void> {
  await writeJson(path.join(getSourceRepoCacheDir(source), 'last-pull.json'), {
    lastPull: new Date().toISOString(),
  });
}

/**
 * Clone or pull a source repo. Returns the repo path, or null on failure.
 */
async function ensureSourceRepo(source: SourceConfig, force: boolean, dryRun = false): Promise<string | null> {
  const repoDir = getSourceRepoDir(source);
  if (dryRun) {
    if (!await pathExists(repoDir)) {
      log.info(`[dry-run] [source:${source.name}] Would clone the repository; no cached skills are available to preview.`);
      return null;
    }
    if (force || await shouldPullSource(source)) {
      log.info(`[dry-run] [source:${source.name}] Would refresh the cached repository; previewing its current contents.`);
    }
    return repoDir;
  }

  if (await pathExists(repoDir)) {
    // Existing clone: pull if TTL expired or forced
    if (!force && !(await shouldPullSource(source))) {
      log.debug(`[source:${source.name}] Within pull TTL, skipping git pull`);
      return repoDir;
    }

    try {
      const result = await pullRepo(repoDir);
      await recordSourcePull(source);
      log.debug(`[source:${source.name}] Git pull: ${result}`);
      return repoDir;
    } catch (e) {
      log.warn(`[source:${source.name}] Pull failed: ${(e as Error).message}`);
      // Return existing repo even if pull fails (use cached version)
      return repoDir;
    }
  }

  // First time: clone via the provider so its configured authentication path
  // (token, credential helper, or SSH agent) is used.
  try {
    await ensureDir(path.dirname(repoDir));
    const cloneSpin = spinner(`[source:${source.name}] Cloning...`).start();

    const providerName = detectProvider(source.repo);
    const provider = getProvider(providerName);
    const repoInfo = provider.parseRepoInput(source.repo);
    const cloneTarget = provider.name === 'git'
      ? repoInfo.httpsUrl
      : `${repoInfo.owner}/${repoInfo.repo}`;
    provider.cloneRepo(cloneTarget, repoDir);
    await recordSourcePull(source);

    cloneSpin.succeed(`[source:${source.name}] Cloned`);
    return repoDir;
  } catch (e) {
    log.warn(`[source:${source.name}] Clone failed: ${(e as Error).message}`);
    return null;
  }
}

// ─── Commands ────────────────────────────────────────────

/**
 * Add a source to the team's teamai.yaml.
 * This modifies the team repo and requires a push (via MR or direct).
 */
export async function sourceAdd(repoUrl: string, options: { name?: string } & GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  await withSourceLock(options, () => sourceAddLocked(repoUrl, options, localConfig, teamConfig));
}

async function sourceAddLocked(repoUrl: string, options: { name?: string } & GlobalOptions, localConfig: LocalConfig, initialTeamConfig: TeamaiConfig): Promise<void> {
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath) ?? initialTeamConfig;
  const repoPath = localConfig.repo.localPath;

  // Derive name from repo URL if not provided
  const name = options.name ?? deriveSourceName(repoUrl);
  if (!name) {
    log.error('Could not derive source name from URL. Use --name to specify one.');
    return;
  }
  try {
    assertSafeResourceName(name);
  } catch (e) {
    log.error(`Invalid source name "${name}": ${(e as Error).message}`);
    return;
  }

  // Check for duplicates
  const existing = teamConfig.sources ?? [];
  if (existing.some((s) => s.name === name)) {
    log.error(`Source "${name}" already exists. Use a different name or remove it first.`);
    return;
  }
  if (existing.some((s) => s.repo === repoUrl)) {
    log.error(`Source repo "${repoUrl}" already configured (as "${existing.find((s) => s.repo === repoUrl)!.name}").`);
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would add source "${name}" (${repoUrl}); repository access will be checked when applied.`);
    return;
  }

  // Verify the source repo is accessible by cloning it
  const cloneResult = await ensureSourceRepo({ name, repo: repoUrl }, true);
  if (!cloneResult) {
    log.error('Could not access the source repo. Check the URL and your git credentials.');
    return;
  }

  // Warn up front when the source cannot share anything. `pull` opts in on a
  // source's `publicSkills` declaration, so a repo without a teamai.yaml (or
  // with an empty publicSkills list) syncs 0 skills. Say so here, at add time,
  // instead of letting pull skip it silently later.
  const sourceConfig = await loadTeamConfig(cloneResult);
  for (const line of sourceSyncWarnings(name, sourceConfig)) {
    log.warn(line);
  }

  // Update teamai.yaml
  const yamlPath = path.join(repoPath, 'teamai.yaml');
  const content = await readFileSafe(yamlPath);
  if (!content) {
    log.error('Could not read teamai.yaml');
    return;
  }

  const raw = YAML.parse(content);
  if (!raw.sources) {
    raw.sources = [];
  }
  raw.sources.push({ name, repo: repoUrl });
  await fse.writeFile(yamlPath, YAML.stringify(raw));

  log.success(`Added source "${name}" (${repoUrl})`);
  log.info('Run `teamai push` to share this change with your team.');
}

/**
 * Remove a source from teamai.yaml and clean up this scope's installation.
 */
export async function sourceRemove(name: string, options: GlobalOptions): Promise<void> {
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: options.dryRun });
  await withSourceLock(options, () => sourceRemoveLocked(name, options, localConfig, teamConfig));
}

async function sourceRemoveLocked(name: string, options: GlobalOptions, localConfig: LocalConfig, initialTeamConfig: TeamaiConfig): Promise<void> {
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath) ?? initialTeamConfig;
  const repoPath = localConfig.repo.localPath;

  const existing = teamConfig.sources ?? [];
  const source = existing.find((s) => s.name === name);
  // A different destination may already have removed this source from the
  // shared team checkout. Its absence must not strand this installation.
  const manifest = await loadSourceManifest(name, localConfig);
  if (!source && !manifest) {
    log.error(`Source "${name}" not found. Run \`teamai source list\` to see configured sources.`);
    return;
  }

  // A shared checkout may have re-used this alias for a different producer.
  // Old (or unidentified) scoped ownership only authorizes local cleanup.
  const removeSubscription = !!source && (!manifest || manifest.repositoryId === getSourceRepoId(source));
  if (source && !removeSubscription) {
    log.info(`Keeping source "${name}" configuration: this installation does not belong to its current repository.`);
  }

  // Validate every ownership record and deletion target before changing YAML.
  // The shared lifecycle lock keeps source ownership stable through removal.
  const cleanupPaths: string[] = [];
  const retainedSkills: string[] = [];
  const retainedPaths: Record<string, string[]> = {};
  if (manifest) {
    const baseDir = resolveBaseDir(localConfig);
    await assertSourceDestinationsUnchanged(manifest, teamConfig, localConfig, baseDir);
    const otherOwners = await getSourcePathOwners(getSourceManifestPath(name, localConfig));
    const localTeamSkills = await getLocalTeamSkillNames(teamConfig, localConfig);
    for (const skill of manifest.installedSkills) {
      if (isLocalTeamSkill(skill, localTeamSkills)
        || hasNestedSourceOwner(skill, manifest, teamConfig, localConfig, baseDir, otherOwners)) {
        retainedSkills.push(skill);
        retainedPaths[skill] = getRetainedSkillPaths(skill, manifest, teamConfig, localConfig, baseDir);
        continue;
      }
      cleanupPaths.push(...await getSkillRemovalPaths(skill, teamConfig, localConfig, baseDir, otherOwners, manifest.installedPaths?.[skill], manifest.installedPhysicalPaths));
    }
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would remove source "${name}"`);
    return;
  }

  if (removeSubscription) {
    // Update teamai.yaml
    const yamlPath = path.join(repoPath, 'teamai.yaml');
    const content = await readFileSafe(yamlPath);
    if (!content) {
      log.error('Could not read teamai.yaml');
      return;
    }

    const raw = YAML.parse(content);
    raw.sources = (raw.sources ?? []).filter((s: SourceConfig) => s.name !== name);
    await fse.writeFile(yamlPath, YAML.stringify(raw));
  }

  // Apply the ownership-checked plan only after configuration was readable.
  for (const target of cleanupPaths) await remove(target);

  // Protected files must not lose their provenance and become push candidates.
  if (manifest && retainedSkills.length > 0) {
    await saveSourceManifest(name, localConfig, {
      ...manifest, destinationRoot: path.resolve(resolveBaseDir(localConfig)),
      teamCheckout: path.resolve(localConfig.repo.localPath),
      installedSkills: retainedSkills, installedPaths: retainedPaths,
      installedPhysicalPaths: Object.fromEntries(Object.values(retainedPaths).flat()
        .map((target) => [target, getSourcePhysicalPin(manifest, resolveBaseDir(localConfig), target)])),
    });
    log.warn(`Retained source ownership for ${retainedSkills.length} skill(s) overlapping team, builtin, or nested source content. Review ${getSourceManifestPath(name, localConfig)} before retiring that tracking.`);
  } else {
    // Other projects may still use this source's shared clone and manifests.
    await remove(getSourceManifestPath(name, localConfig));
  }

  log.success(`Removed source "${name}"`);
  if (removeSubscription) log.info('Run `teamai push` to share this change with your team.');
}

/**
 * List all configured sources: team-level git cross-team sources (from
 * teamai.yaml) plus the personal HTTP bypass (report/sync/ack), if configured.
 */
export async function sourceList(): Promise<void> {
  // Git cross-team sources come from the team config. Tolerate a missing init:
  // the HTTP bypass is independent of the team repo, so still show it.
  let gitSources: SourceConfig[] = [];
  try {
    // Read-only: the load never persists a migration (#893).
    const { teamConfig } = await autoDetectInit(undefined, { dryRun: true });
    gitSources = teamConfig.sources ?? [];
  } catch {
    // Not initialized (no team repo) — only the HTTP bypass may exist.
  }

  const { describeLocalAgent } = await import('./local-agent.js');
  const httpSource = await describeLocalAgent({ dryRun: true });

  if (gitSources.length === 0 && !httpSource) {
    log.info('No sources configured. Use `teamai source add <url>` or `teamai source add-http <endpoint>`.');
    return;
  }

  if (gitSources.length > 0) {
    log.info(`Git cross-team sources (${gitSources.length}):`);
    for (const source of gitSources) {
      const repoDir = getSourceRepoDir(source);
      const cloned = await pathExists(repoDir);
      const status = cloned ? '(synced)' : '(not yet synced)';
      log.info(`  ${source.name} ${status}`);
      log.dim(`    ${source.repo}`);
    }
  }

  if (httpSource) {
    const { skills, rules, claudemd } = httpSource.resourceCounts;
    log.info('HTTP source (report/sync/ack):');
    log.info(`  ${httpSource.endpoint}`);
    log.dim(`    ${skills} skill(s), ${rules} rule(s), ${claudemd} claude.md`);
    for (const p of httpSource.boundProjects) {
      log.dim(`    bound: ${p.projectName ?? p.projectId} — ${p.path}`);
    }
  }
}

/**
 * Add a personal HTTP source (report/sync/ack side channel) alongside the git
 * main repo. Reuses the local-agent bypass so a git-based user gets the same
 * report/sync/ack lifecycle an `init --http` user has, without touching the git
 * main repo.
 *
 * Rejected when the main repo itself is HTTP: that setup already owns the single
 * local-agent config, and a second endpoint would silently overwrite it.
 */
export async function sourceAddHttp(
  endpoint: string,
  options: { token?: string; force?: boolean } & GlobalOptions,
): Promise<void> {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    log.error('Endpoint is required. Usage: teamai source add-http <endpoint> --token <key>');
    return;
  }

  // Guard: if the main repo is already an HTTP backend, it owns the single
  // local-agent config — refuse rather than overwrite its endpoint.
  const mainConfig = (await detectProjectConfig(undefined, undefined, { dryRun: options.dryRun }))
    ?? (await loadLocalConfig({ dryRun: options.dryRun }));
  if (mainConfig?.repo.kind === 'http') {
    log.error('Your main team repo is already an HTTP backend, which owns the HTTP source config.');
    log.info('An HTTP bypass is only for git-based main repos. Nothing changed.');
    return;
  }

  if (options.dryRun) {
    log.info(`[dry-run] Would add HTTP source ${trimmed}`);
    return;
  }

  const { initLocalAgentHttp } = await import('./local-agent.js');
  // force: true so re-running add-http updates the bypass's own endpoint/token.
  await initLocalAgentHttp({ endpoint: trimmed, token: options.token, force: true });
  log.success(`HTTP source added (${trimmed}).`);
  log.info('It will report/sync on the next AI session (via the hook-dispatch hook already installed).');
}

/**
 * Remove the personal HTTP source: uninstall its resources and clear its config.
 */
export async function sourceRemoveHttp(options: GlobalOptions): Promise<void> {
  if (options.dryRun) {
    log.info('[dry-run] Would remove the HTTP source');
    return;
  }
  const { removeLocalAgentHttp } = await import('./local-agent.js');
  await removeLocalAgentHttp();
}

/**
 * Browse public skills from a source.
 */
export async function sourceBrowse(name: string, options: GlobalOptions): Promise<void> {
  // Read-only: the load never persists a migration (#893).
  const { localConfig, teamConfig } = await autoDetectInit(undefined, { dryRun: true });
  if (!(teamConfig.sources ?? []).some((source) => source.name === name)) {
    log.error(`Source "${name}" not found. Run \`teamai source list\` to see configured sources.`);
    return;
  }
  await withSourceLock(options, () => sourceBrowseLocked(name, options, localConfig, teamConfig));
}

async function sourceBrowseLocked(name: string, options: GlobalOptions, localConfig: LocalConfig, initialTeamConfig: TeamaiConfig): Promise<void> {
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath) ?? initialTeamConfig;
  const sources = teamConfig.sources ?? [];
  const source = sources.find((s) => s.name === name);

  if (!source) {
    log.error(`Source "${name}" not found. Run \`teamai source list\` to see configured sources.`);
    return;
  }

  // Ensure source repo is cloned
  const repoDir = await ensureSourceRepo(source, !!options.force, !!options.dryRun);
  if (!repoDir) {
    if (!options.dryRun) log.error(`Could not access source "${name}".`);
    return;
  }

  const sourceTeamConfig = await loadTeamConfig(repoDir);
  if (!sourceTeamConfig) {
    log.warn(`Source "${name}" has no teamai.yaml.`);
    return;
  }

  const publicSkills = sourceTeamConfig.publicSkills;
  if (!publicSkills || publicSkills.length === 0) {
    log.info(`Source "${name}" has not declared any public skills.`);
    log.dim('  The source team needs to add `publicSkills: [...]` to their teamai.yaml.');
    return;
  }

  // Verify which declared public skills actually exist
  const skillsDir = path.join(repoDir, 'skills');
  const available: Array<{ name: string; description: string }> = [];

  for (const skillName of publicSkills) {
    const exists = await findSkillInRepo(skillsDir, skillName);
    if (exists) {
      const desc = await extractSkillDescription(exists);
      available.push({ name: skillName, description: desc });
    }
  }

  if (available.length === 0) {
    log.info(`Source "${name}" declares ${publicSkills.length} public skill(s), but none were found in the repo.`);
    return;
  }

  log.info(`Public skills from "${name}" (${available.length}):`);
  for (const skill of available) {
    const desc = skill.description ? ` — ${skill.description}` : '';
    log.info(`  ${skill.name}${desc}`);
  }
}

// ─── Pull sources ────────────────────────────────────────

/**
 * Pull skills from all configured sources.
 * Called from pull() at the top level (not inside pullForScope).
 */
export async function pullSources(localConfig: LocalConfig, options: GlobalOptions): Promise<void> {
  if (!(await loadTeamConfig(localConfig.repo.localPath))?.sources?.length) return;
  try {
    await withSourceLock(options, () => pullSourcesLocked(localConfig, options));
  } catch (error) {
    log.warn(`[source] ${(error as Error).message}`);
  }
}

async function pullSourcesLocked(localConfig: LocalConfig, options: GlobalOptions): Promise<void> {
  const teamConfig = await loadTeamConfig(localConfig.repo.localPath);
  if (!teamConfig) return;

  const sources = teamConfig.sources ?? [];
  if (sources.length === 0) return;

  const baseDir = resolveBaseDir(localConfig);

  for (const source of sources) {
    try {
      await pullSingleSource(source, teamConfig, localConfig, baseDir, options);
    } catch (e) {
      log.warn(`[source:${source.name}] Pull failed: ${(e as Error).message}`);
    }
  }
}

async function pullSingleSource(
  source: SourceConfig,
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  baseDir: string,
  options: GlobalOptions,
): Promise<void> {
  // Ensure source repo is cloned/updated
  const repoDir = await ensureSourceRepo(source, !!options.force, !!options.dryRun);
  if (!repoDir) return;

  // Load source's teamai.yaml
  const sourceTeamConfig = await loadTeamConfig(repoDir);
  if (!sourceTeamConfig) {
    log.debug(`[source:${source.name}] No teamai.yaml, skipping`);
    return;
  }

  // A valid empty publication withdraws previous skills. An unreadable config
  // above is not evidence of withdrawal and leaves the installation untouched.
  const publicSkills = sourceTeamConfig.publicSkills ?? [];

  // Find actual skill directories in the source repo
  const skillsDir = path.join(repoDir, 'skills');
  const physicalRepoDir = await resolveSourcePhysicalPath(repoDir);
  const skillsToDeploy: Array<{ name: string; sourcePath: string }> = [];

  for (const skillName of publicSkills) {
    const skillPath = await findSkillInRepo(skillsDir, skillName);
    if (skillPath) {
      const physicalSource = await resolveSourcePhysicalPath(skillPath);
      if ((await fse.lstat(skillPath)).isSymbolicLink()
        && !isRelativeDescendant(path.relative(physicalRepoDir, physicalSource))) {
        throw new Error(`Source skill root symlink leaves its repository cache: ${skillPath}. Manual review is required.`);
      }
      // Copy concrete contents, never install a root link whose later physical
      // cleanup could delete its referent. In-repository aliases remain valid.
      skillsToDeploy.push({ name: skillName, sourcePath: physicalSource });
    }
  }

  // Load current manifest to determine what to add/remove
  const oldManifest = await loadSourceManifest(source.name, localConfig);
  const oldInstalled = new Set(oldManifest?.installedSkills ?? []);
  const repositoryId = getSourceRepoId(source);
  const repositoryChanged = !!oldManifest && oldManifest.repositoryId !== repositoryId;
  if (repositoryChanged && [...oldInstalled].some((skill) => !oldManifest.installedPaths?.[skill]?.length)) {
    log.warn(`[source:${source.name}] Cannot replace an installation with unrecorded destinations. Keeping all previous files and provenance unchanged. Manual review is required: review ${getSourceManifestPath(source.name, localConfig)} and the original deployment paths before retiring this claim.`);
    return;
  }
  if (oldManifest) await assertSourceDestinationsUnchanged(oldManifest, teamConfig, localConfig, baseDir);

  // Collect skills that belong to the local team (they take priority)
  const localTeamSkills = await getLocalTeamSkillNames(teamConfig, localConfig);
  const otherOwners = await getSourcePathOwners(getSourceManifestPath(source.name, localConfig));

  // Deploy skills to tool paths
  const deployed: string[] = [];
  const protectedOldSkills = [...oldInstalled].filter((skill) => isLocalTeamSkill(skill, localTeamSkills)
    || hasNestedSourceOwner(skill, oldManifest!, teamConfig, localConfig, baseDir, otherOwners));
  if (repositoryChanged && protectedOldSkills.length > 0) {
    log.warn(`[source:${source.name}] Cannot replace this installation while prior source paths overlap team, builtin, or nested source content. Keeping its provenance for manual review: ${getSourceManifestPath(source.name, localConfig)}`);
    return;
  }
  const retained = new Set(protectedOldSkills);
  const installedPaths: Record<string, string[]> = {};
  const installedPhysicalPaths: Record<string, string> = {};
  for (const skill of protectedOldSkills) {
    installedPaths[skill] = getRetainedSkillPaths(skill, oldManifest!, teamConfig, localConfig, baseDir);
    for (const target of installedPaths[skill]) installedPhysicalPaths[target] = getSourcePhysicalPin(oldManifest!, baseDir, target);
  }
  if (protectedOldSkills.length > 0) {
    log.warn(`[source:${source.name}] Keeping source provenance for paths overlapping team, builtin, or nested source content; review ${getSourceManifestPath(source.name, localConfig)} before retiring that tracking.`);
  }
  let newCount = 0;
  let updatedCount = 0;

  const previousTargets = [...oldInstalled].flatMap((skill) =>
    getRetainedSkillPaths(skill, oldManifest!, teamConfig, localConfig, baseDir)
      .map((relative) => ({ path: getSourcePhysicalPin(oldManifest!, baseDir, relative), relative, skillName: skill })));
  const plannedTargets: Array<{ path: string; skillName: string; lexicalPath: string; replacesSymlink: boolean }> = [];
  const plans: Array<{ skill: (typeof skillsToDeploy)[number]; targets: string[]; codexSkillsPath?: string; conflictingPath?: string; conflictingRecord?: string }> = [];
  for (const skill of skillsToDeploy) {
    // Local team skills take priority: skip source skill if name conflicts
    if (isLocalTeamSkill(skill.name, localTeamSkills)) {
      log.debug(`[source:${source.name}] Skipping "${skill.name}" (local team has same name)`);
      continue;
    }

    // Resolve without a source path: the Codex resolver's duplicate cleanup
    // must not delete a path before cross-installation ownership is checked.
    const targets: string[] = [];
    let codexSkillsPath: string | undefined;
    let conflictingPath: string | undefined;
    let conflictingRecord: string | undefined;
    for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
      if (!toolPath.skills || !await ResourceHandler.isToolInstalled(toolPath.skills, baseDir)) continue;
      const target = await resolveSkillDestination(tool, toolPath.skills, baseDir, skill.name);
      if (tool === CODEX_TOOL && target !== path.join(baseDir, toolPath.skills, skill.name)) codexSkillsPath = toolPath.skills;
      targets.push(target);
      const destination = await resolveSourceCopyDestination(target);
      const physical = destination.path;
      if (destination.replacesSymlink && previousTargets.some((candidate) => pathsOverlap(path.resolve(baseDir, candidate.relative), target))) {
        throw new Error(`Copying would change the pinned source destination: ${target}. Keeping the installation unchanged. Manual review is required; restore the original destination before retrying.`);
      }
      plannedTargets.push({ path: physical, skillName: skill.name, lexicalPath: target, replacesSymlink: destination.replacesSymlink });
      const owner = otherOwners.find((candidate) => candidate.repositoryId !== repositoryId && pathsOverlap(candidate.path, physical));
      if (owner) {
        conflictingPath = target;
        conflictingRecord = owner.manifestPath;
      }
    }
    if (targets.length > 0) plans.push({ skill, targets, codexSkillsPath, conflictingPath, conflictingRecord });
  }

  // Directory copies merge content. Crossing an existing parent/child boundary
  // would either strand withdrawn descendants or adopt their bytes under a new
  // identity. Keep the whole installation unchanged until ownership is reviewed.
  for (const target of plannedTargets) {
    if (target.replacesSymlink && plannedTargets.some((candidate) => (candidate.lexicalPath !== target.lexicalPath || candidate.skillName !== target.skillName)
      && pathsOverlap(candidate.lexicalPath, target.lexicalPath))) {
      throw new Error(`Copying would replace a symlink containing another planned skill: ${target.lexicalPath}. Manual review is required.`);
    }
    const overlap = [...previousTargets, ...otherOwners, ...plannedTargets]
      .find((owned) => pathsOverlap(owned.path, target.path)
        && (owned.path !== target.path || owned.skillName !== target.skillName));
    if (overlap) {
      log.warn(`[source:${source.name}] Cannot change overlapping skill directory boundaries: ${target.path} overlaps ${overlap.path}. Keeping the previous installation unchanged. Manual review is required: back up retained files, remove the affected source installation(s), then pull again. Ownership record: ${getSourceManifestPath(source.name, localConfig)}`);
      return;
    }
  }

  // A repository replacement cannot retain old content under the new identity.
  // Preflight every skill before writing so a conflict preserves the old record
  // and files intact, without leaving unrecorded partial replacements behind.
  const conflict = plans.find((plan) => plan.conflictingPath);
  if (conflict && repositoryChanged) {
    log.warn(`[source:${source.name}] Cannot replace this installation: another source repository owns ${conflict.conflictingPath}. Keeping previous installation. Ownership record: ${conflict.conflictingRecord}`);
    return;
  }

  // Validate retained fallback paths before any unrelated plan can write.
  for (const { skill, conflictingPath } of plans) {
    if (conflictingPath && oldInstalled.has(skill.name)) {
      retained.add(skill.name);
      installedPaths[skill.name] = getRetainedSkillPaths(skill.name, oldManifest!, teamConfig, localConfig, baseDir);
      for (const target of installedPaths[skill.name]) installedPhysicalPaths[target] = getSourcePhysicalPin(oldManifest!, baseDir, target);
    }
  }

  // Codex's shared-directory preference may leave a verified duplicate in its
  // configured directory. Validate every optional reconciliation before the
  // resolver is allowed to delete anything; owned paths stay with lifecycle
  // cleanup, and planned destinations (including physical aliases) must survive.
  const reconciliations: Array<{ skill: (typeof skillsToDeploy)[number]; skillsPath: string; target: string; physical: string }> = [];
  for (const { skill, codexSkillsPath, conflictingPath } of plans) {
    if (!codexSkillsPath || conflictingPath) continue;
    const target = path.join(baseDir, codexSkillsPath, skill.name);
    assertWithinRoot(baseDir, target);
    if (!isRelativeDescendant(path.relative(baseDir, target))) throw new Error('Refusing to reconcile a source destination root');
    const physical = await resolveSourcePhysicalPath(target);
    if (!await pathExists(target)) continue;
    const physicalRoot = await resolveSourcePhysicalPath(baseDir);
    if (physical === path.parse(physical).root || physical === physicalRoot || physicalRoot.startsWith(physical + path.sep)) {
      throw new Error('Refusing to reconcile a source destination root or ancestor');
    }
    if (pathsOverlap(physical, physicalRepoDir) || skillsToDeploy.some((input) => pathsOverlap(physical, input.sourcePath))) {
      log.warn(`[source:${source.name}] Keeping Codex duplicate that overlaps the source repository cache: ${target}. Manual review is required.`);
      continue;
    }
    if ([...otherOwners, ...previousTargets, ...plannedTargets].some((owner) => pathsOverlap(owner.path, physical))
      || previousTargets.some((owner) => pathsOverlap(path.resolve(baseDir, owner.relative), target))
      || plannedTargets.some((planned) => pathsOverlap(planned.lexicalPath, target))) continue;
    reconciliations.push({ skill, skillsPath: codexSkillsPath, target, physical });
  }
  if (!options.dryRun) {
    for (const { skill, skillsPath, target, physical } of reconciliations) {
      if (await resolveSourcePhysicalPath(target) !== physical) {
        throw new Error(`Source destination changed before Codex reconciliation: ${target}. Manual review is required.`);
      }
      // The existing resolver alone decides whether both copies and the
      // incoming source match. Different local drafts are never removed.
      await resolveSkillDestination(CODEX_TOOL, skillsPath, baseDir, skill.name, skill.sourcePath);
    }
  }

  for (const { skill, targets, conflictingPath, conflictingRecord } of plans) {
    if (conflictingPath) {
      log.warn(`[source:${source.name}] Skipping "${skill.name}": another source repository owns ${conflictingPath}. Remove that installation before pulling this skill. Ownership record: ${conflictingRecord}`);
      continue;
    }

    if (options.dryRun) {
      const label = oldInstalled.has(skill.name) ? 'update' : 'new';
      log.info(`[dry-run] [source:${source.name}] Would pull ${skill.name} (${label})`);
      deployed.push(skill.name);
      continue;
    }

    // Deploy only after every target passes the ownership check.
    for (const targetDir of targets) {
      await copyDir(skill.sourcePath, targetDir);
      const relativeTarget = path.relative(baseDir, targetDir);
      const skillPaths = installedPaths[skill.name] ??= [];
      if (!skillPaths.includes(relativeTarget)) skillPaths.push(relativeTarget);
      // copyDir may replace a leaf symlink: pin the actual post-copy location.
      installedPhysicalPaths[relativeTarget] = await resolveSourcePhysicalPath(targetDir);
    }

    if (oldInstalled.has(skill.name)) {
      updatedCount++;
    } else {
      newCount++;
    }
    deployed.push(skill.name);
  }

  if (!options.dryRun) {
    // Record only this pull's destinations, plus conflict-retained copies.
    // Release withdrawn skills and old tool paths, even for the same producer;
    // both foreign ownership and newly deployed paths veto physical deletion.
    const currentOwners = Object.values(installedPhysicalPaths).map((physicalPath) => ({
      path: physicalPath, repositoryId,
    }));
    for (const oldSkill of oldInstalled) {
      if (retained.has(oldSkill) || isLocalTeamSkill(oldSkill, localTeamSkills)) continue;
      const previousPaths = oldManifest?.installedPaths?.[oldSkill];
      // Repository replacements with unrecorded claims already stop above.
      await removeSkillFromToolPaths(oldSkill, teamConfig, localConfig, baseDir, [...otherOwners, ...currentOwners], previousPaths, oldManifest?.installedPhysicalPaths);
    }
  }

  // Save manifest
  if (!options.dryRun) {
    await saveSourceManifest(source.name, localConfig, {
      destinationRoot: path.resolve(baseDir),
      teamCheckout: path.resolve(localConfig.repo.localPath),
      repositoryId,
      lastPull: new Date().toISOString(),
      installedSkills: [...deployed, ...retained],
      installedPaths, installedPhysicalPaths,
    });
  }

  if (deployed.length > 0) {
    if (newCount > 0) {
      log.success(`[source:${source.name}] Synced ${deployed.length} skills (${newCount} new, ${updatedCount} updated)`);
    } else {
      log.success(`[source:${source.name}] Synced ${deployed.length} skills (all updated)`);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Explain, at `source add` time, why a source would sync 0 skills. `pull`
 * deploys only skills a source opts into via its teamai.yaml `publicSkills`
 * list, so a missing teamai.yaml or an empty publicSkills list means nothing
 * is shared. Returns the warning lines to print (empty when the source is
 * ready to share). `null` config = no teamai.yaml (or an unparseable one).
 */
export function sourceSyncWarnings(name: string, sourceConfig: TeamaiConfig | null): string[] {
  if (!sourceConfig) {
    return [
      `Source repo "${name}" has no teamai.yaml, so it declares no public skills.`,
      `This source will sync 0 skills until the source team adds a teamai.yaml with a publicSkills list.`,
    ];
  }
  if ((sourceConfig.publicSkills?.length ?? 0) === 0) {
    return [
      `Source repo "${name}" has a teamai.yaml but declares no publicSkills.`,
      `This source will sync 0 skills until the source team adds a publicSkills list to its teamai.yaml.`,
    ];
  }
  return [];
}

/**
 * Derive a source name from a git remote URL.
 * Works for any host (github.com, git.woa.com, gitlab.com, etc.):
 *   - "git@github.com:teamai/skills.git"      → "teamai"
 *   - "https://github.com/teamai/skills.git"  → "teamai"
 *   - "git@git.woa.com:platform/skills.git"   → "platform"
 */
export function deriveSourceName(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  let repoPath = '';

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      repoPath = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  } else {
    const scpMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
    repoPath = scpMatch?.[1] ?? trimmed;
  }

  const segments = repoPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  return segments.length >= 2 ? segments[0] : null;
}

/**
 * Find a skill directory in a repo, handling both flat and namespaced layouts.
 * Returns the full path to the skill directory, or null if not found.
 */
async function findSkillInRepo(skillsDir: string, skillName: string): Promise<string | null> {
  if (!isCanonicalSkillName(skillName)) throw new Error('Invalid source skill name');
  if (!await pathExists(skillsDir)) return null;

  const containsSkill = async (candidate: string): Promise<boolean> => {
    try {
      if ((await fse.lstat(candidate)).isSymbolicLink()) await resolveSourcePhysicalPath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return pathExists(path.join(candidate, 'SKILL.md'));
  };

  // Check flat layout first: skills/<name>/SKILL.md
  const flatPath = path.join(skillsDir, skillName);
  if (await containsSkill(flatPath)) {
    return flatPath;
  }

  // Check namespaced layout: skills/<namespace>/<name>/SKILL.md
  const topDirs = await listDirs(skillsDir);
  for (const ns of topDirs) {
    const nsPath = path.join(skillsDir, ns, skillName);
    if (await containsSkill(nsPath)) {
      return nsPath;
    }
  }

  return null;
}

/**
 * Extract description from a SKILL.md frontmatter.
 */
async function extractSkillDescription(skillDir: string): Promise<string> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  if (!content) return '';

  const { data } = parseFrontmatter(content);
  const desc = data['description'];
  if (!desc) return '';

  return String(desc).replace(/\s+/g, ' ').trim();
}

/**
 * Get the set of skill names that belong to the local team.
 */
async function getLocalTeamSkillNames(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<Set<string>> {
  const handler = getHandler('skills');
  const items = await handler.scanTeamForPull(teamConfig, localConfig);
  const names = new Set(items.map((i) => i.name));
  // Also include builtin skills, legacy ones too: a source-team removal must not
  // delete a legacy tree wholesale, which only pull's ownership rule may prune.
  for (const name of [...BUILTIN_SKILL_NAMES, ...LEGACY_BUILTIN_SKILL_NAMES]) {
    names.add(name);
  }
  return names;
}

/** Team-owned and builtin directories take priority, including nested names. */
function isLocalTeamSkill(name: string, teamSkills: Set<string>): boolean {
  return [...teamSkills].some((teamSkill) =>
    teamSkill === name || name.startsWith(`${teamSkill}/`) || teamSkill.startsWith(`${name}/`));
}

interface SourcePathOwner {
  path: string;
  skillName?: string;
  sourceName?: string;
  manifestPath?: string;
  repositoryId?: string;
}

function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(second + path.sep) || second.startsWith(first + path.sep);
}

/** Old unpinned records authorize only plain paths, never historical symlinks. */
function getSourcePhysicalPin(manifest: Pick<SourceInstallManifest, 'installedPhysicalPaths'>, baseDir: string, relative: string): string {
  if (manifest.installedPhysicalPaths !== undefined) {
    const pin = manifest.installedPhysicalPaths[relative];
    if (!pin) throw new Error(`Missing source physical destination for ${relative}. Manual review is required.`);
    return pin;
  }
  return path.resolve(baseDir, relative);
}

/** Older writers could install a root link without owning its referent. */
async function assertSourceSkillRootIsNotSymlink(target: string): Promise<void> {
  try {
    if ((await fse.lstat(target)).isSymbolicLink()) {
      throw new Error(`Installed source skill root is a symlink: ${target}. Keeping the installation unchanged. Manual review is required; review the link, its referent, and the retained ownership record before retrying.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertSourceDestinationsUnchanged(manifest: SourceInstallManifest, teamConfig: TeamaiConfig, localConfig: LocalConfig, baseDir: string): Promise<void> {
  for (const skill of manifest.installedSkills) {
    for (const relative of getRetainedSkillPaths(skill, manifest, teamConfig, localConfig, baseDir)) {
      const target = path.resolve(baseDir, relative);
      await assertSourceSkillRootIsNotSymlink(target);
      if (await resolveSourcePhysicalPath(target) !== getSourcePhysicalPin(manifest, baseDir, relative)) {
        throw new Error(`Source destination changed or has an unverified symlink: ${target}. Keeping the installation unchanged. Manual review is required; restore the original destination before retrying, or review the retained files and ownership record.`);
      }
    }
  }
}

/** Preserve validated fallback destinations from older scoped records too. */
function getRetainedSkillPaths(skill: string, manifest: SourceInstallManifest, teamConfig: TeamaiConfig, localConfig: LocalConfig, baseDir: string): string[] {
  const paths = manifest.installedPaths?.[skill] ?? Object.values(scopedToolPaths(teamConfig, localConfig))
    .flatMap((toolPath) => toolPath.skills ? [path.join(toolPath.skills, skill)] : []);
  return paths.map((target) => {
    const absolute = path.resolve(baseDir, target);
    assertWithinRoot(baseDir, absolute);
    const relative = path.relative(baseDir, absolute);
    if (!isRelativeDescendant(relative)) throw new Error('Refusing to retain a source destination root');
    return relative;
  });
}

/** A descendant owner cannot account for all bytes retained in its parent. */
function hasNestedSourceOwner(skill: string, manifest: SourceInstallManifest, teamConfig: TeamaiConfig, localConfig: LocalConfig, baseDir: string, otherOwners: SourcePathOwner[]): boolean {
  const paths = manifest.installedPaths?.[skill] ?? Object.values(scopedToolPaths(teamConfig, localConfig))
    .flatMap((toolPath) => toolPath.skills ? [path.join(toolPath.skills, skill)] : []);
  return paths.some((target) => {
    const physical = getSourcePhysicalPin(manifest, baseDir, path.relative(baseDir, path.resolve(baseDir, target)));
    return otherOwners.some((owner) => owner.path.startsWith(physical + path.sep));
  });
}

/** Foreign ownership can veto writes/deletion, never authorize them. */
export async function getSourcePathOwners(currentManifest?: string): Promise<SourcePathOwner[]> {
  // Public push readers must not inspect a source transaction in progress.
  // Mutation callers already hold the lock and pass their current manifest.
  if (!currentManifest && !await acquireLock(sourceLockPath(), { dryRun: true })) {
    throw new Error('Source ownership is being updated; retry skill push after it finishes.');
  }
  const owners: SourcePathOwner[] = [];
  const sourcesDir = path.join(getUserHome(), '.teamai', 'sources');
  for (const name of await listDirs(sourcesDir)) {
    const installationsDir = path.join(getSourceDir(name), 'installations');
    for (const file of await listFiles(installationsDir)) {
      const manifestPath = path.join(installationsDir, file);
      if (manifestPath === currentManifest || !file.endsWith('.json')) continue;
      const manifest = await readSourceManifest(manifestPath);
      if (!manifest || typeof manifest.destinationRoot !== 'string' || !path.isAbsolute(manifest.destinationRoot)) continue;
      const root = path.resolve(manifest.destinationRoot);
      for (const skill of manifest.installedSkills) {
        for (const installedPath of manifest.installedPaths?.[skill] ?? []) {
          if (!installedPath || path.isAbsolute(installedPath)) continue;
          const target = path.resolve(root, installedPath);
          const relative = path.relative(root, target);
          if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
          const physical = getSourcePhysicalPin(manifest, root, relative);
          if (manifest.installedPhysicalPaths === undefined && await resolveSourcePhysicalPath(target) !== physical) {
            throw new Error(`Unverified symlink in source ownership record: ${manifestPath}. Manual review is required.`);
          }
          owners.push({ path: physical, skillName: skill, sourceName: name, manifestPath, repositoryId: manifest.repositoryId });
        }
      }
    }
  }
  return owners;
}

/** Plan deletion only after the last installation releases a recorded path. */
async function getSkillRemovalPaths(skillName: string, teamConfig: TeamaiConfig, localConfig: LocalConfig, baseDir: string, otherOwners: SourcePathOwner[], installedPaths?: string[], installedPhysicalPaths?: Record<string, string>): Promise<string[]> {
  if (!isCanonicalSkillName(skillName)) throw new Error('Invalid source skill name for cleanup');
  const removalPaths: string[] = [];
  const paths = installedPaths ?? Object.values(scopedToolPaths(teamConfig, localConfig))
    .flatMap((toolPath) => toolPath.skills ? [path.join(toolPath.skills, skillName)] : []);
  for (const installedPath of paths) {
    const skillDir = path.resolve(baseDir, installedPath);
    assertWithinRoot(baseDir, skillDir);
    if (!isRelativeDescendant(path.relative(baseDir, skillDir))) throw new Error('Refusing to remove a source destination root');
    await assertSourceSkillRootIsNotSymlink(skillDir);
    const physicalPath = await resolveSourcePhysicalPath(skillDir);
    if (physicalPath !== getSourcePhysicalPin({ installedPhysicalPaths }, baseDir, path.relative(baseDir, skillDir))) {
      throw new Error(`Source destination changed before cleanup: ${skillDir}. Manual review is required.`);
    }
    if (!await pathExists(skillDir)) continue;
    const physicalRoot = await resolveSourcePhysicalPath(baseDir);
    if (physicalPath === path.parse(physicalPath).root || physicalPath === physicalRoot || physicalRoot.startsWith(physicalPath + path.sep)) {
      throw new Error('Refusing to remove a source destination root or ancestor');
    }
    const owner = otherOwners.find((candidate) => pathsOverlap(candidate.path, physicalPath));
    if (owner) {
      if (owner.manifestPath) log.info(`Kept "${skillDir}" because another source installation owns it. Ownership record: ${owner.manifestPath}`);
      continue;
    }
    removalPaths.push(physicalPath);
  }
  return removalPaths;
}

async function removeSkillFromToolPaths(skillName: string, teamConfig: TeamaiConfig, localConfig: LocalConfig, baseDir: string, otherOwners: SourcePathOwner[], installedPaths?: string[], installedPhysicalPaths?: Record<string, string>): Promise<void> {
  for (const target of await getSkillRemovalPaths(skillName, teamConfig, localConfig, baseDir, otherOwners, installedPaths, installedPhysicalPaths)) {
    await remove(target);
  }
}

/**
 * Read source provenance for the current team and resource destination only.
 */
export async function getSourceSkillOrigins(localConfig: LocalConfig): Promise<Map<string, string>> {
  const origins = new Map<string, string>();
  const sourcesDir = path.join(getUserHome(), '.teamai', 'sources');
  if (!await pathExists(sourcesDir)) return origins;

  const sourceDirs = await listDirs(sourcesDir);
  for (const dir of sourceDirs) {
    const manifest = await loadSourceManifest(dir, localConfig);
    if (manifest) {
      for (const skill of manifest.installedSkills) {
        if (!origins.has(skill)) origins.set(skill, dir);
      }
    }
  }

  return origins;
}

/** Name-only quarantine is reserved for records without complete physical ownership. */
export async function getSourcePushQuarantineNames(localConfig: LocalConfig): Promise<Set<string>> {
  const names = new Set<string>();
  const quarantine = (skill: string) => {
    names.add(skill);
    // Recursive push scans identify nested skills by their final component.
    names.add(path.posix.basename(skill));
  };
  const sourcesDir = path.join(getUserHome(), '.teamai', 'sources');
  for (const sourceName of await listDirs(sourcesDir)) {
    const currentPath = getSourceManifestPath(sourceName, localConfig);
    const quarantineScoped = (scoped: SourceInstallManifest | null, manifestPath: string) => {
      let ambiguous = false;
      for (const skill of scoped?.installedSkills ?? []) {
        const paths = scoped?.installedPaths?.[skill];
        const hasPhysicalOwnership = scoped?.destinationRoot && paths?.length
          && paths.every((target) => scoped.installedPhysicalPaths?.[target]);
        if (!hasPhysicalOwnership) {
          quarantine(skill);
          ambiguous = true;
        }
      }
      if (ambiguous) log.warn(`[source:${sourceName}] Scoped tracking has no complete physical ownership. Matching names are excluded from push until you review ${manifestPath}.`);
    };
    // Keep the direct read: a malformed current .json path may be a directory,
    // which file enumeration would omit. Ambiguous foreign claims also apply
    // when another checkout scans the same HOME; modern pins stay path-specific.
    quarantineScoped(await loadSourceManifest(sourceName, localConfig), currentPath);
    const installationsDir = path.join(getSourceDir(sourceName), 'installations');
    for (const file of await listFiles(installationsDir)) {
      const manifestPath = path.join(installationsDir, file);
      if (manifestPath === currentPath || !file.endsWith('.json')) continue;
      quarantineScoped(await readSourceManifest(manifestPath), manifestPath);
    }
    const legacyPath = path.join(getSourceDir(sourceName), 'installed.json');
    const legacy = await readSourceManifest(legacyPath);
    if (!Array.isArray(legacy?.installedSkills) || legacy.installedSkills.length === 0) continue;
    for (const name of legacy.installedSkills) quarantine(name);
    log.warn(`[source:${sourceName}] Legacy tracking has no destination identity. Matching skill names are excluded from push until you review ${legacyPath}.`);
  }
  return names;
}
