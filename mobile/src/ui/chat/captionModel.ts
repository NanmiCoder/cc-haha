import type { ChatItem } from '../../core/types'
import { describeStep, type StepLabel } from './steps'

/** The most recent tool call without a result (only after the last user message); null if none. */
export function currentStepLabel(
  items: readonly ChatItem[],
  workDir?: string | null
): StepLabel | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.type === 'user') return null
    if (item.type !== 'tool') continue
    // Those with parentToolUseId are steps inside a subagent, not what the main agent is currently doing.
    if (item.parentToolUseId) continue
    // Sessions opened from history have no pending flag; they just have no result yet.
    if (item.pending || item.result === undefined) return describeStep(item, workDir)
  }
  return null
}

export type CaptionInput = {
  step?: StepLabel | null
  waiting?: boolean
  compacting?: boolean
}
export type CaptionParts = {
  tone: 'run' | 'attention'
  /** Lead text: "Running", "Waiting for your approval · Run", "Thinking". */
  lead: string
  /** Objects like commands and paths; natural language objects also go here, with mono marking the font. */
  object?: string
  mono: boolean
}

/** Present-tense leads for known step verbs; unknown tools (raw tool names) read as "Calling X". */
const progressiveVerbs: Record<string, string> = {
  Read: 'Reading',
  Edit: 'Editing',
  Write: 'Writing',
  Run: 'Running',
  Search: 'Searching',
  Find: 'Finding',
  Open: 'Opening',
  'Web search': 'Searching the web',
  'Updated todos': 'Updating todos',
  'Submit plan': 'Submitting plan',
  Called: 'Calling',
}

function progressive(label: StepLabel): { lead: string; object?: string } {
  switch (label.verb) {
    case 'Thinking process':
      return { lead: 'Thinking' }
    case 'Subagent':
      return { lead: 'Running subagent', object: label.object }
    case 'Ask':
      return { lead: 'Asking you a question', object: label.object }
  }
  const known = progressiveVerbs[label.verb]
  if (known) return { lead: known, object: label.object }
  return { lead: `Calling ${label.verb}`, object: label.object }
}

export function captionParts({ step, waiting, compacting }: CaptionInput): CaptionParts {
  if (waiting) {
    // Waiting for approval: amber, stating which step is being approved.
    const verb = step && step.verb !== 'Thinking process' ? step.verb : undefined
    return {
      tone: 'attention',
      lead: verb ? `Waiting for your approval · ${verb}` : 'Waiting for your approval',
      object: verb ? step?.object : undefined,
      mono: step?.mono ?? false,
    }
  }
  if (compacting) return { tone: 'run', lead: 'Compacting context', mono: false }
  if (!step) return { tone: 'run', lead: 'Thinking', mono: false }
  const { lead, object } = progressive(step)
  return { tone: 'run', lead, object, mono: step.mono }
}

/** While waiting for approval the status line refers to the call waiting for approval, not the most recent call without a result (with parallel calls they differ). */
export function pendingStepLabel(
  items: readonly ChatItem[],
  toolUseId: string | undefined,
  workDir?: string | null
): StepLabel | null {
  if (!toolUseId) return null
  const item = items.findLast((entry) => entry.type === 'tool' && entry.toolUseId === toolUseId)
  return item ? describeStep(item, workDir) : null
}
