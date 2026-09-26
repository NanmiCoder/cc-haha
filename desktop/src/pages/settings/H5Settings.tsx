import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from '@/i18n'
import { useUIStore } from '@/stores/uiStore'
import { useSessionStore } from '@/stores/sessionStore'
import { SettingsPageHeader, SettingsPill } from '@/components/settings/SettingsSection'
import { SETTINGS_TABS } from '../Settings'
import { ActivitySettings } from '../ActivitySettings'
import { AdapterSettings } from '../AdapterSettings'
import { ComputerUseSettings } from '../ComputerUseSettings'
import { DiagnosticsSettings } from '../DiagnosticsSettings'
import { GeneralSettings } from './GeneralSettings'
import { H5AccessSettings } from './H5AccessSettings'
import { McpSettings } from '../McpSettings'
import { MemorySettings } from '../MemorySettings'
import { PetSettings } from '../../features/pets/PetSettings'
import { ProviderSettings } from './ProviderSettings'
import { TerminalSettings } from '../TerminalSettings'
import { TraceList } from '../TraceList'
import { AboutSettings } from './AboutSettings'
import { AgentManager } from '../../components/settings/AgentManager'
import { SkillList } from '../../components/skills/SkillList'
import { SkillDetail } from '../../components/skills/SkillDetail'
import { PluginList } from '../../components/plugins/PluginList'
import { PluginDetail } from '../../components/plugins/PluginDetail'
import { useSkillStore } from '../../stores/skillStore'
import { usePluginStore } from '../../stores/pluginStore'

// H5 (phone browser) Settings surface. It exposes the same full section list
// as the desktop rail (SETTINGS_TABS + about) — the 0.6.6 "two pill" browser
// fence is lifted, so every desktop setting is reachable from a phone.
// Desktop-only capabilities still degrade inside their components
// (terminal/pets/computer-use show their "desktop app required" state), which
// keeps the list identical to the desktop app.
export function H5Settings() {
  const t = useTranslation()
  const active = useUIStore((state) => state.activeSettingsTab)
  const pending = useUIStore((state) => state.pendingSettingsTab)
  const selected = pending ?? active
  useEffect(() => {
    if (pending) useUIStore.getState().setActiveSettingsTab(pending)
    if (pending) useUIStore.getState().setPendingSettingsTab(null)
  }, [pending])

  const navRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Keep the selected pill visible in the horizontally scrolling strip.
    navRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [selected])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-surface)]">
      <div
        ref={navRef}
        aria-label={t('sidebar.settings')}
        role="navigation"
        className="flex min-w-0 shrink-0 flex-nowrap gap-2 overflow-x-auto border-b border-[var(--color-border)] p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&_button]:min-h-11 [&_button]:shrink-0"
      >
        {SETTINGS_TABS.map((tab) => (
          <SettingsPill
            key={tab.id}
            selected={selected === tab.id}
            onClick={() => useUIStore.getState().setActiveSettingsTab(tab.id)}
          >
            {t(`settings.tab.${tab.id}`)}
          </SettingsPill>
        ))}
        <SettingsPill
          className="ml-1 shrink-0"
          selected={selected === 'about'}
          onClick={() => useUIStore.getState().setActiveSettingsTab('about')}
        >          {t('settings.tab.about')}
        </SettingsPill>
      </div>
      <div className={selected === 'trace' ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden' : 'min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6'}>
        {selected === 'providers' && <ProviderSettings browserMode />}
        {selected === 'activity' && <ActivitySettings />}
        {selected === 'general' && <GeneralSettings />}
        {selected === 'h5Access' && <H5AccessSettings />}
        {selected === 'adapters' && <AdapterSettings />}
        {selected === 'terminal' && <H5TerminalSettings />}
        {selected === 'mcp' && <McpSettings />}
        {selected === 'agents' && <AgentManager />}
        {selected === 'skills' && <H5SkillSettings />}
        {selected === 'memory' && <MemorySettings />}
        {selected === 'plugins' && <H5PluginSettings />}
        {selected === 'pets' && <PetSettings />}
        {selected === 'computerUse' && <ComputerUseSettings />}
        {selected === 'trace' && <TraceList />}
        {selected === 'diagnostics' && <DiagnosticsSettings />}
        {selected === 'about' && <AboutSettings />}
      </div>
    </div>
  )
}

// H5 终端默认落在当前活动会话的工作目录，让手机端能直接操作那个项目；
// 无活动会话时不传 cwd，由服务端回落 CLAUDE_CONFIG_DIR/HOME。
function H5TerminalSettings() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  )
  const cwd = activeSession?.workDir ?? activeSession?.projectRoot ?? undefined
  return <TerminalSettings showPreferences cwd={cwd} />
}

// Same selected-detail pattern as the desktop Settings rail wrappers, but the
// header copy matches what H5 users already see on this surface.
function H5SkillSettings() {
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

function H5PluginSettings() {
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

