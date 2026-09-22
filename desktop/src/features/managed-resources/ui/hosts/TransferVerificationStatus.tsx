import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import type { ManagedTransferJob } from '../../api/hostManagementApi'

/** Transfer 100% is not verification 100%. Never invent progress for remote hashing. */
export function TransferVerificationStatus({ job }: { job: ManagedTransferJob | null }) {
  const t = useTranslation()
  const [now, setNow] = useState(Date.now)
  const active = job?.state === 'verifying'
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, job?.id, job?.verificationStartedAt])
  if (!active || !job) return null
  const elapsed = Math.max(0, Math.floor((now - (job.verificationStartedAt ?? now)) / 1000))
  const remote = job.verificationMethod === 'remote-sha256'
  const verified = Math.min(job.size, Math.max(0, job.verifiedBytes ?? 0))
  return <span className="flex min-w-0 flex-wrap items-center gap-2" data-testid="transfer-verification-status">
    <span>{t(remote ? 'managedResources.transfer.remoteHash' : 'managedResources.transfer.streamHash')}</span>
    <progress aria-label={t('managedResources.transfer.verifying')} className="h-2 w-24" max={Math.max(job.size, 1)} value={remote ? undefined : verified} />
    {!remote && <span>{(verified / (1024 * 1024)).toFixed(1)} / {(job.size / (1024 * 1024)).toFixed(1)} MiB</span>}
    <span>{t('managedResources.transfer.verifyElapsed', { seconds: elapsed })}</span>
  </span>
}
