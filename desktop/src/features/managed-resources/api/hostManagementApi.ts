import { z } from 'zod'
import { HostCredentialWriteSchema, type HostCredentialWrite, type AccountPasswordWrite } from './credentialMutationContract.js'
import {
  M4_BASE_REVISION_MAX_CHARS,
  M4_EDIT_TEXT_MAX_BYTES,
  M4_FILENAME_MAX_CHARS,
  M4_OWNER_ID_MAX_CHARS,
  M4_OWNER_ID_MIN_CHARS,
  M4_PATH_MAX_CHARS,
  M4_UUID_MESSAGE,
  isM4AbsolutePosixPath,
  isM4BaseRevision,
  isM4EditText,
  isM4FileName,
  isM4Generation,
  isM4Uuid,
} from './m4IpcContract.js'
import type {
  Concept,
  ConversationContextSelectionV2,
  CredentialKind,
  Host,
  HostApplication,
  HostApplicationAccount,
  HostManagementEvent,
  ResourceTag,
  TagNamespace,
} from '../types/resourceTypes.js'

export type CreateApplicationInput = Omit<HostApplication, 'id' | 'accounts'> & {
  accounts: (Omit<HostApplicationAccount, 'id'> & AccountPasswordWrite)[]
}

export type CreateHostInput = Omit<Host, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'applications'> & {
  credential?: HostCredentialWrite
  applications: CreateApplicationInput[]
}

export type UpdateHostInput = {
  credential?: HostCredentialWrite
  id: string
  expectedRevision: number
  changes: Partial<Omit<Host, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'applications'>>
}

export type CreateTagInput = {
  /** Matches the wire schema's optional discriminator; see `SaveTagInputSchema`. */
  mode?: 'create'
  namespace: TagNamespace
  name: string
  colorToken: string | null
}

// `mode` mirrors the discriminated wire schema in `ConceptInputSchema`; the
// renderer always sends it, and it stays optional here so an existing caller
// that omits it is not a type error (the IPC schema is the gate).
export type CreateConceptInput = Omit<Concept, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & {
  mode?: 'create'
}
export type UpdateConceptInput = {
  mode?: 'update'
  id: string
  expectedRevision: number
  changes: Partial<Omit<Concept, 'id' | 'revision' | 'createdAt' | 'updatedAt'>>
}

export type CredentialRecordSummary = {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
  kind: CredentialKind
  label: string
  backend: 'electron-safe-storage-v1'
  hasSecret: true
}

export type CredentialSecretInput =
  | {
      kind: 'ssh-password' | 'application-password' | 'database-password' | 'redis-password'
      password: string
    }
  | {
      kind: 'ssh-private-key' | 'tls-client-key'
      privateKeyPem: string
      passphrase?: string
    }

export type RevealedPasswordCredential = {
  credentialId: string
  kind: 'ssh-password' | 'application-password' | 'database-password' | 'redis-password'
  password: string
  /** Renderer must evict the plaintext from component state at this deadline. */
  expiresAt: number
}

export type CreateCredentialRecordInput = {
  mode?: 'create'
  kind: CredentialKind
  label: string
  secret: CredentialSecretInput
}

export type UpdateCredentialRecordInput = {
  mode?: 'update'
  id: string
  expectedRevision: number
  label?: string
  secret: CredentialSecretInput
}
import {
  AccessUrlSchema,
  AddressSchema,
  IdSchema,
  NameSchema,
  PortSchema,
  RevisionSchema,
  TagNameSchema,
  UsernameSchema,
  ConversationContextSelectionV2Schema,
} from '../types/resourceSchemas.js'

// ==========================================
// Result & Error Types
// ==========================================

