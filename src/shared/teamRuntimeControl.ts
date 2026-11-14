import { z } from 'zod/v4'

export const teamRuntimeControlStatusSchema = z.enum(['running', 'pausing', 'paused', 'resuming', 'partial'])
export const teamRuntimeControlIdentitySchema = z.object({
  leadSessionId: z.string().min(1),
  incarnationId: z.string().min(1),
})
export const teamRuntimeControlActionSchema = teamRuntimeControlIdentitySchema.extend({
  expectedRevision: z.number().int().positive(),
  requestId: z.string().min(1),
}).strict()
export const teamMemberRuntimeIdentitySchema = teamRuntimeControlIdentitySchema.extend({
  expectedRevision: z.number().int().positive(),
  sessionId: z.string().min(1),
})

/** A sidecar belongs to one team incarnation, including every approved addition. */
export const teamRuntimeControlRecordSchema = teamRuntimeControlIdentitySchema.extend({
  schemaVersion: z.literal(1),
  teamName: z.string().min(1),
  revision: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  status: teamRuntimeControlStatusSchema,
  ownerId: z.string().min(1),
  updatedAt: z.number(),
  pausedAt: z.number().optional(),
  error: z.string().optional(),
  memberErrors: z.record(z.string(), z.string()).optional(),
  resume: z.object({
    requestId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    createdAt: z.number(),
    eligibleSessionIds: z.array(z.string()),
    startedSessionIds: z.array(z.string()),
  }).passthrough().optional(),
}).passthrough()

export type TeamRuntimeControlIdentity = z.infer<typeof teamRuntimeControlIdentitySchema>
export type TeamRuntimeControlAction = z.infer<typeof teamRuntimeControlActionSchema>
export type TeamMemberRuntimeIdentity = z.infer<typeof teamMemberRuntimeIdentitySchema>
export type TeamRuntimeControlRecord = z.infer<typeof teamRuntimeControlRecordSchema>
export type TeamRuntimeControlView = Pick<TeamRuntimeControlRecord,
  'schemaVersion' | 'teamName' | 'leadSessionId' | 'incarnationId' | 'revision' | 'epoch' | 'status' | 'updatedAt' | 'error'> & {
  resumeEligibleCount: number
  members: Array<{
    agentId: string
    sessionId: string
    planId: string
    memberId: string
    name: string
    status: 'paused' | 'running' | 'waiting' | 'completed' | 'failed'
    error?: string
  }>
}
