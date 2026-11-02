import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../../state/AppContext'
import { ScheduleDetail } from '../../ui/schedules/ScheduleDetail'

/** /schedule/[id]?host —— 一个定时任务的详情。 */
export default function ScheduleDetailRoute() {
  const { id, host } = useLocalSearchParams<{ id: string; host?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return <ScheduleDetail key={`${hostId}:${id}`} hostId={hostId} id={id} />
}
