/**
 * Endpoint builders for AWS Bedrock Runtime Converse API (`Converse` / `ConverseStream`)
 * and control-plane model listing (`ListFoundationModels`).
 */

const BEDROCK_RUNTIME_HOST_RE = /^bedrock-runtime\.([a-z]{2}(?:-[a-z]+)+-\d+)\.amazonaws\.com(?:\.cn)?$/i
const BEDROCK_CONTROL_HOST_RE = /^bedrock\.([a-z]{2}(?:-[a-z]+)+-\d+)\.amazonaws\.com(?:\.cn)?$/i
const BEDROCK_CONVERSE_ACTION_RE = /\/model\/[^/]+\/converse(?:-stream)?$/i

/**
 * Infer the AWS region for SigV4 signing from the endpoint hostname, explicit
 * credential region, or ambient AWS environment variables.
 */
export function extractBedrockRegion(
  baseUrl: string,
  explicitRegion?: string,
): string {
  const fromCredential = explicitRegion?.trim()
  if (fromCredential) return fromCredential

  try {
    const { hostname } = new URL(baseUrl)
    const runtimeMatch = hostname.match(BEDROCK_RUNTIME_HOST_RE)
    if (runtimeMatch?.[1]) return runtimeMatch[1].toLowerCase()
    const controlMatch = hostname.match(BEDROCK_CONTROL_HOST_RE)
    if (controlMatch?.[1]) return controlMatch[1].toLowerCase()
  } catch {
    // Custom or partial URLs fall back to env/default below.
  }

  return (
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    'us-east-1'
  )
}

/**
 * Build an AWS Bedrock Runtime Converse or ConverseStream URL.
 *
 * Accepts standard regional roots (`https://bedrock-runtime.us-east-1.amazonaws.com`),
 * custom gateways (`http://127.0.0.1:4321`, `https://gw.internal/bedrock`), or a
 * full action URL (`.../model/<id>/converse[-stream]`). Model IDs (including
 * cross-region inference profiles and ARNs) are percent-encoded as a single path
 * segment, matching AWS Bedrock Runtime and `@ai-sdk/amazon-bedrock`.
 */
export function buildBedrockConverseEndpoint(
  baseUrl: string,
  modelId: string,
  stream = false,
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const encodedModel = encodeURIComponent(modelId.trim())
  const action = stream ? 'converse-stream' : 'converse'

  if (BEDROCK_CONVERSE_ACTION_RE.test(trimmed)) {
    return trimmed.replace(BEDROCK_CONVERSE_ACTION_RE, `/model/${encodedModel}/${action}`)
  }
  return `${trimmed}/model/${encodedModel}/${action}`
}

/**
 * Derive candidate URLs for listing Bedrock foundation models.
 *
 * On AWS, `ListFoundationModels` lives on the control-plane host
 * `bedrock.<region>.amazonaws.com` rather than `bedrock-runtime.<region>.amazonaws.com`.
 * Custom gateways/proxies keep their own base URL.
 */
export function buildBedrockModelsEndpoints(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return []

  try {
    const parsed = new URL(trimmed)
    const runtimeMatch = parsed.hostname.match(BEDROCK_RUNTIME_HOST_RE)
    if (runtimeMatch) {
      const controlUrl = new URL(trimmed)
      controlUrl.hostname = parsed.hostname.replace(/^bedrock-runtime\./i, 'bedrock.')
      controlUrl.pathname = '/foundation-models'
      controlUrl.search = ''
      return [controlUrl.toString()]
    }
  } catch {
    // Fall through to path-based candidates.
  }

  const base = trimmed.replace(BEDROCK_CONVERSE_ACTION_RE, '')
  return [`${base}/foundation-models`, `${base}/v1/models`]
}
