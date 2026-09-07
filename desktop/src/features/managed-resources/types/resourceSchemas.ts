/**
 * 资源 DTO、selection v2、manifest v2 的 Zod 校验。
 *
 * 形状与 `resourceTypes.ts` 的领域类型一一对应；持久化对象
 * （ResourceDocument / ConversationContextSelectionV2 /
 * PublicContextManifestV2）顶层 `.passthrough()`，允许未来扩展字段；
 * 但已知的跨类型字段或秘密字段必须被拒绝；安全未知字段继续透传。
 *
 * 依赖方向：static import sharedSchemas + dataConnectionSchemas；
 * 禁止 dynamic import、Promise、可变缓存、`z.unknown()` 回退
 * 与 `z.ZodTypeAny`。
 */

import { z } from 'zod'
import {
  AccessUrlSchema,
  AddressSchema,
  BodyMarkdownSchema,
  CanonicalBase64Schema,
  IdSchema,
  Iso8601UtcSchema,
  NameSchema,
  PortSchema,
  PublicSecretFieldError,
  rejectPublicSecretFields,
  RevisionSchema,
  TagNameSchema,
  UniqueIdArraySchema,
  UniqueIdObjectArraySchema,
  UsernameSchema,
} from './sharedSchemas.js'
import {
  DataConnectionSchema,
  PublicDatabaseSummarySchema,
  PublicRedisSummarySchema,
} from './dataConnectionSchemas.js'

// re-export 共享原语，保持 resourceSchemas.ts 作为下游的唯一入口；
// 调用方不必同时 import sharedSchemas。
export {
  AccessUrlSchema,
  AddressSchema,
  BodyMarkdownSchema,
  CanonicalBase64Schema,
  IdSchema,
  Iso8601UtcSchema,
  NameSchema,
  PortSchema,
  RevisionSchema,
  TagNameSchema,
  UniqueIdArraySchema,
  UniqueIdObjectArraySchema,
  UsernameSchema,
  PublicSecretFieldError,
  rejectPublicSecretFields,
  ConceptBodyMarkdownSchema,
} from './sharedSchemas.js'
export {
  DataConnectionSchema,
  PublicDatabaseSummarySchema,
  PublicRedisSummarySchema,
} from './dataConnectionSchemas.js'

// ---------- ResourceTag ----------

export const TagNamespaceSchema = z.enum(['host', 'database', 'redis', 'concept'])

export const ResourceTagSchema = z
  .object({
    id: IdSchema,
    revision: RevisionSchema,
    createdAt: Iso8601UtcSchema,
    updatedAt: Iso8601UtcSchema,
    namespace: TagNamespaceSchema,
    name: TagNameSchema,
    normalizedName: z.string().min(1).max(80),
    colorToken: z.string().nullable(),
  })
  .passthrough()

// ---------- Host ----------

export const HostAuthTypeSchema = z.enum(['password', 'privateKey'])

export const HostAuthSchema = z
  .object({
    type: HostAuthTypeSchema,
    credentialId: IdSchema.nullable(),
  })
  .passthrough()

export const HostApplicationAccountSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1).max(120),
    username: z.string().min(1).max(64),
    credentialId: IdSchema.nullable(),
  })
  .passthrough()

export const HostApplicationSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(120),
    version: z.string().nullable(),
    installPaths: z.array(z.string().min(1).max(4096)).max(64),
    accessDescription: z.string().max(16 * 1024),
    accessUrls: z.array(AccessUrlSchema).max(64),
    loginUrl: AccessUrlSchema.nullable(),
    accounts: UniqueIdObjectArraySchema(HostApplicationAccountSchema, 64),
    notes: z.string().max(16 * 1024),
  })
  .passthrough()

export const HostSchema = z
  .object({
    id: IdSchema,
    revision: RevisionSchema,
    createdAt: Iso8601UtcSchema,
    updatedAt: Iso8601UtcSchema,
    name: NameSchema,
    address: AddressSchema,
    port: PortSchema,
    username: UsernameSchema,
    auth: HostAuthSchema,
    tagIds: UniqueIdArraySchema.max(50),
    initialDirectory: z
      .string()
      .regex(/^\/[^\u0000]*$/)
      .nullable(),
    applications: UniqueIdObjectArraySchema(HostApplicationSchema, 100),
    notes: z.string().max(16 * 1024),
  })
  .passthrough()

// ---------- Concept ----------

export const ConceptSchema = z
  .object({
    id: IdSchema,
    revision: RevisionSchema,
    createdAt: Iso8601UtcSchema,
    updatedAt: Iso8601UtcSchema,
    title: NameSchema,
    summary: z.string().max(1024),
    bodyMarkdown: BodyMarkdownSchema,
    tagIds: UniqueIdArraySchema.max(50),
    dependsOnIds: UniqueIdArraySchema.max(100),
    referenceIds: UniqueIdArraySchema.max(100),
  })
  .passthrough()

// ---------- CredentialRecord ----------

export const CredentialKindSchema = z.enum([
  'ssh-password',
  'ssh-private-key',
  'application-password',
  'database-password',
  'redis-password',
  'tls-client-key',
])

export const CredentialBackendSchema = z.literal('electron-safe-storage-v1')

export const CredentialRecordSchema = z
  .object({
    id: IdSchema,
    revision: RevisionSchema,
    createdAt: Iso8601UtcSchema,
    updatedAt: Iso8601UtcSchema,
    kind: CredentialKindSchema,
    label: z.string().min(1).max(120),
    backend: CredentialBackendSchema,
    ciphertextBase64: CanonicalBase64Schema,
  })
  .passthrough()

// ---------- KnownHostKey ----------

