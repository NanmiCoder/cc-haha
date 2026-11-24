import { Box, Puzzle } from 'lucide-react'

import type { ActivityStatsResponse } from '../../api/activityStats'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { useTranslation } from '../../i18n'

type RankItem = {
  id: string
  label: string
  count: number
  kind: 'plugin' | 'skill'
}

function getPluginNameFromToolName(toolName: string) {
  if (!toolName.startsWith('mcp__')) return null
  const parts = toolName.split('__').filter(Boolean)
  const serverName = parts[1]
  if (!serverName) return null
  if (serverName === 'codex_apps' && parts[2]) return parts[2]
  return serverName
}

export function buildPluginAndSkillRankItems(stats: ActivityStatsResponse | null): RankItem[] {
  const skillItems = Object.entries(stats?.skillUsage ?? {}).map<RankItem>(([skill, count]) => ({
    id: `skill:${skill}`,
    label: `$${skill}`,
    count,
    kind: 'skill',
  }))

  const pluginUsage = new Map<string, number>()
  for (const [toolName, count] of Object.entries(stats?.toolUsage ?? {})) {
    const pluginName = getPluginNameFromToolName(toolName)
    if (!pluginName || count <= 0) continue
    pluginUsage.set(pluginName, (pluginUsage.get(pluginName) || 0) + count)
  }
  const pluginItems = [...pluginUsage.entries()].map<RankItem>(([pluginName, count]) => ({
    id: `plugin:${pluginName}`,
    label: `@${pluginName.replace(/_/g, '-')}`,
    count,
    kind: 'plugin',
  }))

  return [...skillItems, ...pluginItems]
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 6)
}

export function TokenSkills({ stats }: { stats: ActivityStatsResponse }) {
  const t = useTranslation()
  const items = buildPluginAndSkillRankItems(stats)
  if (items.length === 0) return null

  return (
    <SettingsSection title={t('settings.activity.mostUsedPluginsAndSkills')}>
      <ul className="border-t border-[var(--color-border)]">
        {items.map((item) => (
          <li key={item.id} className="flex min-h-[44px] items-center gap-3 border-b border-[var(--color-border)] py-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]"
            >
              {item.kind === 'skill' ? <Box size={14} strokeWidth={1.75} /> : <Puzzle size={14} strokeWidth={1.75} />}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text-primary)]">{item.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-tertiary)]">
              {t(item.count === 1 ? 'settings.activity.count.runOne' : 'settings.activity.count.runOther', { count: item.count })}
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  )
}
