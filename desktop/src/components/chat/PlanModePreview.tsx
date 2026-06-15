import { FileText, ShieldCheck } from 'lucide-react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import type { PermissionUpdate } from '../../types/chat'

export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'

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
}

export function isExitPlanModeTool(toolName: string): boolean {
  return toolName === EXIT_PLAN_MODE_TOOL_NAME
}

export function PlanPreviewCard({
  title,
  plan,
  filePath,
  allowedPrompts = [],
  requestedPermissionsTitle,
  emptyLabel = 'No plan content available.',
}: Props) {
  const trimmedPlan = plan.trim()

  return (
    <div data-testid="plan-preview-card" className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-start gap-2 border-b border-[var(--color-border)]/65 bg-[var(--color-surface-container-low)] px-3 py-2.5">
        <FileText size={15} strokeWidth={2.1} className="mt-0.5 shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">
            {title}
          </div>
          {filePath ? (
            <div className="mt-0.5 truncate font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
              {filePath}
            </div>
          ) : null}
        </div>
      </div>

      <div className="max-h-[520px] overflow-auto px-3 py-3">
        {trimmedPlan ? (
          <MarkdownRenderer content={trimmedPlan} variant="compact" />
        ) : (
          <div className="text-xs text-[var(--color-text-tertiary)]">{emptyLabel}</div>
        )}
      </div>

      {allowedPrompts.length > 0 && requestedPermissionsTitle ? (
        <div className="border-t border-[var(--color-border)]/65 bg-[var(--color-surface-container-low)] px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase text-[var(--color-outline)]">
            <ShieldCheck size={13} strokeWidth={2.1} aria-hidden="true" />
            {requestedPermissionsTitle}
          </div>
          <div className="space-y-1">
            {allowedPrompts.map((prompt, index) => (
              <div
                key={`${prompt.tool}-${prompt.prompt}-${index}`}
                className="rounded-md border border-[var(--color-border)]/70 bg-[var(--color-surface)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)]"
              >
                <span className="font-[var(--font-mono)] font-semibold text-[var(--color-text-primary)]">
                  {prompt.tool}
                </span>
                <span className="text-[var(--color-text-tertiary)]"> · </span>
                <span>{prompt.prompt}</span>
              </div>
            ))}
          </div>
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
