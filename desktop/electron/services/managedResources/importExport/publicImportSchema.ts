import { z } from 'zod'
import {
  ConceptSchema, HostSchema, HostAuthSchema, HostApplicationSchema,
  HostApplicationAccountSchema, KnownHostKeySchema, ResourceTagSchema,
  UniqueIdObjectArraySchema,
} from '../../../../src/features/managed-resources/types/resourceSchemas.js'
import {
  ConnectionTlsSchema, SqlConnectionSchema, RedisConnectionSchema,
} from '../../../../src/features/managed-resources/types/dataConnectionSchemas.js'

// External import is deliberately stricter than the forward-compatible disk
// schema. Do not remove unknown fields from existing resource documents.
const auth = HostAuthSchema.extend({ credentialId: z.null() }).strict()
const account = HostApplicationAccountSchema.extend({ credentialId: z.null() }).strict()
const application = HostApplicationSchema.extend({
  accounts: UniqueIdObjectArraySchema(account, 64),
}).strict()
const host = HostSchema.extend({
  auth,
  applications: UniqueIdObjectArraySchema(application, 100),
}).strict()
const tls = ConnectionTlsSchema.safeExtend({ clientKeyCredentialId: z.null() }).strict()
const sql = SqlConnectionSchema.safeExtend({ credentialId: z.null(), tls }).strict()
const redis = RedisConnectionSchema.safeExtend({ credentialId: z.null(), tls }).strict()

export const PublicImportDocumentSchema = z.object({
  schemaVersion: z.literal(2),
  exportedAt: z.string().optional(),
  hosts: UniqueIdObjectArraySchema(host, 10_000),
  tags: UniqueIdObjectArraySchema(ResourceTagSchema.strict(), 10_000),
  concepts: UniqueIdObjectArraySchema(ConceptSchema.strict(), 10_000),
  dataConnections: UniqueIdObjectArraySchema(z.discriminatedUnion('kind', [sql, redis]), 10_000),
  knownHostKeys: z.array(KnownHostKeySchema.strict()).max(10_000),
  credentials: z.array(z.never()).max(0).optional().default([]),
}).strict()