export type HostManagementErrorCode =
  | 'UNAVAILABLE'
  | 'UNAUTHORIZED_OWNER'
  | 'INVALID_ARGUMENT'
  | 'RESOURCE_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'RESOURCE_IN_USE'
  | 'DEPENDENCY_CYCLE'
  // M5 context resolution (new codes; `CONTEXT_LIMIT_EXCEEDED` is introduced by
  // this stage — see the M5 report).
  | 'CONCEPT_CYCLE'
  | 'CONTEXT_RESOURCE_MISSING'
  | 'CONTEXT_REVISION_CHANGED'
  | 'CONTEXT_LIMIT_EXCEEDED'
  | 'CONTEXT_STORE_UNAVAILABLE'
  | 'VAULT_UNAVAILABLE'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'HOST_KEY_REQUIRED'
  | 'HOST_KEY_CHANGED'
  | 'AUTH_FAILED'
  | 'CONNECT_TIMEOUT'
  | 'DISCONNECTED'
  | 'SFTP_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'FILE_CHANGED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING'
  | 'UNSAFE_REPLACE_UNSUPPORTED'
  | 'CANCELLED'
  | 'READ_ONLY'
  | 'WRITE_FAILED'
  | 'VALIDATION_FAILED'
  | string

export type HostManagementErrorReference = {
  id: string
  type: string
  name?: string
  description?: string
}

export type HostManagementError = {
  code: HostManagementErrorCode
  messageKey: string
  params?: Record<string, unknown>
  retryable?: boolean
  references?: HostManagementErrorReference[]
  /**
   * Full `dependsOn` cycle path from a rejected concept write, first id repeated
   * at the end (e.g. `[A, B, C, A]`). Optional: every other rejection leaves it
   * unset.
   */
  cycle?: string[]
}

export type HostManagementResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: HostManagementError }

// ==========================================
// IPC Strict Input Schemas
// ==========================================

// Length rule shared with the preload validator (`m4IpcContract.ts`).
export const OwnerIdSchema = z.string().min(M4_OWNER_ID_MIN_CHARS).max(M4_OWNER_ID_MAX_CHARS)
export const OptionalOwnerIdSchema = OwnerIdSchema.optional()

export const BaseIpcPayloadSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
}).strict()

export const GetResourceInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  id: IdSchema,
}).strict()

export const ListHostsInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  query: z.string().max(100).optional(),
  tagId: IdSchema.optional(),
}).strict()

export const ListTagsInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  namespace: z.enum(['host', 'database', 'redis', 'concept']).optional(),
}).strict()

export const CreateApplicationInputSchema = z.object({
  name: z.string().min(1).max(120),
  version: z.string().nullable().optional(),
  installPaths: z.array(z.string().min(1).max(4096)).max(64),
  accessDescription: z.string().max(16 * 1024),
  accessUrls: z.array(AccessUrlSchema).max(64),
  loginUrl: AccessUrlSchema.nullable().optional(),
  accounts: z.array(z.object({
    id: IdSchema.optional(),
    password: z.string().min(1).max(16 * 1024).optional(),
    label: z.string().min(1).max(120),
    username: z.string().min(1).max(64),
    credentialId: IdSchema.nullable().optional(),
  }).strict()).max(64),
  notes: z.string().max(16 * 1024),
}).strict()

export const SaveHostInputSchema = z.union([
  z.object({
    credential: HostCredentialWriteSchema.optional(),
    mode: z.literal('create').optional(),
    ownerId: OptionalOwnerIdSchema,
    name: NameSchema,
    address: AddressSchema,
    port: PortSchema,
    username: UsernameSchema,
    auth: z.object({
      type: z.enum(['password', 'privateKey']),
      credentialId: IdSchema.nullable(),
    }).strict(),
    tagIds: z.array(IdSchema).max(50),
    initialDirectory: z.string().regex(/^\/[^\u0000]*$/).nullable().optional(),
    applications: z.array(CreateApplicationInputSchema).max(100).optional(),
    notes: z.string().max(16 * 1024),
  }).strict(),
  z.object({
    mode: z.literal('update').optional(),
    ownerId: OptionalOwnerIdSchema,
    id: IdSchema,
    expectedRevision: RevisionSchema,
    credential: HostCredentialWriteSchema.optional(),
    changes: z.object({
      name: NameSchema.optional(),
      address: AddressSchema.optional(),
      port: PortSchema.optional(),
      username: UsernameSchema.optional(),
      auth: z.object({
        type: z.enum(['password', 'privateKey']),
        credentialId: IdSchema.nullable(),
      }).strict().optional(),
      tagIds: z.array(IdSchema).max(50).optional(),
      initialDirectory: z.string().regex(/^\/[^\u0000]*$/).nullable().optional(),
      notes: z.string().max(16 * 1024).optional(),
    }).strict(),
  }).strict(),
])

