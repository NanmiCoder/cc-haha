import { useState } from 'react'
import { ChevronDown, ChevronUp, FileText, ShieldCheck } from 'lucide-react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { useTranslation } from '../../i18n'
import type { PermissionUpdate } from '../../types/chat'
import { PLAN_REJECTION_MESSAGE, PLAN_REJECTION_WITH_REASON_PREFIX } from '../../../../src/constants/messages'

const PLAN_COLLAPSE_LINE_THRESHOLD = 14
const PLAN_COLLAPSE_CHAR_THRESHOLD = 900

export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'

export type AllowedPrompt = {
  tool: string
  prompt: string
}

export type PlanPreviewModel = {
  plan: string
  filePath: string
  allowedPrompts: AllowedPrompt[]
}

type Props = {
  title: string
  plan: string
  filePath?: string
  allowedPrompts?: AllowedPrompt[]
  requestedPermissionsTitle?: string
  emptyLabel?: string
  /** Rendered inside a card that already frames it (the approval card). */
  embedded?: boolean
}

export function isExitPlanModeTool(toolName: string): boolean {
  return toolName === EXIT_PLAN_MODE_TOOL_NAME
}

export function isEnterPlanModeTool(toolName: string): boolean {
  return toolName === ENTER_PLAN_MODE_TOOL_NAME
}

export function isPlanRevisionResult(content: unknown): boolean {
  const text = extractTextContent(content).trim()
  return text === PLAN_REJECTION_MESSAGE || text.startsWith(PLAN_REJECTION_WITH_REASON_PREFIX)
}

