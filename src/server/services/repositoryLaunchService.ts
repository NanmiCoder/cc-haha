import { execFile as execFileCallback } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { ApiError } from '../middleware/errorHandler.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'
import { registerFilesystemAccessRoot } from './filesystemAccessRoots.js'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'
import {
  ensureWorktreesDirExcluded,
  performPostCreationSetup,
  validateWorktreeSlug,
  worktreeBranchName,
} from '../../utils/worktree.js'

const execFile = promisify(execFileCallback)
const GIT_TIMEOUT_MS = 10_000
const WORKTREE_TIMEOUT_MS = 60_000
const MAX_GIT_BUFFER_BYTES = 2_000_000
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

const REPOSITORY_ERROR = {
  workdirMissing: 'WORKDIR_MISSING',
  workdirNotDirectory: 'WORKDIR_NOT_DIRECTORY',
  notGit: 'REPOSITORY_NOT_GIT',
  contextFailed: 'REPOSITORY_CONTEXT_ERROR',
  branchNotFound: 'REPOSITORY_BRANCH_NOT_FOUND',
  dirtyWorktree: 'REPOSITORY_DIRTY_WORKTREE',
  branchCheckedOut: 'REPOSITORY_BRANCH_CHECKED_OUT',
  worktreeCreateFailed: 'REPOSITORY_WORKTREE_CREATE_FAILED',
  switchFailed: 'REPOSITORY_SWITCH_FAILED',
  branchNameInvalid: 'REPOSITORY_BRANCH_NAME_INVALID',
  branchExists: 'REPOSITORY_BRANCH_EXISTS',
  branchCreateFailed: 'REPOSITORY_BRANCH_CREATE_FAILED',
  noCommits: 'REPOSITORY_NO_COMMITS',
} as const

type RepositoryErrorCode = typeof REPOSITORY_ERROR[keyof typeof REPOSITORY_ERROR]

export type RepositoryBranchInfo = {
  name: string
  current: boolean
  local: boolean
  remote: boolean
  remoteRef?: string
  checkedOut: boolean
  worktreePath?: string
  /**
   * Commit the branch points at. Lets a caller tell a switch that would rewrite
   * files from one that only moves the ref — the two are indistinguishable by
   * name, and only the former can be blocked by uncommitted changes.
   */
  commit?: string
}

export type RepositoryWorktreeInfo = {
  path: string
  branch: string | null
  current: boolean
}

export type RepositoryContextResult = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  workDir: string
  repoRoot: string | null
  repoName: string | null
  currentBranch: string | null
  defaultBranch: string | null
  /** Commit `HEAD` resolves to, or null on an unborn branch. */
  headCommit: string | null
  dirty: boolean
  branches: RepositoryBranchInfo[]
  worktrees: RepositoryWorktreeInfo[]
  error?: string
}

export type CreateRepositoryBranchOptions = {
  name: string
  /**
   * Branch the new one starts from, named as it appears in `branches`. Remote
   * names resolve to their tracking ref. Omitted means `HEAD`.
   */
  from?: string | null
}

export type CreateRepositoryBranchResult = {
  branch: string
  baseRef: string
  context: RepositoryContextResult
}

export type CreateSessionRepositoryOptions = {
  branch?: string | null
  worktree?: boolean
}

export type PreparedSessionWorkspace = {
  workDir: string
  repository?: {
    requestedWorkDir: string
    repoRoot: string
    branch: string
    worktree: boolean
    baseRef: string
    worktreePath?: string
    worktreeBranch?: string
    worktreeSlug?: string
  }
}

export type RepositorySessionLaunchState = {
  workDir: string
  repository?: PreparedSessionWorkspace['repository']
  worktreeSession?: { worktreePath?: string | null } | null
  transcriptMessageCount: number
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  return path.resolve(left) === path.resolve(right)
}

export function isMaterializedWorktreeLaunch(
  launchInfo: RepositorySessionLaunchState,
): boolean {
  const worktreePath = launchInfo.repository?.worktreePath
  return (
    samePath(launchInfo.workDir, worktreePath) ||
    samePath(launchInfo.workDir, launchInfo.worktreeSession?.worktreePath) ||
    samePath(worktreePath, launchInfo.worktreeSession?.worktreePath)
  )
}

