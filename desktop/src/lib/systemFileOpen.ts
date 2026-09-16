import { openTargetsApi } from '../api/openTargets'
import { getDesktopHost } from './desktopHost'
import { t } from '../i18n'
import { useUIStore } from '../stores/uiStore'

/**
 * Say that a path could not be opened, naming it.
 *
 * Every one of these paths comes from something the assistant wrote — prose, a
 * checkpoint, a directory listing — and any of them can outlive the file. The
 * failures used to land in floating promises, so a click on a stale reference
 * did nothing at all and read as a broken button.
 */
export function reportOpenFailure(path: string): void {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  useUIStore.getState().addToast({ type: 'error', message: t('openWith.openFailed', { name }) })
}

export function resolveAbsoluteOpenPath(path: string, workDir?: string): string {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return path
  if (path.startsWith('/') || path.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(path) || !workDir) return path
  return `${workDir.replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`
}

/**
 * Prefer Electron's guarded shell bridge. Browser/H5 builds have no native shell,
 * so fall back to the local server's equally validated system-default target.
 */
export async function openLocalFileWithSystem(path: string): Promise<void> {
  try {
    await getDesktopHost().shell.openPath(path)
    return
  } catch {
    const result = await openTargetsApi.listForPath(path)
    const target = result.targets.find((candidate) => candidate.kind === 'system_default')
    if (!target) throw new Error('No system application is available for this file')
    await openTargetsApi.open(target.id, path)
  }
}
