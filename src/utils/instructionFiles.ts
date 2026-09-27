import { getSettingsForSource } from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'

export const INSTRUCTION_FILE_MODES = [
  'claude-md',
  'claude-md-or-agents-md',
  'claude-md-and-agents-md',
  'managed-only',
] as const

export type InstructionFilesMode = (typeof INSTRUCTION_FILE_MODES)[number]
export const INSTRUCTION_FILES_PLUGIN = 'agents-md@builtin'

export function normalizeInstructionFilesMode(value: unknown): InstructionFilesMode {
  if (INSTRUCTION_FILE_MODES.includes(value as InstructionFilesMode)) {
    return value as InstructionFilesMode
  }
  return 'claude-md-or-agents-md'
}

/** Sources are supplied in descending precedence. Each option inherits separately. */
export function getInstructionFilesModeFromSettings(
  ...sources: (SettingsJson | null | undefined)[]
): InstructionFilesMode {
  const options = Object.fromEntries(sources.toReversed().flatMap(settings =>
    Object.entries(settings?.pluginConfigs?.[INSTRUCTION_FILES_PLUGIN]?.options ?? {})
      .filter(([, value]) => value !== undefined),
  ))
  const mode = normalizeInstructionFilesMode(options.instructionFiles)
  if (mode !== 'claude-md-or-agents-md' || options.projectInstructions === undefined) {
    return mode
  }
  // Read-time migration matches the builtin plugin without rewriting user files.
  switch (options.projectInstructions) {
    case 'none': return 'managed-only'
    case 'both': return 'claude-md-and-agents-md'
    case 'agents-fallback': return 'claude-md-or-agents-md'
    default: return 'claude-md'
  }
}

export function getInstructionFilesMode(): InstructionFilesMode {
  // Repository settings must not be able to switch off instructions themselves.
  return getInstructionFilesModeFromSettings(
    getSettingsForSource('policySettings'),
    getSettingsForSource('flagSettings'),
    getSettingsForSource('userSettings'),
  )
}

/** Patch only this option; undefined deletes the key via settings' merge protocol. */
export function instructionFilesSettingsPatch(value: string | undefined, legacy?: string): SettingsJson {
  return {
    pluginConfigs: {
      [INSTRUCTION_FILES_PLUGIN]: { options: { instructionFiles: value as string, projectInstructions: legacy as string } },
    },
  }
}
