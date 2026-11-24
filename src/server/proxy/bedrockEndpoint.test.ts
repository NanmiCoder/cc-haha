import { describe, expect, test } from 'bun:test'
import {
  buildBedrockConverseEndpoint,
  buildBedrockModelsEndpoints,
  extractBedrockRegion,
} from './bedrockEndpoint.js'

describe('bedrockEndpoint', () => {
  test('builds Converse and ConverseStream URLs and encodes model IDs', () => {
    expect(
      buildBedrockConverseEndpoint('https://bedrock-runtime.us-east-1.amazonaws.com', 'anthropic.claude-sonnet-4-6-v1:0', false),
    ).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-6-v1%3A0/converse')

    expect(
      buildBedrockConverseEndpoint('https://bedrock-runtime.us-west-2.amazonaws.com/', 'us.anthropic.claude-opus-4-6-v1:0', true),
    ).toBe('https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-opus-4-6-v1%3A0/converse-stream')

    // ARN model IDs encode slashes and colons as a single path segment
    expect(
      buildBedrockConverseEndpoint(
        'https://bedrock-runtime.eu-west-1.amazonaws.com',
        'arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-4-6',
        true,
      ),
    ).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aeu-west-1%3A123456789012%3Ainference-profile%2Feu.anthropic.claude-sonnet-4-6/converse-stream',
    )

    // Replaces existing action suffix when a full action URL is provided
    expect(
      buildBedrockConverseEndpoint(
        'http://127.0.0.1:4321/model/old-model/converse',
        'amazon.nova-pro-v1:0',
        true,
      ),
    ).toBe('http://127.0.0.1:4321/model/amazon.nova-pro-v1%3A0/converse-stream')
  })

  test('extracts region from AWS hostnames or falls back to explicit credential region', () => {
    expect(extractBedrockRegion('https://bedrock-runtime.ap-northeast-1.amazonaws.com')).toBe('ap-northeast-1')
    expect(extractBedrockRegion('https://bedrock.eu-central-1.amazonaws.com')).toBe('eu-central-1')
    expect(extractBedrockRegion('http://127.0.0.1:4321', 'us-west-2')).toBe('us-west-2')
  })

  test('maps bedrock-runtime host to control-plane bedrock host for foundation model discovery', () => {
    expect(buildBedrockModelsEndpoints('https://bedrock-runtime.us-east-1.amazonaws.com')).toEqual([
      'https://bedrock.us-east-1.amazonaws.com/foundation-models',
    ])
    expect(buildBedrockModelsEndpoints('http://127.0.0.1:4321/bedrock')).toEqual([
      'http://127.0.0.1:4321/bedrock/foundation-models',
      'http://127.0.0.1:4321/bedrock/v1/models',
    ])
  })
})
