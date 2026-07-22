/**
 * Agents REST API
 *
 * GET    /api/agents        — 获取 Agent 列表
 * GET    /api/agents/:name  — 获取 Agent 详情
 * POST   /api/agents        — 创建 Agent
 * POST   /api/agents/reload — 重载当前 CLI 会话中的 Agent 定义
 * PUT    /api/agents/:name  — 更新 Agent
 * DELETE /api/agents/:name  — 删除 Agent
 *
 * GET    /api/tasks         — 获取后台任务列表
 * GET    /api/tasks/:id     — 获取任务详情
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import {
  AgentService,
  type AgentDefinition as EditableAgentDefinition,
  type AgentUpdate,
  type AgentMutationContext,
  type AgentMutationResult,
  type AgentScope,
} from '../services/agentService.js'
import { taskService } from '../services/taskService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { resetTaskList } from '../../utils/tasks.js'
import {
  resolveAgentModelDisplay,
  resolveAgentOverrides,
  type ResolvedAgent,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  clearAgentDefinitionsCache,
  getAgentDefinitionsWithOverrides,
  type AgentDefinition as SharedAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { AGENT_COLORS } from '../../tools/AgentTool/agentColorManager.js'
import { parseEffortValue } from '../../utils/effort.js'
import { reloadSessionComponents } from '../services/sessionComponentReloadService.js'
import { getAllBaseTools } from '../../tools.js'
import { filterToolsForAgent } from '../../tools/AgentTool/agentToolUtils.js'

const agentService = new AgentService()

export async function handleAgentsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1] // 'agents' | 'tasks'

    if (resource === 'tasks') {
      return await handleTasksApi(req, segments)
    }

    return await handleAgents(req, url, segments)
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Agent CRUD ─────────────────────────────────────────────────────────────

async function handleAgents(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const method = req.method
  const agentName = segments[2] ? decodeAgentName(segments[2]) : undefined

  // ── POST /api/agents/reload ──────────────────────────────────────────
  if (method === 'POST' && agentName === 'reload') {
    const sessionId = url.searchParams.get('sessionId')?.trim()
    if (!sessionId) {
      throw ApiError.badRequest('Missing required "sessionId" query parameter')
    }
    return Response.json({
      ok: true,
      session: await reloadSessionComponents(sessionId),
    })
  }

  // ── GET /api/agents ──────────────────────────────────────────────────
  if (method === 'GET' && !agentName) {
    const cwd = url.searchParams.get('cwd') || getCwd()
    const { activeAgents, allAgents } = await getAgentDefinitionsWithOverrides(cwd)
    const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)

    return Response.json({
      availableTools: getAvailableCustomAgentTools(),
      activeAgents: await Promise.all(
        activeAgents.map(agent => serializeAgentForRequest(agent, true, cwd)),
      ),
      allAgents: await Promise.all(
        resolvedAgents.map(agent => serializeResolvedAgent(agent, cwd)),
      ),
    })
  }

  // ── GET /api/agents/:name ────────────────────────────────────────────
  if (method === 'GET' && agentName) {
    agentService.assertValidName(agentName)
    const cwd = url.searchParams.get('cwd') || getCwd()
    const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)
    const agent = activeAgents.find(candidate => candidate.agentType === agentName)
    if (!agent) {
      throw ApiError.notFound(`Agent not found: ${agentName}`)
    }
    return Response.json({
      agent: await serializeAgentForRequest(agent, true, cwd),
    })
  }

  // ── POST /api/agents ─────────────────────────────────────────────────
  if (method === 'POST' && !agentName) {
    const body = await parseJsonBody(req)
    assertAllowedFields(body, CREATE_AGENT_FIELDS)
    const context = parseMutationContext(body, false)
    const agent = parseCreateAgent(body)
    await assertCreateIdentityAvailable(agent.name, context)
    const mutation = await agentService.createAgent(agent, context)
    clearAgentDefinitionsCache()
    const visibleAgent = await loadMutatedAgent(
      agent.name,
      context,
      mutation,
    )
    return Response.json({ agent: visibleAgent }, { status: 201 })
  }

  // ── PUT /api/agents/:name ────────────────────────────────────────────
  if (method === 'PUT' && agentName) {
    const body = await parseJsonBody(req)
    assertAllowedFields(body, UPDATE_AGENT_FIELDS)
    const context = parseMutationContext(body, true)
    const updates = parseAgentUpdates(body, agentName)
    await assertMutableTarget(agentName, context)
    const mutation = await agentService.updateAgent(agentName, updates, context)
    clearAgentDefinitionsCache()
    const visibleAgent = await loadMutatedAgent(
      agentName,
      context,
      mutation,
    )
    return Response.json({ agent: visibleAgent })
  }

  // ── DELETE /api/agents/:name ─────────────────────────────────────────
  if (method === 'DELETE' && agentName) {
    const context = parseDeleteMutationContext(url)
    await assertMutableTarget(agentName, context)
    await agentService.deleteAgent(agentName, context)
    clearAgentDefinitionsCache()
    return Response.json({ ok: true })
  }

  throw new ApiError(
    405,
    `Method ${method} not allowed on /api/agents${agentName ? `/${agentName}` : ''}`,
    'METHOD_NOT_ALLOWED',
  )
}

function getAvailableCustomAgentTools(): string[] {
  const enabledTools = getAllBaseTools().filter(tool => {
    try {
      return tool.isEnabled()
    } catch {
      return false
    }
  })
  return filterToolsForAgent({
    tools: enabledTools,
    isBuiltIn: false,
    isAsync: true,
  }).map(tool => tool.name).sort((a, b) => a.localeCompare(b))
}

// ─── Tasks API ─────────────────────────────────────────────────────────────
//
// GET /api/tasks                         → list all tasks (across all task lists)
// GET /api/tasks/lists                   → list all task lists with summaries
// GET /api/tasks/lists/:taskListId       → get all tasks for a specific task list
// GET /api/tasks/lists/:taskListId/:id   → get a single task
// POST /api/tasks/lists/:taskListId/reset → clear a completed task list

async function handleTasksApi(
  req: Request,
  segments: string[],
): Promise<Response> {
  const sub = segments[2] // 'lists' or undefined

  if (sub === 'lists') {
    const taskListId = segments[3]
    const taskId = segments[4]

    if (req.method === 'POST' && taskListId && taskId === 'reset') {
      await resetTaskList(taskListId)
      return Response.json({ ok: true })
    }

    if (req.method !== 'GET') {
      throw new ApiError(
        405,
        `Method ${req.method} not allowed on /api/tasks/lists`,
        'METHOD_NOT_ALLOWED',
      )
    }

    if (taskListId && taskId) {
      // GET /api/tasks/lists/:taskListId/:taskId
      const task = await taskService.getTask(taskListId, taskId)
      if (!task) throw ApiError.notFound(`Task not found: ${taskListId}/${taskId}`)
      return Response.json({ task })
    }

    if (taskListId) {
      // GET /api/tasks/lists/:taskListId
      const tasks = await taskService.getTasksForList(taskListId)
      return Response.json({ tasks })
    }

    // GET /api/tasks/lists
    const lists = await taskService.listTaskLists()
    return Response.json({ lists })
  }

  if (req.method !== 'GET') {
    throw new ApiError(
      405,
      `Method ${req.method} not allowed on /api/tasks`,
      'METHOD_NOT_ALLOWED',
    )
  }

  // GET /api/tasks — list all tasks
  const tasks = await taskService.listTasks()
  return Response.json({ tasks })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('JSON body must be an object')
  }
  return body as Record<string, unknown>
}

type ApiAgentDefinition = {
  agentType: string
  description?: string
  model?: string
  modelDisplay?: string
  effort?: SharedAgentDefinition['effort']
  tools?: string[]
  systemPrompt?: string
  color?: string
  source: SharedAgentDefinition['source']
  baseDir?: string
  target?: string
  isActive: boolean
  editable?: boolean
}

type ApiResolvedAgentDefinition = ApiAgentDefinition & {
  overriddenBy?: SharedAgentDefinition['source']
}

function serializeActiveAgent(
  agent: SharedAgentDefinition,
  isActive: boolean,
  editable = false,
  target?: string,
): ApiAgentDefinition {
  const tools =
    editable && Object.hasOwn(agent, 'rawTools') ? agent.rawTools : agent.tools
  return {
    agentType: agent.agentType,
    description: agent.whenToUse,
    model: agent.model,
    modelDisplay: resolveAgentModelDisplay(agent),
    effort: agent.effort,
    tools,
    systemPrompt:
      isEditableSource(agent.source) && agent.rawSystemPrompt !== undefined
        ? agent.rawSystemPrompt
        : agent.getSystemPrompt.length === 0
          ? agent.getSystemPrompt()
          : undefined,
    color: agent.color,
    source: agent.source,
    baseDir: agent.baseDir,
    target,
    isActive,
    editable,
  }
}

const CREATE_AGENT_FIELDS = new Set([
  'scope',
  'cwd',
  'name',
  'description',
  'systemPrompt',
  'model',
  'effort',
  'tools',
  'color',
])

const UPDATE_AGENT_FIELDS = new Set([...CREATE_AGENT_FIELDS, 'target'])

function decodeAgentName(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw ApiError.badRequest('Invalid encoded agent name')
  }
}

function assertAllowedFields(
  body: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): void {
  const unexpected = Object.keys(body).find(key => !allowedFields.has(key))
  if (unexpected) {
    throw ApiError.badRequest(`Unexpected agent field: ${unexpected}`)
  }
}

function parseMutationContext(
  body: Record<string, unknown>,
  allowTarget: boolean,
): AgentMutationContext {
  const scope = parseScope(body.scope)
  if (body.cwd !== undefined && typeof body.cwd !== 'string') {
    throw ApiError.badRequest('Agent cwd must be a string')
  }
  if (
    allowTarget &&
    body.target !== undefined &&
    (typeof body.target !== 'string' || body.target.trim().length === 0)
  ) {
    throw ApiError.badRequest('Agent target must be a non-empty string')
  }
  return {
    scope,
    cwd: body.cwd as string | undefined,
    target: allowTarget ? (body.target as string | undefined) : undefined,
  }
}

function parseDeleteMutationContext(url: URL): AgentMutationContext {
  return {
    scope: parseScope(url.searchParams.get('scope')),
    cwd: url.searchParams.get('cwd') || undefined,
    target: url.searchParams.get('target') || undefined,
  }
}

function parseScope(value: unknown): AgentScope {
  if (value === undefined || value === null || value === '') {
    return 'user'
  }
  if (value !== 'user' && value !== 'project') {
    throw ApiError.badRequest('Agent scope must be "user" or "project"')
  }
  return value
}

function parseCreateAgent(
  body: Record<string, unknown>,
): EditableAgentDefinition {
  const name = requireNonEmptyString(body.name, 'name')
  agentService.assertValidName(name)
  return {
    name,
    description: requireNonEmptyString(body.description, 'description'),
    systemPrompt: requireNonEmptyString(body.systemPrompt, 'systemPrompt'),
    ...parseOptionalAgentFields(body, false),
  }
}

function parseAgentUpdates(
  body: Record<string, unknown>,
  agentName: string,
): AgentUpdate {
  const updates = parseOptionalAgentFields(body, true)
  if (body.name !== undefined) {
    const requestedName = requireNonEmptyString(body.name, 'name')
    agentService.assertValidName(requestedName)
    updates.name = requestedName
    if (requestedName !== agentName) {
      throw ApiError.badRequest('Agent name cannot be changed')
    }
  }
  if (body.description !== undefined) {
    updates.description = requireNonEmptyString(body.description, 'description')
  }
  if (Object.hasOwn(body, 'systemPrompt')) {
    if (typeof body.systemPrompt !== 'string') {
      throw ApiError.badRequest('Agent systemPrompt must be a string')
    }
    updates.systemPrompt = body.systemPrompt.trim()
  }
  return updates
}

function parseOptionalAgentFields(
  body: Record<string, unknown>,
  allowNull: false,
): Partial<EditableAgentDefinition>
function parseOptionalAgentFields(
  body: Record<string, unknown>,
  allowNull: true,
): AgentUpdate
function parseOptionalAgentFields(
  body: Record<string, unknown>,
  allowNull: boolean,
): AgentUpdate {
  const fields: AgentUpdate = {}

  if (body.model === null) {
    if (allowNull) fields.model = null
  } else if (body.model !== undefined) {
    fields.model = requireNonEmptyString(body.model, 'model')
  }
  if (body.effort === null) {
    if (allowNull) fields.effort = null
  } else if (body.effort !== undefined) {
    const effort = parseEffortValue(body.effort)
    if (effort === undefined) {
      throw ApiError.badRequest(
        'Agent effort must be a supported level or integer',
      )
    }
    fields.effort = effort
  }
  if (body.tools === null) {
    if (allowNull) fields.tools = null
  } else if (body.tools !== undefined) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.some(
        tool => typeof tool !== 'string' || tool.trim().length === 0,
      )
    ) {
      throw ApiError.badRequest('Agent tools must be an array of non-empty strings')
    }
    fields.tools = body.tools.map(tool => (tool as string).trim())
  }
  if (body.color === null) {
    if (allowNull) fields.color = null
  } else if (body.color !== undefined) {
    const color = requireNonEmptyString(body.color, 'color')
    if (!(AGENT_COLORS as readonly string[]).includes(color)) {
      throw ApiError.badRequest(`Unsupported agent color: ${color}`)
    }
    fields.color = color
  }
  return fields
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiError.badRequest(`Agent ${field} must be a non-empty string`)
  }
  return value.trim()
}

async function assertMutableTarget(
  name: string,
  context: AgentMutationContext,
): Promise<void> {
  const editable = await agentService.getAgent(name, context)
  if (editable) return

  const cwd = context.cwd || getCwd()
  const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const active = activeAgents.find(agent => agent.agentType === name)
  if (active && !isEditableSource(active.source)) {
    throw new ApiError(
      403,
      `Agent is read-only: ${name}`,
      'READ_ONLY_AGENT',
    )
  }
  throw ApiError.notFound(`Agent not found in ${context.scope} scope: ${name}`)
}

async function assertCreateIdentityAvailable(
  name: string,
  context: AgentMutationContext,
): Promise<void> {
  clearAgentDefinitionsCache()
  const cwd = context.cwd || getCwd()
  const source = context.scope === 'user' ? 'userSettings' : 'projectSettings'
  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  if (
    allAgents.some(
      agent => agent.agentType === name && agent.source === source,
    )
  ) {
    throw ApiError.conflict(
      `Agent already exists in ${context.scope} scope: ${name}`,
    )
  }
}

async function loadMutatedAgent(
  name: string,
  context: AgentMutationContext,
  mutation: AgentMutationResult,
): Promise<ApiAgentDefinition> {
  const cwd = context.cwd || getCwd()
  const { activeAgents, allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const source = context.scope === 'user' ? 'userSettings' : 'projectSettings'
  const normalizedDir = await normalizeDirectoryIdentity(mutation.agentsDir)
  const normalizedTarget = await normalizeDirectoryIdentity(mutation.target)
  const candidates = allAgents.filter(
    candidate => candidate.agentType === name && candidate.source === source,
  )
  let agent: SharedAgentDefinition | undefined
  for (const candidate of candidates) {
    if (
      candidate.baseDir !== undefined &&
      (await normalizeDirectoryIdentity(candidate.baseDir)) === normalizedDir &&
      candidate.sourceFilePath !== undefined &&
      (await normalizeDirectoryIdentity(candidate.sourceFilePath)) ===
        normalizedTarget
    ) {
      agent = candidate
      break
    }
  }
  if (!agent) {
    throw ApiError.internal(
      `Agent was written but is not visible to the shared loader: ${name}`,
    )
  }
  return serializeAgentForRequest(agent, activeAgents.includes(agent), cwd)
}

async function normalizeDirectoryIdentity(directory: string): Promise<string> {
  try {
    return await fs.realpath(directory)
  } catch {
    return path.resolve(directory)
  }
}

function isEditableSource(source: SharedAgentDefinition['source']): boolean {
  return source === 'userSettings' || source === 'projectSettings'
}

async function serializeAgentForRequest(
  agent: SharedAgentDefinition,
  isActive: boolean,
  cwd: string,
): Promise<ApiAgentDefinition> {
  const editable = await resolveEditableAgent(agent, cwd)
  return serializeActiveAgent(
    agent,
    isActive,
    editable !== null,
    editable?.target,
  )
}

async function resolveEditableAgent(
  agent: SharedAgentDefinition,
  cwd: string,
): Promise<AgentMutationResult | null> {
  if (!isEditableSource(agent.source) || !agent.baseDir) return null

  const context: AgentMutationContext = {
    scope: agent.source === 'userSettings' ? 'user' : 'project',
    cwd,
    target: agent.sourceFilePath,
  }
  try {
    const editable = await agentService.getAgent(agent.agentType, context)
    if (!editable) return null
    return editable
  } catch (error) {
    if (error instanceof ApiError && error.statusCode < 500) return null
    throw error
  }
}

async function serializeResolvedAgent(
  agent: ResolvedAgent,
  cwd: string,
): Promise<ApiResolvedAgentDefinition> {
  return {
    ...(await serializeAgentForRequest(agent, !agent.overriddenBy, cwd)),
    overriddenBy: agent.overriddenBy,
  }
}
