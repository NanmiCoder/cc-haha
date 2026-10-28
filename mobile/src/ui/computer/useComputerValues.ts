import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { ApiClient } from '../../core/client'
import { loadHostBackgroundTasks, runningTaskCount } from '../../core/hostActivity'
import type { ScheduledTask } from '../../core/operations'
import { useDashboard } from '../../state/DashboardContext'
import { activeSessions } from '../activity/hostSessions'
import { scheduleSummary } from '../home/homeModel'
import { errorText } from '../theme'
import { readAutoQuestion, type AutoQuestion } from '../settings/settingsModel'
import { activitySummary, modelDisplayName } from './computerModel'

export type ComputerKey =
  | 'model'
  | 'effort'
  | 'mode'
  | 'autoQuestion'
  | 'schedules'
  | 'activity'

export type ComputerValues = {
  model?: string
  effort?: string
  mode?: string
  autoQuestion?: AutoQuestion
  schedules?: string
  activity?: string
  errors: Partial<Record<ComputerKey, string>>
}

const empty: ComputerValues = { errors: {} }

/**
 * 一台电脑的设置概况，每次页面聚焦时重新读取（模型页、定时任务页改完回来能看到新值）。
 * 按电脑 id 存放：切到另一台电脑后不会把上一台的值显示出来；每项独立读，一项失败不影响其他。
 *
 * 读取：GET /api/models/current、/api/effort、/api/permissions/mode、/api/settings/user、
 * /api/scheduled-tasks，以及各进行中会话的 background-tasks。
 */
export function useComputerValues(client: ApiClient | null) {
  const { snapshot } = useDashboard()
  // 快照放进 ref：首页每次刷新不重新触发读取。
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])
  const [state, setState] = useState<{ hostId: string; values: ComputerValues } | null>(null)
  const hostId = client?.host.id

  useFocusEffect(
    useCallback(() => {
      if (!client) return
      const controller = new AbortController()
      const signal = controller.signal
      const id = client.host.id
      const merge = (patch: Partial<ComputerValues>, failed?: ComputerKey, message?: string) => {
        if (signal.aborted) return
        setState((current) => {
          const base = current?.hostId === id ? current.values : empty
          const errors = { ...base.errors }
          const keys = Object.keys(patch) as ComputerKey[]
          for (const key of keys) delete errors[key]
          if (failed) errors[failed] = message ?? ''
          return { hostId: id, values: { ...base, ...patch, errors } }
        })
      }
      const read = <T,>(
        key: ComputerKey,
        load: Promise<T>,
        apply: (value: T) => Partial<ComputerValues>
      ) =>
        load
          .then((value) => merge(apply(value)))
          .catch((e) => merge({}, key, errorText(e)))

      void read(
        'model',
        client.get<{ model: { id: string; name?: string } }>('/api/models/current', { signal }),
        (value) => ({ model: modelDisplayName(value.model) })
      )
      void read('effort', client.get<{ level: string }>('/api/effort', { signal }), (value) => ({
        effort: value.level,
      }))
      void read(
        'mode',
        client.get<{ mode: string }>('/api/permissions/mode', { signal }),
        (value) => ({ mode: value.mode })
      )
      void read(
        'autoQuestion',
        client.get<{ autoQuestion?: unknown }>('/api/settings/user', { signal }),
        (value) => ({ autoQuestion: readAutoQuestion(value) })
      )
      void read(
        'schedules',
        client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks', { signal }),
        (value) => ({ schedules: scheduleSummary(value.tasks ?? [], new Date()) })
      )
      void read(
        'activity',
        (async () => {
          const current = snapshotRef.current
          const sessions = await activeSessions(
            client,
            current?.hostId === id ? current : null,
            signal
          )
          const groups = await loadHostBackgroundTasks(
            client,
            sessions.map((session) => session.id),
            signal
          )
          return activitySummary({
            running: runningTaskCount(groups),
            read: groups.length,
            total: sessions.length,
          })
        })(),
        (summary) => ({ activity: summary ?? '暂时读不到' })
      )
      return () => controller.abort()
    }, [client])
  )

  /** 本页写成功后直接更新本地值，不等下次聚焦重读。 */
  const patch = useCallback(
    (next: Partial<Omit<ComputerValues, 'errors'>>) =>
      setState((current) =>
        current && current.hostId === hostId
          ? { hostId: current.hostId, values: { ...current.values, ...next } }
          : current
      ),
    [hostId]
  )
  return { values: state && state.hostId === hostId ? state.values : empty, patch }
}
