// This exact model only supports 1K. Unknown relay aliases retain their
// existing options instead of guessing capabilities from the model name.
// https://ai.google.dev/gemini-api/docs/image-generation
export function isGeminiFlashLiteImageModel(model: string): boolean {
  return model.trim().replace(/^models\//, '') === 'gemini-3.1-flash-lite-image'
}

export function assertGeminiImageResolution(
  model: string,
  resolution: '1k' | '2k' | undefined,
): void {
  if (isGeminiFlashLiteImageModel(model) && resolution !== undefined && resolution !== '1k') {
    throw new Error(`The Gemini image model ${model} only supports 1K resolution. Use resolution "1k" or leave it unset.`)
  }
}
