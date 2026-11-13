import { getRemoteRecipe, REMOTE_CONNECTORS } from '../../../src/services/connectors/remoteCatalog'

export const CONNECTOR_PROXY_FIXTURE_ENDPOINT = 'https://mcp.blocked.test/mcp'

/** Process-local fixture data; production catalog files remain unchanged. */
export function configureConnectorProxyFixture(endpoint: string | undefined, platform = `${process.platform}-${process.arch}`) {
  if (endpoint !== CONNECTOR_PROXY_FIXTURE_ENDPOINT) throw new Error('Connector fixture requires its reserved HTTPS endpoint')
  const recipe = getRemoteRecipe('huggingface')
  const definition = REMOTE_CONNECTORS.find(item => item.id === 'huggingface')
  if (!recipe || !definition) throw new Error('Missing Hugging Face connector fixture')
  recipe.endpoint = endpoint
  if (!definition.platforms.includes(platform)) definition.platforms = [...definition.platforms, platform]
  return recipe
}

const actionKinds = new Set(['prepare', 'authenticate', 'check', 'cancel', 'deactivate', 'remove'])
const errorCodes = new Set(['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR', 'ERROR'])
const errorMessages = new Set([
  'Unknown connector endpoint', 'Method not allowed', 'Expected a JSON object', 'Unknown connector action field',
  'acknowledgeSharedCredentials must be a boolean', 'Invalid sessionId', 'Invalid connector configuration',
  'Configuration is only accepted during setup or authentication', 'Unknown connector', 'No operation to cancel',
  'A connector operation is already running', 'Connector is not supported on this platform',
  'Confirm shared credentials before connecting', 'Connector is already installed', 'Prepare this connector first',
  'Use authentication to change credentials on an installed connector', 'An unexpected error occurred',
])

/** Keep actionable API diagnostics without echoing arbitrary response/request data. */
export function connectorActionFailure(kind: string, status: number, payload: unknown) {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  return {
    kind: actionKinds.has(kind) ? kind : 'unknown', status,
    error: typeof body.error === 'string' && errorCodes.has(body.error) ? body.error : 'UNKNOWN',
    message: typeof body.message === 'string' && errorMessages.has(body.message) ? body.message : 'Unexpected connector API response',
  }
}
