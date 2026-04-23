import { useState } from 'react'
import {
  mockPermissionModes,
  mockModels,
  mockEffortLevels,
  mockSessions,
  mockStatusBar,
} from '../mocks/data'

/* ────────────────────────────────────────────────────────────────────
   Icon helpers for the permission modes (matching HTML prototype exactly)
   ──────────────────────────────────────────────────────────────────── */
const permissionIcons: Record<string, { icon: string; color: string; selectedColor?: string }> = {
  ask:    { icon: 'verified_user', color: 'text-outline' },
  auto:   { icon: 'bolt',          color: 'text-outline' },
  plan:   { icon: 'architecture',  color: 'text-tertiary' },
  bypass: { icon: 'gavel',         color: 'text-error' },
}

const modelIcons: Record<string, string> = {
  opus:   'psychology',
  sonnet: 'smart_toy',
  haiku:  'auto_awesome',
}

/* ════════════════════════════════════════════════════════════════════
   SessionControls  —  full-page component (sidebar + header + chat +
   two open dropdown panels + composer + footer)
   ════════════════════════════════════════════════════════════════════ */
export default function SessionControls() {
  const [selectedPermission, setSelectedPermission] = useState('ask')
  const [selectedModel, setSelectedModel] = useState('sonnet')
  const [selectedEffort, setSelectedEffort] = useState('Medium')
  const [showPermissions, setShowPermissions] = useState(true)
  const [showModelConfig, setShowModelConfig] = useState(true)

  const activeModel = mockModels.find((m) => m.id === selectedModel)

  return (
    <div className="h-screen w-screen bg-background text-on-surface font-body selection:bg-primary-fixed overflow-hidden relative">
      {/* ─── TopAppBar ─────────────────────────────────────────── */}
      <header className="bg-[#FAF9F5] font-headline font-semibold tracking-wide text-sm fixed top-0 left-0 right-0 flex justify-between items-center px-6 h-12 z-40">
        <div className="flex items-center gap-6">
          <span className="text-sm font-bold text-[#1B1C1A] uppercase tracking-tighter">
            Claude Code Companion
          </span>
          <nav className="hidden md:flex gap-4">
            <a className="text-[#1B1C1A] border-b-2 border-[#8F482F] pb-1 cursor-pointer active:opacity-70">
              Code
            </a>
            <a className="text-[#87736D] hover:text-[#8F482F] transition-colors cursor-pointer active:opacity-70">
              Terminal
            </a>
            <a className="text-[#87736D] hover:text-[#8F482F] transition-colors cursor-pointer active:opacity-70">
              History
            </a>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[#87736D] cursor-pointer">
            arrow_back_ios
          </span>
          <span className="material-symbols-outlined text-[#87736D] cursor-pointer">
            arrow_forward_ios
          </span>
          <button className="ml-2 px-3 py-1 bg-surface-container-high rounded text-[#8F482F] hover:bg-surface-container-highest transition-colors">
            Settings
          </button>
        </div>
      </header>

      {/* Separator line */}
      <div className="bg-[#F4F4F0] h-[1px] w-full fixed top-12 z-40" />

      {/* ─── SideNavBar ────────────────────────────────────────── */}
      <aside className="bg-[#F4F4F0] font-body text-sm font-medium fixed left-0 top-0 h-full w-[280px] hidden md:flex flex-col p-4 gap-2 pt-16 z-30">
        {/* Project header */}
        <div className="px-2 mb-4">
          <div className="flex items-center gap-3 mb-1">
            <img
              className="w-8 h-8 rounded-full"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuCjFls9oDx5jX7Zv8P7BA9QbodBzvDJFhVNIiVjAhp_OhnXT6lmE-uYCDDZvNS4kWHssfxAYuiH05KsXLBWgLd4K-8prrjodVjSsKAG1LhvKWN90nyVzDBSrreWkpW7reNC1N_T4J_Pdr9mgAYVwYRS10nvUMZs_ajpTg2CoTtMkQRRGZGZXLk_gU94EoaeDEPNbvwaxOeeTeGgOxwnzcPIUn6EFzqc5Bjug00IDIrhRYiuwEaGNkTuz39mNFxJl2bKiHES5HxUM60"
              alt="project avatar"
            />
            <div>
              <h3 className="text-on-surface font-bold leading-none">All projects</h3>
              <p className="text-[10px] text-outline uppercase tracking-widest mt-1">
                Active Session
              </p>
            </div>
          </div>
        </div>

        {/* Nav items */}
        <button className="w-full text-left p-2.5 bg-[#FAF9F5] text-[#1B1C1A] rounded-lg relative before:content-[''] before:absolute before:left-[-8px] before:w-1 before:h-4 before:bg-[#8F482F] before:rounded-full before:top-1/2 before:-translate-y-1/2 transition-all duration-200 ease-in-out flex items-center gap-3">
          <span className="material-symbols-outlined text-[#8F482F]">add</span>
          <span>New session</span>
        </button>
        <button className="w-full text-left p-2.5 text-[#87736D] hover:bg-[#EBEBE6] rounded-lg transition-all duration-200 ease-in-out flex items-center gap-3">
          <span className="material-symbols-outlined">calendar_today</span>
          <span>Scheduled</span>
        </button>
        <button className="w-full text-left p-2.5 text-[#87736D] hover:bg-[#EBEBE6] rounded-lg transition-all duration-200 ease-in-out flex items-center gap-3" data-count={mockSessions.today.length}>
          <span className="material-symbols-outlined">history</span>
          <span>Today</span>
        </button>
        <button className="w-full text-left p-2.5 text-[#87736D] hover:bg-[#EBEBE6] rounded-lg transition-all duration-200 ease-in-out flex items-center gap-3" data-count={mockSessions.previous7Days.length}>
          <span className="material-symbols-outlined">event_note</span>
          <span>Previous 7 Days</span>
        </button>
        <button className="w-full text-left p-2.5 text-[#87736D] hover:bg-[#EBEBE6] rounded-lg transition-all duration-200 ease-in-out flex items-center gap-3" data-count={mockSessions.older.length}>
          <span className="material-symbols-outlined">archive</span>
          <span>Older</span>
        </button>

        {/* Bottom modes */}
        <div className="mt-auto pt-4 border-t border-outline/10 flex flex-col gap-1">
          <button className="flex items-center gap-3 p-2 text-outline hover:text-primary transition-colors">
            <span className="material-symbols-outlined text-xs">computer</span>
            <span className="text-xs">Local Mode</span>
          </button>
          <button className="flex items-center gap-3 p-2 text-outline hover:text-primary transition-colors">
            <span className="material-symbols-outlined text-xs">cloud</span>
            <span className="text-xs">Remote Mode</span>
          </button>
        </div>
      </aside>

      {/* ─── Main Content Area (blurred / dimmed behind overlays) ── */}
      <main className="md:ml-[280px] pt-12 pb-8 min-h-screen blur-[2px] opacity-60">
        <div className="max-w-4xl mx-auto px-8 py-12">
          <div className="grid grid-cols-12 gap-6">
            {/* Main Thread */}
            <div className="col-span-8 space-y-8">
              {/* AI message */}
              <div className="bg-surface-container-low rounded-xl p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold text-xs">
                    AI
                  </div>
                  <span className="font-semibold text-sm">Claude 4.6 Sonnet</span>
                </div>
                <p className="text-on-surface-variant leading-relaxed">
                  I've analyzed the{' '}
                  <code className="bg-surface-dim px-1.5 py-0.5 rounded font-mono text-sm">
                    auth_provider.go
                  </code>{' '}
                  file. The race condition occurs during the token refresh cycle. I recommend
                  wrapping the session update in a mutex lock.
                </p>
              </div>

              {/* User message */}
              <div className="flex justify-end">
                <div className="bg-surface-container-highest rounded-xl p-6 max-w-[80%]">
                  <p className="text-on-surface leading-relaxed">
                    Can you implement that? Also check if this affects the WebSocket connection
                    longevity.
                  </p>
                </div>
              </div>

              {/* Code Block Preview */}
              <div className="bg-surface-dim rounded-lg overflow-hidden font-mono text-sm">
                <div className="bg-surface-container-high px-4 py-2 flex justify-between items-center">
                  <span className="text-xs text-on-surface-variant">
                    internal/auth/provider.go
                  </span>
                  <span className="material-symbols-outlined text-sm text-outline cursor-pointer">
                    content_copy
                  </span>
                </div>
                <pre className="p-4 text-on-surface">
                  <code>{`func (p *Provider) RefreshToken(ctx context.Context) error {
    p.mu.Lock()
    defer p.mu.Unlock()

    // logic to refresh token...
    return nil
}`}</code>
                </pre>
              </div>
            </div>

            {/* Session Meta */}
            <div className="col-span-4 space-y-6">
              <div className="bg-surface-container-lowest border border-outline-variant/20 rounded-xl p-4">
                <h4 className="text-xs font-bold uppercase tracking-widest text-outline mb-4">
                  Context Files
                </h4>
                <ul className="space-y-3">
                  <li className="flex items-center gap-2 text-sm text-on-surface-variant">
                    <span className="material-symbols-outlined text-sm">description</span>
                    auth_provider.go
                  </li>
                  <li className="flex items-center gap-2 text-sm text-on-surface-variant">
                    <span className="material-symbols-outlined text-sm">description</span>
                    main.go
                  </li>
                  <li className="flex items-center gap-2 text-sm text-on-surface-variant">
                    <span className="material-symbols-outlined text-sm">description</span>
                    session_test.go
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ─── Overlay Layer (Active Selectors) ──────────────────── */}
      <div className="fixed inset-0 z-50 flex flex-col justify-end items-center pointer-events-none p-8">
        {/* Floating Dropdown Overlay Container */}
        <div className="w-full max-w-2xl flex gap-4 mb-4 pointer-events-auto items-end">
          {/* ── Permissions Dropdown ─────────────────────────────── */}
          {showPermissions && (
            <div
              className="w-80 rounded-xl border border-[#E8E6DC] overflow-hidden flex flex-col"
              style={{
                background: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(20px)',
                boxShadow:
                  '0 4px 20px rgba(27, 28, 26, 0.04), 0 12px 40px rgba(27, 28, 26, 0.08)',
              }}
            >
              <div className="px-4 py-3 bg-surface-container-low border-b border-[#E8E6DC]">
                <span className="text-[10px] font-bold uppercase tracking-widest text-outline">
                  Execution Permissions
                </span>
              </div>
              <div className="p-2 space-y-1">
                {mockPermissionModes.map((mode) => {
                  const meta = permissionIcons[mode.id] || {
                    icon: mode.icon,
                    color: 'text-outline',
                  }
                  const isSelected = selectedPermission === mode.id
                  const isPlan = mode.id === 'plan'
                  const isBypass = mode.id === 'bypass'

                  let hoverClass = 'hover:bg-surface-container-high'
                  if (isPlan) hoverClass = 'hover:bg-tertiary-container/10'
                  if (isBypass) hoverClass = 'hover:bg-error-container/20'

                  let labelColor = ''
                  if (isPlan) labelColor = 'text-tertiary'
                  if (isBypass) labelColor = 'text-error'

                  return (
                    <button
                      key={mode.id}
                      onClick={() => setSelectedPermission(mode.id)}
                      className={`w-full text-left p-3 rounded-lg ${hoverClass} transition-colors flex gap-3 group`}
                    >
                      <span
                        className={`material-symbols-outlined ${meta.color} mt-0.5`}
                      >
                        {meta.icon}
                      </span>
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-semibold ${labelColor}`}>
                            {mode.label}
                          </span>
                          {isSelected && (
                            <span className="material-symbols-outlined text-primary text-sm">
                              check_circle
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-on-surface-variant">{mode.description}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── Model & Effort Dropdown ─────────────────────────── */}
          {showModelConfig && (
            <div
              className="w-64 rounded-xl border border-[#E8E6DC] overflow-hidden flex flex-col"
              style={{
                background: 'rgba(255, 255, 255, 0.85)',
                backdropFilter: 'blur(20px)',
                boxShadow:
                  '0 4px 20px rgba(27, 28, 26, 0.04), 0 12px 40px rgba(27, 28, 26, 0.08)',
              }}
            >
              <div className="px-4 py-3 bg-surface-container-low border-b border-[#E8E6DC]">
                <span className="text-[10px] font-bold uppercase tracking-widest text-outline">
                  Model Configuration
                </span>
              </div>

              {/* Models */}
              <div className="p-2">
                {mockModels.map((model) => {
                  const isActive = selectedModel === model.id
                  const icon = modelIcons[model.id] || 'smart_toy'

                  return (
                    <button
                      key={model.id}
                      onClick={() => setSelectedModel(model.id)}
                      className={`w-full text-left p-2.5 rounded-lg flex items-center justify-between transition-colors ${
                        isActive
                          ? 'bg-primary/5 text-primary'
                          : 'hover:bg-surface-container-high'
                      }`}
                    >
                      <div
                        className={`flex items-center gap-2 ${
                          isActive ? 'font-semibold' : ''
                        }`}
                      >
                        <span
                          className={`material-symbols-outlined text-sm ${
                            isActive ? '' : 'text-outline'
                          }`}
                        >
                          {icon}
                        </span>
                        <span className="text-sm">{model.name}</span>
                      </div>
                      {isActive && (
                        <span className="material-symbols-outlined text-sm">
                          radio_button_checked
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Divider */}
              <div className="mx-4 h-[1px] bg-[#E8E6DC]" />

              {/* Effort levels */}
              <div className="p-2">
                <div className="px-2 mb-2">
                  <span className="text-[9px] font-bold text-outline uppercase tracking-tighter">
                    Thinking Effort
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {mockEffortLevels.map((level) => {
                    const isActive = selectedEffort === level
                    /* The HTML uses "Med" for the label display of "Medium" */
                    const displayLabel =
                      level === 'Medium' ? 'Med' : level

                    return (
                      <button
                        key={level}
                        onClick={() => setSelectedEffort(level)}
                        className={`text-xs py-2 px-3 rounded-md transition-all ${
                          isActive
                            ? 'bg-primary text-on-primary'
                            : 'border border-outline-variant/30 hover:border-primary'
                        } ${level === 'Max' ? 'font-bold' : ''}`}
                      >
                        {displayLabel}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── The Composer (Anchor) ─────────────────────────────── */}
        <div
          className="w-full max-w-2xl p-4 rounded-xl border border-outline-variant/15 pointer-events-auto flex flex-col gap-3"
          style={{
            background: 'rgba(255, 255, 255, 0.85)',
            backdropFilter: 'blur(20px)',
            boxShadow:
              '0 4px 20px rgba(27, 28, 26, 0.04), 0 12px 40px rgba(27, 28, 26, 0.08)',
          }}
        >
          <textarea
            className="w-full bg-transparent border-none focus:ring-0 focus:outline-none resize-none font-body text-on-surface placeholder:text-outline"
            placeholder="Reply to Claude..."
            rows={2}
          />
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              {/* Permission pill */}
              <button
                onClick={() => setShowPermissions((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-container-low border border-[#E8E6DC] text-xs font-medium hover:bg-surface-container-high transition-all"
              >
                <span className="material-symbols-outlined text-base">
                  {permissionIcons[selectedPermission]?.icon || 'verified_user'}
                </span>
                {mockPermissionModes.find((m) => m.id === selectedPermission)?.label ||
                  'Ask permissions'}
              </button>

              {/* Model pill */}
              <button
                onClick={() => setShowModelConfig((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-container-low border border-[#E8E6DC] text-xs font-medium hover:bg-surface-container-high transition-all"
              >
                <span className="material-symbols-outlined text-base">
                  {modelIcons[selectedModel] || 'smart_toy'}
                </span>
                {activeModel?.name || 'Sonnet 4.6'}
              </button>

              {/* Attach file button */}
              <button className="p-1.5 rounded-lg text-outline hover:bg-surface-container-low transition-colors">
                <span className="material-symbols-outlined">attach_file</span>
              </button>
            </div>

            {/* Run button */}
            <button className="bg-primary text-on-primary px-4 py-1.5 rounded-lg font-semibold text-sm flex items-center gap-2 hover:opacity-90 transition-opacity">
              Run
              <span className="material-symbols-outlined text-base">send</span>
            </button>
          </div>
        </div>
      </div>

      {/* ─── Footer / Status Bar ───────────────────────────────── */}
      <footer className="bg-[#FAF9F5] font-body text-xs tracking-tight fixed bottom-0 left-0 w-full h-8 border-t border-[#87736D]/20 flex items-center justify-between px-4 z-[60]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-4 rounded-full bg-primary-fixed flex items-center justify-center">
              <span
                className="material-symbols-outlined text-[10px] text-on-primary-fixed"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                person
              </span>
            </div>
            <span className="text-outline">
              {mockStatusBar.user} &bull; {mockStatusBar.username} &bull; {mockStatusBar.plan}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button className="text-primary font-bold hover:bg-[#F4F4F0] transition-colors px-2 py-0.5 rounded">
            {mockStatusBar.branch}
          </button>
          <button className="text-[#87736D] hover:bg-[#F4F4F0] transition-colors px-2 py-0.5 rounded">
            {mockStatusBar.worktreeToggle}
          </button>
          <button className="text-[#87736D] hover:bg-[#F4F4F0] transition-colors px-2 py-0.5 rounded">
            {mockStatusBar.localSwitch}
          </button>
        </div>
      </footer>
    </div>
  )
}
