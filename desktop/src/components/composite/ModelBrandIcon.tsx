import { memo } from 'react'
import { Cpu } from 'lucide-react'
import anthropicSvg from '@lobehub/icons-static-svg/icons/anthropic.svg?raw'
import claudeSvg from '@lobehub/icons-static-svg/icons/claude.svg?raw'
import cohereSvg from '@lobehub/icons-static-svg/icons/cohere.svg?raw'
import deepseekSvg from '@lobehub/icons-static-svg/icons/deepseek.svg?raw'
import doubaoSvg from '@lobehub/icons-static-svg/icons/doubao.svg?raw'
import geminiSvg from '@lobehub/icons-static-svg/icons/gemini.svg?raw'
import googleSvg from '@lobehub/icons-static-svg/icons/google.svg?raw'
import grokSvg from '@lobehub/icons-static-svg/icons/grok.svg?raw'
import hunyuanSvg from '@lobehub/icons-static-svg/icons/hunyuan.svg?raw'
import kimiSvg from '@lobehub/icons-static-svg/icons/kimi.svg?raw'
import lmstudioSvg from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw'
import metaSvg from '@lobehub/icons-static-svg/icons/meta.svg?raw'
import minimaxSvg from '@lobehub/icons-static-svg/icons/minimax.svg?raw'
import mistralSvg from '@lobehub/icons-static-svg/icons/mistral.svg?raw'
import moonshotSvg from '@lobehub/icons-static-svg/icons/moonshot.svg?raw'
import ollamaSvg from '@lobehub/icons-static-svg/icons/ollama.svg?raw'
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import openrouterSvg from '@lobehub/icons-static-svg/icons/openrouter.svg?raw'
import perplexitySvg from '@lobehub/icons-static-svg/icons/perplexity.svg?raw'
import qwenSvg from '@lobehub/icons-static-svg/icons/qwen.svg?raw'
import zhipuSvg from '@lobehub/icons-static-svg/icons/zhipu.svg?raw'
import { cx } from '@/lib/cx'

/**
 * Official monochrome AI/LLM brand marks sourced from `@lobehub/icons-static-svg` (MIT).
 *
 * Rendered as inline `<svg fill="currentColor" viewBox="0 0 24 24">` without `<title>`
 * so icons inherit theme ink tokens cleanly in both Light and Dark themes and never
 * pollute accessible button names. Unknown/custom models fall back to a restrained
 * `lucide-react` `Cpu` glyph — never generic AI sparkles.
 */
export type ModelBrandKey =
  | 'claude'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'google'
  | 'deepseek'
  | 'grok'
  | 'qwen'
  | 'zhipu'
  | 'minimax'
  | 'kimi'
  | 'moonshot'
  | 'mistral'
  | 'meta'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'doubao'
  | 'cohere'
  | 'perplexity'
  | 'hunyuan'

type ParsedPath = {
  d: string
  clipRule?: 'evenodd' | 'nonzero'
  fillOpacity?: string
}

const RAW_BRAND_SVGS: Record<ModelBrandKey, string> = {
  claude: claudeSvg,
  anthropic: anthropicSvg,
  openai: openaiSvg,
  gemini: geminiSvg,
  google: googleSvg,
  deepseek: deepseekSvg,
  grok: grokSvg,
  qwen: qwenSvg,
  zhipu: zhipuSvg,
  minimax: minimaxSvg,
  kimi: kimiSvg,
  moonshot: moonshotSvg,
  mistral: mistralSvg,
  meta: metaSvg,
  openrouter: openrouterSvg,
  ollama: ollamaSvg,
  lmstudio: lmstudioSvg,
  doubao: doubaoSvg,
  cohere: cohereSvg,
  perplexity: perplexitySvg,
  hunyuan: hunyuanSvg,
}

function parseSvgPaths(raw: string): ParsedPath[] {
  const paths: ParsedPath[] = []
  for (const match of raw.matchAll(/<path\s+([^>]+?)\/?>(?:<\/path>)?/g)) {
    const attrs = match[1] ?? ''
    const d = attrs.match(/\bd="([^"]+)"/)?.[1]
    if (!d) continue
    const clipRule = attrs.match(/\bclip-rule="(evenodd|nonzero)"/)?.[1] as 'evenodd' | 'nonzero' | undefined
    const fillOpacity = attrs.match(/\bfill-opacity="([^"]+)"/)?.[1]
    paths.push({
      d,
      ...(clipRule ? { clipRule } : {}),
      ...(fillOpacity ? { fillOpacity } : {}),
    })
  }
  return paths
}

const BRAND_PATHS: Record<ModelBrandKey, ParsedPath[]> = Object.fromEntries(
  (Object.entries(RAW_BRAND_SVGS) as Array<[ModelBrandKey, string]>).map(([key, raw]) => [
    key,
    parseSvgPaths(raw),
  ]),
) as Record<ModelBrandKey, ParsedPath[]>

