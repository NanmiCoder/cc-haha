import { useLocalSearchParams } from 'expo-router'
import { useApp } from '../state/AppContext'
import { ScheduleList } from '../ui/schedules/ScheduleList'

/** /schedules?host — Scheduled tasks of one computer (opened from the This computer panel on home). */
export default function Schedules() {
  const { host } = useLocalSearchParams<{ host?: string }>()
  const { registry } = useApp()
  const hostId = host ?? registry.selectedId ?? ''
  return <ScheduleList key={hostId} hostId={hostId} />
}
