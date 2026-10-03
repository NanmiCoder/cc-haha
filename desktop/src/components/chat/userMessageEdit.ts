import {
  extractRestoredUserDisplay,
  pathsReferToSameFile,
  stripGeneratedImageMetadataLines,
} from '../../stores/chatStore'
import {
  formatWorkspaceReferencePrompt,
  type WorkspaceChatReference,
} from '../../stores/workspaceChatContextStore'
import type { AttachmentRef, UIAttachment, UIMessage } from '../../types/chat'

type UserTextMessage = Extract<UIMessage, { type: 'user_text' }>

export type EditableAttachment = UIAttachment & {
  id: string
  /** False when neither inline data nor a path survived; it cannot be resent. */
  sendable: boolean
}

export type UserMessageEditDraft = {
  text: string
  attachments: EditableAttachment[]
  sessionReferences: Array<{ sessionId: string }>
}

export type UserMessageResendPayload = {
  content: string
  attachments: AttachmentRef[]
  options: {
    sessionReferences?: Array<{ sessionId: string }>
    displayContent: string
    displayAttachments: AttachmentRef[]
  }
  droppedAttachmentCount: number
}

// Placeholders the send path writes when a prompt carries attachments but no
// text (`buildModelContent` and the server's image-only replay). They are not
// something the user typed, so they must not come back into the editor.
const ATTACHMENT_ONLY_PLACEHOLDERS = new Set([
  'Please analyze the attached files.',
  'Please analyze the attached image.',
])

function isSendable(attachment: UIAttachment): boolean {
  return Boolean(attachment.data || attachment.path)
}

/**
 * Rebuild what the user originally typed from the prompt that actually reached
 * the model. Parsing the model-facing text with the same reader history uses
 * makes a live bubble and its reloaded copy produce the same draft: leading
 * `@"path"` references and the workspace reference block become chips, the
 * session-reference envelope moves to `sessionReferences`, and the remaining
 * text is the prompt body.
 */
export function createUserMessageEditDraft(
  message: Pick<UserTextMessage, 'content' | 'modelContent' | 'attachments' | 'sessionReferences'>,
): UserMessageEditDraft {
  const messageAttachments = message.attachments ?? []
  const hasImage = messageAttachments.some((attachment) => attachment.type === 'image')
  const source = message.modelContent ?? message.content
  const parsed = extractRestoredUserDisplay(hasImage ? stripGeneratedImageMetadataLines(source) : source)
  const parsedAttachments = parsed.attachments ?? []

  // Message attachments add what the model text cannot carry — inline images
  // and data-only uploads. Chat selections are already part of the text body,
  // and anything with a path the text already referenced would be a duplicate.
  const extraAttachments = messageAttachments.filter((attachment) =>
    attachment.referenceKind !== 'chat-selection' &&
    !parsedAttachments.some((candidate) => attachment.path && pathsReferToSameFile(candidate.path, attachment.path)),
  )

  const attachments = [...parsedAttachments, ...extraAttachments].map((attachment, index) => ({
    ...attachment,
    id: `edit-attachment-${index}`,
    sendable: isSendable(attachment),
  }))

  const body = parsed.content.trim()
  const text = attachments.length > 0 && ATTACHMENT_ONLY_PLACEHOLDERS.has(body) ? '' : body

  return {
    text,
    attachments,
    sessionReferences: message.sessionReferences ?? parsed.sessionReferences ?? [],
  }
}

function hasReferenceContext(attachment: UIAttachment): boolean {
  return Boolean(
    attachment.lineStart ||
    attachment.note?.trim() ||
    attachment.quote?.trim() ||
    attachment.diffSide ||
    attachment.hunkId,
  )
}

function toWorkspaceReference(attachment: EditableAttachment): WorkspaceChatReference {
  return {
    id: attachment.id,
    kind: attachment.diffSide || attachment.hunkId
      ? 'code-comment'
      : attachment.lineStart
        ? 'code-selection'
        : 'file',
    path: attachment.path!,
    name: attachment.name,
    isDirectory: attachment.isDirectory,
    lineStart: attachment.lineStart,
    lineEnd: attachment.lineEnd,
    diffSide: attachment.diffSide,
    hunkId: attachment.hunkId,
    note: attachment.note,
    quote: attachment.quote,
  }
}

/**
 * Turn an edited draft back into `sendMessage` arguments, in the same shape the
 * composer produces (`ChatInput` handleSubmit): the workspace reference prompt
 * goes in front of the text, and every file keeps travelling as an attachment
 * so the server still prefixes its `@"path"`.
 */
export function buildUserMessageResendPayload(
  draft: UserMessageEditDraft,
  labels: { contextReferencesOnly: (count: number) => string },
): UserMessageResendPayload | null {
  const text = draft.text.trim()
  const sendable = draft.attachments.filter((attachment) => attachment.sendable)
  if (!text && sendable.length === 0) return null

  const referencePrompt = formatWorkspaceReferencePrompt(
    sendable
      .filter((attachment) => attachment.type === 'file' && attachment.path && hasReferenceContext(attachment))
      .map(toWorkspaceReference),
  )
  const content = [referencePrompt, text].filter(Boolean).join('\n\n')

  const attachments: AttachmentRef[] = sendable.map((attachment) =>
    attachment.type === 'image'
      ? {
          type: 'image',
          name: attachment.name,
          mimeType: attachment.mimeType,
          ...(attachment.data ? { data: attachment.data } : { path: attachment.path }),
        }
      : {
          type: 'file',
          name: attachment.name,
          path: attachment.path,
          data: attachment.data,
          mimeType: attachment.mimeType,
          isDirectory: attachment.isDirectory,
          lineStart: attachment.lineStart,
          lineEnd: attachment.lineEnd,
          note: attachment.note,
          quote: attachment.quote,
        },
  )

  const displayAttachments: AttachmentRef[] = sendable.map(({ id: _id, sendable: _sendable, ...attachment }) => attachment)

  return {
    content,
    attachments,
    options: {
      ...(draft.sessionReferences.length > 0 ? { sessionReferences: draft.sessionReferences } : {}),
      displayContent: text || labels.contextReferencesOnly(sendable.length),
      displayAttachments,
    },
    droppedAttachmentCount: draft.attachments.length - sendable.length,
  }
}

/** User turns after `messageId` that a rewind to it would delete. */
export function countLaterUserTurns(messages: UIMessage[], messageId: string): number {
  const targetIndex = messages.findIndex((message) => message.id === messageId)
  if (targetIndex < 0) return 0
  let count = 0
  for (let index = targetIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!
    if (
      message.type === 'user_text' &&
      !message.pending &&
      !message.optimisticQueued &&
      !message.teammateFrom
    ) count += 1
  }
  return count
}
