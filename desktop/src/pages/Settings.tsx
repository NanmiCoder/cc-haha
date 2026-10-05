import { H5Settings } from './settings/H5Settings'
import { getDesktopHost } from '@/lib/desktopHost'
import { useEffect, useRef } from 'react'
import {
  BookOpen,
  Bot,
  Box,
  ChartNoAxesColumn,
  HeartPulse,
  Info,
  MessageSquare,
  Mic,
  MousePointer2,
  PawPrint,
  Plug,
  Puzzle,
  QrCode,
  Server,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation, type TranslationKey } from '../i18n'
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
import { ActivitySettings } from './ActivitySettings'
import { MemorySettings } from './MemorySettings'
import { PetSettings } from '../features/pets/PetSettings'
import { useUIStore, type SettingsTab } from '../stores/uiStore'
import { AgentManager } from '../components/settings/AgentManager'
import { H5AccessSettings } from './settings/H5AccessSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { VoiceInputSettings } from './settings/VoiceInputSettings'
import { AboutSettings } from './settings/AboutSettings'
import { ProviderSettings } from './settings/ProviderSettings'

export function Settings() {
  return getDesktopHost().isDesktop ? <DesktopSettings /> : <H5Settings />
}

type SettingsNavEntry = { tab: SettingsTab; icon: LucideIcon; label: TranslationKey }

const SETTINGS_NAV: SettingsNavEntry[] = [
  { tab: 'providers', icon: Server, label: 'settings.tab.providers' },
  { tab: 'general', icon: SlidersHorizontal, label: 'settings.tab.general' },
  { tab: 'voice', icon: Mic, label: 'settings.tab.voice' },
  { tab: 'h5Access', icon: QrCode, label: 'settings.tab.h5Access' },
  { tab: 'adapters', icon: MessageSquare, label: 'settings.tab.adapters' },
  { tab: 'terminal', icon: SquareTerminal, label: 'settings.tab.terminal' },
  { tab: 'mcp', icon: Plug, label: 'settings.tab.mcp' },
  { tab: 'agents', icon: Bot, label: 'settings.tab.agents' },
  { tab: 'skills', icon: Box, label: 'settings.tab.skills' },
  { tab: 'memory', icon: BookOpen, label: 'settings.tab.memory' },
  { tab: 'plugins', icon: Puzzle, label: 'settings.tab.plugins' },
  { tab: 'pets', icon: PawPrint, label: 'settings.tab.pets' },
  { tab: 'computerUse', icon: MousePointer2, label: 'settings.tab.computerUse' },
  { tab: 'activity', icon: ChartNoAxesColumn, label: 'settings.tab.activity' },
  { tab: 'diagnostics', icon: HeartPulse, label: 'settings.tab.diagnostics' },
]

/** Set apart below a rule, the way the reference rail ends. */
const SETTINGS_NAV_ABOUT: SettingsNavEntry = { tab: 'about', icon: Info, label: 'settings.tab.about' }

export function DesktopSettings() {
  const activeTab = useUIStore((s) => s.activeSettingsTab)
  const setActiveTab = useUIStore((s) => s.setActiveSettingsTab)
  const pendingSettingsTab = useUIStore((s) => s.pendingSettingsTab)
  const t = useTranslation()

  useEffect(() => {
    if (!pendingSettingsTab) return
    setActiveTab(pendingSettingsTab)
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pendingSettingsTab, setActiveTab])

  const navItem = ({ tab, icon, label }: SettingsNavEntry) => (
    <TabButton key={tab} icon={icon} label={t(label)} active={activeTab === tab} onClick={() => setActiveTab(tab)} />
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--color-surface)]">
      <div className="flex-1 flex overflow-hidden">
        {/* The rail sits on the page's own paper, separated by the rule, the
            way every other secondary panel in the app is (the workbench, the
            diff split). The Settings tab is filled with paper so its bottom
            edge runs unbroken into the view it opens onto; a grey rail here
            made it the one tab whose paper met a different colour. */}
        <nav
          data-testid="settings-navigation"
          aria-label={t('settings.title')}
          className="w-[216px] flex-shrink-0 flex flex-col overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-[18px]"
        >
          <div className="px-2.5 pb-2 text-xs font-semibold text-[var(--color-text-tertiary)]">{t('settings.title')}</div>
          <div className="flex flex-col gap-px">
            {SETTINGS_NAV.map(navItem)}
          </div>
          <div aria-hidden="true" className="mx-2.5 my-2 h-px shrink-0 bg-[var(--color-border)]" />
          {navItem(SETTINGS_NAV_ABOUT)}
        </nav>

        {/* The page frame every pane shares — one width, one set of gutters —
            so a pane never sets its own max-width. It is fluid up to 1120px:
            at the common 1440px window it fills the column, and on a large
            display it stops before rows stretch past reading distance. The old
            700px cap left explorer-style panes (memory, skills) cramped in the
            middle of an empty page. One width for every pane, so switching
            panes never moves the header. */}
        <div className="flex-1 min-w-0 overflow-y-auto [scrollbar-gutter:stable]">
          <div data-testid="settings-page-frame" className="mx-auto w-full max-w-[1120px] px-10 pt-9 pb-[72px]">
            {activeTab === 'providers' && <ProviderSettings />}
            {activeTab === 'activity' && <ActivitySettings />}
            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'voice' && <VoiceInputSettings />}
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
            {activeTab === 'diagnostics' && <DiagnosticsSettings />}
            {activeTab === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  )
}

function TabButton({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void }) {
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
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex h-[30px] w-full shrink-0 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-left text-[13px] transition-[background-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        active
          ? 'bg-[var(--color-surface-selected)] font-medium text-[var(--color-text-primary)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      <Icon
        size={15}
        strokeWidth={1.75}
        aria-hidden="true"
        className={`shrink-0 ${active ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-tertiary)]'}`}
      />
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
        title={t('settings.tab.skills')}
        description={t('settings.skills.description')}
        className="mb-5"
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
        title={t('settings.tab.plugins')}
        description={t('settings.plugins.description')}
        className="mb-5"
      />
      <PluginList />
    </div>
  )
}
