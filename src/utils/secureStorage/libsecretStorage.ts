import { execFile } from 'child_process'
import { promisify } from 'util'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { SecureStorage, SecureStorageData } from './types.js'

const execFileAsync = promisify(execFile)

/**
 * libsecret / secret-service storage for Linux.
 *
 * Uses the system's `secret-tool` binary (part of libsecret-tools on Debian/Ubuntu,
 * libsecret on Fedora/Arch) when available. Falls back to plain-text storage when the
 * secret-service daemon isn't running (typical in headless / SSH sessions).
 *
 * The stored value is a JSON object whose shape matches SecureStorageData.
 * We wrap errors so callers can opt-in to the fallback.
 */

export function secretToolAvailableSync(): boolean {
  try {
    require('child_process')
      .execFileSync('secret-tool', ['--help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export async function secretToolAvailable(): Promise<boolean> {
  try {
    await execFileAsync('secret-tool', ['--help'])
    return true
  } catch {
    return false
  }
}

function baseAttributes(): string[] {
  return [
    'application',
    'claude-code',
    'schema',
    'com.anthropic.claude-code.credentials',
  ]
}

function getLabel(): string {
  return `Claude Code credentials (${getClaudeConfigHomeDir()})`
}

export const libsecretStorage: SecureStorage = {
  name: 'libsecret',
  read(): SecureStorageData | null {
    try {
      const stdout = require('child_process').execFileSync(
        'secret-tool',
        ['lookup', ...baseAttributes()],
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
      )
      return stdout ? (JSON.parse(stdout) as SecureStorageData) : null
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    try {
      const { stdout } = await execFileAsync('secret-tool', [
        'lookup',
        ...baseAttributes(),
      ])
      return stdout ? (JSON.parse(stdout) as SecureStorageData) : null
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    const serialized = JSON.stringify(data)
    try {
      const child = require('child_process').spawnSync(
        'secret-tool',
        ['store', '--label', getLabel(), ...baseAttributes()],
        { input: serialized, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' },
      )
      if (child.status !== 0) {
        return { success: false, warning: `secret-tool store failed: ${child.stderr?.slice?.(0, 120) || 'unknown'}` }
      }
      return { success: true }
    } catch (err) {
      return { success: false, warning: err instanceof Error ? err.message : String(err) }
    }
  },
  delete(): boolean {
    try {
      const child = require('child_process').spawnSync(
        'secret-tool',
        ['clear', ...baseAttributes()],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return child.status === 0
    } catch {
      return false
    }
  },
}
