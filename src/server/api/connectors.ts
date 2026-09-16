import type { ConnectorAction, ConnectorActionOptions } from '../../services/connectors/types.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getConnectorService, ConnectorServiceError, type ConnectorService } from '../services/connectorService.js'

const actions = new Set(['prepare', 'authenticate', 'check', 'cancel', 'deactivate', 'remove'])

export function createConnectorsApi(getService: () => Promise<Pick<ConnectorService, 'list' | 'get' | 'action'>>) {
  return async (req: Request, _url: URL, segments: string[]): Promise<Response> => {
    try {
      const id = segments[2]
      const action = segments[3]
      if (segments.length > 4 || (action && !actions.has(action))) throw ApiError.notFound('Unknown connector endpoint')
      if (req.method === 'GET' && !action) {
        const service = await getService()
        return Response.json(id ? { connector: service.get(id) } : { items: service.list() })
      }
      if (req.method !== 'POST' || !id || !action) throw new ApiError(405, 'Method not allowed', 'METHOD_NOT_ALLOWED')
      let body: unknown
      try { body = await req.json() } catch { throw ApiError.badRequest('Expected a JSON object') }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw ApiError.badRequest('Expected a JSON object')
      const options = body as Record<string, unknown>
      if (Object.keys(options).some(key => !['acknowledgeSharedCredentials', 'sessionId', 'configuration'].includes(key))) throw ApiError.badRequest('Unknown connector action field')
      if ('acknowledgeSharedCredentials' in options && typeof options.acknowledgeSharedCredentials !== 'boolean') throw ApiError.badRequest('acknowledgeSharedCredentials must be a boolean')
      if ('sessionId' in options && (typeof options.sessionId !== 'string' || !options.sessionId.trim() || options.sessionId.length > 256)) throw ApiError.badRequest('Invalid sessionId')
      if ('configuration' in options) {
        if (!['prepare', 'authenticate'].includes(action)) throw ApiError.badRequest('Configuration is only accepted during setup or authentication')
        const config = options.configuration
        if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length > 8 || Object.entries(config).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value))) throw ApiError.badRequest('Invalid connector configuration')
      }
      const service = await getService()
      return Response.json({ connector: service.action(id, action as ConnectorAction, options as ConnectorActionOptions) }, { status: 202 })
    } catch (error) { return errorResponse(error instanceof ConnectorServiceError ? new ApiError(error.statusCode, error.message, error.statusCode === 409 ? 'CONFLICT' : error.statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST') : error) }
  }
}

export const handleConnectorsApi = createConnectorsApi(getConnectorService)
