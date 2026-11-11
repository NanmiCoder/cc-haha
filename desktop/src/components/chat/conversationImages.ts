import { confirmDiskTargets } from '@/hooks/useDiskConfirmedTargets'
import type { UIMessage } from '@/types/chat'
import { attachmentImageSource, isManagedGeneratedImagePath, localImageFileUrl } from '@/lib/attachmentImages'
import { extractAssistantOutputTargets, type AssistantOutputTarget } from '@/lib/assistantOutputTargets'
import { createAssistantMarkdownImageResolver, localPathFromMarkdownImageUrl } from '@/lib/markdownImages'
import { isRootedLocalPath } from '@/lib/handlePreviewLink'
import { toolResultImagesFor } from '@/lib/toolResultContent'
import { extractImagePaths } from '@/components/chat/InlineImageGallery'
import { parseImageGenerationResult } from '@/components/chat/ImageGenerationBlock'
import { isImageGenerationToolName } from '@/components/chat/imageGenerationTools'
import { sameGalleryImage, type GalleryImage } from '@/components/chat/conversationImageGallery'
import { extractResolvedMarkdownImageSources } from '@/components/markdown/MarkdownRenderer'

type Context = { sessionId: string; baseUrl: string; workDir?: string | null; imageLabel: string; changedFilesByTurnId?: ReadonlyMap<string, string[]> }

function assistantTargets(messages: readonly UIMessage[], context: Context, includeUnconfirmedNames = false) {
  let changedFiles: string[] | undefined
  const targets = new Map<string, AssistantOutputTarget[]>()
  for (const message of messages) {
    if (message.type === 'user_text' && !message.pending) {
      const files = context.changedFilesByTurnId?.get(message.id)
      changedFiles = files?.length ? files : undefined
    } else if (message.type === 'assistant_text') {
      targets.set(message.id, extractAssistantOutputTargets(message.content, {
        workDir: context.workDir, changedFiles, includeUnconfirmedNames,
      }).filter((target) => target.kind === 'image' && target.source !== 'markdown-link'))
    }
  }
  return targets
}

/** Resolve ambiguous names even when their transcript rows have never mounted. */
export function resolveConversationImages(messages: readonly UIMessage[], context: Context): GalleryImage[] | Promise<GalleryImage[]> {
  const targets = assistantTargets(messages, context, true)
  const pending = [...targets].filter(([, values]) => values.some((target) => target.nameCandidates?.length || target.awaitsConfirmation))
  if (!pending.length) return collectConversationImages(messages, context, targets)
  return Promise.all(pending.map(async ([id, values]) => {
    targets.set(id, await confirmDiskTargets(context.sessionId, values))
  })).then(() => collectConversationImages(messages, context, targets))
}

/** Uses the same parsers and file boundaries as the individual transcript renderers. */
export function collectConversationImages(messages: readonly UIMessage[], context: Context, targets = assistantTargets(messages, context)): GalleryImage[] {
  const images: GalleryImage[] = []
  const calls = new Map(messages.flatMap((message) => message.type === 'tool_use' ? [[message.toolUseId, message] as const] : []))
  const resolveMarkdownImage = createAssistantMarkdownImageResolver(context)
  const resolveProseImage = (src: string) => isManagedGeneratedImagePath(src) ? null : resolveMarkdownImage(src)
  const add = (image: GalleryImage) => {
    if (!images.some((existing) => sameGalleryImage(existing, image))) images.push(image)
  }
  const addPath = (path: string) => add({ src: localImageFileUrl(path), name: fileName(path), path })

  for (const message of messages) {
    if (message.type === 'user_text') {
      for (const attachment of message.attachments ?? []) {
        const src = attachment.type === 'image' ? attachmentImageSource(attachment) : undefined
        if (src) add({ src, name: attachment.name, ...(attachment.path ? { path: attachment.path } : {}) })
      }
    } else if (message.type === 'assistant_text') {
      for (const src of extractResolvedMarkdownImageSources(message.content, resolveProseImage)) {
        const path = localPathFromMarkdownImageUrl(src, context) ?? undefined
        add({ src, name: path ? fileName(path) : context.imageLabel, ...(path ? { path } : {}) })
      }
      for (const path of extractImagePaths(message.content)) {
        if (!isManagedGeneratedImagePath(path)) addPath(path)
      }
      for (const target of targets.get(message.id) ?? []) {
        if (target.kind !== 'image' || target.source === 'markdown-link' || isManagedGeneratedImagePath(target.href)) continue
        const src = resolveMarkdownImage(target.normalizedPath ?? target.href)
        if (!src) continue
        const path = localPathFromMarkdownImageUrl(src, context) ?? undefined
        add({ src, name: target.title, ...(path ? { path } : {}) })
      }
    } else if (message.type === 'tool_result') {
      const call = calls.get(message.toolUseId)
      const toolImages = toolResultImagesFor({ toolName: call?.toolName ?? '', input: call?.input, content: message.content })
      for (const inline of toolImages.images) {
        const path = toolImages.originalPath && isRootedLocalPath(toolImages.originalPath) ? toolImages.originalPath : undefined
        add({ src: '', inline, name: path ? fileName(path) : context.imageLabel, ...(path ? { path } : {}) })
      }
      if (call && isImageGenerationToolName(call.toolName)) {
        const generated = message.isError ? null : parseImageGenerationResult(message.content)
        for (const image of generated?.images ?? []) addPath(image.path)
      } else {
        for (const path of extractImagePaths(toolText(message.content))) addPath(path)
      }
    }
  }
  return images
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function toolText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(toolText).filter(Boolean).join('\n')
  if (content && typeof content === 'object') {
    if ('text' in content && typeof content.text === 'string') return content.text
    // Tool renderers show ordinary result objects as JSON, which can also name
    // screenshot files (e.g. a browser result's screenshotPath).
    return JSON.stringify(content)
  }
  return ''
}
