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
import { SettingsService } from '../services/settingsService.js'
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
import { getBuiltInAgentsWithoutOverrides } from '../../tools/AgentTool/builtInAgents.js'
import {
  resolveBuiltInAgentOverrides,
  type ResolvedBuiltInAgentOverride,
} from '../../tools/AgentTool/builtInAgentOverrides.js'
import { isRestrictedToPluginOnly } from '../../utils/settings/pluginOnlyPolicy.js'
import {
  SETTING_SOURCES,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { parseEffortValue } from '../../utils/effort.js'
import { reloadSessionComponents } from '../services/sessionComponentReloadService.js'
import { getAllBaseTools } from '../../tools.js'
import { filterToolsForAgent } from '../../tools/AgentTool/agentToolUtils.js'
import { listSessionModels } from '../services/sessionModelCatalog.js'

const agentService = new AgentService()
const settingsService = new SettingsService()

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

  // ── GET /api/agents/:name/provider-models ───────────────────────────
  if (method === 'GET' && segments[3] === 'provider-models' && agentName) {
    const cwd = url.searchParams.get('cwd') || getCwd()
    await assertOverridableBuiltInAgent(agentName, cwd)
    return Response.json({ models: await listSessionModels() })
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

  // ── PUT|DELETE /api/agents/:name/override ────────────────────────────
  // A deliberately narrow path for built-in agents, which stay read-only on
  // the routes below. Placed ahead of them so the generic PUT/DELETE keep
  // seeing only `/api/agents/:name` and their 403 contract is untouched.
  if (segments[3] === 'override' && agentName) {
    if (method === 'PUT') {
      const body = await parseJsonBody(req)
      assertAllowedFields(body, BUILT_IN_OVERRIDE_FIELDS)
      const cwd = typeof body.cwd === 'string' ? body.cwd : getCwd()
      await assertOverridableBuiltInAgent(agentName, cwd)
      const patch = parseBuiltInOverridePatch(body)
      if (patch.providerId) {
        const providerId = patch.providerId === 'claude-official' ? null : patch.providerId
        if (!(await listSessionModels()).some(model => model.providerId === providerId)) {
          throw ApiError.badRequest('Requested agent provider is unavailable; choose an available provider or inherit the session provider')
        }
      }
      await settingsService.updateBuiltInAgentOverride(agentName, patch)
      clearAgentDefinitionsCache()
      return Response.json({
        agent: await loadBuiltInAgentAfterOverride(agentName, cwd),
      })
    }

    if (method === 'DELETE') {
      const cwd = url.searchParams.get('cwd') || getCwd()
      await assertOverridableBuiltInAgent(agentName, cwd)
      // Idempotent: clearing an agent that has no override is not an error,
      // so the desktop can fire "reset to default" without checking first.
      await settingsService.updateBuiltInAgentOverride(agentName, null)
      clearAgentDefinitionsCache()
      return Response.json({
        agent: await loadBuiltInAgentAfterOverride(agentName, cwd),
      })
    }

    throw new ApiError(
      405,
      `Method ${method} not allowed on /api/agents/${agentName}/override`,
      'METHOD_NOT_ALLOWED',
    )
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
  providerId?: string
  effort?: SharedAgentDefinition['effort']
  tools?: string[]
  systemPrompt?: string
  color?: string
  source: SharedAgentDefinition['source']
  baseDir?: string
  target?: string
  isActive: boolean
  /**
   * Whether the *file* backing this agent can be rewritten. Built-ins stay
   * false — the generic PUT/DELETE still 403 them. Deliberately separate from
   * `overridable` below, which is a much narrower capability.
   */
  editable?: boolean
  /** Built-in agents only: provider/model/effort can be changed via /override. */
  overridable?: boolean
  /** Built-in agents only: what model/effort this build ships with. */
  defaults?: { model?: string; effort?: SharedAgentDefinition['effort'] }
  /** Built-in agents only: the override currently in effect, if any. */
  override?: {
    providerId?: string
    model?: string
    effort?: SharedAgentDefinition['effort']
    source: SettingSource
  }
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
    ...(agent.providerId ? { providerId: agent.providerId } : {}),
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
    ...serializeBuiltInOverride(agent),
  }
}

/**
 * Built-in extras: what this build ships, and what the user changed.
 *
 * `model`/`effort`/`modelDisplay` above already carry the *effective* value —
 * the override is applied at the loader — so these fields exist only so the UI
 * can offer "reset to built-in default" and name the default. The default
 * differs per agent and per build, so it can never be a client-side constant.
 */
function serializeBuiltInOverride(
  agent: SharedAgentDefinition,
): Partial<ApiAgentDefinition> {
  if (agent.source !== 'built-in') return {}

  const shipped = getBuiltInAgentsWithoutOverrides().find(
    candidate => candidate.agentType === agent.agentType,
  )
  const override: ResolvedBuiltInAgentOverride | undefined =
    resolveBuiltInAgentOverrides().get(agent.agentType)
  const fields = [override?.providerId, override?.model, override?.effort].filter(
    field => field !== undefined,
  )

  return {
    overridable: true,
    defaults: { model: shipped?.model, effort: shipped?.effort },
    ...(fields.length > 0
      ? {
          override: {
            ...(override?.providerId ? { providerId: override.providerId.value } : {}),
            ...(override?.model ? { model: override.model.value } : {}),
            ...(override?.effort ? { effort: override.effort.value } : {}),
            // Fields can come from different files. Report the highest-priority
            // one so the UI locks the control if any part is admin-managed.
            source: fields.reduce((winner, field) =>
              SETTING_SOURCES.indexOf(field.source) >
              SETTING_SOURCES.indexOf(winner.source)
                ? field
                : winner,
            ).source,
          },
        }
      : {}),
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

// No `scope`: built-in overrides are user-level by definition. Accepting and
// ignoring one would silently write somewhere the caller did not ask for.
const BUILT_IN_OVERRIDE_FIELDS = new Set(['providerId', 'model', 'effort', 'cwd'])

/**
 * Only the provider, model and effort of an agent that is genuinely built-in right now.
 *
 * Membership, not `assertValidName`: AGENT_SLUG_PATTERN is lowercase-only and
 * would reject `Explore` and `Plan` outright.
 */
async function assertOverridableBuiltInAgent(
  name: string,
  cwd: string,
): Promise<void> {
  if (isRestrictedToPluginOnly('agents')) {
    throw new ApiError(
      403,
      'Agent customization is restricted to plugins by managed settings',
      'AGENT_CUSTOMIZATION_LOCKED',
    )
  }

  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const match = allAgents.find(agent => agent.agentType === name)
  if (!match) {
    throw ApiError.notFound(`Agent not found: ${name}`)
  }
  if (match.source !== 'built-in') {
    // Distinct from READ_ONLY_AGENT so the desktop can tell "edit this through
    // the agent editor" apart from "this source cannot be written at all".
    throw new ApiError(
      403,
      `Agent is not built-in: ${name}`,
      'NOT_A_BUILT_IN_AGENT',
    )
  }
}

function parseBuiltInOverridePatch(body: Record<string, unknown>): {
  providerId?: string | null
  model?: string | null
  effort?: string | number | null
} {
  const patch: { providerId?: string | null; model?: string | null; effort?: string | number | null } = {}

  if (Object.hasOwn(body, 'providerId')) {
    patch.providerId = body.providerId === null ? null : requireNonEmptyString(body.providerId, 'providerId')
  }
  if (Object.hasOwn(body, 'model')) {
    patch.model =
      body.model === null ? null : requireNonEmptyString(body.model, 'model')
  }
  if (Object.hasOwn(body, 'effort')) {
    if (body.effort === null) {
      patch.effort = null
    } else {
      const effort = parseEffortValue(body.effort)
      if (effort === undefined) {
        throw ApiError.badRequest(
          'Agent effort must be a supported level or integer',
        )
      }
      patch.effort = effort
    }
  }
  return patch
}

/**
 * Re-read a built-in agent after its override changed.
 *
 * loadMutatedAgent cannot serve this: it filters on the userSettings source and
 * matches by realpath of baseDir/sourceFilePath, neither of which a built-in has.
 */
async function loadBuiltInAgentAfterOverride(
  name: string,
  cwd: string,
): Promise<ApiAgentDefinition> {
  const { activeAgents, allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const agent = allAgents.find(
    candidate => candidate.agentType === name && candidate.source === 'built-in',
  )
  if (!agent) {
    throw ApiError.internal(
      `Built-in agent disappeared after writing its override: ${name}`,
    )
  }
  return serializeAgentForRequest(agent, activeAgents.includes(agent), cwd)
}

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
