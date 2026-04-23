import { useState } from 'react'
import { mockToolInspection } from '../mocks/data'

export function ToolInspection() {
  const [activeDiffTab, setActiveDiffTab] = useState<'split' | 'unified'>('split')

  const { toolType, toolName, description, filePath, dryRunStatus, linesChanged, diffLines } =
    mockToolInspection

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-surface)]">
      {/* Separator */}
      <div className="h-px w-full bg-[var(--color-surface-container)]" />

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-8 max-w-6xl mx-auto w-full">
        <div className="flex flex-col gap-6">
          {/* ── Title row + action buttons ─────────────────── */}
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 bg-[var(--color-primary-fixed)] text-[var(--color-on-primary)] text-[10px] font-bold rounded uppercase tracking-widest">
                  {toolType}
                </span>
                <h1 className="font-[var(--font-headline)] font-extrabold text-2xl text-[var(--color-on-surface)] tracking-tight">
                  {toolName}
                </h1>
              </div>
              <p className="text-[var(--color-on-surface-variant)] font-medium">{description}</p>
            </div>
            <div className="flex gap-2">
              <button className="px-4 py-2 bg-[var(--color-surface-container-high)] rounded-lg text-sm font-semibold hover:bg-[var(--color-surface-variant)] transition-all">
                Revert Change
              </button>
              <button className="px-4 py-2 bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-lg text-sm font-semibold shadow-sm hover:opacity-90 transition-all">
                Apply to All
              </button>
            </div>
          </div>

          {/* ── Metadata cards ─────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-[var(--color-surface-container-low)] rounded-xl p-4 flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[var(--color-outline)] uppercase tracking-wider">
                Target File
              </span>
              <div className="flex items-center gap-2 text-[var(--color-on-surface)]">
                <span className="material-symbols-outlined text-[18px]">description</span>
                <span className="font-[var(--font-mono)] text-sm">{filePath}</span>
              </div>
            </div>

            <div className="bg-[var(--color-surface-container-low)] rounded-xl p-4 flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[var(--color-outline)] uppercase tracking-wider">
                Status
              </span>
              <div className="flex items-center gap-2 text-[var(--color-tertiary)]">
                <span
                  className="material-symbols-outlined text-[18px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  check_circle
                </span>
                <span className="font-semibold text-sm">{dryRunStatus}</span>
              </div>
            </div>

            <div className="bg-[var(--color-surface-container-low)] rounded-xl p-4 flex flex-col gap-1">
              <span className="text-[10px] font-bold text-[var(--color-outline)] uppercase tracking-wider">
                Lines Modified
              </span>
              <div className="flex items-center gap-2 text-[var(--color-on-surface)]">
                <span className="material-symbols-outlined text-[18px]">edit_note</span>
                <span className="font-semibold text-sm">
                  +{linesChanged.added} / -{linesChanged.removed} lines
                </span>
              </div>
            </div>
          </div>

          {/* ── Diff Viewer ────────────────────────────────── */}
          <div className="bg-[var(--color-surface-dim)] rounded-xl overflow-hidden border border-[var(--color-outline-variant)]/20 shadow-sm">
            <div className="px-4 py-2.5 bg-[var(--color-surface-container-high)] flex items-center justify-between border-b border-[var(--color-outline-variant)]/20">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-error)] opacity-30" />
                  <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-primary-fixed-dim)]" />
                  <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-tertiary-container)] opacity-30" />
                </div>
                <span className="font-[var(--font-mono)] text-xs text-[var(--color-outline)] px-2 border-l border-[var(--color-outline-variant)]/30">
                  {filePath} — Diff View
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[11px] text-[var(--color-outline)] font-medium">
                  L{diffLines[0]?.lineNo ?? 1} — L{diffLines[diffLines.length - 1]?.lineNo ?? 1}
                </span>
                <div className="flex bg-[var(--color-surface-container-low)] rounded p-0.5">
                  <button
                    onClick={() => setActiveDiffTab('split')}
                    className={`px-2 py-1 text-[10px] font-bold uppercase ${
                      activeDiffTab === 'split'
                        ? 'bg-[var(--color-surface)] rounded shadow-sm text-[var(--color-on-surface)]'
                        : 'text-[var(--color-outline)]'
                    }`}
                  >
                    Split
                  </button>
                  <button
                    onClick={() => setActiveDiffTab('unified')}
                    className={`px-2 py-1 text-[10px] font-bold uppercase ${
                      activeDiffTab === 'unified'
                        ? 'bg-[var(--color-surface)] rounded shadow-sm text-[var(--color-on-surface)]'
                        : 'text-[var(--color-outline)]'
                    }`}
                  >
                    Unified
                  </button>
                </div>
              </div>
            </div>

            <div className="font-[var(--font-mono)] text-[13px] leading-relaxed p-4 overflow-x-auto whitespace-pre">
              {diffLines.map((line, idx) => {
                const isAdded = line.type === 'added'
                const isRemoved = line.type === 'removed'

                let rowBg = ''
                if (isAdded) rowBg = 'bg-[var(--color-diff-added-bg)]'
                else if (isRemoved) rowBg = 'bg-[var(--color-diff-removed-bg)]'

                let lineNoColor = 'text-[var(--color-outline)] opacity-40'
                if (isAdded) lineNoColor = 'text-[var(--color-tertiary)] opacity-40'
                else if (isRemoved) lineNoColor = 'text-[var(--color-error)] opacity-40'

                const prefix = isAdded ? '+   ' : isRemoved ? '-   ' : '    '

                return (
                  <div key={idx} className={`flex w-full ${rowBg}`}>
                    <span
                      className={`w-10 flex-shrink-0 text-right pr-4 select-none ${lineNoColor}`}
                    >
                      {line.lineNo}
                    </span>
                    <span className="text-[var(--color-on-surface-variant)]">
                      {prefix}
                      {line.content}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Implementation Context ─────────────────────── */}
          <div className="p-6 bg-[var(--color-surface-container-lowest)] rounded-2xl border border-[var(--color-outline-variant)]/10">
            <h3 className="font-[var(--font-headline)] font-bold text-sm text-[var(--color-on-surface)] mb-4">
              Implementation Context
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1 w-6 h-6 rounded bg-[var(--color-primary-fixed)] flex items-center justify-center">
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-on-primary)]">
                      psychology
                    </span>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-outline)] mb-1">
                      Reasoning
                    </p>
                    <p className="text-sm text-[var(--color-on-surface-variant)] leading-relaxed">
                      The <code className="font-[var(--font-mono)]">legacyAuthService</code> was
                      deprecated in RFC-204. The new SDK provides automatic session refresh and
                      better error typing. This migration ensures the login flow is compliant with
                      the new security standards.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="mt-1 w-6 h-6 rounded bg-[var(--color-diff-added-bg)] flex items-center justify-center">
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-diff-added-text)]">
                      science
                    </span>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-outline)] mb-1">
                      Impact Analysis
                    </p>
                    <p className="text-sm text-[var(--color-on-surface-variant)] leading-relaxed">
                      No changes needed in calling components. The interface remains compatible but
                      internal state management is improved.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-center">
                <div className="w-full h-32 rounded-xl bg-[var(--color-surface-container)] relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-primary)]/5 to-[var(--color-secondary)]/5" />
                  <div className="absolute inset-0 flex items-center justify-center gap-4">
                    <div className="flex flex-col items-center gap-1">
                      <div className="p-2 bg-[var(--color-surface)] rounded-lg shadow-sm">
                        <span className="material-symbols-outlined text-[var(--color-outline)]">
                          description
                        </span>
                      </div>
                      <span className="text-[9px] font-bold text-[var(--color-outline)]">
                        auth.ts
                      </span>
                    </div>
                    <span className="material-symbols-outlined text-[var(--color-outline)] animate-pulse">
                      keyboard_double_arrow_right
                    </span>
                    <div className="flex flex-col items-center gap-1">
                      <div className="p-2 bg-[var(--color-surface)] rounded-lg shadow-sm border border-[var(--color-tertiary)]/20">
                        <span className="material-symbols-outlined text-[var(--color-tertiary)]">
                          check_circle
                        </span>
                      </div>
                      <span className="text-[9px] font-bold text-[var(--color-tertiary)]">
                        Verified
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