export const DeleteResourceInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  id: IdSchema,
  expectedRevision: RevisionSchema,
}).strict()

export const SaveApplicationInputSchema = z.union([
  z.object({
    mode: z.literal('create').optional(),
    ownerId: OptionalOwnerIdSchema,
    hostId: IdSchema,
    expectedHostRevision: RevisionSchema,
    application: CreateApplicationInputSchema,
  }).strict(),
  z.object({
    mode: z.literal('update').optional(),
    ownerId: OptionalOwnerIdSchema,
    hostId: IdSchema,
    expectedHostRevision: RevisionSchema,
    applicationId: IdSchema,
    changes: z.object({
      name: z.string().min(1).max(120).optional(),
      version: z.string().nullable().optional(),
      installPaths: z.array(z.string().min(1).max(4096)).max(64).optional(),
      accessDescription: z.string().max(16 * 1024).optional(),
      accessUrls: z.array(AccessUrlSchema).max(64).optional(),
      loginUrl: AccessUrlSchema.nullable().optional(),
      accounts: z.array(z.object({
        id: IdSchema.optional(),
        password: z.string().min(1).max(16 * 1024).optional(),
        label: z.string().min(1).max(120),
        username: z.string().min(1).max(64),
        credentialId: IdSchema.nullable().optional(),
      }).strict()).max(64).optional(),
      notes: z.string().max(16 * 1024).optional(),
    }).strict(),
  }).strict(),
])

export const DeleteApplicationInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  hostId: IdSchema,
  expectedHostRevision: RevisionSchema,
  applicationId: IdSchema,
}).strict()

export const SaveTagInputSchema = z.union([
  z.object({
    mode: z.literal('create').optional(),
    ownerId: OptionalOwnerIdSchema,
    namespace: z.enum(['host', 'database', 'redis', 'concept']),
    name: TagNameSchema,
    colorToken: z.string().nullable().optional(),
  }).strict(),
  z.object({
    mode: z.literal('update').optional(),
    ownerId: OptionalOwnerIdSchema,
    id: IdSchema,
    expectedRevision: RevisionSchema,
    name: TagNameSchema,
    colorToken: z.string().nullable().optional(),
  }).strict(),
])

