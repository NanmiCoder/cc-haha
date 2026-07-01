import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { copyTextToClipboard } from '../chat/clipboard'
import { injectInstallScriptIntoNewTerminal } from '../../lib/terminalCommandInjection'
import { detectPlatform } from '../../lib/detectPlatform'
import {
  buildSmartInstallPlan,
  buildSmartInstallCommandLine,
} from '../../lib/smartInstallScript'
import type {
  PluginPrerequisiteInstallStep,
  PluginPrerequisiteRow,
} from '../../types/plugin'

type Platform = 'win32' | 'darwin' | 'linux'

type Props = {
  open: boolean
  pluginName: string
  rows: ReadonlyArray<PluginPrerequisiteRow>
  /**
   * Called when the user clicks "I installed it, recheck". Host
   * re-fetches `pluginsApi.prerequisites(id)` and updates `rows`. The
   * modal stays open so the user sees the new state. When everything
   * is satisfied the host should auto-close via `open=false`.
   */
  onRecheck: () => void
  isRechecking?: boolean
  onClose: () => void
}

/**
 * Inline notice + install affordance for plugins whose MCP servers
 * declared host-command prerequisites that aren't currently in PATH.
 *
 * Triggered by `PluginList.handleInlineToggle` after a successful
 * enable: cc-haha probes prerequisites via `pluginsApi.prerequisites`
 * and pops this modal when at least one declared command is missing.
 *
 * Each missing dependency renders a row with:
 *   - the command name + human label + homepage link
 *   - which MCP servers depend on it
 *   - per-platform install commands (one or more) with copy buttons
 *     and "open terminal + copy" buttons
 *
 * The "open in terminal" affordance opens a fresh terminal tab via
 * `useTabStore.openTerminalTab` and copies the command into the
 * clipboard. The user pastes (right-click / Ctrl+Shift+V) and runs
 * — we never auto-execute, both as a safety guarantee and to keep
 * the implementation simple (no PTY input plumbing).
 *
 * Already-satisfied prerequisites are NOT shown (they would just
 * clutter the dialog). When everything is satisfied the host closes
 * the modal automatically so the user doesn't see an empty dialog.
 */
export function PluginPrerequisitesModal({
  open,
  pluginName,
  rows,
  onRecheck,
  isRechecking,
  onClose,
}: Props) {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const platform = useMemo(detectPlatform, [])

  // Optimistic copy-feedback state, keyed by `${rowIdx}:${stepIdx}`.
  // Reset on modal close so reopening the modal starts fresh.
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [installAllRunning, setInstallAllRunning] = useState(false)
  useEffect(() => {
    if (!open) {
      setCopiedKey(null)
      setInstallAllRunning(false)
    }
  }, [open])

  const missingRows = rows.filter((r) => !r.installed)

  // Build the "install all" command list for the current platform.
  // On Windows, switch to the smart-installer path: ONE command line
  // that runs an encoded PowerShell script handling PATH refresh,
  // manager-availability fallthrough, and per-command verification.
  // The naive per-command path stays for darwin/linux where PATH
  // doesn't suffer the same staleness issue (POSIX shells respect
  // `export PATH` updates from the install scripts themselves).
  // Pick the FIRST install step per row — plugin authors put the
  // most ergonomic option first (e.g. winget on Windows, brew on
  // macOS). A row with no install step for this platform is silently
  // dropped — the user still sees the row in the modal with the
  // "no automated install for {platform}" hint.
  const installAllCommands = useMemo(() => {
    if (platform === 'win32') {
      const plan = buildSmartInstallPlan(missingRows, 'win32')
      if (plan.length === 0) return []
      return [buildSmartInstallCommandLine(plan)]
    }
    const cmds: string[] = []
    for (const row of missingRows) {
      const steps = row.install?.[platform] ?? []
      if (steps.length > 0) {
        cmds.push(steps[0]!.cmd)
      }
    }
    return cmds
  }, [missingRows, platform])

  // The user-visible "(N)" badge on the button shows the count of
  // missing prereqs being addressed, NOT the count of injected
  // commands (smart mode is one injection covering N prereqs).
  const installAllCount = useMemo(() => {
    let n = 0
    for (const row of missingRows) {
      const steps = row.install?.[platform] ?? []
      if (steps.length > 0) n++
    }
    return n
  }, [missingRows, platform])

  const canInstallAll = installAllCommands.length > 0

  const handleCopy = async (cmd: string, key: string) => {
    const ok = await copyTextToClipboard(cmd)
    if (!ok) {
      addToast({ type: 'error', message: t('pluginPrereq.copyFailed') })
      return
    }
    setCopiedKey(key)
    addToast({ type: 'success', message: t('pluginPrereq.copied') })
    window.setTimeout(() => {
      setCopiedKey((cur) => (cur === key ? null : cur))
    }, 1500)
  }

  const handleOpenInTerminal = async (cmd: string, key: string) => {
    // Copy first so the user can paste immediately. We deliberately
    // do NOT auto-feed the command into the PTY — letting cc-haha
    // execute arbitrary install commands without an explicit user
    // keystroke would be a bad security default. Paste + Enter is
    // explicit user action.
    const ok = await copyTextToClipboard(cmd)
    if (!ok) {
      addToast({ type: 'error', message: t('pluginPrereq.copyFailed') })
      return
    }
    setCopiedKey(key)
    useTabStore.getState().openTerminalTab()
    addToast({
      type: 'info',
      message: t('pluginPrereq.openedTerminalToast'),
      duration: 6000,
    })
  }

  const handleInstallAll = async () => {
    if (installAllRunning || !canInstallAll) return
    setInstallAllRunning(true)
    try {
      await injectInstallScriptIntoNewTerminal(installAllCommands)
      addToast({
        type: 'info',
        message: t('pluginPrereq.installAllRunningToast', {
          count: String(installAllCount),
        }),
        duration: 8000,
      })
    } catch (err) {
      addToast({
        type: 'error',
        message: t('pluginPrereq.installAllFailedToast', {
          detail: err instanceof Error ? err.message : String(err),
        }),
      })
    } finally {
      setInstallAllRunning(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('pluginPrereq.title', { name: pluginName })}
      width={680}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('pluginPrereq.dismiss')}
          </Button>
          {canInstallAll && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleInstallAll}
              loading={installAllRunning}
              data-testid="plugin-prereq-install-all"
              title={t('pluginPrereq.installAllTooltip', {
                count: String(installAllCount),
              })}
            >
              <span className="material-symbols-outlined text-[16px]">play_arrow</span>
              {t('pluginPrereq.installAll', {
                count: String(installAllCount),
              })}
            </Button>
          )}
          <Button size="sm" onClick={onRecheck} loading={isRechecking}>
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            {t('pluginPrereq.recheck')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-text-secondary)] leading-6">
          {t('pluginPrereq.intro', { count: String(missingRows.length) })}
        </p>

        <div
          data-testid="plugin-prereq-rows"
          className="flex flex-col gap-3"
        >
          {missingRows.map((row, idx) => (
            <PrerequisiteRow
              key={row.command}
              row={row}
              rowIdx={idx}
              platform={platform}
              copiedKey={copiedKey}
              onCopy={handleCopy}
              onOpenInTerminal={handleOpenInTerminal}
            />
          ))}
        </div>

        <p className="text-xs text-[var(--color-text-tertiary)] leading-5">
          {t('pluginPrereq.safetyNote')}
        </p>
      </div>
    </Modal>
  )
}

