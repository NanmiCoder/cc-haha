import { Server } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useTabStore, HOSTS_TAB_ID } from '../../../stores/tabStore'
import { useTranslation } from '../../../i18n'
import { getDesktopHost } from '../../../lib/desktopHost'

export function HostsTabButton() {
  const t = useTranslation()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const isHostsActive = activeTabId === HOSTS_TAB_ID
  const host = getDesktopHost()

  // Only available in desktop runtime where hostManagement capability is enabled
  if (!host.capabilities.hostManagement) {
    return null
  }

  return (
    <IconButton
      icon={<Server size={17} strokeWidth={1.9} />}
      label={t('managedResources.title') || '主机管理'}
      onClick={() => {
        useTabStore.getState().openHostsTab(t('managedResources.title') || '主机管理')
      }}
      size="md"
      tone={isHostsActive ? 'default' : 'muted'}
      pressed={isHostsActive}
      data-active={isHostsActive ? 'true' : 'false'}
    />
  )
}
