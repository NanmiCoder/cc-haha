import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const WORKSPACE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/

export class WorkspaceRoot {
  constructor(private readonly rootDir: string) {
    if (!path.isAbsolute(rootDir)) {
      throw new Error(`WorkspaceRoot requires an absolute path, got: ${rootDir}`)
    }
  }

  getRoot(): string {
    return this.rootDir
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true })
  }

  resolveWorkspaceDir(name: string): string {
    if (typeof name !== 'string' || !WORKSPACE_NAME_RE.test(name)) {
      throw new Error(`invalid workspace name: ${JSON.stringify(name)}`)
    }
    const candidate = path.resolve(this.rootDir, name)
    if (!this.isInsideRoot(candidate)) {
      throw new Error(`invalid workspace name: ${name}`)
    }
    return candidate
  }

  async ensureWorkspaceDir(name: string): Promise<string> {
    const dir = this.resolveWorkspaceDir(name)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  isInsideRoot(targetPath: string): boolean {
    const normalizedRoot = path.resolve(this.rootDir)
    const normalizedTarget = path.resolve(targetPath)
    if (normalizedTarget === normalizedRoot) return true
    const rel = path.relative(normalizedRoot, normalizedTarget)
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  }
}
