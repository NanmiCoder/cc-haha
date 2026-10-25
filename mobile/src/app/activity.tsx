import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { HostActivity } from '../ui/activity/HostActivity'
import { SessionActivity } from '../ui/activity/SessionActivity'

/**
 * /activity?id&host —— 一个会话的后台活动，可停止；
 * /activity?host —— 整台电脑的后台活动，按会话分组、只读。
 */
export default function Activity() {
  const { host, id } = useLocalSearchParams<{ host?: string; id?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return id ? (
    <SessionActivity key={`${hostId}:${id}`} hostId={hostId} id={id} />
  ) : (
    <HostActivity key={hostId} hostId={hostId} />
  )
}
