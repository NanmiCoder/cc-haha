import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeEnabled,
} from '../../utils/fastMode.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export const fast = {
  type: 'local-jsx',
  name: 'fast',
  get description() {
    return `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY} and supported models)`
  },
  availability: ['claude-ai', 'console'],
  isEnabled: () => isFastModeEnabled() && !getIsNonInteractiveSession(),
  get isHidden() {
    return !isFastModeEnabled() || getIsNonInteractiveSession()
  },
  argumentHint: '[on|off]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./fast.js'),
} satisfies Command

export const fastNonInteractive = {
  type: 'local',
  name: 'fast',
  supportsNonInteractive: true,
  availability: ['claude-ai', 'console'],
  get description() {
    return `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY} and supported models)`
  },
  argumentHint: '[on|off]',
  isEnabled: () => isFastModeEnabled() && getIsNonInteractiveSession(),
  get isHidden() {
    return !isFastModeEnabled() || !getIsNonInteractiveSession()
  },
  load: () => import('./fast-noninteractive.js'),
} satisfies Command

export default fast
