import { H5Settings } from './settings/H5Settings'
import { getDesktopHost } from '@/lib/desktopHost'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
import { Kbd } from '@/components/ui/Kbd'
import { SearchField } from '@/components/ui/SearchField'
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

type SettingsNavEntry = {
  tab: SettingsTab
  icon: LucideIcon
  label: TranslationKey
  keywords: readonly string[]
}

const SETTINGS_NAV: SettingsNavEntry[] = [
  { tab: 'providers', icon: Server, label: 'settings.tab.providers', keywords: ['model', 'api', 'key', 'provider', 'claude', 'openai', 'deepseek', 'proxy', '模型', '供应商', '接口'] },
  { tab: 'general', icon: SlidersHorizontal, label: 'settings.tab.general', keywords: ['theme', 'appearance', 'language', 'zoom', 'font', 'proxy', 'notification', 'storage', '主题', '外观', '语言', '缩放', '代理', '通用'] },
  { tab: 'voice', icon: Mic, label: 'settings.tab.voice', keywords: ['speech', 'microphone', 'asr', 'dictation', 'shortcut', 'vocabulary', '语音', '麦克风', '听写'] },
  { tab: 'h5Access', icon: QrCode, label: 'settings.tab.h5Access', keywords: ['phone', 'mobile', 'qr', 'remote', 'tunnel', 'h5', '手机', '远程', '扫码'] },
  { tab: 'adapters', icon: MessageSquare, label: 'settings.tab.adapters', keywords: ['im', 'wechat', 'feishu', 'lark', 'dingtalk', 'telegram', 'slack', 'discord', '微信', '飞书', '钉钉', '机器人'] },
  { tab: 'terminal', icon: SquareTerminal, label: 'settings.tab.terminal', keywords: ['shell', 'zsh', 'bash', 'xterm', 'font', '终端', '命令行'] },
  { tab: 'mcp', icon: Plug, label: 'settings.tab.mcp', keywords: ['server', 'tool', 'stdio', 'sse', 'http', '工具', '服务'] },
  { tab: 'agents', icon: Bot, label: 'settings.tab.agents', keywords: ['subagent', 'team', 'agent', '智能体', '代理'] },
  { tab: 'skills', icon: Box, label: 'settings.tab.skills', keywords: ['skill', 'slash', 'command', '技能'] },
  { tab: 'memory', icon: BookOpen, label: 'settings.tab.memory', keywords: ['claude.md', 'memory', 'context', '记忆'] },
  { tab: 'plugins', icon: Puzzle, label: 'settings.tab.plugins', keywords: ['plugin', 'extension', 'hook', '插件', '扩展'] },
  { tab: 'pets', icon: PawPrint, label: 'settings.tab.pets', keywords: ['pet', 'desktop', 'mascot', '桌宠', '宠物'] },
  { tab: 'computerUse', icon: MousePointer2, label: 'settings.tab.computerUse', keywords: ['screen', 'accessibility', 'mouse', 'keyboard', 'control', '电脑', '操控', '权限'] },
  { tab: 'activity', icon: ChartNoAxesColumn, label: 'settings.tab.activity', keywords: ['token', 'usage', 'cost', 'heatmap', 'stats', 'chart', '用量', '统计', '账单'] },
  { tab: 'diagnostics', icon: HeartPulse, label: 'settings.tab.diagnostics', keywords: ['log', 'doctor', 'health', 'debug', 'repair', '诊断', '日志', '修复'] },
]

