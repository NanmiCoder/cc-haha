import { describe, expect, test } from 'bun:test'

import { getImageGenerationRuntimeConfig } from './config.js'

const customEnv = {
  CC_HAHA_IMAGE_PROVIDER_KIND: 'openai_images',
  CC_HAHA_IMAGE_PROVIDER_ID: 'fixture-provider',
  CC_HAHA_IMAGE_MODEL: 'fixture-image-model',
  CC_HAHA_IMAGE_BASE_URL: 'https://images.example.test',
  CC_HAHA_IMAGE_API_KEY: 'fixture-key',
}

describe('image generation runtime protocol', () => {
  test('defaults the legacy image environment to the OpenAI Images protocol', () => {
    expect(getImageGenerationRuntimeConfig(customEnv)?.protocol).toBe('openai_images')
  })

  test.each(['openai_images', 'gemini_native', 'xai_images'])('reads explicit protocol %s', protocol => {
    expect(getImageGenerationRuntimeConfig({
      ...customEnv,
      CC_HAHA_IMAGE_PROTOCOL: ` ${protocol} `,
    })).toMatchObject({ kind: 'openai_images', protocol })
  })

  test.each(['future_protocol', '', '   '])('rejects an unknown protocol %j before any provider request', protocol => {
    expect(getImageGenerationRuntimeConfig({
      ...customEnv,
      CC_HAHA_IMAGE_PROTOCOL: protocol,
    })).toBeNull()
  })

  test.each(['openai_oauth', 'grok_oauth'])('ignores stale custom protocol for %s', kind => {
    const config = getImageGenerationRuntimeConfig({
      ...customEnv,
      CC_HAHA_IMAGE_PROVIDER_KIND: kind,
      CC_HAHA_IMAGE_PROTOCOL: 'gemini_native',
    })
    expect(config?.kind).toBe(kind)
    expect(config?.protocol).toBeUndefined()
  })
})
