import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'
import { ModelBrandIcon, resolveModelBrand, type ModelBrandKey } from './ModelBrandIcon'

describe('resolveModelBrand', () => {
  it.each<[string, ModelBrandKey]>([
    ['claude-sonnet-4-6', 'claude'],
    ['claude-opus-5-5', 'claude'],
    ['anthropic/claude-sonnet-5.5', 'claude'],
    ['gpt-6-sol', 'openai'],
    ['gpt-5.3-codex', 'openai'],
    ['o3-mini', 'openai'],
    ['openai/gpt-5.6-luna', 'openai'],
    ['gemini-4-argon-contributor', 'gemini'],
    ['google/gemini-2.5-pro', 'gemini'],
    ['deepseek-flash[1m]', 'deepseek'],
    ['deepseek-ai/deepseek-v4-pro', 'deepseek'],
    ['grok-4.7', 'grok'],
    ['x-ai/grok-4.7', 'grok'],
    ['qwen3.7-max', 'qwen'],
    ['qwen/qwen3.6-27b', 'qwen'],
    ['glm-5.3[1m]', 'zhipu'],
    ['z-ai/glm-5.3', 'zhipu'],
    ['MiniMax-M3[1m]', 'minimax'],
    ['kimi-k2.7-code', 'kimi'],
    ['moonshotai/kimi-k3', 'kimi'],
    ['k3', 'kimi'],
    ['mistral-large', 'mistral'],
    ['meta-llama/llama-3.3-70b', 'meta'],
    ['doubao-seedream-5-0', 'doubao'],
    ['command-r-plus', 'cohere'],
    ['sonar-pro', 'perplexity'],
    ['hy4-preview', 'hunyuan'],
  ])('maps modelId %s to %s', (modelId, expected) => {
    expect(resolveModelBrand({ modelId })).toBe(expected)
  })

  it('prefers the model brand over a multi-model gateway provider', () => {
    expect(
      resolveModelBrand({
        modelId: 'anthropic/claude-sonnet-5.5',
        presetId: 'openrouter',
        providerName: 'OpenRouter',
      }),
    ).toBe('claude')
  })

  it('falls back to provider/preset metadata when modelId is absent or generic', () => {
    expect(resolveModelBrand({ providerId: 'claude-official' })).toBe('claude')
    expect(resolveModelBrand({ providerId: 'openai-official' })).toBe('openai')
    expect(resolveModelBrand({ providerId: 'grok-official' })).toBe('grok')
    expect(resolveModelBrand({ providerId: 'deepseek-account' })).toBe('deepseek')
    expect(resolveModelBrand({ presetId: 'openrouter', providerName: 'OpenRouter' })).toBe('openrouter')
    expect(resolveModelBrand({ presetId: 'ollama', providerName: 'Ollama' })).toBe('ollama')
    expect(resolveModelBrand({ presetId: 'lmstudio', providerName: 'LM Studio' })).toBe('lmstudio')
    expect(resolveModelBrand({ providerId: 'antigravity-acp', providerName: 'Antigravity' })).toBe('google')
  })

  it('returns null for unknown custom models and providers', () => {
    expect(resolveModelBrand({ modelId: 'custom-internal-v1', presetId: 'custom', providerName: 'My Relay' })).toBeNull()
  })
})

describe('ModelBrandIcon', () => {
  it('renders an accessible-hidden monochrome SVG with parsed paths for known brands', () => {
    const { container } = render(<ModelBrandIcon modelId="claude-sonnet-4-6" size={16} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-brand', 'claude')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('width', '16')
    expect(svg).toHaveAttribute('height', '16')
    expect(svg?.querySelectorAll('path').length).toBeGreaterThan(0)
    // Must not inject <title> elements that could leak into parent button accessible names.
    expect(svg?.querySelector('title')).toBeNull()
  })

  it('renders a restrained Cpu fallback icon for unknown models', () => {
    const { container } = render(<ModelBrandIcon modelId="alpha" size={14} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeInTheDocument()
    expect(svg).toHaveAttribute('data-brand', 'fallback')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
  })
})
