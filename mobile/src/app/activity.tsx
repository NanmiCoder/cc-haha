import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { HostActivity } from '../ui/activity/HostActivity'

/** /activity?host —— 整台电脑的后台活动，按会话分组、只读。单个会话的运行信息在会话页的顶栏胶囊里。 */
export default function Activity() {
  const { host } = useLocalSearchParams<{ host?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return <HostActivity key={hostId} hostId={hostId} />
}
