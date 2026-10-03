import { splitSessionReferenceContext } from '@/lib/sessionReferences'
import {
  extractLeadingFileReferences,
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

function normalizeAttachmentPath(path: string | undefined): string | undefined {
  return path?.replace(/\\/g, '/').replace(/^\.\//, '')
}

function referenceContextKey(attachment: UIAttachment): string {
  return JSON.stringify([
    attachment.lineStart,
    attachment.lineEnd ?? attachment.lineStart,
    attachment.diffSide,
    attachment.note?.trim() || undefined,
    attachment.quote?.trim() || undefined,
  ])
}

type AttachmentCandidate = { attachment: UIAttachment; paths: Array<string | undefined> }

function reconstructAttachments(
  leading: UIAttachment[],
  workspace: UIAttachment[],
  originals: UIAttachment[],
): UIAttachment[] {
  const unmatchedLeading = leading.map((attachment) => ({ attachment, paths: [attachment.path] }))
  const references: AttachmentCandidate[] = workspace.map((attachment) => ({ attachment, paths: [attachment.path] }))
  const findLeading = (path: string | undefined, exact: boolean) => {
    for (let index = unmatchedLeading.length - 1; index >= 0; index -= 1) {
      const candidatePath = unmatchedLeading[index]!.attachment.path
      if (exact
        ? normalizeAttachmentPath(candidatePath) === normalizeAttachmentPath(path)
        : pathsReferToSameFile(candidatePath, path)
      ) return index
    }
    return -1
  }
  // The composer sends upload paths first, then workspace paths in reference
  // order. Match from the end so a root-file selection cannot consume an upload
  // with the same suffix; retain every unmatched absolute transport path.
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index]!
    let matchingIndex = findLeading(reference.attachment.path, true)
    if (matchingIndex < 0) matchingIndex = findLeading(reference.attachment.path, false)
    if (matchingIndex >= 0) {
      const [matched] = unmatchedLeading.splice(matchingIndex, 1)
      reference.paths.push(matched!.attachment.path)
      reference.attachment = { ...reference.attachment, path: matched!.attachment.path }
    }
  }

  const candidates: AttachmentCandidate[] = [...unmatchedLeading, ...references]
  const unmatchedOriginals = originals.filter((attachment) => attachment.referenceKind !== 'chat-selection')
  for (const candidate of candidates) {
    const matchingIndex = unmatchedOriginals.findIndex((original) =>
      original.path && candidate.paths.some((path) =>
        normalizeAttachmentPath(path) === normalizeAttachmentPath(original.path),
      ) && referenceContextKey(original) === referenceContextKey(candidate.attachment),
    )
    if (matchingIndex < 0) continue
    const [original] = unmatchedOriginals.splice(matchingIndex, 1)
    const metadata = Object.fromEntries(Object.entries(original!).filter(([, value]) => value !== undefined))
    candidate.attachment = { ...candidate.attachment, ...metadata, path: candidate.attachment.path }
  }
  // The display parser may already have lost a prefix on a reloaded message.
  // Its remaining bare chip is redundant with a recovered canonical path, but
  // distinct absolute paths and data-only uploads must survive.
  const extraAttachments = unmatchedOriginals.filter((original) =>
    !original.path || !candidates.some((candidate) => candidate.paths.some((path) =>
      normalizeAttachmentPath(path) === normalizeAttachmentPath(original.path),
    )),
  )
  return [...candidates.map((candidate) => candidate.attachment), ...extraAttachments]
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
  const sanitized = hasImage ? stripGeneratedImageMetadataLines(source) : source
  const referenceContext = splitSessionReferenceContext(sanitized)
  // Parse transport prefixes separately: the history display reader otherwise
  // deduplicates absolute paths against relative workspace paths by suffix.
  const leading = extractLeadingFileReferences(referenceContext.content)
  const parsed = extractRestoredUserDisplay(leading.content)
  const attachments = reconstructAttachments(leading.attachments ?? [], parsed.attachments ?? [], messageAttachments)
    .map((attachment, index) => ({
      ...attachment,
      id: `edit-attachment-${index}`,
      sendable: isSendable(attachment),
    }))

  const body = parsed.content.trim()
  const text = attachments.length > 0 && ATTACHMENT_ONLY_PLACEHOLDERS.has(body) ? '' : body

  return {
    text,
    attachments,
    sessionReferences: message.sessionReferences ?? referenceContext.sessionReferences,
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
