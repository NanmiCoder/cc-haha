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
  run_command: SquareTerminal,
  Edit: FilePen,
  edit_file: FilePen,
  replace_file_content: FilePen,
  multi_replace_file_content: FilePen,
  Write: FilePlus,
  write_file: FilePlus,
  write_to_file: FilePlus,
  Read: FileText,
  Glob: Search,
  Grep: FileSearch,
  Agent: Bot,
  WebSearch: Globe,
  WebFetch: Download,
  NotebookEdit: NotebookPen,
  Skill: Box,
}

function readInputFilePath(obj: Record<string, unknown>): string {
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.Path === 'string') return obj.Path
  if (typeof obj.TargetFile === 'string') return obj.TargetFile
  if (typeof obj.path === 'string') return obj.path
  return ''
}

/**
 * Extract human-readable detail lines from tool input.
 */
export function extractToolDetails(toolName: string, input: unknown, t: (key: TranslationKey, params?: Record<string, string | number>) => string): { primary: string; secondary?: string } {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}

  switch (toolName) {
    case 'Bash':
    case 'run_command': {
      const cmd = typeof obj.command === 'string'
        ? obj.command
        : typeof obj.CommandLine === 'string'
          ? obj.CommandLine
          : ''
      const desc = typeof obj.description === 'string'
        ? obj.description
        : typeof obj.toolSummary === 'string'
          ? obj.toolSummary
          : undefined
      return { primary: cmd, secondary: desc }
    }
    case 'Edit':
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const filePath = readInputFilePath(obj)
      const hasOld = Boolean(obj.old_string || obj.Target || obj.TargetContent)
      return { primary: filePath, secondary: hasOld ? t('permission.replacingContent') : undefined }
    }
    case 'Write':
    case 'write_file':
    case 'write_to_file': {
      const filePath = readInputFilePath(obj)
      return { primary: filePath }
    }
    case 'Read': {
      const filePath = readInputFilePath(obj)
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

const ANTIGRAVITY_PERMISSION_TOOL_NAMES = new Set([
  'run_command',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_file',
  'write_to_file',
])

export function getPermissionTitle(
  toolName: string,
  input: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  displayName?: string,
  antigravityToolName?: string,
) {
  const obj = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const filePath = readInputFilePath(obj)
  const fileName = filePath ? filePath.split('/').pop() || filePath : ''
  const actor = displayName?.trim()
    || (antigravityToolName || ANTIGRAVITY_PERMISSION_TOOL_NAMES.has(toolName) ? 'Antigravity' : 'Claude')

  switch (toolName) {
    case 'Edit':
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'Write':
    case 'write_file':
    case 'write_to_file': {
      const actionLabel = toolName === 'Write' || toolName === 'write_file' || toolName === 'write_to_file'
        ? 'Write'
        : 'Edit'
      return fileName
        ? t('permission.allowEditFile', { actor, toolName: actionLabel, fileName })
        : t('permission.allowEditFileGeneric', { actor, toolName: actionLabel.toLowerCase() })
    }
    case 'Bash':
    case 'run_command':
      return t('permission.allowBash', { actor })
    default:
      return t('permission.allowTool', { actor, toolName })
  }
}