export function PlanPreviewCard({
  title,
  plan,
  filePath,
  allowedPrompts = [],
  requestedPermissionsTitle,
  emptyLabel = 'No plan content available.',
  embedded = false,
}: Props) {
  const t = useTranslation()
  const trimmedPlan = plan.trim()
  const planLines = trimmedPlan ? trimmedPlan.split('\n') : []
  const isLongPlan = planLines.length > PLAN_COLLAPSE_LINE_THRESHOLD || trimmedPlan.length > PLAN_COLLAPSE_CHAR_THRESHOLD
  const [expanded, setExpanded] = useState(false)
  const isCollapsedPreview = isLongPlan && !expanded
  const hiddenLineCount = Math.max(1, planLines.length - PLAN_COLLAPSE_LINE_THRESHOLD)

  // `embedded` is the plan inside the approval card, which already supplies
  // the frame and the header — a second bordered card inside it was the
  // card-in-card the 「素」 rules rule out. Standalone (a finished plan in the
  // transcript) it keeps its own elevated artifact card.
  return (
    <div
      data-testid="plan-preview-card"
      className={embedded
        ? 'min-w-0'
        : 'v6c-glass-card overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]'}
    >
      <div className={`flex min-w-0 items-center gap-2 ${embedded ? 'pb-2' : 'border-b border-[var(--color-border)] px-4 py-3'}`}>
        <FileText size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
        <div className="shrink-0 text-[13px] font-medium text-[var(--color-text-primary)]">
          {title}
        </div>
        {filePath ? (
          <div className="min-w-0 truncate rounded-[var(--radius-xs)] bg-[var(--color-surface-container-low)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-tertiary)]" title={filePath}>
            {filePath}
          </div>
        ) : null}
      </div>

      <div className="relative">
        <div
          className={[
            isCollapsedPreview
              ? 'max-h-[260px] overflow-hidden'
              : 'scrollbar-autohide scroll-edge-fade max-h-[520px] overflow-auto',
            embedded ? '' : 'px-4 py-3',
          ].filter(Boolean).join(' ')}
        >
          {trimmedPlan ? (
            <MarkdownRenderer content={trimmedPlan} variant="compact" />
          ) : (
            <div className="text-xs text-[var(--color-text-tertiary)]">{emptyLabel}</div>
          )}
        </div>
        {isCollapsedPreview ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--color-surface-container)] to-transparent"
          />
        ) : null}
      </div>

      {isLongPlan ? (
        <button
          type="button"
          data-plan-expand-toggle="true"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={`flex h-8 w-full items-center justify-center gap-1 border-t border-[var(--color-border)] text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] ${
            embedded ? 'mt-2 rounded-[var(--radius-md)]' : ''
          }`}
        >
          {expanded ? (
            <>
              {t('codeViewer.collapse')}
              <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" />
            </>
          ) : (
            <>
              {t('codeViewer.showMoreLines', { count: hiddenLineCount })}
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
            </>
          )}
        </button>
      ) : null}

      {allowedPrompts.length > 0 && requestedPermissionsTitle ? (
        <div className={embedded ? 'pt-2.5' : 'border-t border-[var(--color-border)] px-4 py-3'}>
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
            <ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />
            {requestedPermissionsTitle}
          </div>
          <ul className="space-y-0.5 pl-5">
            {allowedPrompts.map((prompt, index) => (
              <li
                key={`${prompt.tool}-${prompt.prompt}-${index}`}
                className="text-xs text-[var(--color-text-secondary)]"
              >
                <span className="rounded-[var(--radius-xs)] bg-[var(--color-surface-container-low)] px-1 font-mono text-[11px] text-[var(--color-text-primary)]">
                  {prompt.tool}
                </span>
                <span className="text-[var(--color-text-tertiary)]"> · </span>
                <span>{prompt.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export function extractPlanPreview(input: unknown, resultContent?: unknown): PlanPreviewModel {
  const inputRecord = asRecord(input)
  const resultText = extractTextContent(resultContent)
  const approvedPlan = resultText ? extractApprovedPlan(resultText) : ''

  return {
    plan:
      getString(inputRecord, 'plan') ||
      getString(inputRecord, 'planContent') ||
      approvedPlan,
    filePath:
      getString(inputRecord, 'planFilePath') ||
      getString(inputRecord, 'filePath') ||
      (resultText ? extractPlanFilePath(resultText) : ''),
    allowedPrompts: extractAllowedPrompts(inputRecord.allowedPrompts),
  }
}

export function buildPromptPermissionUpdates(allowedPrompts: AllowedPrompt[]): PermissionUpdate[] {
  if (allowedPrompts.length === 0) return []

  return [
    {
      type: 'addRules',
      rules: allowedPrompts.map((prompt) => ({
        toolName: prompt.tool,
        ruleContent: `prompt: ${prompt.prompt.trim()}`,
      })),
      behavior: 'allow',
      destination: 'session',
    },
  ]
}

/** Modes the approval dialog can hand the session before implementation starts. */
export type PlanApprovalMode = 'acceptEdits' | 'bypassPermissions'

/**
 * Approval with an explicit mode, mirroring the official CLI: every "yes" in
 * its plan dialog carries a `setMode` update, so a session that entered plan
 * mode without a previous mode to restore (e.g. it launched in plan mode) does
 * not silently land on `default` and start prompting for every tool call.
 */
export function buildPlanApprovalPermissionUpdates(
  mode: PlanApprovalMode,
  allowedPrompts: AllowedPrompt[],
): PermissionUpdate[] {
  return [
    { type: 'setMode', mode, destination: 'session' },
    ...buildPromptPermissionUpdates(allowedPrompts),
  ]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function extractAllowedPrompts(value: unknown): AllowedPrompt[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    const record = asRecord(item)
    const tool = getString(record, 'tool').trim()
    const prompt = getString(record, 'prompt').trim()
    return tool && prompt ? [{ tool, prompt }] : []
  })
}

function extractApprovedPlan(text: string): string {
  const match = /## Approved Plan(?: \(edited by user\))?:\s*\n([\s\S]*)$/i.exec(text)
  return match?.[1]?.trim() ?? ''
}

function extractPlanFilePath(text: string): string {
  const match = /^Your plan has been saved to:\s*(.+)$/m.exec(text)
  return match?.[1]?.trim() ?? ''
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk
        if (chunk && typeof chunk === 'object' && 'text' in chunk) {
          const text = (chunk as { text?: unknown }).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
