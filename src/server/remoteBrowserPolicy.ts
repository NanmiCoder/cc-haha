import type { RequestCompatibility, SavedProvider } from './types/provider.js'
import { AUTO_QUESTION_TIMEOUT_OPTIONS, normalizeAutoQuestionSettings } from '../shared/autoQuestionSettings.js'

export type ApiRequestContext = { remoteBrowser?: boolean; remoteDeviceId?: string; remoteDeviceExpiresAt?: number }
const READ_SETTINGS = ['agentTeamsEnabled', 'alwaysThinkingEnabled', 'workflowKeywordTriggerEnabled', 'autoDreamEnabled', 'skipAutoPermissionPrompt', 'chatSendBehavior', 'outputStyle', 'skipWebFetchPreflight', 'language']
const WRITE_SETTINGS = new Set(['language', 'chatSendBehavior', 'alwaysThinkingEnabled', 'workflowKeywordTriggerEnabled', 'outputStyle', 'autoQuestion'])
const RESERVED_PROVIDER_PATHS = new Set(['settings', 'cc-switch', 'test', 'models', 'presets', 'auth-status', 'official', 'reorder'])
const REMOTE_COMPATIBILITY_KEYS = new Set(['maxOutputTokens', 'outputTokenLimit', 'outputTokenField', 'sampling', 'reasoning', 'parallelTools', 'structuredOutput'])

/** The browser replaces the fields it can edit, while hidden extensions stay on the desktop. */
export function replaceRemoteCompatibility(current: RequestCompatibility | undefined, input: Record<string, unknown> | null) {
  const hidden = Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => !REMOTE_COMPATIBILITY_KEYS.has(key)))
  const editable = Object.fromEntries(Object.entries(input ?? {}).filter(([key]) => REMOTE_COMPATIBILITY_KEYS.has(key)))
  const result = { ...hidden, ...editable }
  return Object.keys(result).length ? result : null
}

export function remoteProviderRouteAllowed(parts: string[], method: string): boolean {
  const id = parts[2]
  if (!id) return method === 'GET' || method === 'POST'
  if (parts.length === 3) {
    if (['presets', 'auth-status'].includes(id)) return method === 'GET'
    if (id === 'official') return method === 'POST'
    if (id === 'reorder') return method === 'PUT'
    return !RESERVED_PROVIDER_PATHS.has(id) && ['GET', 'PUT', 'DELETE'].includes(method)
  }
  return parts.length === 4 && !RESERVED_PROVIDER_PATHS.has(id) && parts[3] === 'activate' && method === 'POST'
}

export function remoteSettingsRouteAllowed(parts: string[], method: string): boolean {
  return parts.length === 3 && parts[2] === 'user' && ['GET', 'PUT'].includes(method)
}

export function projectRemoteSettings(settings: Record<string, unknown>) {
  return {
    ...Object.fromEntries(READ_SETTINGS.filter(key => ['string', 'boolean', 'number'].includes(typeof settings[key])).map(key => [key, settings[key]])),
    ...(settings.autoQuestion !== undefined
      ? { autoQuestion: normalizeAutoQuestionSettings(settings.autoQuestion) }
      : {}),
  }
}

export function validateRemoteSettingsPatch(input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([key, value]) => {
    if (!WRITE_SETTINGS.has(key)) return false
    if (key === 'language') return typeof value === 'string' && value.length <= 80
    if (key === 'outputStyle') return typeof value === 'string' && ['default', 'Explanatory', 'Learning'].includes(value)
    if (key === 'chatSendBehavior') return value === 'enter' || value === 'modifierEnter'
    if (key === 'autoQuestion') return value !== null && typeof value === 'object' &&
      !Array.isArray(value) && Object.keys(value).length === 2 &&
      Object.keys(value).every((field) => field === 'enabled' || field === 'timeoutMinutes') &&
      typeof (value as Record<string, unknown>).enabled === 'boolean' &&
      AUTO_QUESTION_TIMEOUT_OPTIONS.some((minutes) => minutes === (value as Record<string, unknown>).timeoutMinutes)
    return typeof value === 'boolean'
  })
}

