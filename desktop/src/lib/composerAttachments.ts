import { isTauriRuntime } from './desktopRuntime'

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

function nextAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getFileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/g, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || filePath
}

export function pathToComposerAttachment(filePath: string): ComposerAttachment {
  return {
    id: nextAttachmentId(),
    name: getFileNameFromPath(filePath),
    type: 'file',
    path: filePath,
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
  if (!isTauriRuntime()) return null

  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
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
  const nativePath = isTauriRuntime() ? getNativeFilePath(file) : undefined
  if (nativePath) {
    return pathToComposerAttachment(nativePath)
  }

  const isImage = file.type.startsWith('image/')
  const data = await readFileAsDataUrl(file)
  return {
    id: nextAttachmentId(),
    name: file.name,
    type: isImage ? 'image' : 'file',
    mimeType: file.type || undefined,
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
