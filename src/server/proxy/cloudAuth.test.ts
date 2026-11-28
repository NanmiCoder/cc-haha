import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import {
  buildBedrockRequestHeaders,
  buildOpenaiAuthHeaders,
  buildVertexServiceTierHeaders,
  parseBedrockCredential,
  parseVertexCredential,
  resolveVertexAuthHeaders,
} from './cloudAuth.js'

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

describe('Google Vertex AI auth and service-tier headers', () => {
  test('parses Express Mode API key, OAuth2 ya29 token, Service Account JSON, and ADC', () => {
    expect(parseVertexCredential('AQ.Ab8RN6-express-key', 'api_key', 'https://aiplatform.googleapis.com/v1/publishers/google')).toEqual({
      kind: 'api_key',
      apiKey: 'AQ.Ab8RN6-express-key',
    })

    // Custom preset defaults to authStrategy: 'auth_token'; Express keys and bare aiplatform root must still use x-goog-api-key.
    expect(parseVertexCredential('AQ.Ab8RN6-express-key', 'auth_token', 'https://aiplatform.googleapis.com')).toEqual({
      kind: 'api_key',
      apiKey: 'AQ.Ab8RN6-express-key',
    })
    expect(parseVertexCredential('AIzaSyExpressKey123', 'auth_token', 'https://us-central1-aiplatform.googleapis.com')).toEqual({
      kind: 'api_key',
      apiKey: 'AIzaSyExpressKey123',
    })
    expect(parseVertexCredential('opaque-express-key', 'auth_token', 'https://aiplatform.googleapis.com')).toEqual({
      kind: 'api_key',
      apiKey: 'opaque-express-key',
    })
    expect(parseVertexCredential('Bearer explicit-vertex-token', 'api_key', 'https://aiplatform.googleapis.com')).toEqual({
      kind: 'bearer',
      token: 'explicit-vertex-token',
    })

    expect(parseVertexCredential('ya29.a0AfH6SM-mock-token', 'api_key')).toEqual({
      kind: 'bearer',
      token: 'ya29.a0AfH6SM-mock-token',
    })

    expect(
      parseVertexCredential('my-oauth-token', 'auth_token', 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1'),
    ).toEqual({
      kind: 'bearer',
      token: 'my-oauth-token',
    })

    const saJson = JSON.stringify({
      type: 'service_account',
      project_id: 'demo-proj',
      client_email: 'bot@demo-proj.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----\n',
    })
    const parsedSa = parseVertexCredential(saJson)
    expect(parsedSa.kind).toBe('service_account')
    if (parsedSa.kind === 'service_account') {
      expect(parsedSa.credentials.client_email).toBe('bot@demo-proj.iam.gserviceaccount.com')
      expect(parsedSa.credentials.project_id).toBe('demo-proj')
    }

    expect(parseVertexCredential('adc')).toEqual({ kind: 'adc' })
    expect(parseVertexCredential('gcloud-adc')).toEqual({ kind: 'adc' })
    expect(parseVertexCredential('')).toEqual({ kind: 'adc' })
  })

  test('resolves x-goog-api-key for Express Mode and Authorization Bearer for OAuth/SA/ADC', async () => {
    expect(await resolveVertexAuthHeaders('AQ.express-123', 'api_key', 'https://aiplatform.googleapis.com/v1/publishers/google')).toEqual({
      'x-goog-api-key': 'AQ.express-123',
    })

    expect(await resolveVertexAuthHeaders('ya29.direct-token')).toEqual({
      Authorization: 'Bearer ya29.direct-token',
    })

    const saJson = JSON.stringify({
      client_email: 'runner@proj.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
    })
    const saHeaders = await resolveVertexAuthHeaders(saJson, 'api_key', '', {
      getAccessToken: async (parsed) => {
        expect(parsed.kind).toBe('service_account')
        return 'ya29.minted-from-sa'
      },
    })
    expect(saHeaders).toEqual({ Authorization: 'Bearer ya29.minted-from-sa' })

    const adcHeaders = await resolveVertexAuthHeaders('adc', 'api_key', '', {
      getAccessToken: async (parsed) => {
        expect(parsed.kind).toBe('adc')
        return 'ya29.minted-from-adc'
      },
    })
    expect(adcHeaders).toEqual({ Authorization: 'Bearer ya29.minted-from-adc' })
  })

  test('maps service tiers to Vertex PayGo headers', () => {
    expect(buildVertexServiceTierHeaders('flex')).toEqual({
      'X-Vertex-AI-LLM-Request-Type': 'shared',
      'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
    })
    expect(buildVertexServiceTierHeaders('priority')).toEqual({
      'X-Vertex-AI-LLM-Request-Type': 'shared',
      'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
    })
    expect(buildVertexServiceTierHeaders('default')).toEqual({})
    expect(buildVertexServiceTierHeaders('auto')).toEqual({})
    expect(buildVertexServiceTierHeaders(undefined)).toEqual({})
  })
})

describe('AWS Bedrock auth (Bearer API Key + SigV4)', () => {
  test('parses Bedrock API keys, colon SigV4 credentials, JSON credentials, and ambient env', () => {
    expect(parseBedrockCredential('ABSKQmVkcm9ja0FQSUtleQ==')).toEqual({
      kind: 'bearer',
      token: 'ABSKQmVkcm9ja0FQSUtleQ==',
    })

    expect(parseBedrockCredential('AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toEqual({
      kind: 'sigv4',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    })

    expect(parseBedrockCredential('ASIAIOSFODNN7EXAMPLE:secret-key:session-tok:with:colons')).toEqual({
      kind: 'sigv4',
      credentials: {
        accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'secret-key',
        sessionToken: 'session-tok:with:colons',
      },
    })

    expect(
      parseBedrockCredential(JSON.stringify({
        accessKeyId: 'AKIA1234567890ABCDEF',
        secretAccessKey: 'secret-json',
        sessionToken: 'tok-json',
        region: 'eu-central-1',
      })),
    ).toEqual({
      kind: 'sigv4',
      credentials: {
        accessKeyId: 'AKIA1234567890ABCDEF',
        secretAccessKey: 'secret-json',
        sessionToken: 'tok-json',
        region: 'eu-central-1',
      },
    })

    expect(parseBedrockCredential('aws-env', { AWS_BEARER_TOKEN_BEDROCK: 'env-bearer-key' })).toEqual({
      kind: 'bearer',
      token: 'env-bearer-key',
    })

    expect(
      parseBedrockCredential('aws-env', {
        AWS_ACCESS_KEY_ID: 'AKIAENV1234567890ABC',
        AWS_SECRET_ACCESS_KEY: 'env-secret',
        AWS_SESSION_TOKEN: 'env-session',
        AWS_REGION: 'ap-northeast-1',
      }),
    ).toEqual({
      kind: 'sigv4',
      credentials: {
        accessKeyId: 'AKIAENV1234567890ABC',
        secretAccessKey: 'env-secret',
        sessionToken: 'env-session',
        region: 'ap-northeast-1',
      },
    })

    expect(() => parseBedrockCredential('aws-env', {})).toThrow(/AWS Bedrock credentials are missing/)
  })

  test('produces a cryptographically valid AWS SigV4 signature for Bedrock Runtime', async () => {
    const accessKeyId = 'AKIAIOSFODNN7EXAMPLE'
    const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const sessionToken = 'FwoGZXIvYXdzEBYaDMOCKSESSIONTOKEN'
    const url = 'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-sonnet-4-6-v1%3A0/converse-stream'
    const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hi' }] }] })
    const signingDate = new Date('2026-11-24T12:00:00Z')

    const headers = await buildBedrockRequestHeaders({
      url,
      method: 'POST',
      body,
      rawCredential: `${accessKeyId}:${secretAccessKey}:${sessionToken}`,
      baseHeaders: { 'Content-Type': 'application/json' },
      signingDate,
    })

    expect(headers['x-amz-date']).toBe('20261124T120000Z')
    expect(headers['x-amz-security-token']).toBe(sessionToken)
    expect(headers['x-amz-content-sha256']).toBe(sha256Hex(body))

    const auth = headers.authorization ?? headers.Authorization
    expect(auth).toBeDefined()
    const match = auth!.match(/^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(`${accessKeyId}/20261124/us-west-2/bedrock/aws4_request`)

    // Independently recompute the AWS SigV4 signature per official AWS specification
    const signedHeaderNames = match![2]!.split(';')
    const lowerMap: Record<string, string> = { host: 'bedrock-runtime.us-west-2.amazonaws.com' }
    for (const [k, v] of Object.entries(headers)) lowerMap[k.toLowerCase()] = v
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${lowerMap[name]!.trim()}\n`).join('')
    // AWS SigV4 double-encodes non-S3 URI path segments (%3A -> %253A)
    const canonicalUri = '/model/us.anthropic.claude-sonnet-4-6-v1%253A0/converse-stream'
    const canonicalRequest = [
      'POST',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaderNames.join(';'),
      sha256Hex(body),
    ].join('\n')
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      '20261124T120000Z',
      '20261124/us-west-2/bedrock/aws4_request',
      sha256Hex(canonicalRequest),
    ].join('\n')
    const kDate = hmac(`AWS4${secretAccessKey}`, '20261124')
    const kRegion = hmac(kDate, 'us-west-2')
    const kService = hmac(kRegion, 'bedrock')
    const kSigning = hmac(kService, 'aws4_request')
    const expectedSignature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
    expect(match![3]).toBe(expectedSignature)
  })
})

describe('Azure OpenAI auth header resolution', () => {
  test('uses api-key for Azure OpenAI endpoints and Bearer for Entra ID or standard OpenAI', () => {
    expect(buildOpenaiAuthHeaders({
      url: 'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
      apiKey: 'azure-secret-key',
      authStrategy: 'api_key',
    })).toEqual({ 'api-key': 'azure-secret-key' })

    expect(buildOpenaiAuthHeaders({
      url: 'https://my-res.services.ai.azure.com/openai/v1/responses',
      apiKey: 'foundry-key',
    })).toEqual({ 'api-key': 'foundry-key' })

    // Custom preset defaults to authStrategy: 'auth_token', so opaque Azure API keys must still send `api-key`.
    expect(buildOpenaiAuthHeaders({
      url: 'https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
      apiKey: 'azure-secret-key',
      authStrategy: 'auth_token',
    })).toEqual({ 'api-key': 'azure-secret-key' })

    // Entra ID Bearer token via explicit Bearer prefix or JWT detection
    expect(buildOpenaiAuthHeaders({
      url: 'https://my-res.openai.azure.com/openai/v1/chat/completions',
      apiKey: 'Bearer entra-token',
      authStrategy: 'auth_token',
    })).toEqual({ Authorization: 'Bearer entra-token' })

    const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl'
    expect(buildOpenaiAuthHeaders({
      url: 'https://my-res.openai.azure.com/openai/v1/chat/completions',
      apiKey: fakeJwt,
      authStrategy: 'api_key',
    })).toEqual({ Authorization: `Bearer ${fakeJwt}` })

    // Custom proxy forced into azure_openai format
    expect(buildOpenaiAuthHeaders({
      url: 'http://127.0.0.1:4000/openai/v1/chat/completions',
      apiKey: 'corp-azure-key',
      forceAzure: true,
    })).toEqual({ 'api-key': 'corp-azure-key' })

    // Non-Azure OpenAI stays Bearer
    expect(buildOpenaiAuthHeaders({
      url: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-openai-123',
      authStrategy: 'api_key',
    })).toEqual({ Authorization: 'Bearer sk-openai-123' })
  })
})
