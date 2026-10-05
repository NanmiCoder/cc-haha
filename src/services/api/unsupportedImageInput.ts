/**
 * Recognizes provider errors that reject image input for a text-only model.
 *
 * Kept free of CLI state so both the CLI error mapper and the desktop proxy
 * (which retries OpenAI Chat requests without images) share one definition.
 */
export function isUnsupportedImageInputErrorMessage(message: string): boolean {
  const raw = message.toLowerCase()
  // vLLM: "<model> is not a multimodal model" names the modality, not images.
  if (/\bnot an? (multimodal|multi-modal|vision) model\b/.test(raw)) return true
  if (!raw.includes('image')) return false
  if (isOpenAIImageUrlTextOnlySchemaError(raw)) {
    return true
  }
  return (
    raw.includes('not support') ||
    raw.includes('not supported') ||
    raw.includes('unsupported') ||
    raw.includes('vision') ||
    raw.includes('multimodal') ||
    raw.includes('multi-modal') ||
    raw.includes('modality')
  )
}

function isOpenAIImageUrlTextOnlySchemaError(raw: string): boolean {
  if (!raw.includes('image_url')) return false
  if (
    raw.includes('not allowed') ||
    raw.includes('not permitted') ||
    raw.includes('disallowed') ||
    raw.includes('forbidden') ||
    raw.includes('only supported by certain models')
  ) {
    return true
  }
  if (!raw.includes('text')) return false
  return (
    raw.includes('expected') ||
    raw.includes('input should be') ||
    raw.includes('not one of') ||
    raw.includes('permitted') ||
    raw.includes('received') ||
    raw.includes('unknown variant') ||
    raw.includes('invalid value') ||
    raw.includes('invalid type') ||
    raw.includes('valid enumeration') ||
    raw.includes('only text')
  )
}
