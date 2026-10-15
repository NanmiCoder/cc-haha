import { useState } from 'react'
import { useTranslation, type Locale } from '@/i18n'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { settingsApi } from '@/api/settings'
import { modelsApi } from '@/api/models'
import { SettingsGroup, SettingsRow, SettingsSection, SettingsSwitchRow } from '@/components/settings/SettingsSection'
import { SelectField, type SelectFieldProps } from '@/components/ui/SelectField'
import type { ChatSendBehavior, ThemeMode, UserSettings, EffortLevel } from '@/types/settings'

export function H5GeneralSettings() {
  const t = useTranslation()
  const settings = useSettingsStore()
  const theme = useUIStore((state) => state.theme)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (patch: Partial<UserSettings>) => {
    setBusy(true)
    setFailed(false)
    try {
      await settingsApi.updateUser(patch)
      await settings.fetchAll()
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  const effort = async (level: EffortLevel) => {
    setBusy(true)
    setFailed(false)
    try { await modelsApi.setEffort(level); useSettingsStore.setState({ effortLevel: level }) }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  const languages: { value: Locale, label: string }[] = [
    { value: 'en', label: 'English' }, { value: 'zh', label: '简体中文' }, { value: 'zh-TW', label: '繁體中文' }, { value: 'jp', label: '日本語' }, { value: 'kr', label: '한국어' },
  ]
  const themes: { value: ThemeMode, label: string }[] = [
    { value: 'white', label: t('settings.general.appearance.white') }, { value: 'glaze-white', label: t('settings.general.appearance.glazeWhite') }, { value: 'paper', label: t('settings.general.appearance.paper') },
    { value: 'warm-classic', label: t('settings.general.appearance.warmClassic') }, { value: 'celadon', label: t('settings.general.appearance.celadon') },
    { value: 'dark', label: t('settings.general.appearance.dark') }, { value: 'deep-night', label: t('settings.general.appearance.deepNight') }, { value: 'ink-blue', label: t('settings.general.appearance.inkBlue') },
  ]
  const effortLabels = {
    low: t('settings.general.effort.low'), medium: t('settings.general.effort.medium'), high: t('settings.general.effort.high'),
    xhigh: t('settings.general.effort.xhigh'), max: t('settings.general.effort.max'),
  }
  const levels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
  const supported = settings.currentModel?.supportedReasoningEfforts
  const effortOptions = !settings.currentModel ? [] : levels.filter((value) => supported ? supported.includes(value) : value !== 'xhigh')
  const selectedEffort = effortOptions.includes(settings.effortLevel) ? settings.effortLevel : effortOptions[0] ?? settings.effortLevel
  const responseLanguages = [{ value: '', label: t('settings.general.responseLangDefault') },
    { value: 'english', label: 'English' }, { value: 'chinese', label: '中文' }, { value: 'japanese', label: '日本語' }, { value: 'korean', label: '한국어' }]
  if (settings.responseLanguage && !responseLanguages.some((item) => item.value === settings.responseLanguage)) responseLanguages.push({ value: settings.responseLanguage, label: settings.responseLanguage })
  const styles = [{ value: 'default', label: t('settings.general.outputStyleBuiltin.default.label') },
    { value: 'Explanatory', label: t('settings.general.outputStyleBuiltin.explanatory.label') }, { value: 'Learning', label: t('settings.general.outputStyleBuiltin.learning.label') }]
  if (settings.outputStyle && !styles.some((item) => item.value === settings.outputStyle)) styles.push({ value: settings.outputStyle, label: settings.outputStyle })
  // Native selects on purpose: this pane renders on a phone, where the OS
  // picker is the usable one. Each sits in a settings row, named by its title.
  const select = <T extends string>(label: string, field: Omit<SelectFieldProps<T>, 'label' | 'labelHidden' | 'size'>) => (
    <SettingsRow title={label}>
      <SelectField<T> {...field} label={label} labelHidden size="md" containerClassName="w-full sm:w-[220px]" />
    </SettingsRow>
  )
  return <div className="w-full min-w-0">
    {failed && <p role="alert" className="mb-4 text-[13px] text-[var(--color-error)]">{t('publicAccess.genericError')}</p>}
    <SettingsSection className="mt-0" title={t('settings.general.appearanceTitle')} description={t('h5Settings.browserOnly')}>
      <SettingsGroup>
        {select<ThemeMode>(t('settings.general.appearanceTitle'), { value: theme, options: themes, onChange: (value) => { useUIStore.getState().setFollowSystemTheme(false); void settings.setTheme(value) } })}
        {select<Locale>(t('settings.general.languageTitle'), { value: settings.locale, options: languages, onChange: settings.setLocale })}
      </SettingsGroup>
    </SettingsSection>
    <SettingsSection title={t('h5Settings.agentPreferences')} description={t('h5Settings.agentPreferencesHint')}>
      <SettingsGroup>
        {select(t('settings.general.responseLangTitle'), { disabled: busy, value: settings.responseLanguage, options: responseLanguages, onChange: (language) => void save({ language }) })}
        {select(t('settings.general.outputStyleTitle'), { disabled: busy, value: settings.outputStyle || 'default', options: styles, onChange: (outputStyle) => void save({ outputStyle }) })}
        {select<EffortLevel>(t('h5Settings.effort'), { disabled: busy || !effortOptions.length, value: selectedEffort, options: effortOptions.map((value) => ({ value, label: effortLabels[value] })), onChange: (value) => void effort(value) })}
        {select<ChatSendBehavior>(t('h5Settings.sendBehavior'), { disabled: busy, value: settings.chatSendBehavior, options: [{ value: 'enter', label: t('h5Settings.enter') }, { value: 'modifierEnter', label: t('h5Settings.modifierEnter') }], onChange: (chatSendBehavior) => void save({ chatSendBehavior }) })}
        <SettingsSwitchRow disabled={busy} checked={settings.thinkingEnabled} title={t('settings.general.thinkingEnabled')} description={t('settings.general.thinkingDescription')} onChange={(alwaysThinkingEnabled) => void save({ alwaysThinkingEnabled })} />
        <SettingsSwitchRow disabled={busy} checked={settings.workflowKeywordTriggerEnabled} title={t('settings.general.workflowKeywordEnabled')} description={t('settings.general.workflowKeywordDescription')} onChange={(workflowKeywordTriggerEnabled) => void save({ workflowKeywordTriggerEnabled })} />
      </SettingsGroup>
    </SettingsSection>
  </div>
}
