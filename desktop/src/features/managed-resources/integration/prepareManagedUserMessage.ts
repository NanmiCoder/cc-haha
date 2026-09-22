import { getDesktopHost } from '../../../lib/desktopHost/index.js'
import type { AttachmentRef } from '../../../types/chat.js'
import type { HostManagementResult, ManagedContextTicketRef } from '../api/hostManagementApi.js'
import type { ManagedContextSubmission } from './chatSubmission.js'
import { getManagedRuntimeRevision, waitForManagedRuntimeRevision } from './runtimeRevision.js'

const preparations = new Map<string, Set<AbortController>>()
export function cancelPendingManagedMessages(sessionId: string): void {
  for (const controller of preparations.get(sessionId) ?? []) controller.abort()
  preparations.delete(sessionId)
}

export async function prepareManagedUserMessage(input: {
  sessionId: string
  content: string
  attachments?: AttachmentRef[]
  submission: ManagedContextSubmission
}): Promise<HostManagementResult<ManagedContextTicketRef>> {
  const controller = new AbortController()
  const active = preparations.get(input.sessionId) ?? new Set<AbortController>()
  active.add(controller)
  preparations.set(input.sessionId, active)
  try {
    const runtimeRevision = await waitForManagedRuntimeRevision(input.sessionId, controller.signal)
    if (controller.signal.aborted) throw new Error('CANCELLED')
    const result = await getDesktopHost().conversationContext.prepareSubmission({
      sessionId: input.sessionId,
      requestId: input.submission.submissionId,
      runtimeRevision,
      content: input.content,
      attachments: input.attachments as unknown as Record<string, unknown>[] | undefined,
      selection: input.submission.selection,
    })
    if (controller.signal.aborted) throw new Error('CANCELLED')
    if (getManagedRuntimeRevision(input.sessionId) !== runtimeRevision) throw new Error('RUNTIME_REVISION_MISMATCH')
    return result
  } catch (failure) {
    const code = failure instanceof Error && /^(CANCELLED|RUNTIME_REVISION_UNAVAILABLE|RUNTIME_REVISION_MISMATCH)$/.test(failure.message)
      ? failure.message : 'CONTEXT_PREPARE_FAILED'
    return { ok: false, error: { code, messageKey: `managedResources.errors.${code}` } }
  } finally {
    active.delete(controller)
    if (active.size === 0 && preparations.get(input.sessionId) === active) preparations.delete(input.sessionId)
  }
}