export const SaveCredentialInputSchema = z.union([
  z.object({
    mode: z.literal('create').optional(),
    ownerId: OptionalOwnerIdSchema,
    kind: z.enum([
      'ssh-password',
      'ssh-private-key',
      'application-password',
      'database-password',
      'redis-password',
      'tls-client-key',
    ]),
    label: z.string().min(1).max(120),
    secret: z.discriminatedUnion('kind', [
      z.object({
        kind: z.enum([
          'ssh-password',
          'application-password',
          'database-password',
          'redis-password',
        ]),
        password: z.string().min(1).max(16 * 1024),
      }).strict(),
      z.object({
        kind: z.enum(['ssh-private-key', 'tls-client-key']),
        privateKeyPem: z.string().min(1).max(64 * 1024),
        passphrase: z.string().max(16 * 1024).optional(),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    mode: z.literal('update').optional(),
    ownerId: OptionalOwnerIdSchema,
    id: IdSchema,
    expectedRevision: RevisionSchema,
    label: z.string().min(1).max(120).optional(),
    secret: z.discriminatedUnion('kind', [
      z.object({
        kind: z.enum([
          'ssh-password',
          'application-password',
          'database-password',
          'redis-password',
        ]),
        password: z.string().min(1).max(16 * 1024),
      }).strict(),
      z.object({
        kind: z.enum(['ssh-private-key', 'tls-client-key']),
        privateKeyPem: z.string().min(1).max(64 * 1024),
        passphrase: z.string().max(16 * 1024).optional(),
      }).strict(),
    ]),
  }).strict(),
])

export const TemporaryCredentialInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  hostId: IdSchema,
  secret: z.discriminatedUnion('kind', [
    z.object({
      kind: z.enum([
        'ssh-password',
        'application-password',
        'database-password',
        'redis-password',
      ]),
      password: z.string().min(1).max(16 * 1024),
    }).strict(),
    z.object({
      kind: z.enum(['ssh-private-key', 'tls-client-key']),
      privateKeyPem: z.string().min(1).max(64 * 1024),
      passphrase: z.string().max(16 * 1024).optional(),
    }).strict(),
  ]),
}).strict()

export const RevealCredentialInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  id: IdSchema,
}).strict()

export const ConceptInputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create'),
    ownerId: OptionalOwnerIdSchema,
    title: NameSchema,
    summary: z.string().max(1024),
    bodyMarkdown: z.string().min(1).max(64 * 1024),
    tagIds: z.array(IdSchema).max(50),
    dependsOnIds: z.array(IdSchema).max(100),
    referenceIds: z.array(IdSchema).max(100),
  }).strict(),
  z.object({
    mode: z.literal('update'),
    ownerId: OptionalOwnerIdSchema,
    id: IdSchema,
    expectedRevision: RevisionSchema,
    changes: z.object({
      title: NameSchema.optional(),
      summary: z.string().max(1024).optional(),
      bodyMarkdown: z.string().min(1).max(64 * 1024).optional(),
      tagIds: z.array(IdSchema).max(50).optional(),
      dependsOnIds: z.array(IdSchema).max(100).optional(),
      referenceIds: z.array(IdSchema).max(100).optional(),
    }).strict(),
  }).strict(),
])

export const DeleteConceptInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  id: IdSchema,
  expectedRevision: RevisionSchema,
  removeReferenceEdges: z.boolean().optional(),
}).strict()

export const ContextSelectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  sessionId: z.string().min(1).max(256),
  selection: z.any().optional(),
}).strict()

export const CreateConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  hostId: IdSchema,
  expectedRevision: RevisionSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(300).optional(),
}).strict()

export const StartConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: z.string().uuid(),
}).strict()

export const AnswerHostKeyInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: z.string().uuid(),
  challengeId: z.string().uuid(),
  decision: z.enum(['trust', 'reject']),
}).strict()

export const WriteConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: z.string().uuid(),
  generation: z.number().int().min(1),
  data: z.string(),
  isBase64: z.boolean().optional(),
}).strict()

export const ResizeConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: z.string().uuid(),
  generation: z.number().int().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
}).strict()

export const AckOutputInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: z.string().uuid(),
  generation: z.number().int().min(1),
  bytesAcked: z.number().int().min(0),
}).strict()

export const DisconnectConnectionInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: z.string().uuid(),
}).strict()

// ==========================================
// M4 SFTP / Transfer / Remote Edit (F29-02)
// ==========================================
//
// Every M4 channel uses an explicit strict Zod schema. The renderer's
// `ownerId` is untrusted input: the IPC layer replaces it with the canonical
// owner resolved from `requireMainWindow()` before any service call. Service
// implementations therefore see the canonical owner only.
//
// Identifier rules:
//   - token:     UUID v4 (matches `LocalPathToken.token`)
//   - jobId:     UUID v4 (matches `TransferJobId`)
//   - editId:    UUID v4 (matches `RemoteEditSession.id`)
//   - connectionId: UUID v4 (matches `SshSessionService`)
//   - generation: integer >= 1
//
// Path rules:
//   - absolutePath / remotePath: absolute POSIX, 1..4096 chars, no NUL, no `//`
//   - fileName: 1..255 chars, no path separators, no absolute drive, no NUL,
//     no Windows-forbidden chars, reserved device names, trailing dots/spaces or control chars

