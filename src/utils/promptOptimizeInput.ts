import { z } from 'zod/v4'
import { MAX_OPTIMIZE_PROMPT_LENGTH } from '../shared/promptOptimizeReferences.js'

const plainDraft = z.string().trim().min(1).max(MAX_OPTIMIZE_PROMPT_LENGTH)

export const optimizeDraftSchema = z.union([
  plainDraft,
  z.strictObject({
    // Offsets refer to the original string, including any leading whitespace.
    text: z.string().refine(text => plainDraft.safeParse(text).success),
    referenceEnds: z.array(z.int().positive()).min(1).max(MAX_OPTIMIZE_PROMPT_LENGTH),
  }).refine(({ text, referenceEnds }) =>
    referenceEnds.every((end, index) => {
      const previous = referenceEnds[index - 1] ?? 0
      return end <= text.length && end > previous && text.slice(previous, end - 1).includes('@')
    })),
])
