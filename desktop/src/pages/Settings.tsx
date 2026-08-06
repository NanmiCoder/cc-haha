import { useEffect, useRef } from 'react'
import { useTranslation } from '../i18n'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { AdapterSettings } from './AdapterSettings'
import { useSkillStore } from '../stores/skillStore'
import { SkillList } from '../components/skills/SkillList'
import { SkillDetail } from '../components/skills/SkillDetail'
import { usePluginStore } from '../stores/pluginStore'
import { PluginList } from '../components/plugins/PluginList'
import { PluginDetail } from '../components/plugins/PluginDetail'
import { ComputerUseSettings } from './ComputerUseSettings'
import { McpSettings } from './McpSettings'
import { TerminalSettings } from './TerminalSettings'
import { DiagnosticsSettings } from './DiagnosticsSettings'
import { TraceList } from './TraceList'
import { ActivitySettings } from './ActivitySettings'
import { MemorySettings } from './MemorySettings'
import { PetSettings } from '../features/pets/PetSettings'
import { useUIStore } from '../stores/uiStore'
import { AgentManager } from '../components/settings/AgentManager'
import { H5AccessSettings } from './settings/H5AccessSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { AboutSettings } from './settings/AboutSettings'
import { ProviderSettings } from './settings/ProviderSettings'

