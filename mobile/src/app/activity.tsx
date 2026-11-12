import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { HostActivity } from '../ui/activity/HostActivity'

/** /activity?host — Background activity for the whole computer, grouped by session, read-only. A single session's run info is in the capsule in the session header. */
export default function Activity() {
  const { host } = useLocalSearchParams<{ host?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return <HostActivity key={hostId} hostId={hostId} />
}
