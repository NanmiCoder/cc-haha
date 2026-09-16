/**
 * U07 / M7-B wire frame — the renderer side of the request identity contract.
 *
 * `user_message` gains `requestId` (the M6 submission token, which is the
 * server's `requestId`) and an optional `contextTicket` **only when a selection
 * exists**. With no selection the frame is built with exactly the three original
 * keys, so the no-selection path stays byte-identical to the pre-M7 frame
 * (pinned by `contract.emptySelection.test.tsx` and `check:chat-contract`).
 *
 * All three send points (immediate, first message of a created/replaced session,
 * queued flush) build their frame here, so the identity travels with the message
 * that was prepared and is never regenerated at send time.
 */

import type { AttachmentRef } from '../../../types/chat.js'
import type { ManagedContextSubmission } from './chatSubmission.js'

export type ContextTicketRef = {
  ticketId: string
  sidecarInstanceId: string
}

export type UserMessageFrame = {
  type: 'user_message'
  content: string
  /** Passed through verbatim, including `undefined` — the pre-M7 frame shape. */
  attachments?: AttachmentRef[]
  requestId?: string
  contextTicket?: ContextTicketRef
}

export function buildUserMessageFrame(input: {
  content: string
  attachments?: AttachmentRef[]
  submission?: ManagedContextSubmission | null
  /** Present once the renderer has staged the selection on the sidecar. */
  ticket?: ContextTicketRef | null
}): UserMessageFrame {
  if (!input.submission) {
    // No selection: the original frame, key for key (`JSON.stringify` drops the
    // `undefined` attachments exactly as it did before this batch).
    return { type: 'user_message', content: input.content, attachments: input.attachments }
  }
  return {
    type: 'user_message',
    content: input.content,
    requestId: input.submission.submissionId,
    ...(input.ticket ? {
      contextTicket: {
        ticketId: input.ticket.ticketId,
        sidecarInstanceId: input.ticket.sidecarInstanceId,
      },
    } : {}),
    attachments: input.attachments,
  }
}
