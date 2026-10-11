import type { ReasoningEffortLevel } from './settings'

export type RuntimeSelection = {
  providerId: string | null
  modelId: string
  effortLevel?: ReasoningEffortLevel
  openAIFastMode?: boolean
}
