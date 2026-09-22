import { useId, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslation } from '@/i18n'
import type { Host } from '../../types/resourceTypes'
import { ProtectedPasswordReveal } from '../ProtectedPasswordReveal'

/** Authentication details only: collapsing must never unmount the SSH/file workspace. */
export function HostAuthenticationSection({ host }: { host: Host }) {
  const t = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  return (
    <section data-testid="host-authentication-section" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          block
          className="justify-start"
          data-testid="host-authentication-toggle"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          icon={expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          onClick={() => setExpanded(value => !value)}
        >
          {t('managedResources.authMethod')}
        </Button>
      </h3>
      <div id={`${id}-body`} hidden={!expanded}>
        {/* Unmount on collapse to evict revealed passwords rather than merely hiding them. */}
        {expanded && <>
          <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-[var(--color-text-tertiary)]">{t('managedResources.authMethod')}: </span>
              <span className="font-medium text-[var(--color-text-primary)]">
                {host.auth.type === 'password' ? t('managedResources.authPassword') : t('managedResources.authKey')}
              </span>
            </div>
            <div>
              <span className="text-[var(--color-text-tertiary)]">{t('managedResources.initialDir')}: </span>
              <span className="break-all font-mono text-[var(--color-text-primary)]">{host.initialDirectory || '/'}</span>
            </div>
          </div>
          {host.auth.type === 'password' && host.auth.credentialId && (
            <div className="mt-4">
              <ProtectedPasswordReveal credentialId={host.auth.credentialId} label={t('managedResources.passwordReveal.sshLabel')} />
            </div>
          )}
        </>}
      </div>
    </section>
  )
}
