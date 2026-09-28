import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, HelpCircle, Network } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useTranslation } from '@/i18n'
import { getDesktopHost } from '@/lib/desktopHost'
import { NetworkManagerPanel } from './NetworkManagerPanel'
import { NetworkManagerHelp } from './NetworkManagerHelp'

export function NetworkManagerButton() {
  const t = useTranslation()
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [openingConnections, setOpeningConnections] = useState(false)
  const [connectionsFeedback, setConnectionsFeedback] = useState<'opened' | 'failed' | null>(null)
  const openingRef = useRef(false)
  const viewRevision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; viewRevision.current++ }
  }, [])
  const host = getDesktopHost()
  if (!host.networkManager) return null

  async function openConnections() {
    if (openingRef.current || !host.networkManager) return
    openingRef.current = true
    const revision = viewRevision.current
    setOpeningConnections(true)
    setConnectionsFeedback(null)
    try {
      const result = await host.networkManager.openNetworkConnections()
      if (mounted.current && viewRevision.current === revision) setConnectionsFeedback(result.ok ? 'opened' : 'failed')
    } catch {
      if (mounted.current && viewRevision.current === revision) setConnectionsFeedback('failed')
    } finally {
      openingRef.current = false
      if (mounted.current) setOpeningConnections(false)
    }
  }

  return <>
    <IconButton
      icon={<Network size={17} strokeWidth={1.9} />}
      label={t('networkManager.title')}
      size="md"
      tone={open ? 'default' : 'muted'}
      pressed={open}
      onClick={() => setOpen(true)}
    />
    {open && <Modal open onClose={() => { viewRevision.current++; setOpen(false); setHelpOpen(false); setConnectionsFeedback(null) }}
      title={helpOpen ? t('networkManager.help.title') : t('networkManager.title')}
      closeLabel={t('networkManager.close')} width={1180}
      headerActions={<>
        <Button size="base" variant="secondary" icon={<Network size={15} />}
          loading={openingConnections} title={t('networkManager.connectionsHint')}
          data-testid="open-network-connections" onClick={() => void openConnections()}>
          {t('networkManager.openConnections')}
        </Button>
        <IconButton
          icon={helpOpen ? <ArrowLeft size={17} /> : <HelpCircle size={17} />}
          label={t(helpOpen ? 'networkManager.help.back' : 'networkManager.help.open')}
          size="md" tone="muted" bordered
          onClick={() => setHelpOpen(value => !value)}
        />
      </>}>
      {connectionsFeedback && <p role={connectionsFeedback === 'failed' ? 'alert' : 'status'}
        className={`mb-3 text-sm ${connectionsFeedback === 'failed' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'}`}>
        {t(connectionsFeedback === 'failed' ? 'networkManager.connectionsError' : 'networkManager.connectionsOpened')}
      </p>}
      {helpOpen && <NetworkManagerHelp />}
      <div hidden={helpOpen}><NetworkManagerPanel api={host.networkManager} /></div>
    </Modal>}
  </>
}
