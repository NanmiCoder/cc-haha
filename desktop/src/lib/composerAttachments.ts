import { getApiUrl } from '../api/client'
import { isDesktopRuntime } from './desktopRuntime'
import { getDesktopHost } from './desktopHost'
import { compressDataUrl } from './imageCompress'

export type ComposerAttachment = {
  id: string
  name: string
  type: 'image' | 'file'
  path?: string
  mimeType?: string
  previewUrl?: string
  data?: string
  isDirectory?: boolean
  lineStart?: number
  lineEnd?: number
  note?: string
  quote?: string
}

const IMAGE_PATH_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGE_PATH_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function nextAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function getPathExtension(filePath: string): string {
  const fileName = getFileNameFromPath(filePath)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
}

export function isPreviewableImagePath(filePath: string): boolean {
  return IMAGE_PATH_EXTENSIONS.has(getPathExtension(filePath))
}

export function getFilesystemPreviewUrl(filePath: string): string {
  return getApiUrl(`/api/filesystem/file?path=${encodeURIComponent(filePath)}`)
}

function getImageMimeTypeForPath(filePath: string): string | undefined {
  return IMAGE_PATH_MIME_TYPES[getPathExtension(filePath)]
}

export function getFileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/g, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || filePath
}

export function pathToComposerAttachment(filePath: string): ComposerAttachment {
  const isImage = isPreviewableImagePath(filePath)
  return {
    id: nextAttachmentId(),
    name: getFileNameFromPath(filePath),
    type: isImage ? 'image' : 'file',
    path: filePath,
    mimeType: isImage ? getImageMimeTypeForPath(filePath) : undefined,
    previewUrl: isImage ? getFilesystemPreviewUrl(filePath) : undefined,
  }
}

export function pathsToComposerAttachments(filePaths: string[]): ComposerAttachment[] {
  return filePaths
    .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
    .map(pathToComposerAttachment)
}

export function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types ?? [])
  return types.includes('Files') || dataTransfer.files.length > 0
}

export async function dataTransferToComposerAttachments(dataTransfer: DataTransfer): Promise<ComposerAttachment[]> {
  return filesToComposerAttachments(dataTransfer.files)
}

export async function selectNativeFileAttachments(): Promise<ComposerAttachment[] | null> {
  const host = getDesktopHost()
  if (!host.isDesktop || !host.capabilities.dialogs) return null

  try {
    const selected = await host.dialogs.open({
      multiple: true,
      directory: false,
    })
    const paths = normalizeDialogSelection(selected)
    return pathsToComposerAttachments(paths)
  } catch (error) {
    console.warn('[attachments] Native file picker failed; falling back to browser file input', error)
    return null
  }
}

export async function filesToComposerAttachments(files: FileList | File[]): Promise<ComposerAttachment[]> {
  const entries = Array.from(files)
  const attachments = await Promise.all(entries.map(fileToComposerAttachment))
  return attachments.filter((attachment): attachment is ComposerAttachment => !!attachment)
}

function normalizeDialogSelection(selected: string | string[] | null): string[] {
  if (!selected) return []
  const paths = Array.isArray(selected) ? selected : [selected]
  return paths.filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
}

function getNativeFilePath(file: File): string | undefined {
  const path = (file as File & { path?: unknown }).path
  return typeof path === 'string' && path.length > 0 ? path : undefined
}

async function fileToComposerAttachment(file: File): Promise<ComposerAttachment | null> {
  const nativePath = isDesktopRuntime() ? getNativeFilePath(file) : undefined
  if (nativePath) {
    return pathToComposerAttachment(nativePath)
  }

  const isImage = file.type.startsWith('image/')
  const rawData = await readFileAsDataUrl(file)
  const data = isImage ? await compressDataUrl(rawData) : rawData
  return {
    id: nextAttachmentId(),
    name: file.name,
    type: isImage ? 'image' : 'file',
    mimeType: isImage ? 'image/jpeg' : (file.type || undefined),
    previewUrl: isImage ? data : undefined,
    data,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
}