// Every rule below is a thin Zod wrapper around the shared predicates in
// `m4IpcContract.ts`, which the preload capability validator calls as well.
// Do not inline an equivalent check here: a rule that exists twice is exactly
// the F30-01/F30-02 drift this file was reworked to remove.
const M4_ABSOLUTE_POSIX_PATH = (max: number) =>
  z
    .string()
    .refine((v) => isM4AbsolutePosixPath(v, max), {
      message: `must be an absolute POSIX path of at most ${max} chars without NUL byte or empty segment`,
    })

// fileName must be a single safe filename segment. We refuse every character
// that could escape the userDataDir/managed-resources/transfers landing dir
// or that is illegal on Windows. Rule shared with the preload validator.
const M4_FILENAME = z
  .string()
  .refine(isM4FileName, {
    message: `must be a single file name of at most ${M4_FILENAME_MAX_CHARS} chars without path separators, drive letters, or Windows-forbidden characters`,
  })

const M4_UUID = z.string().refine(isM4Uuid, { message: M4_UUID_MESSAGE })
const M4_GENERATION = z.number().refine(isM4Generation, { message: 'must be an integer >= 1' })

// `text` cap: 2 MiB **UTF-8 bytes**, computed by the shared `utf8ByteLength`
// helper that the preload validator calls too. The previous version compared
// UTF-16 code units in preload against UTF-8 bytes here, so ~1 MiB of CJK text
// passed preload and was then rejected by this schema.
const M4_EDIT_TEXT = z
  .string()
  .refine(isM4EditText, {
    message: `must be UTF-8 text of at most ${M4_EDIT_TEXT_MAX_BYTES} bytes without NUL`,
  })

export const MintTokenInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  fileName: M4_FILENAME,
}).strict()

export const ResolveTokenInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  token: M4_UUID,
}).strict()

export const RevokeTokenInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  token: M4_UUID,
}).strict()

export const SftpListInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: M4_UUID,
  generation: M4_GENERATION,
  absolutePath: M4_ABSOLUTE_POSIX_PATH(M4_PATH_MAX_CHARS),
}).strict()

export const SftpStatInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: M4_UUID,
  generation: M4_GENERATION,
  absolutePath: M4_ABSOLUTE_POSIX_PATH(M4_PATH_MAX_CHARS),
}).strict()

export const TransferStartDownloadInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  jobId: M4_UUID,
  connectionId: M4_UUID,
  generation: M4_GENERATION,
  remotePath: M4_ABSOLUTE_POSIX_PATH(M4_PATH_MAX_CHARS),
  localToken: M4_UUID,
}).strict()

export const TransferStartUploadInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  jobId: M4_UUID,
  connectionId: M4_UUID,
  generation: M4_GENERATION,
  remotePath: M4_ABSOLUTE_POSIX_PATH(M4_PATH_MAX_CHARS),
  localToken: M4_UUID,
}).strict()

// The native picker grants local folder access. No local path can come from IPC.
export const FolderTransferInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  jobId: M4_UUID,
  connectionId: M4_UUID,
  generation: M4_GENERATION,
  remotePath: M4_ABSOLUTE_POSIX_PATH(M4_PATH_MAX_CHARS),
}).strict()

export const TransferCancelInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  jobId: M4_UUID,
}).strict()

export const TransferGetInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  jobId: M4_UUID,
}).strict()

