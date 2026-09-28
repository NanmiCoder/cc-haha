import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { useTranslation } from '@/i18n'
import type { NetworkProfile, SakuraDiscovery } from '../networkTypes'

type Props = {
  profile: NetworkProfile
  discovery: SakuraDiscovery | null
  detecting: boolean
  error: boolean
  disabled: boolean
  onRefresh(): void
  onChange(profile: NetworkProfile): void
  onPick(field: 'proxyConfigPath' | 'sakuraExecutable'): void
}
export function SakuraRuntimeFields({ profile, discovery, detecting, error, disabled, onRefresh, onChange, onPick }: Props) {
  const t = useTranslation()
  const current = discovery?.proxyPort === profile.proxyPort ? discovery : null
  const instance = current?.status === 'detected' ? current.selected : null
  return <div className="space-y-3" data-testid="sakura-runtime-fields">
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone={instance ? 'success' : 'neutral'}>{t(detecting ? 'networkManager.sakura.detecting' : instance ? 'networkManager.sakura.detected' : current?.running ? 'networkManager.sakura.incomplete' : current?.status === 'not-running' ? 'networkManager.sakura.notRunning' : 'networkManager.sakura.unknown')}</Badge>
      <Button size="sm" variant="secondary" disabled={disabled || detecting} onClick={onRefresh}>{t('networkManager.sakura.refresh')}</Button>
    </div>
    <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{t(instance ? 'networkManager.sakura.autoHint' : 'networkManager.sakura.fallbackHint')}</p>
    {error && <p role="alert" className="text-xs text-[var(--color-error)]">{t('networkManager.sakura.detectError')}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <Input label={t('networkManager.sakuraPath')} value={instance ? instance.clientExecutable || t('networkManager.sakura.noClient') : profile.sakuraExecutable}
          readOnly={!!instance} disabled={disabled} size="md" onChange={event => onChange({ ...profile, sakuraExecutable: event.target.value })} />
        {!instance && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onPick('sakuraExecutable')}>{t('networkManager.chooseExecutable')}</Button>}
      </div>
      <div className="space-y-2">
        <Input label={t('networkManager.proxyConfig')} value={instance?.configPath ?? profile.proxyConfigPath}
          readOnly={!!instance} disabled={disabled} size="md" onChange={event => onChange({ ...profile, proxyConfigPath: event.target.value })} />
        {!instance && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onPick('proxyConfigPath')}>{t('networkManager.chooseConfig')}</Button>}
      </div>
    </div>
    {instance && <dl className="grid gap-x-3 gap-y-1 rounded border border-[var(--color-border)] p-2 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
      <dt>{t('networkManager.sakura.core')}</dt><dd className="break-all font-mono">{instance.executablePath}</dd>
      <dt>PID / {t('networkManager.sakura.started')}</dt><dd className="break-all">{instance.pid} / {instance.startedAt}</dd>
      <dt>{t('networkManager.sakura.source')}</dt><dd>{instance.configSource} · {t('networkManager.sakura.portOwner')}: {profile.proxyPort}</dd>
      <dt>{t('networkManager.sakura.controller')}</dt><dd>{instance.controller || t('networkManager.sakura.controllerYaml')}</dd>
      <dt>{t('networkManager.sakura.checked')}</dt><dd>{current?.checkedAt}</dd>
    </dl>}
    {!!current?.issues.length && <p className="break-words text-xs text-[var(--color-text-secondary)]">{current.issues.join(' · ')}</p>}
  </div>
}
