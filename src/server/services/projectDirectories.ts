import { access, constants, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { expandPath } from '../../utils/path.js'
import { ApiError } from '../middleware/errorHandler.js'
import { findCanonicalGitRootPreservingPathIdentity } from '../../utils/git.js'
import { getProjectMcpDirectoryIdentity, resolveProjectMcpDirectory } from '../../services/mcp/config.js'

export type ProjectAdditionalDirectories = Record<string, string[]>
export type ProjectDirectories = { projectKey: string; mainDirectory: string; additionalDirectories: string[] }

/** Missing legacy fields grant no extra access. Do not resolve against the server cwd. */
export function normalizeAdditionalDirectories(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && path.isAbsolute(item) && !item.includes('\0')))]
    : []
}

export function normalizeProjectAdditionalDirectories(value: unknown): ProjectAdditionalDirectories {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => path.isAbsolute(key) && !key.includes('\0'))
    .map(([key, directories]) => [key, normalizeAdditionalDirectories(directories)]))
}

async function resolveDirectory(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || value.includes('\0')) {
    throw ApiError.badRequest('Choose an absolute directory path on this server')
  }
  try {
    // The existing project boundary verifies native realpath + dev/ino, preserving
    // Unicode path identity and collapsing symlink aliases without changing cwd.
    const directory = await resolveProjectMcpDirectory(value)
    await access(directory, constants.R_OK | constants.X_OK)
    return directory
  } catch {
    throw ApiError.badRequest(`Directory is unavailable or inaccessible: ${value}`)
  }
}

export async function resolveProjectDirectories(workDir: unknown): Promise<Omit<ProjectDirectories, 'additionalDirectories'>> {
  const mainDirectory = await resolveDirectory(workDir)
  const gitRoot = findCanonicalGitRootPreservingPathIdentity(mainDirectory)
  const root = gitRoot ? await resolveProjectMcpDirectory(gitRoot) : mainDirectory
  return { projectKey: getProjectMcpDirectoryIdentity(root), mainDirectory }
}

export async function validateProjectAdditionalDirectories(mainDirectory: string, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) throw ApiError.badRequest('additionalDirectories must be an array of directory paths')
  const directories: string[] = []
  const seen = new Set([getProjectMcpDirectoryIdentity(mainDirectory)])
  for (const item of value) {
    const directory = await resolveDirectory(item)
    const identity = getProjectMcpDirectoryIdentity(directory)
    if (seen.has(identity)) continue
    try {
      // The CLI expands --add-dir paths. Prove that trim/NFC/path expansion
      // still denotes the selected physical directory before granting scope.
      const cliPath = path.resolve(expandPath(directory))
      const [selected, consumed] = await Promise.all([
        stat(directory, { bigint: true }), stat(cliPath, { bigint: true }),
      ])
      if (!selected.isDirectory() || !consumed.isDirectory() || selected.ino === 0n ||
        selected.dev !== consumed.dev || selected.ino !== consumed.ino) throw new Error('identity mismatch')
    } catch {
      throw ApiError.badRequest(`This folder path resolves to a different location or cannot be verified and cannot be added: ${directory}`)
    }
    seen.add(identity)
    directories.push(directory)
  }
  return directories
}
