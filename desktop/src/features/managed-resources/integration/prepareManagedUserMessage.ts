import { getDesktopHost } from '../../../lib/desktopHost/index.js'
import type { AttachmentRef } from '../../../types/chat.js'
import type { HostManagementResult, ManagedContextTicketRef } from '../api/hostManagementApi.js'
import type { ManagedContextSubmission } from './chatSubmission.js'
import { getManagedRuntimeRevision } from './runtimeRevision.js'

export async function prepareManagedUserMessage(input: {
  sessionId: string
  content: string
  attachments?: AttachmentRef[]
  submission: ManagedContextSubmission
}): Promise<HostManagementResult<ManagedContextTicketRef>> {
  const runtimeRevision = getManagedRuntimeRevision(input.sessionId)
  if (runtimeRevision === null) {
    return {
      ok: false,
      error: {
        code: 'RUNTIME_REVISION_UNAVAILABLE',
        messageKey: 'managedResources.errors.RUNTIME_REVISION_UNAVAILABLE',
      },
    }
  }

  return getDesktopHost().conversationContext.prepareSubmission({
    sessionId: input.sessionId,
    requestId: input.submission.submissionId,
    runtimeRevision,
    content: input.content,
    attachments: input.attachments as unknown as Record<string, unknown>[] | undefined,
    selection: input.submission.selection,
  })
}
