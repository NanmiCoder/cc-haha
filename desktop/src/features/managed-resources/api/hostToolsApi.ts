import { z } from 'zod'

export const ExecutionUserSchema = z.string().max(64).regex(/^(?:[a-zA-Z_][a-zA-Z0-9_.-]*\$?)?$/)
export const ApplicationPinSchema = z.object({
  directory: z.enum(['apps', 'conf', 'logs', 'bin/bin']),
  relativePath: z.string().min(1).max(4096).refine(value =>
    !value.startsWith('/') && !/[\\\\\x00-\x1f\x7f]/.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
}).strict()
export const HostToolsPreferencesSchema = z.object({
  runAsUser: ExecutionUserSchema.default(''),
  collapsed: z.object({ apps: z.boolean().optional(), conf: z.boolean().optional(), logs: z.boolean().optional(), 'bin/bin': z.boolean().optional() }).strict().default({}),
  javaKeywords: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  lastJavaSearch: z.string().max(120).default(''),
  pinnedFiles: z.array(ApplicationPinSchema).max(1000).default([]),
}).strict()
export type HostToolsPreferences = z.infer<typeof HostToolsPreferencesSchema>
export const emptyHostToolsPreferences = (): HostToolsPreferences => ({ runAsUser: '', collapsed: {}, javaKeywords: [], lastJavaSearch: '', pinnedFiles: [] })
export const HostToolsScopeSchema = z.object({
  hostId: z.string().uuid(),
  applicationId: z.string().uuid().optional(),
  rootIndex: z.number().int().min(0).max(63).optional(),
  expectedRoot: z.string().min(1).max(4096).optional(),
}).strict().refine(value => value.applicationId ? value.rootIndex !== undefined && value.expectedRoot !== undefined : value.rootIndex === undefined && value.expectedRoot === undefined)
export type HostToolsScope = z.infer<typeof HostToolsScopeSchema>
const patch = z.object({
  runAsUser: ExecutionUserSchema.optional(),
  collapsed: HostToolsPreferencesSchema.shape.collapsed.optional(),
  pinFile: ApplicationPinSchema.extend({ pinned: z.boolean() }).optional(),
  addJavaKeyword: z.string().trim().min(1).max(120).optional(),
  removeJavaKeyword: z.string().trim().min(1).max(120).optional(),
  lastJavaSearch: z.string().max(120).optional(),
}).strict()
export type HostToolsPatch = z.infer<typeof patch>
export const HostToolsInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('getPreferences'), scope: HostToolsScopeSchema }).strict(),
  z.object({ action: z.literal('savePreferences'), scope: HostToolsScopeSchema, patch }).strict(),
  z.object({ action: z.literal('listJava'), hostId: z.string().uuid(), connectionId: z.string().uuid(), generation: z.number().int().positive(), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancelJava'), requestId: z.string().uuid() }).strict(),
])
export type HostToolsInput = z.infer<typeof HostToolsInputSchema>
export type JavaProcess = { pid: number; commandLine: string; xmx: string | null; xms: string | null }
export type HostToolsResult =
  | { kind: 'preferences'; preferences: HostToolsPreferences }
  | { kind: 'java'; processes: JavaProcess[]; sampledAt: string; unreadable: number }
  | { kind: 'cancelled' }