export function shouldCreateWorktreeForSessionLaunch(
  launchInfo: RepositorySessionLaunchState,
): boolean {
  return !!(
    launchInfo.repository?.worktree &&
    launchInfo.transcriptMessageCount === 0 &&
    !isMaterializedWorktreeLaunch(launchInfo)
  )
}

type GitResult = {
  stdout: string
  stderr: string
  code: number
}

type GitWorktreeRecord = {
  path: string
  branch: string | null
}

type ResolvedBranch = RepositoryBranchInfo & {
  baseRef: string
}

function repositoryBadRequest(code: RepositoryErrorCode, message: string): ApiError {
  return new ApiError(400, message, code)
}

async function runGit(
  cwd: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd,
      timeout,
      maxBuffer: MAX_GIT_BUFFER_BYTES,
      env: { ...process.env, ...GIT_NO_PROMPT_ENV },
    })
    return {
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      code: 0,
    }
  } catch (error) {
    const err = error as {
      stdout?: string | Buffer
      stderr?: string | Buffer
      code?: unknown
      message?: string
    }
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      code: typeof err.code === 'number' ? err.code : 1,
    }
  }
}

async function resolveDirectory(workDir: string): Promise<string> {
  const resolved = path.resolve(normalizeDriveRootPathForPlatform(workDir))
  let realPath: string
  try {
    realPath = normalizeDriveRootPathForPlatform(await fs.realpath(resolved))
  } catch {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.workdirMissing,
      `Working directory does not exist: ${resolved}`,
    )
  }

  const stat = await fs.stat(realPath)
  if (!stat.isDirectory()) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.workdirNotDirectory,
      `Working directory is not a directory: ${realPath}`,
    )
  }

  return realPath
}

async function canonicalizeKnownPath(candidate: string): Promise<string> {
  try {
    return (await fs.realpath(candidate)).normalize('NFC')
  } catch {
    return path.resolve(candidate).normalize('NFC')
  }
}

function isSameOrInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeRemoteBranch(ref: string): { name: string; remoteRef: string } | null {
  if (!ref || ref.endsWith('/HEAD')) return null
  const slash = ref.indexOf('/')
  if (slash < 1) return null
  const remote = ref.slice(0, slash)
  const name = ref.slice(slash + 1)
  if (!name) return null
  return {
    name: remote === 'origin' ? name : ref,
    remoteRef: ref,
  }
}

function parseWorktreeList(stdout: string): GitWorktreeRecord[] {
  const records: GitWorktreeRecord[] = []
  let current: GitWorktreeRecord | null = null

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) records.push(current)
      current = { path: line.slice('worktree '.length).normalize('NFC'), branch: null }
      continue
    }
    if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    }
  }

  if (current) records.push(current)
  return records
}

function branchSort(a: RepositoryBranchInfo, b: RepositoryBranchInfo): number {
  if (a.current !== b.current) return a.current ? -1 : 1
  if (a.local !== b.local) return a.local ? -1 : 1
  return a.name.localeCompare(b.name)
}

function isDesktopWorktreeBranch(name: string): boolean {
  return name.startsWith('worktree-desktop-')
}

/**
 * `for-each-ref` rows as `<short name>\t<commit>`. Git ref names cannot contain
 * control characters, so a tab is a separator no branch name can forge.
 */
function parseRefRows(stdout: string): Array<{ ref: string; commit: string }> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return tab < 0
        ? { ref: line, commit: '' }
        : { ref: line.slice(0, tab), commit: line.slice(tab + 1) }
    })
    .filter((row) => row.ref.length > 0)
}

