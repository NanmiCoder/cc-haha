import { useId } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SelectField } from '@/components/ui/SelectField'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useTranslation } from '@/i18n'
import { getChatAppearanceStyle } from '@/lib/chatAppearance'
import { useChatAppearanceStore } from '@/stores/chatAppearanceStore'

export function ChatAppearanceSettings() {
  const t = useTranslation()
  const { appearance, setAppearance, resetAppearance } = useChatAppearanceStore()
  const sizeId = useId()
  const previewId = useId()

  return (
    <SettingsSection
      className="mt-8"
      title={t('settings.chatAppearance.title')}
      description={t('settings.chatAppearance.description')}
      action={(
        <Button size="sm" variant="secondary" onClick={resetAppearance}>
          {t('settings.chatAppearance.reset')}
        </Button>
      )}
    >
      <Card radius="xl" surface="low" padding="none" className="space-y-4 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField
            label={t('settings.chatAppearance.font')}
            value={appearance.font}
            onChange={(font) => setAppearance({ font })}
            options={[
              { value: 'system', label: t('settings.chatAppearance.fontSystem') },
              { value: 'sans', label: t('settings.chatAppearance.fontSans') },
              { value: 'serif', label: t('settings.chatAppearance.fontSerif') },
              { value: 'mono', label: t('settings.chatAppearance.fontMono') },
            ]}
          />
          <SelectField
            label={t('settings.chatAppearance.width')}
            value={appearance.width}
            onChange={(width) => setAppearance({ width })}
            options={[
              { value: 'standard', label: t('settings.chatAppearance.widthStandard') },
              { value: 'wide', label: t('settings.chatAppearance.widthWide') },
              { value: 'full', label: t('settings.chatAppearance.widthFull') },
            ]}
          />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between gap-3 text-sm text-[var(--color-text-primary)]">
            <label htmlFor={sizeId}>{t('settings.chatAppearance.fontSize')}</label>
            <output htmlFor={sizeId}>{appearance.fontSize}px</output>
          </div>
          <input
            id={sizeId}
            type="range"
            min={12}
            max={24}
            step={1}
            value={appearance.fontSize}
            aria-valuetext={`${appearance.fontSize}px`}
            onChange={(event) => setAppearance({ fontSize: Number(event.currentTarget.value) })}
            className="w-full rounded-[var(--radius-sm)] accent-[var(--color-brand)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-border-focus)]"
          />
        </div>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">{t('settings.chatAppearance.hint')}</p>
        <div>
          <p id={previewId} className="mb-2 text-xs font-medium text-[var(--color-text-secondary)]">{t('settings.chatAppearance.preview')}</p>
          <div
            role="region"
            aria-labelledby={previewId}
            className="min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            style={getChatAppearanceStyle(appearance)}
          >
            <MarkdownRenderer className="chat-reading-markdown" content={t('settings.chatAppearance.previewMarkdown')} />
          </div>
        </div>
      </Card>
    </SettingsSection>
  )
}
