import type { EffortValue } from '../effort.js'

/** An omitted approved worker effort means model default, not the leader's setting. */
export function initialRuntimeEffort(
  readPersisted: () => EffortValue | undefined,
  worker = process.env.CC_HAHA_TEAM_WORKER === '1',
): EffortValue | undefined {
  return worker ? undefined : readPersisted()
}
