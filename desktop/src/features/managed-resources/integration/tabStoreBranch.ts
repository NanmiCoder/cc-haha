import { useTabStore, HOSTS_TAB_ID } from '../../../stores/tabStore'

export { HOSTS_TAB_ID }

export function openHostsTab(title?: string): void {
  useTabStore.getState().openHostsTab(title)
}
