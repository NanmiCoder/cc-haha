import { z } from 'zod'
import { ExecutionUserSchema } from './hostToolsApi.js'

export const APPLICATION_DIRECTORIES = ['apps', 'conf', 'logs', 'bin/bin'] as const
export type ApplicationDirectory = typeof APPLICATION_DIRECTORIES[number]
export const isApplicationLog = (name: string) => /\.log(?:\.\d+)?$/i.test(name)
export const isApplicationScript = (name: string) => /\.sh$/i.test(name)
const relativePath = z.string().max(2048).refine(value => value === '' || (
  !/[\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
))
const target = {
  ownerId: z.string().optional(), hostId: z.string().uuid(), applicationId: z.string().uuid(),
  connectionId: z.string().uuid(), generation: z.number().int().positive(),
  rootIndex: z.number().int().min(0).max(99), directory: z.enum(APPLICATION_DIRECTORIES), relativePath,
}
const revision = z.string().min(1).max(150)
export const ApplicationOperationInputSchema = z.discriminatedUnion('action', [
  z.object({ ...target, action: z.literal('list') }).strict(),
  z.object({ ...target, action: z.literal('read') }).strict(),
  z.object({ ...target, action: z.literal('delete'), expectedRevision: revision, confirmed: z.literal(true) }).strict(),
  z.object({ ...target, action: z.literal('start'), requestId: z.string().uuid(), mode: z.enum(['script', 'tail']), expectedRevision: revision, confirmed: z.literal(true), expectedRunAsUser: ExecutionUserSchema.optional() }).strict(),
  z.object({ ownerId: z.string().optional(), action: z.literal('poll'), operationId: z.string().uuid() }).strict(),
  z.object({ ownerId: z.string().optional(), action: z.literal('stop'), operationId: z.string().uuid() }).strict(),
])
export type ApplicationOperationInput = z.infer<typeof ApplicationOperationInputSchema>
export type ApplicationFileTarget = Omit<Extract<ApplicationOperationInput, { action: 'list' }>, 'action' | 'ownerId'>
export type ApplicationFile = {
  name: string; relativePath: string; absolutePath: string
  type: 'file' | 'directory' | 'symlink' | 'other'; size: number; revision: string
}
export type ApplicationOperation = {
  id: string; mode: 'script' | 'tail'; absolutePath: string; cwd: string
  state: 'starting' | 'running' | 'completed' | 'failed' | 'stopped'
  text: string; truncated: boolean; exitCode: number | null; signal: string | null; errorCode: string | null
}
export type ApplicationOperationResult =
  | { kind: 'files'; absolutePath: string; entries: ApplicationFile[] }
  | { kind: 'content'; absolutePath: string; text: string; truncated: boolean }
  | { kind: 'operation'; operation: ApplicationOperation }
  | { kind: 'deleted' }