async function listBranches(repoRoot: string, currentBranch: string | null, worktrees: GitWorktreeRecord[]): Promise<RepositoryBranchInfo[]> {
  const branches = new Map<string, RepositoryBranchInfo>()
  const checkedOutByBranch = new Map<string, string>()
  for (const worktree of worktrees) {
    if (worktree.branch) checkedOutByBranch.set(worktree.branch, worktree.path)
  }

  const localResult = await runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads'])
  if (localResult.code === 0) {
    for (const { ref: name, commit } of parseRefRows(localResult.stdout)) {
      const worktreePath = checkedOutByBranch.get(name)
      branches.set(name, {
        name,
        current: name === currentBranch,
        local: true,
        remote: false,
        checkedOut: !!worktreePath,
        worktreePath,
        commit: commit || undefined,
      })
    }
  }

  const remoteResult = await runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/remotes'])
  if (remoteResult.code === 0) {
    for (const { ref, commit } of parseRefRows(remoteResult.stdout)) {
      const parsed = normalizeRemoteBranch(ref)
      if (!parsed) continue
      const existing = branches.get(parsed.name)
      if (existing) {
        branches.set(parsed.name, {
          ...existing,
          remote: true,
          remoteRef: parsed.remoteRef,
        })
      } else {
        branches.set(parsed.name, {
          name: parsed.name,
          current: parsed.name === currentBranch,
          local: false,
          remote: true,
          remoteRef: parsed.remoteRef,
          checkedOut: false,
          commit: commit || undefined,
        })
      }
    }
  }

  if (currentBranch && !branches.has(currentBranch)) {
    const worktreePath = checkedOutByBranch.get(currentBranch)
    branches.set(currentBranch, {
      name: currentBranch,
      current: true,
      local: true,
      remote: false,
      checkedOut: !!worktreePath,
      worktreePath,
    })
  }

  return [...branches.values()]
    .filter((branch) => !isDesktopWorktreeBranch(branch.name))
    .sort(branchSort)
}

async function getDefaultBranch(repoRoot: string): Promise<string | null> {
  const originHead = await runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead.code === 0) {
    const value = originHead.stdout.trim()
    if (value.startsWith('origin/')) return value.slice('origin/'.length)
    if (value) return value
  }

  const current = await runGit(repoRoot, ['branch', '--show-current'])
  const currentBranch = current.stdout.trim()
  return currentBranch || null
}