export const RemoteEditOpenInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  connectionId: M4_UUID,
  generation: M4_GENERATION,
  absolutePath: M4_ABSOLUTE_POSIX_PATH(M4_PATH_MAX_CHARS),
}).strict()

export const RemoteEditSaveInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  editId: M4_UUID,
  baseRevision: z.string().refine(isM4BaseRevision, {
    message: `must be 1..${M4_BASE_REVISION_MAX_CHARS} chars`,
  }),
  text: M4_EDIT_TEXT,
}).strict()

export const RemoteEditCloseInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  editId: M4_UUID,
}).strict()

// ==========================================
// Host API Interface Definitions
// ==========================================

// ==========================================
// M4 SFTP / transfer / remote-edit DTOs
//
// Renderer-safe views of what the M4 IPC handlers return. They deliberately
// omit the internal `ownerId` (bound by the main process from the calling
// window) and every local filesystem path except the transfer token's own
// `absolutePath`, which is the one path the renderer legitimately needs to
// stage an upload source or read a finished download. The Electron service
// types are NOT imported here: the renderer must never depend on main-process
// modules.
// ==========================================

export type ManagedLocalPathPurpose = 'upload-source' | 'download-target' | 'editor-buffer'

export type ManagedLocalPathToken = {
  token: string
  /** Local landing path for the transfer this token was minted for. */
  absolutePath: string
  /** Millisecond timestamp after which the token is rejected. */
  expiresAt: number
  purpose: ManagedLocalPathPurpose
}

/**
 * `resolveLocalToken` only confirms that a token is valid and owned by the
 * caller. It never exposes the path bound to the token.
 */
export type ManagedLocalTokenConfirmation = {
  ok: true
  token: string
}

export type ManagedAck = {
  ok: true
}

export type ManagedSftpEntryType = 'file' | 'directory' | 'symlink' | 'other'

export type ManagedSftpEntry = {
  name: string
  type: ManagedSftpEntryType
  size: number
  mtimeMs: number
  mode: number
  uid: number
  gid: number
  /** Canonical path of this entry on the REMOTE host. */
  absolutePath: string
}

export type ManagedSftpListResult = {
  parent: ManagedSftpEntry
  entries: ManagedSftpEntry[]
}

export type ManagedTransferDirection = 'upload' | 'download'

export type ManagedTransferState =
  | 'pending'
  | 'preparing'
  | 'in_progress'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Failure detail carried by a transfer job; `code` is always present. */
export type ManagedTransferError = {
  code: string
  size?: number
  max?: number
  expected?: string | number
  actual?: string | number
  reason?: string
}

export type ManagedTransferJob = {
  folder?: boolean
  entriesTotal?: number
  entriesCompleted?: number
  id: string
  connectionId: string
  generation: number
  direction: ManagedTransferDirection
  /** Path on the REMOTE host. */
  remotePath: string
  size: number
  transferred: number
  state: ManagedTransferState
  error: ManagedTransferError | null
  checksum: string | null
  startedAt: number
  finishedAt: number | null
}

export type ManagedRemoteEditLineEnding = 'lf' | 'crlf' | 'mixed'

export type ManagedRemoteEditSession = {
  id: string
  connectionId: string
  generation: number
  /** Path of the edited file on the REMOTE host. */
  absolutePath: string
  baseRevision: string
  baseSha256: string
  baseSize: number
  baseMtimeMs: number
  /** Current text of the edit buffer, as held by the main process. */
  text: string
  hasBom: boolean
  dirty: boolean
  openedAt: number
}

export type ManagedRemoteEditMetadata = {
  size: number
  mtimeMs: number
  mode: number
  lineEnding: ManagedRemoteEditLineEnding
  hasBom: boolean
}

export type ManagedRemoteEditSnapshot = {
  edit: ManagedRemoteEditSession
  metadata: ManagedRemoteEditMetadata
}

export type HostManagementCapabilities = {
  vaultAvailable: boolean
  isWindows: boolean
  sftpEditingAvailable: boolean
}

