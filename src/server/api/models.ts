/**
 * Models REST API
 *
 * GET  /api/models          — 获取可用模型列表
 * GET  /api/models/current  — 获取当前选中的模型
 * PUT  /api/models/current  — 切换模型
 * GET  /api/effort          — 获取 Effort 等级
 * PUT  /api/effort          — 设置 Effort 等级
 */

import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

// ─── Fallback models (used when no provider is configured) ────────────────────

const DEFAULT_MODELS = [
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    description: 'Most capable for ambitious work',
    context: '1m',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    description: 'Most efficient for everyday tasks',
    context: '200k',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest for quick answers',
    context: '200k',
  },
] as const

const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const

const DEFAULT_MODEL = 'claude-opus-4-7'
const DEFAULT_EFFORT = 'medium'

const settingsService = new SettingsService()
const providerService = new ProviderService()

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleModelsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1] // 'models' | 'effort'
    const sub = segments[2] // 'current' | undefined

    // ── /api/effort ───────────────────────────────────────────────────
    if (resource === 'effort') {
      return await handleEffort(req)
    }

    // ── /api/models/* ─────────────────────────────────────────────────
    switch (sub) {
      case undefined:
        // GET /api/models — 优先从激活的 Provider 读取模型列表
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return await handleModelsList()

      case 'current':
        return await handleCurrentModel(req)

      default:
        throw ApiError.notFound(`Unknown models endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleModelsList(): Promise<Response> {
  const { providers, activeId } = await providerService.listProviders()
  const activeProvider = activeId ? providers.find((p) => p.id === activeId) : null
  if (activeProvider) {
    // Convert ModelMapping to model list for API compatibility
    const modelList = [
      { id: activeProvider.models.main, name: activeProvider.models.main, description: 'Main model', context: '' },
      ...(activeProvider.models.haiku !== activeProvider.models.main ? [{ id: activeProvider.models.haiku, name: activeProvider.models.haiku, description: 'Haiku model', context: '' }] : []),
      ...(activeProvider.models.sonnet !== activeProvider.models.main ? [{ id: activeProvider.models.sonnet, name: activeProvider.models.sonnet, description: 'Sonnet model', context: '' }] : []),
      ...(activeProvider.models.opus !== activeProvider.models.main ? [{ id: activeProvider.models.opus, name: activeProvider.models.opus, description: 'Opus model', context: '' }] : []),
    ]
    return Response.json({
      models: modelList,
      provider: { id: activeProvider.id, name: activeProvider.name },
    })
  }
  return Response.json({ models: DEFAULT_MODELS, provider: null })
}

async function handleCurrentModel(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const explicitModel = (settings.model as string) || ''
    const contextTier = (settings.modelContext as string) || undefined
    const env = (settings.env as Record<string, string>) || {}

    // Build the full model list: prefer active provider's models, fall back to defaults
    const { providers, activeId } = await providerService.listProviders()
    const activeProvider = activeId ? providers.find((p) => p.id === activeId) : null

    let currentModelId: string
    let currentModelName: string

    if (activeProvider) {
      // Provider is active — use the model from env (set by syncToSettings when provider was activated)
      // unless user explicitly set a different model ID in settings
      const providerEnvModel = env.ANTHROPIC_MODEL
      if (providerEnvModel && (!explicitModel || explicitModel === DEFAULT_MODEL)) {
        // No explicit model override — use the provider's configured model
        currentModelId = providerEnvModel
        currentModelName = providerEnvModel
      } else {
        // User explicitly set a model (possibly from the provider's model list)
        currentModelId = explicitModel || providerEnvModel || activeProvider.models.main
        currentModelName = currentModelId
      }
    } else {
      // No provider — use settings model with context tier
      currentModelId = explicitModel || DEFAULT_MODEL
      currentModelName = currentModelId
    }

    const lookupId = contextTier ? `${currentModelId}:${contextTier}` : currentModelId

    // Build available models for name lookup
    const availableModels = activeProvider
      ? [
          { id: activeProvider.models.main, name: activeProvider.models.main, description: 'Main model', context: '' },
          ...(activeProvider.models.haiku && activeProvider.models.haiku !== activeProvider.models.main ? [{ id: activeProvider.models.haiku, name: activeProvider.models.haiku, description: 'Haiku model', context: '' }] : []),
          ...(activeProvider.models.sonnet && activeProvider.models.sonnet !== activeProvider.models.main ? [{ id: activeProvider.models.sonnet, name: activeProvider.models.sonnet, description: 'Sonnet model', context: '' }] : []),
          ...(activeProvider.models.opus && activeProvider.models.opus !== activeProvider.models.main ? [{ id: activeProvider.models.opus, name: activeProvider.models.opus, description: 'Opus model', context: '' }] : []),
        ]
      : DEFAULT_MODELS

    const modelEntry = availableModels.find((m) => m.id === lookupId)
      || availableModels.find((m) => m.id === currentModelId)
      || {
        id: currentModelId,
        name: currentModelName,
        description: 'Custom model',
        context: contextTier || 'unknown',
      }

    return Response.json({ model: { ...modelEntry, context: contextTier || modelEntry.context } })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const modelId = body.modelId
    if (typeof modelId !== 'string' || !modelId) {
      throw ApiError.badRequest('Missing or invalid "modelId" in request body')
    }

    // Parse composite IDs like 'claude-opus-4-7-20250610:1m'
    // Persist the base model ID for CLI compatibility and context tier separately
    const colonIdx = modelId.indexOf(':')
    const baseId = colonIdx !== -1 ? modelId.slice(0, colonIdx) : modelId
    const contextTier = colonIdx !== -1 ? modelId.slice(colonIdx + 1) : undefined

    const updates: Record<string, unknown> = { model: baseId }
    if (contextTier) {
      updates.modelContext = contextTier
    } else {
      // Clear context tier when switching to a non-composite model
      updates.modelContext = undefined
    }
    await settingsService.updateUserSettings(updates)
    return Response.json({ ok: true, model: modelId })
  }

  throw methodNotAllowed(req.method)
}

async function handleEffort(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const level = (settings.effort as string) || DEFAULT_EFFORT
    return Response.json({ level, available: EFFORT_LEVELS })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const level = body.level
    if (typeof level !== 'string') {
      throw ApiError.badRequest('Missing or invalid "level" in request body')
    }
    if (!EFFORT_LEVELS.includes(level as (typeof EFFORT_LEVELS)[number])) {
      throw ApiError.badRequest(
        `Invalid effort level: "${level}". Valid levels: ${EFFORT_LEVELS.join(', ')}`,
      )
    }
    await settingsService.updateUserSettings({ effort: level })
    return Response.json({ ok: true, level })
  }

  throw methodNotAllowed(req.method)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