export async function getRepositoryContext(workDir: string): Promise<RepositoryContextResult> {
  let absWorkDir: string
  try {
    absWorkDir = await resolveDirectory(workDir)
    registerFilesystemAccessRoot(workDir)
    registerFilesystemAccessRoot(absWorkDir)
  } catch (error) {
    return {
      state: 'missing_workdir',
      workDir: path.resolve(normalizeDriveRootPathForPlatform(workDir)),
      repoRoot: null,
      repoName: null,
      currentBranch: null,
      defaultBranch: null,
      headCommit: null,
      dirty: false,
      branches: [],
      worktrees: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const gitRoot = findGitRoot(absWorkDir)
  if (!gitRoot) {
    return {
      state: 'not_git_repo',
      workDir: absWorkDir,
      repoRoot: null,
      repoName: null,
      currentBranch: null,
      defaultBranch: null,
      headCommit: null,
      dirty: false,
      branches: [],
      worktrees: [],
    }
  }

  try {
    const repoRoot = findCanonicalGitRoot(gitRoot) ?? gitRoot
    registerFilesystemAccessRoot(repoRoot)
    const [branchResult, defaultBranch, statusResult, worktreeResult, headResult] = await Promise.all([
      runGit(gitRoot, ['branch', '--show-current']),
      getDefaultBranch(gitRoot),
      runGit(gitRoot, ['--no-optional-locks', 'status', '--porcelain']),
      runGit(repoRoot, ['worktree', 'list', '--porcelain']),
      runGit(gitRoot, ['rev-parse', 'HEAD']),
    ])

    const currentBranch = branchResult.stdout.trim() || null
    const rawWorktreeRecords = worktreeResult.code === 0 ? parseWorktreeList(worktreeResult.stdout) : []
    const worktreeRecords = await Promise.all(
      rawWorktreeRecords.map(async (worktree) => ({
        ...worktree,
        path: await canonicalizeKnownPath(worktree.path),
      })),
    )
    const worktrees = worktreeRecords.map((worktree) => ({
      path: worktree.path,
      branch: worktree.branch,
      current: isSameOrInsidePath(worktree.path, absWorkDir),
    }))

    return {
      state: 'ok',
      workDir: absWorkDir,
      repoRoot,
      repoName: path.basename(repoRoot),
      currentBranch,
      defaultBranch,
      headCommit: headResult.code === 0 ? headResult.stdout.trim() || null : null,
      dirty: statusResult.code === 0 && statusResult.stdout.trim().length > 0,
      branches: await listBranches(repoRoot, currentBranch, worktreeRecords),
      worktrees,
    }
  } catch (error) {
    return {
      state: 'error',
      workDir: absWorkDir,
      repoRoot: gitRoot,
      repoName: path.basename(gitRoot),
      currentBranch: null,
      defaultBranch: null,
      headCommit: null,
      dirty: false,
      branches: [],
      worktrees: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function resolveBranch(context: RepositoryContextResult, requestedBranch?: string | null): ResolvedBranch | null {
  if (context.state !== 'ok') return null
  const selectedName = requestedBranch || [
    context.currentBranch,
    context.defaultBranch,
    context.branches[0]?.name,
  ].find((name) => name && context.branches.some((candidate) => candidate.name === name))
  if (!selectedName) return null
  const branch = context.branches.find((candidate) => candidate.name === selectedName)
  if (!branch) return null
  return {
    ...branch,
    baseRef: branch.local ? branch.name : branch.remoteRef ?? branch.name,
  }
}

/**
 * Turns a non-`ok` context into the same error the launch paths raise, so a
 * caller sees one vocabulary for "this directory cannot host a Git operation".
 */
function assertUsableContext(
  context: RepositoryContextResult,
): asserts context is RepositoryContextResult & { repoRoot: string } {
  if (context.state === 'ok' && context.repoRoot) return
  if (context.state === 'not_git_repo') {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Selected directory is not a Git repository',
    )
  }
  if (context.state === 'missing_workdir') {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.workdirMissing,
      context.error || 'Working directory does not exist',
    )
  }
  throw repositoryBadRequest(
    REPOSITORY_ERROR.contextFailed,
    context.error || 'Failed to inspect Git repository',
  )
}

const MAX_BRANCH_NAME_LENGTH = 200

/**
 * `git check-ref-format` is the authoritative rule set — reimplementing it here
 * would drift. It is asked about `refs/heads/<name>` rather than given
 * `--branch`, which additionally expands `@{-1}` into whatever branch was
 * checked out last and would let that through as a "valid" name.
 *
 * The leading-dash and length checks come first because they are the two things
 * the ref-format check cannot see: prefixing `refs/heads/` hides a leading dash
 * from it, while `git branch` further down would read the bare name as a flag.
 */
async function assertValidBranchName(cwd: string, name: string): Promise<void> {
  if (!name) {
    throw repositoryBadRequest(REPOSITORY_ERROR.branchNameInvalid, 'Branch name is required')
  }
  if (name.startsWith('-')) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNameInvalid,
      `Invalid branch name: "${name}" must not start with "-"`,
    )
  }
  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNameInvalid,
      `Invalid branch name: must be ${MAX_BRANCH_NAME_LENGTH} characters or fewer (got ${name.length})`,
    )
  }
  // `listBranches` hides this prefix, so such a branch would be created for real
  // and then be invisible in every context that comes back — no row to select,
  // no error, and nothing in the app that can delete it again.
  if (isDesktopWorktreeBranch(name)) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNameInvalid,
      `Invalid branch name: "${name}" uses a prefix reserved for isolated worktrees`,
    )
  }

  const check = await runGit(cwd, ['check-ref-format', `refs/heads/${name}`])
  if (check.code !== 0) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNameInvalid,
      `Invalid branch name: "${name}" is not a valid Git branch name`,
    )
  }
}

/**
 * Creates a local branch and returns the refreshed context.
 *
 * It deliberately does not move `HEAD`. Picking a branch in the launch controls
 * has never checked it out on the spot — the switch (or the isolated worktree)
 * happens when the session starts, which is also where the dirty-tree and
 * already-checked-out guards live. Creating the ref is the one part that has to
 * happen eagerly, because a branch cannot be selected before it exists.
 */
