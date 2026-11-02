import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { ScheduleList } from '../ui/schedules/ScheduleList'

/** /schedules?host —— 一台电脑的定时任务（从首页“这台电脑”面板进入）。 */
export default function Schedules() {
  const { host } = useLocalSearchParams<{ host?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return <ScheduleList key={hostId} hostId={hostId} />
}