export type HostManagementHostApi = {
  getCapabilities(): Promise<HostManagementResult<HostManagementCapabilities>>
  listHosts(params?: { query?: string; tagId?: string }): Promise<HostManagementResult<Host[]>>
  getHost(id: string): Promise<HostManagementResult<Host>>
  saveHost(input: CreateHostInput | UpdateHostInput): Promise<HostManagementResult<Host>>
  deleteHost(id: string, expectedRevision: number): Promise<HostManagementResult<{ id: string }>>

  saveApplication(input: {
    hostId: string
    expectedHostRevision: number
    application: CreateApplicationInput | (Partial<Omit<HostApplication, 'id' | 'accounts'>> & { id: string; accounts?: (HostApplicationAccount & AccountPasswordWrite)[] })
  }): Promise<HostManagementResult<Host>>
  deleteApplication(input: {
    hostId: string
    expectedHostRevision: number
    applicationId: string
  }): Promise<HostManagementResult<Host>>

  listTags(namespace?: TagNamespace): Promise<HostManagementResult<ResourceTag[]>>
  saveTag(
    input:
      | CreateTagInput
      | { id: string; expectedRevision: number; name: string; colorToken: string | null }
  ): Promise<HostManagementResult<ResourceTag>>
  deleteTag(id: string, expectedRevision: number): Promise<HostManagementResult<{ id: string }>>

  saveCredential(
    input: CreateCredentialRecordInput | UpdateCredentialRecordInput
  ): Promise<HostManagementResult<CredentialRecordSummary>>
  deleteCredential(id: string, expectedRevision: number): Promise<HostManagementResult<{ id: string }>>
  revealCredential(id: string): Promise<HostManagementResult<RevealedPasswordCredential>>
  provideTemporaryCredential(
    hostId: string,
    secret: CredentialSecretInput
  ): Promise<HostManagementResult<{ handle: string }>>

  exportMetadata(): Promise<HostManagementResult<{ filePath: string; count: number } | null>>
  importMetadata(): Promise<HostManagementResult<{ imported: boolean; count: number } | null>>

  // SSH Connection & Terminal (M3)
  createConnection(input: {
    hostId: string
    expectedRevision?: number
    cols?: number
    rows?: number
  }): Promise<HostManagementResult<{ connectionId: string; generation: number }>>
  startConnection(input: {
    connectionId: string
  }): Promise<HostManagementResult<void>>
  answerHostKey(input: {
    connectionId: string
    challengeId: string
    decision: 'trust' | 'reject'
  }): Promise<HostManagementResult<void>>
  writeConnection(input: {
    connectionId: string
    generation: number
    data: string
    isBase64?: boolean
  }): Promise<HostManagementResult<void>>
  resizeConnection(input: {
    connectionId: string
    generation: number
    cols: number
    rows: number
  }): Promise<HostManagementResult<void>>
  ackOutput(input: {
    connectionId: string
    generation: number
    bytesAcked: number
  }): Promise<HostManagementResult<void>>
  disconnect(input: {
    connectionId: string
  }): Promise<HostManagementResult<void>>
  onEvent(handler: (event: HostManagementEvent) => void): Promise<() => void>

  // SFTP browsing, transfers and remote editing (M4). Each method maps onto one
  // existing channel; `ownerId` is never sent from the renderer — the main
  // process binds the canonical owner of the calling window.
  mintUploadToken(fileName: string): Promise<HostManagementResult<ManagedLocalPathToken>>
  mintDownloadToken(fileName: string): Promise<HostManagementResult<ManagedLocalPathToken>>
  resolveLocalToken(token: string): Promise<HostManagementResult<ManagedLocalTokenConfirmation>>
  revokeLocalToken(token: string): Promise<HostManagementResult<ManagedAck>>
  sftpList(
    connectionId: string,
    generation: number,
    absolutePath: string
  ): Promise<HostManagementResult<ManagedSftpListResult>>
  sftpStat(
    connectionId: string,
    generation: number,
    absolutePath: string
  ): Promise<HostManagementResult<ManagedSftpEntry>>
  transferStartDownload(
    jobId: string,
    connectionId: string,
    generation: number,
    remotePath: string,
    localToken: string
  ): Promise<HostManagementResult<ManagedTransferJob>>
  transferStartUpload(
    jobId: string,
    connectionId: string,
    generation: number,
    remotePath: string,
    localToken: string
  ): Promise<HostManagementResult<ManagedTransferJob>>
  transferUploadFolder(input: { jobId: string; connectionId: string; generation: number; remotePath: string }): Promise<HostManagementResult<ManagedTransferJob>>
  transferDownloadFolder(input: { jobId: string; connectionId: string; generation: number; remotePath: string }): Promise<HostManagementResult<ManagedTransferJob>>
  transferCancel(jobId: string): Promise<HostManagementResult<ManagedAck>>
  transferGet(jobId: string): Promise<HostManagementResult<ManagedTransferJob>>
  remoteEditOpen(
    connectionId: string,
    generation: number,
    absolutePath: string
  ): Promise<HostManagementResult<ManagedRemoteEditSnapshot>>
  remoteEditSave(
    editId: string,
    baseRevision: string,
    text: string
  ): Promise<HostManagementResult<ManagedRemoteEditSnapshot>>
  remoteEditClose(editId: string): Promise<HostManagementResult<ManagedAck>>
  hostTools(input: import('./hostToolsApi').HostToolsInput): Promise<HostManagementResult<import('./hostToolsApi').HostToolsResult>>
  applicationOperation(input: import('./applicationOperationsApi').ApplicationOperationInput): Promise<HostManagementResult<import('./applicationOperationsApi').ApplicationOperationResult>>
}