function matchModelBrand(rawModelId: string): ModelBrandKey | null {
  const id = rawModelId.trim().toLowerCase()
  if (!id) return null

  // Explicit namespace prefixes (e.g. OpenRouter / multi-model gateways)
  if (id.startsWith('anthropic/') || id.includes('claude')) return 'claude'
  if (/^(?:openai\/|gpt[-.\s]|o[134](?:[-.\s]|$)|chatgpt|codex)/.test(id)) return 'openai'
  if (id.startsWith('google/gemini') || id.startsWith('gemini') || id.includes('/gemini')) return 'gemini'
  if (id.startsWith('google/')) return 'google'
  if (id.includes('deepseek')) return 'deepseek'
  if (id.startsWith('x-ai/') || id.startsWith('xai/') || /(?:^|[/-])grok(?:[-.\s/]|$)/.test(id)) return 'grok'
  if (id.includes('qwen') || id.startsWith('alibaba/')) return 'qwen'
  if (id.startsWith('z-ai/') || id.startsWith('zhipu') || /(?:^|[/-])glm(?:[-.\s/]|$)/.test(id)) return 'zhipu'
  if (id.includes('minimax')) return 'minimax'
  if (id.startsWith('moonshotai/') || id.includes('moonshot') || /(?:^|[/-])kimi(?:[-.\s/]|$)/.test(id) || /^k\d+(?:\.\d+)?(?:\[|$)/.test(id)) return 'kimi'
  if (id.includes('mistral') || id.includes('mixtral') || id.includes('codestral') || id.includes('pixtral')) return 'mistral'
  if (id.startsWith('meta-llama/') || id.startsWith('meta/') || /(?:^|[/-])llama(?:[-.\s\d/]|$)/.test(id)) return 'meta'
  if (id.includes('doubao') || id.includes('seedream') || id.startsWith('bytedance/')) return 'doubao'
  if (id.includes('cohere') || id.startsWith('command-r')) return 'cohere'
  if (id.includes('perplexity') || /(?:^|[/-])sonar(?:[-.\s/]|$)/.test(id)) return 'perplexity'
  if (id.includes('hunyuan') || /^hy\d+(?:[-.\s]|$)/.test(id)) return 'hunyuan'
  if (/(?:^|[/-])(?:opus|sonnet|haiku|fable)(?:[-.\s\d]|$)/.test(id)) return 'claude'

  return null
}

function matchProviderBrand(raw: string): ModelBrandKey | null {
  const value = raw.trim().toLowerCase()
  if (!value) return null

  if (value === 'official' || value === 'claude-official' || value.includes('claude')) return 'claude'
  if (value.includes('anthropic')) return 'anthropic'
  if (value === 'openai-official' || value.includes('openai') || value.includes('chatgpt')) return 'openai'
  if (value === 'grok-official' || value.includes('grok') || value === 'xai' || value === 'x-ai') return 'grok'
  if (value === 'deepseek-account' || value.includes('deepseek')) return 'deepseek'
  if (value.includes('zhipu') || value.includes('bigmodel') || value === 'z-ai' || value === 'z.ai' || /\bglm\b/.test(value)) return 'zhipu'
  if (value.includes('kimi')) return 'kimi'
  if (value.includes('moonshot')) return 'moonshot'
  if (value.includes('minimax')) return 'minimax'
  if (value.includes('qwen') || value.includes('dashscope')) return 'qwen'
  if (value.includes('gemini')) return 'gemini'
  if (value === 'antigravity-acp' || value.includes('antigravity') || value.includes('google')) return 'google'
  if (value.includes('openrouter')) return 'openrouter'
  if (value.includes('ollama')) return 'ollama'
  if (value.includes('lmstudio') || value.includes('lm studio')) return 'lmstudio'
  if (value.includes('mistral')) return 'mistral'
  if (value.includes('meta') || value.includes('llama')) return 'meta'
  if (value.includes('doubao') || value.includes('bytedance')) return 'doubao'
  if (value.includes('cohere')) return 'cohere'
  if (value.includes('perplexity')) return 'perplexity'
  if (value.includes('hunyuan')) return 'hunyuan'

  return null
}

export type ModelBrandIdentity = {
  modelId?: string | null
  providerId?: string | null
  presetId?: string | null
  providerName?: string | null
}

/**
 * Resolves the authentic brand key for a model or provider.
 * Model ID takes precedence over provider metadata so multi-model gateways
 * (e.g. OpenRouter, Magpie) display the actual model family's mark.
 */
export function resolveModelBrand({
  modelId,
  providerId,
  presetId,
  providerName,
}: ModelBrandIdentity): ModelBrandKey | null {
  if (modelId) {
    const fromModel = matchModelBrand(modelId)
    if (fromModel) return fromModel
  }
  for (const candidate of [presetId, providerId, providerName]) {
    if (!candidate) continue
    const fromProvider = matchProviderBrand(candidate)
    if (fromProvider) return fromProvider
  }
  return null
}

export type ModelBrandIconProps = ModelBrandIdentity & {
  size?: number
  className?: string
}

export const ModelBrandIcon = memo(function ModelBrandIcon({
  modelId,
  providerId,
  presetId,
  providerName,
  size = 14,
  className,
}: ModelBrandIconProps) {
  const brand = resolveModelBrand({ modelId, providerId, presetId, providerName })

  if (!brand) {
    return (
      <Cpu
        size={size}
        strokeWidth={1.75}
        aria-hidden="true"
        data-brand="fallback"
        className={cx('shrink-0', className)}
      />
    )
  }

  const paths = BRAND_PATHS[brand]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      focusable="false"
      data-brand={brand}
      className={cx('shrink-0', className)}
    >
      {paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          clipRule={path.clipRule}
          fillOpacity={path.fillOpacity}
        />
      ))}
    </svg>
  )
})