export function projectRemoteProvider(provider: SavedProvider) {
  const publicKeys = [
    'id', 'presetId', 'name', 'authStrategy', 'baseUrl', 'apiFormat', 'runtimeKind', 'models',
    'model1mSupport', 'autoCompactWindow', 'modelContextWindows', 'toolSearchEnabled',
    'disableExperimentalBetas', 'supportsNestedToolResultMedia', 'notes',
  ] as const
  return {
    ...Object.fromEntries(publicKeys.filter(key => provider[key] !== undefined).map(key => [key, provider[key]])),
    apiKey: '',
    hasApiKey: !!provider.apiKey,
    // Proxy URLs can include authentication and private endpoints. The phone
    // needs only the mode; an omitted edit retains the desktop's full value.
    ...(provider.proxy ? { proxy: { mode: provider.proxy.mode } } : {}),
    ...(provider.requestCompatibility ? {
      requestCompatibility: Object.fromEntries([...REMOTE_COMPATIBILITY_KEYS].filter(key => provider.requestCompatibility![key] !== undefined).map(key => [key, provider.requestCompatibility![key]])),
    } : {}),
    ...(provider.imageGeneration ? {
      imageGeneration: {
        protocol: provider.imageGeneration.protocol ?? 'openai_images',
        model: provider.imageGeneration.model,
        ...(provider.imageGeneration.baseUrl !== undefined ? { baseUrl: provider.imageGeneration.baseUrl } : {}),
        apiKey: '', hasApiKey: !!provider.imageGeneration.apiKey,
      },
    } : {}),
  }
}

const asRecords = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)) : []

/** Copies the listed keys whose value is a string, boolean or number; nothing nested survives. */
function pickScalars(source: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter(key => ['string', 'boolean', 'number'].includes(typeof source[key])).map(key => [key, source[key]]))
}

const CONNECTOR_PUBLIC_KEYS = [
  'id', 'displayName', 'description', 'category', 'transport', 'status', 'connection',
  'supported', 'installed', 'enabled', 'accountLabel', 'collection', 'pluginId',
] as const

/**
 * `GET /api/connectors` for a paired phone. The phone only shows which services
 * are connected or need attention, so OAuth links (`operation.authUrl`), error
 * text (can carry paths or command output), setup fields and package metadata
 * stay on the desktop. `operation` shrinks to its kind and phase, which is
 * enough to tell that a setup is in progress.
 */
export function projectRemoteConnectors(body: Record<string, unknown>) {
  return {
    items: asRecords(body.items).map(connector => {
      const operation = connector.operation && typeof connector.operation === 'object' && !Array.isArray(connector.operation)
        ? pickScalars(connector.operation as Record<string, unknown>, ['kind', 'phase'])
        : undefined
      return { ...pickScalars(connector, CONNECTOR_PUBLIC_KEYS), ...(operation ? { operation } : {}) }
    }),
  }
}

/** `GET /api/workflows`: names and descriptions to run by `/name`; script paths stay on the desktop. */
export function projectRemoteWorkflows(body: Record<string, unknown>) {
  return {
    workflows: asRecords(body.workflows).map(workflow => pickScalars(workflow, ['name', 'description', 'whenToUse', 'source'])),
  }
}

const AGENT_PUBLIC_KEYS = ['agentType', 'description', 'modelDisplay', 'color', 'source', 'isActive'] as const
const projectRemoteAgent = (agent: Record<string, unknown>) => pickScalars(agent, AGENT_PUBLIC_KEYS)

/**
 * `GET /api/agents` and `/api/agents/:name` for a paired native app: the
 * picker needs the type, description and colour. System prompts, definition
 * file paths and tool lists stay on the desktop.
 */
export function projectRemoteAgents(body: Record<string, unknown>) {
  if (body.agent && typeof body.agent === 'object' && !Array.isArray(body.agent)) {
    return { agent: projectRemoteAgent(body.agent as Record<string, unknown>) }
  }
  return {
    activeAgents: asRecords(body.activeAgents).map(projectRemoteAgent),
    allAgents: asRecords(body.allAgents).map(agent => ({
      ...projectRemoteAgent(agent),
      ...pickScalars(agent, ['overriddenBy']),
    })),
  }
}