export const KnownHostKeySchema = z
  .object({
    endpoint: z.string().min(1).max(512),
    algorithm: z.string().min(1).max(64),
    sha256: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}$/, 'sha256 must be 43-character unpadded Base64'),
    trustedAt: Iso8601UtcSchema,
  })
  .passthrough()

// ---------- ResourceDocument ----------

export const ResourceDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: RevisionSchema,
    hosts: UniqueIdObjectArraySchema(HostSchema, 10_000),
    tags: UniqueIdObjectArraySchema(ResourceTagSchema, 10_000),
    concepts: UniqueIdObjectArraySchema(ConceptSchema, 10_000),
    dataConnections: UniqueIdObjectArraySchema(DataConnectionSchema, 10_000),
    credentials: UniqueIdObjectArraySchema(CredentialRecordSchema, 10_000),
    knownHostKeys: z.array(KnownHostKeySchema),
  })
  .passthrough()

// ---------- Selection v2 ----------

export const EntityVersionRefSchema = z
  .object({
    id: IdSchema,
    revision: RevisionSchema,
  })
  .passthrough()

export const EntityVersionRefArraySchema = UniqueIdObjectArraySchema(
  EntityVersionRefSchema,
  100,
)

function uniqueRefs(refs: { id: string }[], ctx: z.core.$RefinementCtx): void {
  const seen = new Set<string>()
  for (const [i, r] of refs.entries()) {
    if (seen.has(r.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [i],
        message: 'duplicate ref id within the same collection',
      })
      return
    }
    seen.add(r.id)
  }
}

function uniqueSourceTags(
  tags: { namespace: string; id: string }[],
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>()
  for (const [i, t] of tags.entries()) {
    const key = `${t.namespace}:${t.id}`
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [i],
        message: 'duplicate sourceTag for the same namespace and tag id',
      })
      return
    }
    seen.add(key)
  }
}

export const SourceTagSchema = z
  .object({
    namespace: TagNamespaceSchema,
    id: IdSchema,
    labelAtSelection: z.string().min(1).max(120),
    memberIds: UniqueIdArraySchema.max(500),
  })
  .passthrough()

export const ConversationContextSelectionV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    hostRefs: z.array(EntityVersionRefSchema).max(20).superRefine(uniqueRefs),
    conceptRootRefs: z.array(EntityVersionRefSchema).max(100).superRefine(uniqueRefs),
    dependencyRefs: z.array(EntityVersionRefSchema).max(100).superRefine(uniqueRefs),
    databaseRefs: z.array(EntityVersionRefSchema).max(20).superRefine(uniqueRefs),
    redisRefs: z.array(EntityVersionRefSchema).max(20).superRefine(uniqueRefs),
    credentialRefs: z.array(EntityVersionRefSchema).max(40).superRefine(uniqueRefs),
    sourceTags: z
      .array(SourceTagSchema)
      .max(200)
      .superRefine(uniqueSourceTags),
    directHostIds: UniqueIdArraySchema.max(20),
    directConceptIds: UniqueIdArraySchema.max(100),
    directDatabaseIds: UniqueIdArraySchema.max(20),
    directRedisIds: UniqueIdArraySchema.max(20),
    includePasswords: z.boolean(),
  })
  .passthrough()
  .superRefine((sel, ctx) => {
    if (sel.includePasswords === false && sel.credentialRefs.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentialRefs'],
        message: 'includePasswords=false requires credentialRefs to be empty',
      })
    }
  })

// ---------- Public manifest v2 ----------

export const PublicContextManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    requestId: IdSchema,
    selection: ConversationContextSelectionV2Schema,
    hosts: UniqueIdObjectArraySchema(
      z
        .object({
          id: IdSchema,
          name: NameSchema,
          address: AddressSchema,
          port: PortSchema,
        })
        .passthrough(),
      20,
    ),
    concepts: UniqueIdObjectArraySchema(
      z
        .object({
          id: IdSchema,
          title: NameSchema,
          includedAs: z.enum(['root', 'dependency']),
        })
        .passthrough(),
      100,
    ),
    // 关键：使用从 dataConnectionSchemas 静态导入的 PublicDatabaseSummarySchema
    // 与 PublicRedisSummarySchema，跨类型字段拒绝逻辑直接生效。
    databases: UniqueIdObjectArraySchema(PublicDatabaseSummarySchema, 20),
    redisConnections: UniqueIdObjectArraySchema(PublicRedisSummarySchema, 20),
    resolvedAt: Iso8601UtcSchema,
    containsSecrets: z.boolean(),
    secretFieldCount: z.number().int().min(0),
    estimatedTokens: z.number().int().min(0),
  })
  .passthrough()
  .superRefine((manifest, ctx) => {
    const incl = manifest.selection.includePasswords
    if (!manifest.containsSecrets && manifest.secretFieldCount !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['secretFieldCount'],
        message: 'containsSecrets=false requires secretFieldCount=0',
      })
    }
    if (manifest.containsSecrets) {
      if (manifest.secretFieldCount <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['secretFieldCount'],
          message: 'containsSecrets=true requires secretFieldCount>0',
        })
      }
      if (!incl) {
        ctx.addIssue({
          code: 'custom',
          path: ['selection', 'includePasswords'],
          message: 'containsSecrets=true requires selection.includePasswords=true',
        })
      }
    }
    if (!incl && manifest.secretFieldCount !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['secretFieldCount'],
        message: 'selection.includePasswords=false requires secretFieldCount=0',
      })
    }
    try {
      rejectPublicSecretFields(manifest, [])
    } catch (e) {
      if (e instanceof PublicSecretFieldError) {
        ctx.addIssue({ code: 'custom', message: e.message })
      } else {
        throw e
      }
    }
  })
