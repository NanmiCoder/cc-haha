import { randomUUID } from 'node:crypto'

export type PowerActivitySnapshot = {
  epoch: string
  revision: number
  busy: boolean
  completionSequence: number
  scheduledCompletionSequence: number
}

// Process-local evidence only. A restarted host never replays persisted task
// completions into an unattended power action. Producers own their lifecycles;
// this clock records boundaries, not a second registry of active sessions.
const epoch = randomUUID()
let revision = 0
let completionSequence = 0
let scheduledCompletionSequence = 0

export const powerActivityClock = {
  changed(): void { revision += 1 },
  completed(scheduled = false): void {
    revision += 1
    completionSequence += 1
    if (scheduled) scheduledCompletionSequence += 1
  },
  read(busy: boolean): PowerActivitySnapshot {
    return { epoch, revision, busy, completionSequence, scheduledCompletionSequence }
  },
}
