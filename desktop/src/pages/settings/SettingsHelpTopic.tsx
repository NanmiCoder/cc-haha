import { SettingsHelp } from '@/components/settings/SettingsHelp'
import { useTranslation, type TranslationKey } from '@/i18n'

type HelpEntryKind = 'what' | 'when' | 'cost' | 'why'

const ENTRY_LABEL_KEYS = {
  what: 'settings.help.label.what',
  when: 'settings.help.label.when',
  cost: 'settings.help.label.cost',
  why: 'settings.help.label.why',
} satisfies Record<HelpEntryKind, TranslationKey>

type HelpTopicKeys = {
  title: TranslationKey
  entries: ReadonlyArray<readonly [HelpEntryKind, TranslationKey]>
}

/**
 * The settings that get a "?" in General settings: the ones whose name or
 * description assumes you already know Claude Code — people kept asking what
 * Auto-dream does. Settings a newcomer can read at a glance (theme, language,
 * notifications) deliberately have none.
 *
 * Keys are spelled out literally so the five locale files can be checked
 * against them.
 */
const SETTINGS_HELP_TOPICS = {
  thinking: {
    title: 'settings.help.thinking.title',
    entries: [
      ['what', 'settings.help.thinking.what'],
      ['when', 'settings.help.thinking.when'],
      ['cost', 'settings.help.thinking.cost'],
    ],
  },
  leanMode: {
    title: 'settings.help.leanMode.title',
    entries: [
      ['what', 'settings.help.leanMode.what'],
      ['when', 'settings.help.leanMode.when'],
      ['cost', 'settings.help.leanMode.cost'],
    ],
  },
  ultracode: {
    title: 'settings.help.ultracode.title',
    entries: [
      ['what', 'settings.help.ultracode.what'],
      ['when', 'settings.help.ultracode.when'],
      ['cost', 'settings.help.ultracode.cost'],
    ],
  },
  agentTeams: {
    title: 'settings.help.agentTeams.title',
    entries: [
      ['what', 'settings.help.agentTeams.what'],
      ['when', 'settings.help.agentTeams.when'],
      ['cost', 'settings.help.agentTeams.cost'],
    ],
  },
  subagents: {
    title: 'settings.help.subagents.title',
    entries: [
      ['what', 'settings.help.subagents.what'],
      ['when', 'settings.help.subagents.when'],
      ['cost', 'settings.help.subagents.cost'],
    ],
  },
  autoQuestion: {
    title: 'settings.help.autoQuestion.title',
    entries: [
      ['what', 'settings.help.autoQuestion.what'],
      ['when', 'settings.help.autoQuestion.when'],
      ['cost', 'settings.help.autoQuestion.cost'],
    ],
  },
  autoDream: {
    title: 'settings.help.autoDream.title',
    entries: [
      ['what', 'settings.help.autoDream.what'],
      ['when', 'settings.help.autoDream.when'],
      ['cost', 'settings.help.autoDream.cost'],
    ],
  },
  webFetchPreflight: {
    title: 'settings.help.webFetchPreflight.title',
    entries: [
      ['what', 'settings.help.webFetchPreflight.what'],
      ['why', 'settings.help.webFetchPreflight.why'],
    ],
  },
  trace: {
    title: 'settings.help.trace.title',
    entries: [
      ['what', 'settings.help.trace.what'],
      ['when', 'settings.help.trace.when'],
    ],
  },
} satisfies Record<string, HelpTopicKeys>

export type SettingsHelpTopicId = keyof typeof SETTINGS_HELP_TOPICS

export function SettingsHelpTopic({ topic }: { topic: SettingsHelpTopicId }) {
  const t = useTranslation()
  const { title, entries } = SETTINGS_HELP_TOPICS[topic]
  return (
    <SettingsHelp
      title={t(title)}
      entries={entries.map(([kind, body]) => ({ label: t(ENTRY_LABEL_KEYS[kind]), body: t(body) }))}
      closeLabel={t('common.close')}
    />
  )
}