export function Settings() {
  const activeTab = useUIStore((s) => s.activeSettingsTab)
  const setActiveTab = useUIStore((s) => s.setActiveSettingsTab)
  const pendingSettingsTab = useUIStore((s) => s.pendingSettingsTab)
  const t = useTranslation()

  useEffect(() => {
    if (!pendingSettingsTab) return
    setActiveTab(pendingSettingsTab)
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pendingSettingsTab, setActiveTab])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="flex-1 flex overflow-hidden">
        {/* Tab navigation */}
        {/* The rail keeps the Settings tab's 195px width for a same-width paper
            handoff when that tab sits at the leading edge of the strip. It does
            *not* chase the tab's live horizontal offset: the rail is page chrome,
            not a geometric extension of a scrollable tab chip, so following
            reorder/scroll lefts shoved the whole navigation mid-panel. Its
            tighter trailing gutter keeps the Japanese "コンピューター操作"
            clear at this width without moving the row contents left.

            Paper, separated by the rule, the way every other secondary panel
            in the app is (the workbench, the diff split). It used to be
            `--color-surface-container-low`, which is the same value the tab
            strip's trough resolves to — so the Settings tab, the one tab whose
            content this rail *is*, was the only selected tab in the app whose
            paper fill met a different colour at its bottom edge. It read as a
            white card stranded on a grey panel. Nothing else changed to fix
            it: the tab is right, this was the odd one out. */}
        <div
          data-testid="settings-navigation"
          className="w-[195px] flex-shrink-0 flex flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] py-4 pl-3 pr-1"
        >
          <div className="flex-1 flex flex-col gap-0.5">
            <TabButton icon="dns" label={t('settings.tab.providers')} active={activeTab === 'providers'} onClick={() => setActiveTab('providers')} />
            <TabButton icon="tune" label={t('settings.tab.general')} active={activeTab === 'general'} onClick={() => setActiveTab('general')} />
            <TabButton icon="qr_code_2" label={t('settings.tab.h5Access')} active={activeTab === 'h5Access'} onClick={() => setActiveTab('h5Access')} />
            <TabButton icon="chat" label={t('settings.tab.adapters')} active={activeTab === 'adapters'} onClick={() => setActiveTab('adapters')} />
            <TabButton icon="terminal" label={t('settings.tab.terminal')} active={activeTab === 'terminal'} onClick={() => setActiveTab('terminal')} />
            <TabButton icon="dns" label={t('settings.tab.mcp')} active={activeTab === 'mcp'} onClick={() => setActiveTab('mcp')} />
            <TabButton icon="smart_toy" label={t('settings.tab.agents')} active={activeTab === 'agents'} onClick={() => setActiveTab('agents')} />
            <TabButton icon="auto_awesome" label={t('settings.tab.skills')} active={activeTab === 'skills'} onClick={() => setActiveTab('skills')} />
            <TabButton icon="history_edu" label={t('settings.tab.memory')} active={activeTab === 'memory'} onClick={() => setActiveTab('memory')} />
            <TabButton icon="extension" label={t('settings.tab.plugins')} active={activeTab === 'plugins'} onClick={() => setActiveTab('plugins')} />
            <TabButton icon="pets" label={t('settings.tab.pets')} active={activeTab === 'pets'} onClick={() => setActiveTab('pets')} />
            <TabButton icon="mouse" label={t('settings.tab.computerUse')} active={activeTab === 'computerUse'} onClick={() => setActiveTab('computerUse')} />
            <TabButton icon="monitoring" label={t('settings.tab.activity')} active={activeTab === 'activity'} onClick={() => setActiveTab('activity')} />
            <TabButton icon="account_tree" label={t('settings.tab.trace')} active={activeTab === 'trace'} onClick={() => setActiveTab('trace')} />
            <TabButton icon="monitor_heart" label={t('settings.tab.diagnostics')} active={activeTab === 'diagnostics'} onClick={() => setActiveTab('diagnostics')} />
          </div>
          <div className="mt-2 border-t border-[var(--color-border-separator)] pt-2">
            <TabButton icon="info" label={t('settings.tab.about')} active={activeTab === 'about'} onClick={() => setActiveTab('about')} />
          </div>
        </div>

        {/* Tab content; trace embeds a full-bleed page that manages its own scroll */}
        <div className={activeTab === 'trace' ? 'flex-1 flex min-h-0 flex-col overflow-hidden' : 'flex-1 overflow-y-auto px-9 py-8'}>
          {activeTab === 'providers' && <ProviderSettings />}
          {activeTab === 'activity' && <ActivitySettings />}
          {activeTab === 'general' && <GeneralSettings />}
          {activeTab === 'h5Access' && <H5AccessSettings />}
          {activeTab === 'adapters' && <AdapterSettings />}
          {activeTab === 'terminal' && <TerminalSettings showPreferences />}
          {activeTab === 'mcp' && <McpSettings />}
          {activeTab === 'agents' && <AgentManager />}
          {activeTab === 'skills' && <SkillSettings />}
          {activeTab === 'memory' && <MemorySettings />}
          {activeTab === 'plugins' && <PluginSettings />}
          {activeTab === 'pets' && <PetSettings />}
          {activeTab === 'computerUse' && <ComputerUseSettings />}
          {activeTab === 'trace' && <TraceList />}
          {activeTab === 'diagnostics' && <DiagnosticsSettings />}
          {activeTab === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}

function TabButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)

  // The rail is taller than its viewport, and Settings remounts whenever the
  // tab is re-entered — from a trace tab's "back to list", say — with the
  // scroll position reset to the top. Without this the selected section can be
  // highlighted somewhere off-screen. `nearest` is a no-op when already visible.
  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  return (
    <button
      ref={ref}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      // `ring-offset` has to name the rail's own fill — it is painted, not
      // transparent, so it tracks whatever the rail is.
      className={`w-full flex items-center gap-2.5 rounded-[var(--radius-md)] py-2 pl-3 pr-2 text-[13.5px] text-left transition-[background-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] ${
        active
          ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] font-medium'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <span
        className={`material-symbols-outlined text-[18px] ${active ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

// ─── Skill Settings ──────────────────────────────────────

function SkillSettings() {
  const selectedSkill = useSkillStore((s) => s.selectedSkill)
  const t = useTranslation()

  if (selectedSkill) {
    return (
      <div className="w-full min-w-0">
        <SkillDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.skills.title')}
        description={t('settings.skills.description')}
      />
      <SkillList />
    </div>
  )
}

function PluginSettings() {
  const selectedPlugin = usePluginStore((s) => s.selectedPlugin)
  const t = useTranslation()

  if (selectedPlugin) {
    return (
      <div className="w-full min-w-0">
        <PluginDetail />
      </div>
    )
  }

  return (
    <div className="w-full min-w-0">
      <SettingsPageHeader
        title={t('settings.plugins.title')}
        description={t('settings.plugins.description')}
      />
      <PluginList />
    </div>
  )
}