function PrerequisiteRow({
  row,
  rowIdx,
  platform,
  copiedKey,
  onCopy,
  onOpenInTerminal,
}: {
  row: PluginPrerequisiteRow
  rowIdx: number
  platform: Platform
  copiedKey: string | null
  onCopy: (cmd: string, key: string) => void
  onOpenInTerminal: (cmd: string, key: string) => void
}) {
  const t = useTranslation()
  const platformSteps = row.install?.[platform] ?? []

  const affectedNames = row.affectedServers
    .map((s) => s.displayName ?? s.name)
    .join(', ')

  return (
    <div
      data-testid={`plugin-prereq-row-${row.command}`}
      className="rounded-xl border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined mt-0.5 text-[18px] text-[var(--color-warning)]" aria-hidden="true">
          warning
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-semibold text-[var(--color-text-primary)]">
              {row.command}
            </span>
            {row.label && (
              <span className="text-xs text-[var(--color-text-secondary)]">
                {row.label}
              </span>
            )}
            {row.homepage && (
              <a
                href={row.homepage}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-[var(--color-primary)] hover:underline"
              >
                {t('pluginPrereq.homepageLink')}
              </a>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-tertiary)] leading-5 break-words">
            {t('pluginPrereq.affectedServers', { servers: affectedNames })}
          </p>

          {platformSteps.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {platformSteps.map((step, stepIdx) => (
                <InstallStepRow
                  key={`${step.manager}-${stepIdx}`}
                  step={step}
                  copyKey={`${rowIdx}:${stepIdx}`}
                  copiedKey={copiedKey}
                  onCopy={onCopy}
                  onOpenInTerminal={onOpenInTerminal}
                />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
              {t('pluginPrereq.noPlatformInstall', { platform })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function InstallStepRow({
  step,
  copyKey,
  copiedKey,
  onCopy,
  onOpenInTerminal,
}: {
  step: PluginPrerequisiteInstallStep
  copyKey: string
  copiedKey: string | null
  onCopy: (cmd: string, key: string) => void
  onOpenInTerminal: (cmd: string, key: string) => void
}) {
  const t = useTranslation()
  const isCopied = copiedKey === copyKey
  return (
    <div className="flex items-stretch gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
      <span className="flex shrink-0 items-center px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
        {step.manager}
      </span>
      <code className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap py-2 font-mono text-[12px] text-[var(--color-text-primary)]">
        {step.cmd}
      </code>
      <div className="flex shrink-0 items-center gap-1 px-1">
        <button
          type="button"
          onClick={() => onCopy(step.cmd, copyKey)}
          data-testid={`prereq-copy-${copyKey}`}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          title={t('pluginPrereq.copyTooltip')}
        >
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            {isCopied ? 'check' : 'content_copy'}
          </span>
          {isCopied ? t('pluginPrereq.copied') : t('pluginPrereq.copy')}
        </button>
        <button
          type="button"
          onClick={() => onOpenInTerminal(step.cmd, copyKey)}
          data-testid={`prereq-open-terminal-${copyKey}`}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          title={t('pluginPrereq.openInTerminalTooltip')}
        >
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            terminal
          </span>
          {t('pluginPrereq.openInTerminal')}
        </button>
      </div>
    </div>
  )
}
