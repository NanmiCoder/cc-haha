/**
 * Vault-free output scans for the managed-context manifest path.
 *
 * Secret material is detected with the repository's existing vault-free
 * scanner (`desktop/electron/services/managedResources/importExport/secretDenylist.ts`,
 * `scanForSecrets`) rather than a second denylist: that module is a pure
 * string/object scanner with no Electron, vault or filesystem dependency, so
 * the sidecar can reuse it as is.
 *
 * Absolute-path detection is managed-context specific and lives here: the
 * public manifest must never carry a local absolute path (the renderer-facing
 * manifest has no path field at all, so any hit means someone widened it).
 */

import { scanForSecrets } from '../../../desktop/electron/services/managedResources/importExport/secretDenylist.js'

export type PublicOutputViolationKind = 'secret' | 'absolute-path'

export type PublicOutputViolation = {
  kind: PublicOutputViolationKind
  path: string
  reason: string
}

/**
 * Leading-token anchored so that URLs / protocol-relative references
 * (`https://host/…`) and relative names (`prod/api`) are not misread as local
 * absolute paths. The separator class deliberately excludes `:` and `/`.
 */
const ABSOLUTE_PATH_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /(?:^|[\s"'`(=])(?:[A-Za-z]:[\\/])/,
    reason: 'Windows drive-letter absolute path',
  },
  {
    pattern: /(?:^|[\s"'`(=])\\\\[A-Za-z0-9._$-]+[\\/]/,
    reason: 'Windows UNC absolute path',
  },
  {
    pattern: /(?:^|[\s"'`(=])file:\/\//i,
    reason: 'file:// URL',
  },
  {
    pattern: /(?:^|[\s"'`(=])\/[A-Za-z0-9._$-]+(?:\/|$)/,
    reason: 'POSIX absolute path',
  },
]

/**
 * The shared scanner matches key *suffixes* (password/secret/token/…), so a
 * vault or credential *handle* field — an indirection into the vault rather
 * than the secret itself — would pass it. §7.2 forbids handles in public
 * output too, so they are checked here.
 */
const VAULT_HANDLE_KEY_PATTERN = /(?:handle|vault(?:ref|id|path|key|token))$/

function findVaultHandleKey(value: unknown, path: string): PublicOutputViolation | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findVaultHandleKey(value[i], `${path}[${i}]`)
      if (hit) return hit
    }
    return null
  }
  for (const [key, nested] of Object.entries(value)) {
    if (VAULT_HANDLE_KEY_PATTERN.test(key.toLowerCase().replace(/[-_]/g, ''))) {
      return {
        kind: 'secret',
        path: `${path}.${key}`,
        reason: `Vault/credential handle key detected: ${key}`,
      }
    }
    const hit = findVaultHandleKey(nested, `${path}.${key}`)
    if (hit) return hit
  }
  return null
}

/** First secret-material hit anywhere in `value`, or null. */
export function findSecretMaterial(
  value: unknown,
  label = '$',
): PublicOutputViolation | null {
  const result = scanForSecrets(value)
  if (result.detected) {
    return { kind: 'secret', path: `${label}${result.path.slice(1)}`, reason: result.reason }
  }
  return findVaultHandleKey(value, label)
}

/** First absolute-path hit anywhere in `value`, or null. */
export function findAbsolutePath(
  value: unknown,
  label = '$',
): PublicOutputViolation | null {
  const visit = (entry: unknown, path: string): PublicOutputViolation | null => {
    if (typeof entry === 'string') {
      for (const { pattern, reason } of ABSOLUTE_PATH_PATTERNS) {
        if (pattern.test(entry)) return { kind: 'absolute-path', path, reason }
      }
      return null
    }
    if (Array.isArray(entry)) {
      for (let i = 0; i < entry.length; i += 1) {
        const hit = visit(entry[i], `${path}[${i}]`)
        if (hit) return hit
      }
      return null
    }
    if (entry && typeof entry === 'object') {
      for (const [key, nested] of Object.entries(entry)) {
        const hit = visit(nested, `${path}.${key}`)
        if (hit) return hit
      }
      return null
    }
    return null
  }
  return visit(value, label)
}

/**
 * Scan a value that is about to leave the process as public output (or that
 * was staged as public input): first secret material, then absolute paths.
 */
export function scanPublicOutput(value: unknown, label = '$'): PublicOutputViolation[] {
  const secret = findSecretMaterial(value, label)
  if (secret) return [secret]
  const path = findAbsolutePath(value, label)
  return path ? [path] : []
}
