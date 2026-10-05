import { useId } from 'react'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import {
  SettingsBlock,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsSection'
import { MarkdownRenderer } from '@/components/markdown/MarkdownRenderer'
import { useTranslation } from '@/i18n'
import { getChatAppearanceStyle, type ChatAppearance } from '@/lib/chatAppearance'
import { useChatAppearanceStore } from '@/stores/chatAppearanceStore'

export function ChatAppearanceSettings() {
  const t = useTranslation()
  const { appearance, setAppearance, resetAppearance } = useChatAppearanceStore()
  const sizeId = useId()
  const previewId = useId()

  return (
    <SettingsSection
      title={t('settings.chatAppearance.title')}
      description={t('settings.chatAppearance.description')}
      action={(
        <Button size="sm" variant="ghost" onClick={resetAppearance}>
          {t('settings.chatAppearance.reset')}
        </Button>
      )}
    >
      <SettingsGroup>
        <SettingsRow title={t('settings.chatAppearance.font')}>
          <SegmentedControl<ChatAppearance['font']>
            label={t('settings.chatAppearance.font')}
            size="sm"
            value={appearance.font}
            onChange={(font) => setAppearance({ font })}
            items={[
              { value: 'system', label: t('settings.chatAppearance.fontSystem') },
              { value: 'sans', label: t('settings.chatAppearance.fontSans') },
              { value: 'serif', label: t('settings.chatAppearance.fontSerif') },
              { value: 'mono', label: t('settings.chatAppearance.fontMono') },
            ]}
          />
        </SettingsRow>
        <SettingsRow title={t('settings.chatAppearance.fontSize')} htmlFor={sizeId} description={t('settings.chatAppearance.hint')}>
          <div className="flex items-center gap-2.5">
            <input
              id={sizeId}
              type="range"
              min={12}
              max={24}
              step={1}
              value={appearance.fontSize}
              aria-valuetext={`${appearance.fontSize}px`}
              onChange={(event) => setAppearance({ fontSize: Number(event.currentTarget.value) })}
              className="w-[150px] cursor-pointer rounded-[var(--radius-sm)] accent-[var(--color-brand)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-border-focus)]"
            />
            <output htmlFor={sizeId} className="w-[38px] font-mono text-xs tabular-nums text-[var(--color-text-secondary)]">
              {appearance.fontSize}px
            </output>
          </div>
        </SettingsRow>
        <SettingsRow title={t('settings.chatAppearance.width')}>
          <SegmentedControl<ChatAppearance['width']>
            label={t('settings.chatAppearance.width')}
            size="sm"
            value={appearance.width}
            onChange={(width) => setAppearance({ width })}
            items={[
              { value: 'standard', label: t('settings.chatAppearance.widthStandard') },
              { value: 'wide', label: t('settings.chatAppearance.widthWide') },
              { value: 'full', label: t('settings.chatAppearance.widthFull') },
            ]}
          />
        </SettingsRow>
        <SettingsBlock>
          <p id={previewId} className="mb-2 text-xs font-medium text-[var(--color-text-tertiary)]">{t('settings.chatAppearance.preview')}</p>
          <div
            role="region"
            aria-labelledby={previewId}
            className="min-w-0 overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-4 py-3"
            style={getChatAppearanceStyle(appearance)}
          >
            <MarkdownRenderer className="chat-reading-markdown" content={t('settings.chatAppearance.previewMarkdown')} />
          </div>
        </SettingsBlock>
      </SettingsGroup>
    </SettingsSection>
  )
}
