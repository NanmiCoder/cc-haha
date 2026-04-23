import { useState } from 'react'
import { mockTeam, mockTeamMessages } from '../mocks/data'

// ─── Inline keyframes for pulse-subtle animation ─────────────────
const pulseSubtleStyle = `
@keyframes pulse-subtle {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; transform: scale(0.98); }
}
.animate-pulse-subtle {
  animation: pulse-subtle 2s ease-in-out infinite;
}
`

export function AgentTeams() {
  const [inputValue, setInputValue] = useState('')

  return (
    <>
      <style>{pulseSubtleStyle}</style>

      <div className="flex-1 flex flex-col relative overflow-hidden bg-[var(--color-surface)] text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-body)' }}>
        {/* Code Content Area */}
        <div className="flex-1 overflow-y-auto p-6 md:p-10 max-w-5xl mx-auto w-full">
          <div className="space-y-8">
            {/* ─── Message Thread ─── */}
            <div className="space-y-6">
              {/* USER message */}
              <div className="flex gap-4 group">
                <div className="w-8 h-8 rounded-full bg-[var(--color-primary-fixed)] flex-shrink-0 flex items-center justify-center text-[var(--color-on-primary)] font-bold text-xs">
                  U
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-widest">
                    User
                  </p>
                  <p className="text-[var(--color-text-primary)] leading-relaxed">
                    {mockTeamMessages.userMessage}
                  </p>
                </div>
              </div>

              {/* CLAUDE COMPANION response */}
              <div className="flex gap-4 group">
                <div className="w-8 h-8 rounded-full bg-[var(--color-tertiary-container)] flex-shrink-0 flex items-center justify-center text-[var(--color-tertiary)]">
                  <span
                    className="material-symbols-outlined text-sm"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    smart_toy
                  </span>
                </div>
                <div className="space-y-4 flex-1">
                  <p className="text-xs font-semibold text-[var(--color-text-tertiary)] uppercase tracking-widest">
                    Claude Companion
                  </p>
                  <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-5 shadow-[var(--shadow-dropdown)]">
                    <p className="mb-4 text-[var(--color-text-primary)]">
                      {mockTeamMessages.assistantMessage}
                    </p>
                    <div className="rounded-lg bg-[var(--color-surface-container-high)] p-4 font-[var(--font-mono)] text-[13px] text-[var(--color-text-secondary)] overflow-x-auto">
                      <span className="text-[var(--color-brand)]">info:</span> spawning child_processes for parallel development
                      <br />
                      <span className="text-[var(--color-secondary)]">active:</span> session-dev cluster initiated
                      <br />
                      <span className="text-[var(--color-tertiary)]">ready:</span> 4 agents assigned
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ─── TEAM STRIP ─── */}
            <div className="relative py-8">
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-[var(--color-border-separator)]" />

              <div className="relative glass-panel p-4 rounded-2xl flex flex-col md:flex-row md:items-center gap-4 overflow-hidden">
                {/* Team label */}
                <div className="flex items-center gap-3 pr-4 md:border-r border-[var(--color-border-separator)]">
                  <div className="p-2 bg-[var(--color-primary-fixed)]/20 rounded-lg">
                    <span className="material-symbols-outlined text-[var(--color-brand)] text-xl">
                      groups
                    </span>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
                      Team: {mockTeam.name}
                    </h3>
                    <p className="text-[11px] font-medium text-[var(--color-text-tertiary)] uppercase tracking-tighter">
                      {mockTeam.memberCount} members
                    </p>
                  </div>
                </div>

                {/* Agent Chips */}
                <div className="flex flex-wrap gap-2 items-center flex-1">
                  {mockTeam.members.map((member) => {
                    if (member.status === 'completed') {
                      return (
                        <div
                          key={member.id}
                          className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-container-high)] rounded-full border border-[var(--color-success)]/20 group hover:border-[var(--color-success)]/50 transition-all cursor-pointer"
                        >
                          <div className="w-2 h-2 rounded-full bg-[var(--color-success)] shadow-[0_0_8px_rgba(126,219,139,0.4)]" />
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                            {member.role}
                          </span>
                          <span
                            className="material-symbols-outlined text-[14px] text-[var(--color-success)]"
                            style={{ fontVariationSettings: "'FILL' 1" }}
                          >
                            check_circle
                          </span>
                        </div>
                      )
                    }

                    if (member.status === 'running') {
                      return (
                        <div
                          key={member.id}
                          className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-container-high)] rounded-full border border-[var(--color-brand)]/20 animate-pulse-subtle group hover:border-[var(--color-brand)]/50 transition-all cursor-pointer"
                        >
                          <div className="w-2 h-2 rounded-full bg-[var(--color-warning)] shadow-[0_0_8px_rgba(247,196,108,0.4)]" />
                          <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                            {member.role}
                          </span>
                          <span
                            className="material-symbols-outlined text-[14px] text-[var(--color-warning)]"
                            style={{ fontVariationSettings: "'FILL' 1" }}
                          >
                            sync
                          </span>
                        </div>
                      )
                    }

                    return (
                      <div
                        key={member.id}
                        className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-container-low)] rounded-full border border-[var(--color-border)] grayscale group hover:grayscale-0 hover:border-[var(--color-secondary)]/50 transition-all cursor-pointer"
                      >
                        <div className="w-2 h-2 rounded-full bg-[var(--color-text-tertiary)] shadow-[0_0_8px_rgba(135,115,109,0.2)]" />
                        <span className="text-xs font-semibold text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-primary)]">
                          {member.role}
                        </span>
                        <span className="material-symbols-outlined text-[14px] text-[var(--color-text-tertiary)]">
                          {member.role === 'Tester' ? 'schedule' : 'pause_circle'}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {/* Expand button */}
                <button className="ml-auto p-2 hover:bg-[var(--color-surface-hover)] rounded-full transition-colors text-[var(--color-text-tertiary)]">
                  <span className="material-symbols-outlined text-sm">expand_more</span>
                </button>
              </div>
            </div>

            {/* ─── Chat Composer ─── */}
            <div className="max-w-3xl mx-auto w-full mt-auto">
              <div className="glass-panel relative rounded-xl p-1.5 flex items-center gap-2 transition-all">
                <div className="p-2 text-[var(--color-text-secondary)]">
                  <span className="material-symbols-outlined">attach_file</span>
                </div>
                <input
                  className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none text-sm text-[var(--color-text-primary)] py-2"
                  placeholder="Type a command or ask Claude..."
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                />
                <button className="bg-[image:var(--gradient-btn-primary)] text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] w-9 h-9 rounded-lg flex items-center justify-center transition-all hover:brightness-105 active:scale-95">
                  <span
                    className="material-symbols-outlined text-lg"
                    style={{ fontVariationSettings: "'FILL' 1" }}
                  >
                    send
                  </span>
                </button>
              </div>
              <div className="mt-3 flex justify-center gap-4">
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)] font-semibold uppercase tracking-widest">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
                  Auto-run enabled
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-tertiary)] font-semibold uppercase tracking-widest">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-secondary)]" />
                  Local LLM
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
