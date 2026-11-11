import * as path from 'node:path'
import { expandPath, normalizePathForConfigKey } from '../../utils/path.js'
import { getPlatform } from '../../utils/platform.js'
import { ApiError } from '../middleware/errorHandler.js'
import { getProjectMcpDirectoryIdentity } from '../../services/mcp/config.js'
import { ProjectDirectoryIoError, readProjectDirectory } from '../../services/mcp/projectDirectoryIo.js'

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

function nativeDirectory(directory: string): string {
  return getPlatform() === 'windows' ? normalizePathForConfigKey(directory) : directory
}

async function resolveDirectory(value: unknown, kind: 'directory' | 'project' = 'directory'): Promise<{ directory: string; root?: string }> {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || value.includes('\0')) {
    throw ApiError.badRequest('Choose an absolute directory path on this server')
  }
  try {
    // The existing project boundary verifies native realpath + dev/ino, preserving
    // Unicode path identity and collapsing symlink aliases without changing cwd.
    const result = await readProjectDirectory({ kind, path: value })
    return { directory: nativeDirectory(result.directory), ...(result.root ? { root: nativeDirectory(result.root) } : {}) }
  } catch (error) {
    if (error instanceof ProjectDirectoryIoError && error.kind !== 'failed') throw ApiError.badRequest(error.message)
    throw ApiError.badRequest(`Directory is unavailable or inaccessible: ${value}`)
  }
}

export async function resolveProjectDirectories(workDir: unknown): Promise<Omit<ProjectDirectories, 'additionalDirectories'>> {
  const { directory: mainDirectory, root = mainDirectory } = await resolveDirectory(workDir, 'project')
  return { projectKey: getProjectMcpDirectoryIdentity(root), mainDirectory }
}

export async function validateProjectAdditionalDirectories(mainDirectory: string, value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) throw ApiError.badRequest('additionalDirectories must be an array of directory paths')
  const directories: string[] = []
  const seen = new Set([getProjectMcpDirectoryIdentity(mainDirectory)])
  for (const item of value) {
    const { directory } = await resolveDirectory(item)
    const identity = getProjectMcpDirectoryIdentity(directory)
    if (seen.has(identity)) continue
    try {
      // The CLI expands --add-dir paths. Prove that trim/NFC/path expansion
      // still denotes the selected physical directory before granting scope.
      const cliPath = path.resolve(expandPath(directory))
      await readProjectDirectory({ kind: 'cliIdentity', path: directory, cliPath })
    } catch (error) {
      if (error instanceof ProjectDirectoryIoError && error.kind !== 'failed') throw ApiError.badRequest(error.message)
      throw ApiError.badRequest(`This folder path resolves to a different location or cannot be verified and cannot be added: ${directory}`)
    }
    seen.add(identity)
    directories.push(directory)
  }
  return directories
}
