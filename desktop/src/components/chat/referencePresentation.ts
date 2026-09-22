import { Box, File, Folder, Package, MessagesSquare, type LucideIcon } from 'lucide-react'
import type { TranslationKey } from '@/i18n'

/**
 * Icon shown for a skill, plugin or filesystem entry when no brand asset exists.
 *
 * The `@` and `/` menus render the same vocabulary on purpose: the same entry
 * must not change shape depending on which menu opened it. Skills use the same
 * outline box the Codex composer uses for `SKILL.md`, plugins use the package
 * glyph, and filesystem rows fall back to folder/file.
 */
export function referenceFallbackIcon(kind: 'skill' | 'plugin' | 'file' | 'directory' | 'session'): LucideIcon {
  if (kind === 'session') return MessagesSquare
  if (kind === 'plugin') return Package
  if (kind === 'skill') return Box
  if (kind === 'directory') return Folder
  return File
}

/**
 * i18n key describing where a skill came from, or null when the source is not
 * one we label. New sources must degrade to no label rather than an empty
 * string, so callers render nothing instead of a blank chip.
 */
export function skillSourceLabelKey(source: string | undefined): TranslationKey | null {
  switch (source) {
    case 'project': return 'chat.slashSkillProject'
    case 'plugin': return 'chat.slashSkillPlugin'
    case 'user': return 'chat.slashSkillPersonal'
    default: return null
  }
}
