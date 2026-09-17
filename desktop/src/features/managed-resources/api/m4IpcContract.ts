/**
 * M4 IPC payload contract — the single source of truth for every field rule
 * that is enforced on more than one side of the renderer/preload/main boundary.
 *
 * Imported by BOTH:
 *   - the preload capability validators (`desktop/electron/ipc/capabilities.ts`)
 *   - the main-process strict Zod schemas
 *     (`desktop/src/features/managed-resources/api/hostManagementApi.ts`)
 *
 * so a rule can never be fixed on one layer and forgotten on the other. The
 * F30-01/F30-02 audit findings were exactly that class of bug: the download
 * field set and the 2 MiB edit-text cap existed twice and drifted.
 *
 * This module runs in Node (main + preload bundles) and in the browser
 * (renderer), therefore it MUST NOT touch Node-only globals such as `Buffer`.
 */

/** Maximum UTF-8 byte length accepted for `remoteEditSave.text` (2 MiB). */
export const M4_EDIT_TEXT_MAX_BYTES = 2 * 1024 * 1024

export const M4_OWNER_ID_MIN_CHARS = 1
export const M4_OWNER_ID_MAX_CHARS = 256
export const M4_PATH_MAX_CHARS = 4096
export const M4_FILENAME_MAX_CHARS = 255
export const M4_BASE_REVISION_MAX_CHARS = 256
export const M4_GENERATION_MIN = 1
export const M4_GENERATION_MAX = Number.MAX_SAFE_INTEGER

/**
 * Matches zod's `z.string().uuid()` (zod 4.x): any RFC 4122 version 1-8 with
 * the RFC variant nibble, plus the all-zero "nil" and all-`f` "max" UUIDs.
 *
 * The preload validator used to accept *any* hex-shaped UUID, so
 * `11111111-1111-1111-1111-111111111111` passed preload and was then rejected
 * by the main schema. `m4IpcContract.test.ts` pins this predicate against the
 * real zod schema across every version/variant nibble.
 */
const M4_UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i

export const M4_UUID_MESSAGE = 'must be a UUID v4'

/** UTF-8 byte length of a JS string, without Node's `Buffer`. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
      continue
    }
    if (code < 0x800) {
      bytes += 2
      continue
    }
    // Surrogate pair (astral plane, e.g. emoji) encodes to 4 bytes. An
    // unpaired surrogate encodes to the 3-byte U+FFFD replacement character,
    // which is what an Encoder (and Buffer.byteLength) produces as well.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i += 1
        continue
      }
    }
    bytes += 3
  }
  return bytes
}

export function isM4Uuid(value: unknown): value is string {
  return typeof value === 'string' && M4_UUID_PATTERN.test(value)
}

/** `undefined`, or a 1..256 character string. The main process overwrites it. */
export function isM4OwnerId(value: unknown): boolean {
  if (value === undefined) return true
  return typeof value === 'string'
    && value.length >= M4_OWNER_ID_MIN_CHARS
    && value.length <= M4_OWNER_ID_MAX_CHARS
}

export function isM4Generation(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= M4_GENERATION_MIN
    && value <= M4_GENERATION_MAX
}

export function isM4AbsolutePosixPath(value: unknown, max = M4_PATH_MAX_CHARS): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > max) return false
  if (value.includes('\u0000')) return false
  if (value.includes('//')) return false
  return value.startsWith('/')
}

/**
 * A single safe filename segment. Every character that could escape the
 * userDataDir/managed-resources/transfers landing dir is refused; `:` also
 * covers Windows drive letters, so no separate drive-letter check is needed.
 */
const M4_FORBIDDEN_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/

export function isM4FileName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > M4_FILENAME_MAX_CHARS) return false
  if (M4_FORBIDDEN_FILENAME_CHARS.test(value)) return false
  if (value === '.' || value === '..' || /[. ]$/.test(value)) return false
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return false
  return true
}

export function isM4BaseRevision(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= M4_BASE_REVISION_MAX_CHARS
}

export function isM4EditText(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.includes('\u0000')) return false
  return utf8ByteLength(value) <= M4_EDIT_TEXT_MAX_BYTES
}

/**
 * Exact allowed field set per M4 operation, ignoring fields the caller omitted.
 * The preload `hasOnlyKeys` check reads this table directly and the
 * main-process Zod object shapes are asserted against it, so the two layers
 * cannot advertise different contracts.
 */
export const M4_PAYLOAD_FIELDS = {
  mintToken: ['ownerId', 'fileName'],
  resolveToken: ['ownerId', 'token'],
  revokeToken: ['ownerId', 'token'],
  sftpList: ['ownerId', 'connectionId', 'generation', 'absolutePath'],
  sftpStat: ['ownerId', 'connectionId', 'generation', 'absolutePath'],
  transferStartDownload: ['ownerId', 'jobId', 'connectionId', 'generation', 'remotePath', 'localToken'],
  transferStartUpload: ['ownerId', 'jobId', 'connectionId', 'generation', 'remotePath', 'localToken'],
  folderTransfer: ['ownerId', 'jobId', 'connectionId', 'generation', 'remotePath'],
  transferCancel: ['ownerId', 'jobId'],
  transferGet: ['ownerId', 'jobId'],
  remoteEditOpen: ['ownerId', 'connectionId', 'generation', 'absolutePath'],
  remoteEditSave: ['ownerId', 'editId', 'baseRevision', 'text'],
  remoteEditClose: ['ownerId', 'editId'],
} as const satisfies Record<string, readonly string[]>

export type M4PayloadKind = keyof typeof M4_PAYLOAD_FIELDS