/** Set apart below a rule, the way the reference rail ends. */
const SETTINGS_NAV_ABOUT: SettingsNavEntry = {
  tab: 'about',
  icon: Info,
  label: 'settings.tab.about',
  keywords: ['version', 'update', 'changelog', 'github', 'author', '关于', '版本', '更新'],
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function DesktopSettings() {
  const activeTab = useUIStore((s) => s.activeSettingsTab)
  const setActiveTab = useUIStore((s) => s.setActiveSettingsTab)
  const pendingSettingsTab = useUIStore((s) => s.pendingSettingsTab)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [navQuery, setNavQuery] = useState('')
  const t = useTranslation()

  useEffect(() => {
    if (!pendingSettingsTab) return
    setActiveTab(pendingSettingsTab)
    if (contentRef.current) contentRef.current.scrollTop = 0
    useUIStore.getState().setPendingSettingsTab(null)
  }, [pendingSettingsTab, setActiveTab])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableElement(event.target)) return
      const input = searchInputRef.current
      if (!input) return
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (dialogs.length > 0) {
        const topDialog = dialogs[dialogs.length - 1]
        if (!topDialog?.contains(input)) return
      }
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const normalizedQuery = navQuery.trim().toLowerCase()
  const matchesEntry = useCallback(
    (entry: SettingsNavEntry) => {
      if (!normalizedQuery) return true
      if (t(entry.label).toLowerCase().includes(normalizedQuery)) return true
      if (entry.tab.toLowerCase().includes(normalizedQuery)) return true
      return entry.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery))
    },
    [normalizedQuery, t],
  )

  const filteredNav = useMemo(() => SETTINGS_NAV.filter(matchesEntry), [matchesEntry])
  const showAbout = matchesEntry(SETTINGS_NAV_ABOUT)
  const visibleEntries = useMemo(
    () => (showAbout ? [...filteredNav, SETTINGS_NAV_ABOUT] : filteredNav),
    [filteredNav, showAbout],
  )

  const selectTab = useCallback(
    (tab: SettingsTab) => {
      setActiveTab(tab)
      if (contentRef.current) contentRef.current.scrollTop = 0
    },
    [setActiveTab],
  )

  const handleSearchNavigate = (direction: 'up' | 'down') => {
    if (visibleEntries.length === 0) return
    const currentIndex = visibleEntries.findIndex((entry) => entry.tab === activeTab)
    const nextIndex =
      currentIndex === -1
        ? direction === 'down'
          ? 0
          : visibleEntries.length - 1
        : (currentIndex + (direction === 'down' ? 1 : -1) + visibleEntries.length) % visibleEntries.length
    const target = visibleEntries[nextIndex]
    if (target) selectTab(target.tab)
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && navQuery) {
      event.preventDefault()
      event.stopPropagation()
      setNavQuery('')
      return
    }
    if (event.key === 'Enter' && visibleEntries.length > 0) {
      const currentVisible = visibleEntries.some((entry) => entry.tab === activeTab)
      if (!currentVisible) {
        event.preventDefault()
        selectTab(visibleEntries[0]!.tab)
      }
    }
  }

  const navItem = ({ tab, icon, label }: SettingsNavEntry) => (
    <TabButton key={tab} icon={icon} label={t(label)} active={activeTab === tab} onClick={() => selectTab(tab)} />
  )

  return (
    <div
      data-testid="desktop-settings-root"
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-surface)]"
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* The rail sits on the page's own paper, separated by the rule, the
            way every other secondary panel in the app is (the workbench, the
            diff split). The Settings tab is filled with paper so its bottom
            edge runs unbroken into the view it opens onto; a grey rail here
            made it the one tab whose paper met a different colour. */}
        <nav
          data-testid="settings-navigation"
          aria-label={t('settings.title')}
          className="flex w-[216px] flex-shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
        >
          <div className="shrink-0 pb-2 pt-4">
            <div className="px-2 pb-2 text-xs font-semibold text-[var(--color-text-tertiary)]">{t('settings.title')}</div>
            <SearchField
              ref={searchInputRef}
              size="sm"
              value={navQuery}
              onChange={setNavQuery}
              label={t('search.findInPage.placeholder')}
              placeholder={t('search.findInPage.placeholder')}
              clearLabel={t('common.clearSearch')}
              trailing={<Kbd size="xs">/</Kbd>}
              onNavigate={handleSearchNavigate}
              onKeyDown={handleSearchKeyDown}
              data-testid="settings-nav-search"
            />
          </div>
          <div className="scrollbar-autohide flex min-h-0 flex-1 flex-col overflow-y-auto pb-4 pt-1">
            {visibleEntries.length === 0 ? (
              <p
                data-testid="settings-nav-empty"
                className="px-2.5 py-6 text-center text-xs text-[var(--color-text-tertiary)]"
              >
                {t('search.global.noResults')}
              </p>
            ) : (
              <>
                {filteredNav.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {filteredNav.map(navItem)}
                  </div>
                )}
                {filteredNav.length > 0 && showAbout && (
                  <div aria-hidden="true" className="mx-2 my-2 h-px shrink-0 bg-[var(--color-border)]" />
                )}
                {showAbout && navItem(SETTINGS_NAV_ABOUT)}
              </>
            )}
          </div>
        </nav>

        {/* The page frame every pane shares — one width, one set of gutters —
            so a pane never sets its own max-width. It is fluid up to 1120px:
            at the common 1440px window it fills the column, and on a large
            display it stops before rows stretch past reading distance. The old
            700px cap left explorer-style panes (memory, skills) cramped in the
            middle of an empty page. One width for every pane, so switching
            panes never moves the header. */}
        <div ref={contentRef} className="v6c-main-canvas scrollbar-autohide flex-1 min-w-0 overflow-y-auto [scrollbar-gutter:stable]">
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
      className={`flex h-[30px] w-full shrink-0 items-center gap-2.5 rounded-[var(--radius-control)] border pl-3 pr-2.5 text-left text-[13px] transition-[background-color,color,border-color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${
        active
          ? 'v6c-active-bar v6c-raised border-transparent font-medium text-[var(--color-text-primary)]'
          : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
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