export async function createRepositoryBranch(
  workDir: string,
  options: CreateRepositoryBranchOptions,
): Promise<CreateRepositoryBranchResult> {
  const absWorkDir = await resolveDirectory(workDir)
  const context = await getRepositoryContext(absWorkDir)
  assertUsableContext(context)

  // Everything below runs in the directory the user picked, not `repoRoot`.
  // `findCanonicalGitRoot` resolves a linked worktree to the *main* checkout,
  // where `HEAD` is a different commit entirely — `headCommit` is read from the
  // worktree, so branching off `repoRoot`'s HEAD would contradict what the
  // caller was just told the current commit is.
  const name = options.name.trim()
  await assertValidBranchName(absWorkDir, name)

  if (context.headCommit === null) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.noCommits,
      'This repository has no commits yet, so there is nothing to branch from.',
    )
  }

  // Any name already in the list, local or remote-only. A remote-only match is
  // the dangerous one: the picker shows `hotfix` (tracking `origin/hotfix`), and
  // creating a second local `hotfix` off the selected branch silently wins the
  // name — `switchExistingCheckout` then runs a plain `git switch hotfix`
  // instead of tracking the remote, launching on the wrong content. Selecting
  // the existing row already does the right thing.
  if (context.branches.some((candidate) => candidate.name === name)) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchExists,
      `Branch already exists: ${name}`,
    )
  }

  let baseRef = 'HEAD'
  const from = options.from?.trim()
  if (from) {
    const base = context.branches.find((candidate) => candidate.name === from)
    if (!base) {
      throw repositoryBadRequest(
        REPOSITORY_ERROR.branchNotFound,
        `Branch not found: ${from}`,
      )
    }
    baseRef = base.local ? base.name : base.remoteRef ?? base.name
  }

  // `--` keeps a start point that looks like a flag from being parsed as one.
  // Reachable: a pre-existing `-x` branch is listed like any other and can be
  // chosen as the base. The name itself is already guarded above.
  const result = await runGit(absWorkDir, ['branch', '--', name, baseRef])
  if (result.code !== 0) {
    const stderr = result.stderr.trim()
    // Collisions git catches but the list cannot: a case-fold clash on macOS and
    // Windows (`Main` where `main` exists) is the common one, and it deserves
    // the translated "already exists" rather than raw English `fatal:` text.
    throw repositoryBadRequest(
      /already exists/i.test(stderr) ? REPOSITORY_ERROR.branchExists : REPOSITORY_ERROR.branchCreateFailed,
      `Failed to create branch: ${stderr || result.stdout.trim() || 'git branch failed'}`,
    )
  }

  return {
    branch: name,
    baseRef,
    context: await getRepositoryContext(absWorkDir),
  }
}

function safeWorktreeSlug(branchName: string, sessionId: string): string {
  const safeBranch = branchName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 38) || 'branch'
  const slug = `desktop-${safeBranch}-${sessionId.slice(0, 8)}`
  validateWorktreeSlug(slug)
  return slug
}

async function createDesktopWorktree(
  context: RepositoryContextResult,
  branch: ResolvedBranch,
  sessionId: string,
): Promise<PreparedSessionWorkspace> {
  if (context.state !== 'ok' || !context.repoRoot) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Cannot create a worktree outside a Git repository',
    )
  }

  const slug = safeWorktreeSlug(branch.name, sessionId)
  const worktreePath = path.join(context.repoRoot, '.claude', 'worktrees', slug)
  const branchName = worktreeBranchName(slug)

  await ensureWorktreesDirExcluded(context.repoRoot)
  await fs.mkdir(path.dirname(worktreePath), { recursive: true })
  const result = await runGit(
    context.repoRoot,
    ['worktree', 'add', '-b', branchName, worktreePath, branch.baseRef],
    WORKTREE_TIMEOUT_MS,
  )
  if (result.code !== 0) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.worktreeCreateFailed,
      `Failed to create worktree: ${result.stderr.trim() || result.stdout.trim() || 'git worktree add failed'}`,
    )
  }

  await performPostCreationSetup(context.repoRoot, worktreePath)

  return {
    workDir: worktreePath,
    repository: {
      requestedWorkDir: context.workDir,
      repoRoot: context.repoRoot,
      branch: branch.name,
      worktree: true,
      baseRef: branch.baseRef,
      worktreePath,
      worktreeBranch: branchName,
      worktreeSlug: slug,
    },
  }
}

