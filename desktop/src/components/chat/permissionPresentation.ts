import {
  Bot,
  Box,
  Download,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Globe,
  NotebookPen,
  Search,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import type { TranslationKey } from '../../i18n'

/**
 * The glyph in the card's icon block, per tool. The block itself is always the
 * warning pair (`--color-warning-container` / `--color-on-warning-container`):
 * the card means "waiting for you", whatever the tool. It used to tint the
 * block by appending an alpha suffix to a `var(...)` string (`${color}18`),
 * which is not a color at all and rendered no background.
 */
export const PERMISSION_TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: SquareTerminal,
  Edit: FilePen,
  Write: FilePlus,
  Read: FileText,
  Glob: Search,
  Grep: FileSearch,
  Agent: Bot,
  WebSearch: Globe,
  WebFetch: Download,
  NotebookEdit: NotebookPen,
  Skill: Box,
}

/**
 * Extract human-readable detail lines from tool input.
 */
export function extractToolDetails(toolName: string, input: unknown, t: (key: TranslationKey, params?: Record<string, string | number>) => string): { primary: string; secondary?: string } {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}

  switch (toolName) {
    case 'Bash': {
      const cmd = typeof obj.command === 'string' ? obj.command : ''
      const desc = typeof obj.description === 'string' ? obj.description : undefined
      return { primary: cmd, secondary: desc }
    }
    case 'Edit': {
      const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
      return { primary: filePath, secondary: obj.old_string ? t('permission.replacingContent') : undefined }
    }
    case 'Write': {
      const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
      return { primary: filePath }
    }
    case 'Read': {
      const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
      return { primary: filePath }
    }
    case 'Glob':
      return { primary: typeof obj.pattern === 'string' ? obj.pattern : '' }
    case 'Grep':
      return { primary: typeof obj.pattern === 'string' ? obj.pattern : '' }
    case 'Agent':
      return { primary: typeof obj.description === 'string' ? obj.description : '' }
    case 'WebSearch':
      return { primary: typeof obj.query === 'string' ? obj.query : '' }
    case 'WebFetch':
      return { primary: typeof obj.url === 'string' ? obj.url : '' }
    default:
      return { primary: typeof input === 'string' ? input : JSON.stringify(input, null, 2) }
  }
}

export function getPermissionTitle(
  toolName: string,
  input: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  displayName?: string,
) {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : ''
  const fileName = filePath ? filePath.split('/').pop() || filePath : ''
  const actor = displayName || 'Claude'

  switch (toolName) {
    case 'Edit':
    case 'Write':
      return fileName
        ? t('permission.allowEditFile', { actor, toolName, fileName })
        : t('permission.allowEditFileGeneric', { actor, toolName: toolName.toLowerCase() })
    case 'Bash':
      return t('permission.allowBash', { actor })
    default:
      return t('permission.allowTool', { actor, toolName })
  }
}
