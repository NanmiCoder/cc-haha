export function buildOpenAIEndpointUrl(baseUrl: string, endpoint: 'chat/completions' | 'responses'): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const versionedBaseUrl = /\/v1$/i.test(normalizedBaseUrl)
    ? normalizedBaseUrl
    : `${normalizedBaseUrl}/v1`
  return `${versionedBaseUrl}/${endpoint}`
}
