import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'

type MobileAppInstallProps = {
  connectionMethodsId: string
  onUseBrowser: () => void
}

export function MobileAppInstall({ connectionMethodsId, onUseBrowser }: MobileAppInstallProps) {
  const t = useTranslation()
  return (
    <SettingsSection title={t('mobileApp.title')} description={t('mobileApp.intro')}>
      <SettingsGroup>
        <SettingsRow title={t('mobileApp.android')} description={t('mobileApp.androidPending')}>
          <Badge tone="neutral" size="sm">{t('mobileApp.pending')}</Badge>
          <Button size="base" variant="secondary" disabled>{t('mobileApp.downloadAndroid')}</Button>
        </SettingsRow>
        <SettingsRow title={t('mobileApp.ios')} description={t('mobileApp.iosPending')}>
          <Badge tone="neutral" size="sm">{t('mobileApp.invitePending')}</Badge>
          <Button size="base" variant="secondary" disabled>{t('mobileApp.joinTestFlight')}</Button>
        </SettingsRow>
        <SettingsRow title={t('mobileApp.browserTitle')} description={t('mobileApp.browserHint')}>
          <Button size="base" aria-controls={connectionMethodsId} onClick={onUseBrowser}>{t('mobileApp.useBrowser')}</Button>
        </SettingsRow>
        <SettingsBlock>
          <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">{t('mobileApp.connectionHint')}</p>
        </SettingsBlock>
      </SettingsGroup>
    </SettingsSection>
  )
}
