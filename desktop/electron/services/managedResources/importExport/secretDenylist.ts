/**
 * Secret denylist and credential leakage detector.
 * Scans objects recursively to ensure no passwords, private keys, tokens,
 * ciphertexts, or sensitive fields are ever imported or exported.
 */

const FORBIDDEN_KEY_NAMES = new Set([
  'password',
  'privatekey',
  'privatekeypem',
  'passphrase',
  'secret',
  'token',
  'ciphertext',
  'encrypteddata',
  'iv',
  'salt',
  'credential',
  'credentials',
  'credentialid',
  'authdata',
  'clientsecret',
  'apikey',
])

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i

function containsUrlUserinfo(str: string): boolean {
  const match = str.match(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^\/\s?#]+)@/i)
  if (match && match[1]) {
    return true
  }
  try {
    const parsed = new URL(str)
    if (parsed.username || parsed.password) {
      return true
    }
  } catch {
    // not a standard URL format, ignore parse error
  }
  return false
}

export type SecretDetectionResult =
  | { detected: false }
  | { detected: true; path: string; reason: string }

export function scanForSecrets(value: unknown, currentPath = '$'): SecretDetectionResult {
  if (value === null || value === undefined) {
    return { detected: false }
  }

  if (typeof value === 'string') {
    if (PRIVATE_KEY_PATTERN.test(value)) {
      return { detected: true, path: currentPath, reason: 'Private key PEM pattern detected' }
    }
    if (containsUrlUserinfo(value)) {
      return { detected: true, path: currentPath, reason: 'URL userinfo detected in string' }
    }
    return { detected: false }
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const res = scanForSecrets(value[i], `${currentPath}[${i}]`)
      if (res.detected) return res
    }
    return { detected: false }
  }

  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const normalizedKey = k.toLowerCase().replace(/[-_]/g, '')

      // Only the actual public tag field may use this otherwise forbidden
      // suffix. Always scan even its string value; never skip an object subtree.
      if (k === 'colorToken' && /^\$\.tags\[\d+\]$/.test(currentPath) && (v === null || typeof v === 'string')) {
        const checked = scanForSecrets(v, `${currentPath}.${k}`)
        if (checked.detected) return checked
        continue
      }

      // Exception: credentialId is allowed ONLY if its value is explicitly null
      if (normalizedKey === 'credentialid' && v === null) {
        continue
      }

      // Exception: empty credentials array is allowed
      if (normalizedKey === 'credentials' && Array.isArray(v) && v.length === 0) {
        continue
      }

      const isForbiddenKey =
        FORBIDDEN_KEY_NAMES.has(normalizedKey) ||
        normalizedKey.endsWith('password') ||
        normalizedKey.endsWith('passphrase') ||
        normalizedKey.endsWith('privatekey') ||
        normalizedKey.endsWith('secret') ||
        normalizedKey.endsWith('ciphertext') ||
        normalizedKey.endsWith('authdata') ||
        normalizedKey.endsWith('token')

      if (isForbiddenKey) {
        return {
          detected: true,
          path: `${currentPath}.${k}`,
          reason: `Forbidden sensitive key name detected: ${k}`,
        }
      }

      const res = scanForSecrets(v, `${currentPath}.${k}`)
      if (res.detected) return res
    }
    return { detected: false }
  }

  return { detected: false }
}
