import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { mobileAppLinks } from './mobileAppLinks'

type MobileAppInstallProps = {
  connectionMethodsId: string
  onUseBrowser: () => void
}

function openExternal(url: string) {
  void getDesktopHost().shell.open(url).catch(() => window.open(url, '_blank', 'noopener'))
}

export function MobileAppInstall({ connectionMethodsId, onUseBrowser }: MobileAppInstallProps) {
  const t = useTranslation()
  const testFlight = mobileAppLinks.testFlight
  return (
    <SettingsSection title={t('mobileApp.title')} description={t('mobileApp.intro')}>
      <SettingsGroup>
        <SettingsRow title={t('mobileApp.android')} description={t('mobileApp.androidAvailable')}>
          <Button size="base" variant="secondary" onClick={() => openExternal(mobileAppLinks.android)}>{t('mobileApp.downloadAndroid')}</Button>
        </SettingsRow>
        <SettingsRow title={t('mobileApp.ios')} description={t(testFlight ? 'mobileApp.iosAvailable' : 'mobileApp.iosPending')}>
          {testFlight
            ? <Button size="base" variant="secondary" onClick={() => openExternal(testFlight)}>{t('mobileApp.joinTestFlight')}</Button>
            : (
              <>
                <Badge tone="neutral" size="sm">{t('mobileApp.invitePending')}</Badge>
                <Button size="base" variant="secondary" disabled>{t('mobileApp.joinTestFlight')}</Button>
              </>
            )}
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
