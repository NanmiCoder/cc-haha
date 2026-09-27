import { z } from 'zod/v4'

export function isValidTeamMemberName(name: string): boolean {
  return /^[\p{L}\p{N}_-]+$/u.test(name) && name !== 'team-lead'
}

export const teamPlanRuntimeSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  effortLevel: z.string().optional(),
}).passthrough()
export const teamPlanAgentSnapshotSchema = z.object({
  systemPrompt: z.string(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  effortLevel: z.string().optional(),
  agentType: z.string().optional(),
  source: z.string().optional(),
  sourceIdentity: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
    z.object({ kind: z.literal('builtin') }).passthrough(),
    z.object({ kind: z.literal('session') }).passthrough(),
  ]).optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  skills: z.array(z.string()).optional(),
  memory: z.string().optional(),
  hooks: z.unknown().optional(),
  maxTurns: z.number().optional(),
  omitClaudeMd: z.boolean().optional(),
  mcpServers: z.unknown().optional(),
  initialPrompt: z.string().optional(),
  isolation: z.string().optional(),
  configurationError: z.string().optional(),
}).passthrough()
export const teamPlanMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  agentType: z.string().min(1),
  prompt: z.string().min(1),
  runtime: teamPlanRuntimeSchema,
  suggestedRuntime: teamPlanRuntimeSchema.optional(),
  reason: z.string().optional(),
  difficulty: z.enum(['low', 'medium', 'high']).optional(),
  agentSnapshot: teamPlanAgentSnapshotSchema.optional(),
}).passthrough()
export const teamPlanTaskSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().optional(),
  ownerId: z.string().optional(),
  dependencies: z.array(z.string()),
}).passthrough()
export const teamPlanRecordSchema = z.object({
  schemaVersion: z.literal(1),
  planId: z.string().min(1),
  sessionId: z.string().min(1),
  teamName: z.string().min(1),
  incarnationId: z.string().min(1),
  revision: z.number().int().positive(),
  state: z.enum(['draft', 'review_pending', 'launching', 'running', 'launch_failed', 'cancelled', 'interrupted']),
  workDir: z.string().min(1),
  leaderRuntime: teamPlanRuntimeSchema,
  agentCatalog: z.record(z.string(), teamPlanAgentSnapshotSchema).optional(),
  members: z.array(teamPlanMemberSchema),
  tasks: z.array(teamPlanTaskSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  parentPlanId: z.string().optional(),
  feedback: z.string().optional(),
  approvedSnapshot: z.object({
    revision: z.number().int().positive(),
    members: z.array(teamPlanMemberSchema),
    tasks: z.array(teamPlanTaskSchema),
    leaderRuntime: teamPlanRuntimeSchema,
    approvedAt: z.number(),
    requestId: z.string().min(1),
  }).passthrough().optional(),
  launch: z.object({
    status: z.enum(['pending', 'running', 'failed']),
    error: z.string().optional(),
    memberIds: z.record(z.string(), z.string()).optional(),
  }).passthrough().optional(),
}).passthrough()
export type TeamPlanAgentSnapshot = z.infer<typeof teamPlanAgentSnapshotSchema>
export type TeamPlanRuntime = z.infer<typeof teamPlanRuntimeSchema>
export type TeamPlanMember = z.infer<typeof teamPlanMemberSchema>
export type TeamPlanTask = z.infer<typeof teamPlanTaskSchema>
export type TeamPlanRecord = z.infer<typeof teamPlanRecordSchema>
export type TeamPlanIdentity = Pick<TeamPlanRecord, 'planId' | 'sessionId' | 'incarnationId'> & { expectedRevision: number }
export type TeamPlanPatch = Partial<Pick<TeamPlanRecord, 'members' | 'tasks' | 'leaderRuntime' | 'feedback' | 'agentCatalog'>>
export type TeamPlanAction = TeamPlanIdentity & { requestId: string; feedback?: string }