function planIsolatedWorktree(
  context: RepositoryContextResult,
  branch: ResolvedBranch,
  sessionId: string,
): PreparedSessionWorkspace {
  if (context.state !== 'ok' || !context.repoRoot) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Cannot create a worktree outside a Git repository',
    )
  }

  const slug = safeWorktreeSlug(branch.name, sessionId)
  const worktreePath = path.join(context.repoRoot, '.claude', 'worktrees', slug)
  const branchName = worktreeBranchName(slug)

  return {
    workDir: context.workDir,
    repository: {
      requestedWorkDir: context.workDir,
      repoRoot: context.repoRoot,
      branch: branch.name,
      worktree: true,
      baseRef: branch.baseRef,
      worktreePath,
      worktreeBranch: branchName,
      worktreeSlug: slug,
    },
  }
}

async function switchExistingCheckout(
  context: RepositoryContextResult,
  branch: ResolvedBranch,
): Promise<PreparedSessionWorkspace> {
  if (context.state !== 'ok' || !context.repoRoot) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.notGit,
      'Cannot switch branches outside a Git repository',
    )
  }

  if (branch.name === context.currentBranch) {
    return {
      workDir: context.workDir,
      repository: {
        requestedWorkDir: context.workDir,
        repoRoot: context.repoRoot,
        branch: branch.name,
        worktree: false,
        baseRef: branch.baseRef,
      },
    }
  }

  if (branch.checkedOut) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchCheckedOut,
      `Branch "${branch.name}" is already checked out in another worktree.`,
    )
  }

  const args = branch.local
    ? ['switch', branch.name]
    : ['switch', '--track', '-c', branch.name, branch.baseRef]
  const result = await runGit(context.workDir, args)
  if (result.code !== 0) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.switchFailed,
      `Failed to switch branch: ${result.stderr.trim() || result.stdout.trim() || 'git switch failed'}`,
    )
  }

  return {
    workDir: context.workDir,
    repository: {
      requestedWorkDir: context.workDir,
      repoRoot: context.repoRoot,
      branch: branch.name,
      worktree: false,
      baseRef: branch.baseRef,
    },
  }
}

export async function prepareSessionWorkspace(
  workDir: string,
  options: CreateSessionRepositoryOptions | undefined,
  sessionId: string,
): Promise<PreparedSessionWorkspace> {
  const absWorkDir = await resolveDirectory(workDir)

  if (!options?.branch && !options?.worktree) {
    return { workDir: absWorkDir }
  }

  const context = await getRepositoryContext(absWorkDir)
  assertUsableContext(context)

  const branch = resolveBranch(context, options.branch)
  if (!branch) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNotFound,
      `Branch not found: ${options.branch || 'default branch'}`,
    )
  }

  return options.worktree
    ? createDesktopWorktree(context, branch, sessionId)
    : switchExistingCheckout(context, branch)
}

export async function resolveSessionWorkspaceLaunch(
  workDir: string,
  options: CreateSessionRepositoryOptions | undefined,
  sessionId: string,
): Promise<PreparedSessionWorkspace> {
  const absWorkDir = await resolveDirectory(workDir)

  if (!options?.branch && !options?.worktree) {
    return { workDir: absWorkDir }
  }

  const context = await getRepositoryContext(absWorkDir)
  assertUsableContext(context)

  const branch = resolveBranch(context, options.branch)
  if (!branch) {
    throw repositoryBadRequest(
      REPOSITORY_ERROR.branchNotFound,
      `Branch not found: ${options.branch || 'default branch'}`,
    )
  }

  return options.worktree
    ? planIsolatedWorktree(context, branch, sessionId)
    : {
        workDir: context.workDir,
        repository: {
          requestedWorkDir: context.workDir,
          repoRoot: context.repoRoot,
          branch: branch.name,
          worktree: false,
          baseRef: branch.baseRef,
        },
      }
}
