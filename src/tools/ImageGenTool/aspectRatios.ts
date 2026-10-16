export const DEFAULT_IMAGE_ASPECT_RATIOS = [
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
] as const

// Gemini's native ImageConfig contract, including automatic selection.
// https://ai.google.dev/api/generate-content#ImageConfig
export const GEMINI_IMAGE_ASPECT_RATIOS = [
  'auto', '1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2',
  '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const

export function assertGeminiImageAspectRatio(ratio: string | undefined): void {
  if (ratio !== undefined && !(GEMINI_IMAGE_ASPECT_RATIOS as readonly string[]).includes(ratio)) {
    throw new Error(`The Gemini image API does not support aspect ratio ${ratio}. Supported ratios: ${GEMINI_IMAGE_ASPECT_RATIOS.join(', ')}.`)
  }
}
