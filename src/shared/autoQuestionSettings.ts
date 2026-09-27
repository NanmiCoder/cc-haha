export type AutoQuestionSettings = {
  enabled: boolean
  timeoutMinutes: number
}

export const DEFAULT_AUTO_QUESTION_SETTINGS: AutoQuestionSettings = {
  enabled: false,
  timeoutMinutes: 5,
}

export const AUTO_QUESTION_TIMEOUT_OPTIONS = [1, 5, 10, 30] as const

/** Missing or malformed legacy settings remain safely disabled. */
export function normalizeAutoQuestionSettings(value: unknown): AutoQuestionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_AUTO_QUESTION_SETTINGS }
  }
  const record = value as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    timeoutMinutes: AUTO_QUESTION_TIMEOUT_OPTIONS.find(
      (minutes) => minutes === record.timeoutMinutes,
    ) ?? DEFAULT_AUTO_QUESTION_SETTINGS.timeoutMinutes,
  }
}
