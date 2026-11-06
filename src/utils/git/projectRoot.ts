type ProjectRootFs = Pick<typeof import('node:fs'), 'statSync' | 'readFileSync' | 'realpathSync'>
type ProjectRootPath = Pick<typeof import('node:path'), 'resolve' | 'dirname' | 'join' | 'basename' | 'sep'>

/** Native path bytes are permission identities. Keep this function self-contained
 * so directory I/O workers can use the same walk without importing runtime state. */
export function findNativeGitRoot(
  startPath: string,
  fs: ProjectRootFs,
  paths: ProjectRootPath,
): { root: string | null; statCount: number } {
  let current = paths.resolve(startPath)
  const root = current.substring(0, current.indexOf(paths.sep) + 1) || paths.sep
  let statCount = 0
  while (current !== root) {
    try {
      statCount++
      const stat = fs.statSync(paths.join(current, '.git'))
      if (stat.isDirectory() || stat.isFile()) return { root: current, statCount }
    } catch {
      // Missing/inaccessible .git entries do not stop the parent walk.
    }
    const parent = paths.dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    statCount++
    const stat = fs.statSync(paths.join(root, '.git'))
    if (stat.isDirectory() || stat.isFile()) return { root, statCount }
  } catch {
    // Check the filesystem root too, retaining the existing walk behavior.
  }
  return { root: null, statCount }
}

/** Authenticate worktree structure and backlink before sharing a main root.
 * All dependencies are explicit because this body also runs in an eval worker. */
export function resolveCanonicalNativeGitRoot(
  gitRoot: string,
  fs: ProjectRootFs,
  paths: ProjectRootPath,
): string {
  try {
    // Regular repositories have a directory here; readFileSync then throws.
    const gitContent = fs.readFileSync(paths.join(gitRoot, '.git'), 'utf-8').trim()
    if (!gitContent.startsWith('gitdir:')) return gitRoot
    const worktreeGitDir = paths.resolve(gitRoot, gitContent.slice('gitdir:'.length).trim())
    const commonDir = paths.resolve(worktreeGitDir, fs.readFileSync(paths.join(worktreeGitDir, 'commondir'), 'utf-8').trim())
    // Both checks are required: attacker-controlled .git/commondir must not
    // borrow another repository's trusted worktree entry or permission grants.
    if (paths.resolve(paths.dirname(worktreeGitDir)) !== paths.join(commonDir, 'worktrees')) return gitRoot
    const backlink = fs.realpathSync(fs.readFileSync(paths.join(worktreeGitDir, 'gitdir'), 'utf-8').trim())
    // Resolve the directory before appending .git. Resolving the .git file
    // itself would follow an attacker-supplied symlink and accept its backlink.
    if (backlink !== paths.join(fs.realpathSync(gitRoot), '.git')) return gitRoot
    // Bare repositories have no containing working directory.
    return paths.basename(commonDir) !== '.git' ? commonDir : paths.dirname(commonDir)
  } catch {
    return gitRoot
  }
}

/** Inline source survives bun --compile without a separate worker asset. */
export function projectRootFunctions(): string {
  return `const findNativeGitRoot = (${findNativeGitRoot.toString()});\nconst resolveCanonicalNativeGitRoot = (${resolveCanonicalNativeGitRoot.toString()});`
}
