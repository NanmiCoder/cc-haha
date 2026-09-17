import type {
  HostManagementResult,
  ManagedContextStageRequest,
  ManagedContextTicketRef,
} from '../../../src/features/managed-resources/api/hostManagementApi.js'

const STAGE_TIMEOUT_MS = 10_000

export type ContextTicketClient = {
  stage(request: ManagedContextStageRequest): Promise<HostManagementResult<ManagedContextTicketRef>>
}

export type ContextTicketClientOptions = {
  getServerUrl: () => Promise<string>
  getLocalAccessToken: () => string | null
  fetchImpl?: typeof fetch
}

function failure(code: string, params?: Record<string, unknown>): HostManagementResult<ManagedContextTicketRef> {
  return {
    ok: false,
    error: {
      code,
      messageKey: code === 'CONTEXT_STAGE_UNAVAILABLE'
        ? 'managedResources.errors.contextStageUnavailable'
        : 'managedResources.errors.contextStageFailed',
      ...(params ? { params } : {}),
    },
  }
}

function stageUrl(serverUrl: string): string | null {
  let url: URL
  try {
    url = new URL(serverUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]' && url.hostname !== '::1') return null
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/context-tickets`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function createContextTicketClient(options: ContextTicketClientOptions): ContextTicketClient {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async stage(request) {
      const token = options.getLocalAccessToken()
      if (!token) return failure('CONTEXT_STAGE_UNAVAILABLE')

      let serverUrl: string
      try {
        serverUrl = await options.getServerUrl()
      } catch {
        return failure('CONTEXT_STAGE_UNAVAILABLE')
      }
      const url = stageUrl(serverUrl)
      if (!url) return failure('CONTEXT_STAGE_UNAVAILABLE')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), STAGE_TIMEOUT_MS)
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
        })
        const body = await response.json().catch(() => ({})) as Record<string, unknown>
        if (!response.ok) {
          const code = typeof body.code === 'string'
            ? body.code
            : typeof body.error === 'string' ? body.error : 'CONTEXT_STAGE_FAILED'
          return failure(code, { status: response.status })
        }
        if (
          typeof body.ticketId !== 'string'
          || typeof body.sidecarInstanceId !== 'string'
          || typeof body.expiresAt !== 'string'
        ) {
          return failure('INVALID_STAGE_RESPONSE')
        }
        return {
          ok: true,
          data: {
            ticketId: body.ticketId,
            sidecarInstanceId: body.sidecarInstanceId,
            expiresAt: body.expiresAt,
          },
        }
      } catch {
        return failure('CONTEXT_STAGE_UNAVAILABLE')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
