import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export class RouterError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

export function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new RouterError(code, message)
}

function runGit(cwd: string, args: string[]) {
  // Metadata resolution must not inherit GIT_DIR/GIT_WORK_TREE overrides or
  // read the operator's global Git config (also keeps fixtures deterministic).
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  } })
}

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args)
  ensure(result.status === 0, 'git_metadata', `Cannot read Git metadata: ${result.stderr?.trim()}`)
  return result.stdout
}

export type Layout = ReturnType<typeof resolveLayout>

/** NUL porcelain preserves spaces, newlines and non-ASCII checkout paths. */
export function resolveLayout(cwd: string) {
  const commonDir = realpathSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\r?\n$/, ''))
  const entries = git(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')
  // Git lists the primary first. Verify its identity rather than deriving it
  // from commonDir's parent (which breaks --separate-git-dir and submodules).
  const first = entries[0]?.split('\0')
  const pathRecord = first?.find((record) => record.startsWith('worktree '))
  ensure(pathRecord && !first?.includes('bare'), 'primary_missing', 'Primary checkout is unavailable or bare')
  const locator = join(commonDir, 'info', 'issue-router.config')
  const registered = existsSync(locator) ? git(cwd, ['config', '--file', locator, '--null', '--get', 'issueRouter.primary']).replace(/\0$/, '') : null
  let candidate = registered ?? pathRecord.slice('worktree '.length)
  // Git init --separate-git-dir without core.worktree reports the git-dir as
  // the main checkout in worktree list. Only its actual primary can bootstrap
  // the locator; a linked checkout cannot infer the missing reverse pointer.
  if (!registered && realpathSync(candidate) === commonDir) {
    ensure(realpathSync(git(cwd, ['rev-parse', '--absolute-git-dir']).replace(/\r?\n$/, '')) === commonDir &&
      git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true',
    'primary_missing', 'Separate Git directory has no primary locator; run init or install-exclude from its primary checkout')
    candidate = git(cwd, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '')
  }
  const primary = realpathSync(candidate)
  ensure(git(primary, ['rev-parse', '--is-inside-work-tree']).trim() === 'true', 'primary_missing', 'Primary path is not a working checkout')
  ensure(realpathSync(git(primary, ['rev-parse', '--absolute-git-dir']).replace(/\r?\n$/, '')) === commonDir,
    'primary_identity', 'Primary checkout does not own the shared Git directory')
  ensure(realpathSync(git(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir']).replace(/\r?\n$/, '')) === commonDir,
    'primary_identity', 'Primary checkout belongs to another repository')
  const stateRoot = join(primary, '.issue-router')
  return { primary, commonDir, stateRoot, database: join(stateRoot, 'state.sqlite3') }
}

export function requireIgnored(layout: Layout) {
  const result = runGit(layout.primary, ['check-ignore', '--no-index', '-q', '.issue-router/'])
  ensure(result.status === 0, 'state_not_ignored', 'State must be ignored in the primary checkout; run install-exclude explicitly first')
}

export function registerLayout(layout: Layout) {
  mkdirSync(join(layout.commonDir, 'info'), { recursive: true })
  git(layout.primary, ['config', '--file', join(layout.commonDir, 'info', 'issue-router.config'), 'issueRouter.primary', layout.primary])
}

/** Explicit bootstrap only; preserves existing shared excludes byte for byte. */
export function installExclude(layout: Layout) {
  const info = join(layout.commonDir, 'info')
  mkdirSync(info, { recursive: true })
  const path = join(info, 'exclude')
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (!previous.split(/\r?\n/).includes('/.issue-router/')) {
    appendFileSync(path, `${previous && !previous.endsWith('\n') ? '\n' : ''}/.issue-router/\n`)
  }
  requireIgnored(layout)
  registerLayout(layout)
  return { path }
}
