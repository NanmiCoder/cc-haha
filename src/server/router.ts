/**
 * API Router — 将请求路由到对应的 API handler
 */

import { handleSessionsApi } from './api/sessions.js'
import { handleSettingsApi } from './api/settings.js'
import { handleModelsApi } from './api/models.js'
import { handleScheduledTasksApi } from './api/scheduled-tasks.js'
import { handleSearchApi } from './api/search.js'
import { handleAgentsApi } from './api/agents.js'
import { handleStatusApi } from './api/status.js'
import { handleConversationsApi } from './api/conversations.js'
import { handleTeamsApi } from './api/teams.js'
import { handleFilesystemRoute } from './api/filesystem.js'
import { handleProvidersApi } from './api/providers.js'
import { handlePluginsApi } from './api/plugins.js'
import { handleSkillsApi } from './api/skills.js'
import { handleMarketApi } from './api/market.js'
import { handleComputerUseApi } from './api/computer-use.js'
import { handleHahaOAuthApi } from './api/haha-oauth.js'
import { handleHahaOpenAIOAuthApi } from './api/haha-openai-oauth.js'
import { handleHahaGrokOAuthApi } from './api/haha-grok-oauth.js'
import { handleMcpApi } from './api/mcp.js'
import { handleDiagnosticsApi } from './api/diagnostics.js'
import { handleDoctorApi } from './api/doctor.js'
import { handleH5AccessApi } from './api/h5-access.js'
import { handleActivityStatsApi } from './api/activityStats.js'
import { handleOpenTargetsApi } from './api/open-targets.js'
import { handleMemoryApi } from './api/memory.js'
import { handleDesktopUiApi } from './api/desktop-ui.js'
import { handleTracesApi } from './api/traces.js'
import { handleWorkflowsApi } from './api/workflows.js'

import { remoteProviderRouteAllowed, remoteSettingsRouteAllowed, projectRemoteProvider, projectRemoteSettings, replaceRemoteCompatibility, validateRemoteSettingsPatch, type ApiRequestContext } from './remoteBrowserPolicy.js'
import { ProviderService } from './services/providerService.js'
import type { SavedProvider } from './types/provider.js'
import { remoteProviderNeedsCredentials } from './remoteProviderCredentials.js'

export async function handleApiRequest(req: Request, url: URL, context: ApiRequestContext = {}): Promise<Response> {
  if (!context.remoteBrowser) return routeApiRequest(req, url)
  const parts = url.pathname.split('/').filter(Boolean)
  const isProvider = parts[1] === 'providers'
  const isSettings = parts[1] === 'settings'
  if (!isProvider && !isSettings) return routeApiRequest(req, url)
  if ((isProvider && !remoteProviderRouteAllowed(parts, req.method)) || (isSettings && !remoteSettingsRouteAllowed(parts, req.method))) {
    return Response.json({ error: 'Desktop-only capability' }, { status: 403 })
  }
  try {
    const createsProvider = isProvider && parts.length === 2 && req.method === 'POST'
    if (createsProvider || (req.method === 'PUT' && (isSettings || (isProvider && parts.length === 3 && parts[2] !== 'reorder')))) {
      const body: unknown = await req.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Object required' }, { status: 400 })
      const input = { ...body } as Record<string, unknown>
      if (isSettings && !validateRemoteSettingsPatch(input)) return Response.json({ error: 'Unsupported General setting' }, { status: 400 })
      if (isProvider) {
        const saved = createsProvider ? undefined : await new ProviderService().getProvider(parts[2]!)
        if (saved && remoteProviderNeedsCredentials(saved, input)) {
          return Response.json({ error: 'Changing a credential destination requires an explicit API key', code: 'REMOTE_PROVIDER_CREDENTIAL_REQUIRED' }, { status: 400 })
        }
        // Empty fields mean retain the saved secret, never replace with the redacted placeholder.
        if (!createsProvider && input.apiKey === '') delete input.apiKey
        if (input.requestCompatibility === null || (input.requestCompatibility && typeof input.requestCompatibility === 'object' && !Array.isArray(input.requestCompatibility))) {
          input.requestCompatibility = replaceRemoteCompatibility(saved?.requestCompatibility, input.requestCompatibility as Record<string, unknown> | null)
          if (createsProvider && input.requestCompatibility === null) delete input.requestCompatibility
        }
        if (input.imageGeneration && typeof input.imageGeneration === 'object' && !Array.isArray(input.imageGeneration)) {
          const image = { ...input.imageGeneration } as Record<string, unknown>
          if (!createsProvider && (image.apiKey === '' || image.apiKey === undefined)) {
            image.apiKey = saved?.imageGeneration?.apiKey
          }
          input.imageGeneration = image
        }
      }
      req = new Request(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(input) })
    }
    const response = await routeApiRequest(req, url)
    if (!response.ok) return response
    const body = await response.json() as Record<string, unknown>
    if (isSettings && req.method === 'GET') return Response.json(projectRemoteSettings(body))
    if (isProvider) {
      if (Array.isArray(body.providers)) body.providers = (body.providers as SavedProvider[]).map(projectRemoteProvider)
      if (body.provider && typeof body.provider === 'object') body.provider = projectRemoteProvider(body.provider as SavedProvider)
    }
    return Response.json(body, { status: response.status })
  } catch {
    return Response.json({ error: 'Remote settings request failed' }, { status: 400 })
  }
}