export type ConceptKnowledgeHostApi = {
  listConcepts(): Promise<HostManagementResult<Concept[]>>
  getConcept(id: string): Promise<HostManagementResult<Concept>>
  saveConcept(input: CreateConceptInput | UpdateConceptInput): Promise<HostManagementResult<Concept>>
  deleteConcept(
    id: string,
    expectedRevision: number,
    removeReferenceEdges?: boolean
  ): Promise<HostManagementResult<{ id: string }>>
}

export type ManagedContextPrepareInput = {
  sessionId: string
  requestId: string
  runtimeRevision: number
  content: string
  attachments?: Record<string, unknown>[]
  selection: ConversationContextSelectionV2
}

export type ManagedContextStageRequest = {
  schemaVersion: 1
  sessionId: string
  requestId: string
  runtimeRevision: number
  contentBinding: string
  contextBinding: string
  publicManifest: import('../types/resourceTypes.js').PublicContextManifestV2
  modelContext: string
}

export type ManagedContextTicketRef = {
  ticketId: string
  sidecarInstanceId: string
  expiresAt: string
}

export const PrepareManagedContextInputSchema = z.object({
  ownerId: OptionalOwnerIdSchema,
  sessionId: z.string().min(1).max(256).regex(/^[^\u0000\r\n]+$/u),
  requestId: IdSchema,
  runtimeRevision: z.number().int().min(1),
  content: z.string().max(4 * 1024 * 1024),
  attachments: z.array(z.object({}).passthrough()).max(64).optional(),
  selection: ConversationContextSelectionV2Schema,
}).strict()

export type ConversationContextHostApi = {
  getSelection(sessionId: string): Promise<HostManagementResult<ConversationContextSelectionV2 | null>>
  saveSelection(sessionId: string, selection: ConversationContextSelectionV2): Promise<HostManagementResult<void>>
  deleteSelection(sessionId: string): Promise<HostManagementResult<void>>
  prepareSubmission(input: ManagedContextPrepareInput): Promise<HostManagementResult<ManagedContextTicketRef>>
}