async function routeApiRequest(req: Request, url: URL): Promise<Response> {
  const path = url.pathname
  const segments = path.split('/').filter(Boolean) // ['api', 'sessions', ...]

  // Route to appropriate handler based on the second segment
  const resource = segments[1]

  switch (resource) {
    case 'sessions': {
      // Route /api/sessions/:id/chat/* to conversations handler
      const subResource = segments[3]
      if (subResource === 'chat') {
        return handleConversationsApi(req, url, segments)
      }
      return handleSessionsApi(req, url, segments)
    }

    case 'conversations':
      return handleConversationsApi(req, url, segments)

    case 'settings':
      return handleSettingsApi(req, url, segments)

    case 'models':
    case 'effort':
      return handleModelsApi(req, url, segments)

    case 'permissions':
      return handleSettingsApi(req, url, segments) // permissions under settings

    case 'scheduled-tasks':
      return handleScheduledTasksApi(req, url, segments)

    case 'search':
      return handleSearchApi(req, url, segments)

    case 'agents':
    case 'tasks':
      return handleAgentsApi(req, url, segments)

    case 'status':
      return handleStatusApi(req, url, segments)

    case 'teams':
      return handleTeamsApi(req, url, segments)

    case 'workflows':
      return handleWorkflowsApi(req, url, segments)

    case 'providers':
      return handleProvidersApi(req, url, segments)

    case 'haha-oauth':
      return handleHahaOAuthApi(req, url, segments)

    case 'haha-openai-oauth':
      return handleHahaOpenAIOAuthApi(req, url, segments)

    case 'haha-grok-oauth':
      return handleHahaGrokOAuthApi(req, url, segments)

    case 'adapters':
      // Adapter protocols pull in platform SDKs that are unnecessary for the
      // core server path. Load them only when this API is actually used.
      return (await import('./api/adapters.js')).handleAdaptersApi(req, url, segments)

    case 'skills':
      return handleSkillsApi(req, url, segments)

    case 'market':
      return handleMarketApi(req, url, segments)

    case 'mcp':
      return handleMcpApi(req, url, segments)

    case 'connectors':
      return (await import('./api/connectors.js')).handleConnectorsApi(req, url, segments)

    case 'plugins':
      return handlePluginsApi(req, url, segments)

    case 'computer-use':
      return handleComputerUseApi(req, url, segments)

    case 'diagnostics':
      return handleDiagnosticsApi(req, url, segments)

    case 'doctor':
      return handleDoctorApi(req, url, segments)

    case 'h5-access':
      return handleH5AccessApi(req, url, segments)

    case 'activity-stats':
      return handleActivityStatsApi(req, url, segments)

    case 'open-targets':
      return handleOpenTargetsApi(req, url, segments)

    case 'memory':
      return handleMemoryApi(req, url, segments)

    case 'desktop-ui':
      return handleDesktopUiApi(req, url, segments)

    case 'traces':
      return handleTracesApi(req, url, segments)

    case 'filesystem':
      return handleFilesystemRoute(url.pathname, url)

    default:
      return Response.json(
        { error: 'Not Found', message: `Unknown API resource: ${resource}` },
        { status: 404 }
      )
  }
}
