import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import type { ApiClient } from '../../core/client'
import {
  buildWorkflowHistoryRuns,
  loadSessionWorkflowRuns,
  loadWorkflowRunDetail,
  workflowRunStatusText,
  type ReconstructedWorkflowRun,
  type WorkflowHistoryRun,
  type WorkflowLiveRun,
  type WorkflowRunDetail,
} from '../../core/workflows'
import { DetentSheet } from '../DetentSheet'
import { Button, EmptyState, Footnote, Icon, InlineError, Loading, Mono, useColors } from '../kit'
import { Text } from '../Text'
import { errorText } from '../theme'
import {
  formatPhaseCount,
  formatWorkflowTime,
  resolveHistoryPhases,
} from './workflowHistoryView'

type DetailEntry =
  | { status: 'loaded'; detail: WorkflowRunDetail | null }
  | { status: 'error'; message: string }

function clearFailedDetails(entries: Record<string, DetailEntry>): Record<string, DetailEntry> {
  let changed = false
  const next: Record<string, DetailEntry> = {}
  for (const [runId, entry] of Object.entries(entries)) {
    if (entry.status === 'error') {
      changed = true
      continue
    }
    next[runId] = entry
  }
  return changed ? next : entries
}

const cardStyle = (colors: ReturnType<typeof useColors>) => ({
  backgroundColor: colors.card,
  borderRadius: 16,
  boxShadow: `0 0 0 1px ${colors.hair}`,
})

/**
 * 已结束的 Workflow 历史记录底单：
 * 一级列出该会话已结束的运行（名称、状态、开始与结束时间、阶段数），
 * 点开一条进入二级查看它的阶段列表与各阶段标题。
 */
export function WorkflowHistorySheet({
  visible,
  onClose,
  client,
  sessionId,
  liveWorkflows,
}: {
  visible: boolean
  onClose(): void
  client: ApiClient | null
  sessionId: string
  liveWorkflows?: Record<string, WorkflowLiveRun>
}) {
  const colors = useColors()
  const [refreshTick, setRefreshTick] = useState(0)
  const [fetched, setFetched] = useState<{
    key: string
    runs: ReconstructedWorkflowRun[]
    error: string
  }>({ key: '', runs: [], error: '' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailByRunId, setDetailByRunId] = useState<Record<string, DetailEntry>>({})
  const [detailRetryTick, setDetailRetryTick] = useState(0)

  const [wasVisible, setWasVisible] = useState(visible)
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (!visible) {
      setSelectedId(null)
      setDetailByRunId(clearFailedDetails)
    } else setRefreshTick((tick) => tick + 1)
  }

  const requestKey = `${sessionId}:${refreshTick}`
  const loading = visible && !!client && fetched.key !== requestKey
  const error = fetched.key === requestKey ? fetched.error : ''

  useEffect(() => {
    if (!visible || !client) return
    const controller = new AbortController()
    loadSessionWorkflowRuns(client, sessionId, controller.signal)
      .then((runs) => {
        if (!controller.signal.aborted) {
          setFetched({ key: requestKey, runs, error: '' })
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setFetched((prev) => ({
            key: requestKey,
            runs: prev.key.startsWith(`${sessionId}:`) ? prev.runs : [],
            error: errorText(err),
          }))
        }
      })
    return () => controller.abort()
  }, [visible, client, sessionId, requestKey])

  const reconstructed = useMemo(
    () => (fetched.key.startsWith(`${sessionId}:`) ? fetched.runs : []),
    [fetched, sessionId]
  )
  const runs = useMemo(
    () => buildWorkflowHistoryRuns({ reconstructed, live: liveWorkflows }),
    [reconstructed, liveWorkflows]
  )
  const selected = useMemo(
    () => (selectedId ? runs.find((run) => run.id === selectedId) ?? null : null),
    [runs, selectedId]
  )
  const selectedDetailEntry = selected ? detailByRunId[selected.runId] : undefined
  const detailLoading = Boolean(
    visible &&
      client &&
      selected &&
      selected.phases.length === 0 &&
      selected.runId &&
      !selectedDetailEntry
  )

  // 若重建结果没有阶段列表（例如子代理未启动前失败），按需补读一次 run 详情以获取脚本阶段标题。
  useEffect(() => {
    if (!visible || !client || !selected || selected.phases.length > 0) return
    const runId = selected.runId
    if (!runId || runId in detailByRunId) return
    const controller = new AbortController()
    loadWorkflowRunDetail(client, sessionId, runId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) {
          setDetailByRunId((prev) => ({ ...prev, [runId]: { status: 'loaded', detail } }))
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setDetailByRunId((prev) => ({
            ...prev,
            [runId]: { status: 'error', message: errorText(err) },
          }))
        }
      })
    return () => controller.abort()
  }, [visible, client, sessionId, selected, detailByRunId, detailRetryTick])

  const resolvedDetails = useMemo(() => {
    const map: Record<string, WorkflowRunDetail | null | undefined> = {}
    for (const [runId, entry] of Object.entries(detailByRunId)) {
      if (entry.status === 'loaded') map[runId] = entry.detail
    }
    return map
  }, [detailByRunId])

  const refresh = useCallback(() => {
    setDetailByRunId(clearFailedDetails)
    setRefreshTick((tick) => tick + 1)
  }, [])
  const retryDetail = useCallback((runId: string) => {
    setDetailByRunId((prev) => {
      if (!(runId in prev)) return prev
      const next = { ...prev }
      delete next[runId]
      return next
    })
    setDetailRetryTick((tick) => tick + 1)
  }, [])
  const close = useCallback(() => {
    setSelectedId(null)
    onClose()
  }, [onClose])

  return (
    <DetentSheet
      visible={visible}
      onClose={close}
      scroll={false}
      title={selected ? selected.workflowName : 'Workflow 记录'}
      left={
        selected ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="返回 Workflow 记录列表"
            onPress={() => setSelectedId(null)}
            style={({ pressed }) => ({
              height: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              paddingRight: 10,
              marginLeft: -4,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Icon name="chevron-left" size={18} color={colors.run} strokeWidth={2.2} />
            <Text style={{ fontSize: 15, fontWeight: '500', color: colors.run }}>返回</Text>
          </Pressable>
        ) : undefined
      }
      right={
        !selected && client ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="刷新 Workflow 记录"
            disabled={loading}
            onPress={refresh}
            style={({ pressed }) => ({
              height: 44,
              paddingHorizontal: 10,
              marginRight: -6,
              justifyContent: 'center',
              opacity: loading ? 0.45 : pressed ? 0.6 : 1,
            })}
          >
            <Icon name="refresh-cw" size={17} color={colors.ink2} strokeWidth={2} />
          </Pressable>
        ) : undefined
      }
    >
      {selected ? (
        <RunDetailView
          run={selected}
          detail={selectedDetailEntry?.status === 'loaded' ? selectedDetailEntry.detail : undefined}
          detailError={selectedDetailEntry?.status === 'error' ? selectedDetailEntry.message : ''}
          loadingDetail={detailLoading}
          onRetryDetail={() => retryDetail(selected.runId)}
        />
      ) : (
        <RunListView
          runs={runs}
          detailsByRunId={resolvedDetails}
          loading={loading}
          error={error}
          onSelect={(run) => setSelectedId(run.id)}
        />
      )}
    </DetentSheet>
  )
}

function RunListView({
  runs,
  detailsByRunId,
  loading,
  error,
  onSelect,
}: {
  runs: WorkflowHistoryRun[]
  detailsByRunId: Record<string, WorkflowRunDetail | null | undefined>
  loading: boolean
  error: string
  onSelect(run: WorkflowHistoryRun): void
}) {
  const colors = useColors()
  const now = new Date()
  return (
    <>
      <InlineError text={error} />
      {loading && runs.length === 0 ? (
        <Loading />
      ) : runs.length === 0 ? (
        <EmptyState
          icon="layers"
          title="还没有 Workflow 记录"
          detail="这个会话里已结束的 Workflow 运行会显示在这里。"
        />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          showsVerticalScrollIndicator
          contentContainerStyle={{ gap: 8, paddingBottom: 34 }}
        >
          {runs.map((run) => {
            const time = formatWorkflowTime(run.startedAt, run.endedAt, now)
            const statusText = workflowRunStatusText(run.status)
            const tone =
              run.status === 'completed'
                ? colors.ok
                : run.status === 'failed'
                  ? colors.err
                  : colors.ink3
            const icon =
              run.status === 'completed'
                ? 'circle-check'
                : run.status === 'failed'
                  ? 'circle-alert'
                  : 'x'
            const phaseCount = resolveHistoryPhases(run, detailsByRunId[run.runId]).length
            const phaseLabel = formatPhaseCount(phaseCount)
            return (
              <Pressable
                key={run.id}
                accessibilityRole="button"
                accessibilityLabel={[
                  run.workflowName,
                  statusText,
                  time.range,
                  phaseLabel,
                  '查看阶段列表',
                ]
                  .filter(Boolean)
                  .join('，')}
                onPress={() => onSelect(run)}
                style={({ pressed }) => [
                  cardStyle(colors),
                  {
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    gap: 4,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <View style={{ minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon name={icon} size={16} color={tone} strokeWidth={2.2} />
                  <Text
                    numberOfLines={1}
                    style={{ flexShrink: 1, fontSize: 15, fontWeight: '600', color: colors.ink }}
                  >
                    {run.workflowName}
                  </Text>
                  <Text style={{ flexShrink: 0, fontSize: 13, color: tone }}>{statusText}</Text>
                  <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {time.duration ? (
                      <Mono style={{ fontSize: 13, color: colors.ink3 }}>{time.duration}</Mono>
                    ) : null}
                    <Icon name="chevron-right" size={15} color={colors.ink3} strokeWidth={2.2} />
                  </View>
                </View>
                <View style={{ paddingLeft: 24, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {time.range ? (
                    <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                      {time.range}
                    </Text>
                  ) : null}
                  {time.range ? (
                    <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>·</Text>
                  ) : null}
                  <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
                    {phaseLabel}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </ScrollView>
      )}
    </>
  )
}

function RunDetailView({
  run,
  detail,
  detailError,
  loadingDetail,
  onRetryDetail,
}: {
  run: WorkflowHistoryRun
  detail: WorkflowRunDetail | null | undefined
  detailError: string
  loadingDetail: boolean
  onRetryDetail(): void
}) {
  const colors = useColors()
  const now = new Date()
  const time = formatWorkflowTime(run.startedAt, run.endedAt, now)
  const phases = resolveHistoryPhases(run, detail)
  const statusText = workflowRunStatusText(run.status)
  const tone =
    run.status === 'completed'
      ? colors.ok
      : run.status === 'failed'
        ? colors.err
        : colors.ink3
  return (
    <ScrollView
      style={{ flex: 1 }}
      showsVerticalScrollIndicator
      contentContainerStyle={{ gap: 12, paddingBottom: 34 }}
    >
      <View style={[cardStyle(colors), { paddingHorizontal: 14, paddingVertical: 12, gap: 8 }]}>
        <MetaRow label="状态" value={statusText} valueColor={tone} />
        {time.start ? <MetaRow label="开始时间" value={time.start} mono /> : null}
        {time.end ? <MetaRow label="结束时间" value={time.end} mono /> : null}
        {time.duration ? <MetaRow label="耗时" value={time.duration} mono /> : null}
        <MetaRow label="阶段数" value={formatPhaseCount(phases.length)} />
      </View>
      {run.error ? <InlineError text={run.error} /> : null}
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.ink2, paddingHorizontal: 4 }}>
          阶段列表
        </Text>
        {loadingDetail && phases.length === 0 ? (
          <Loading />
        ) : detailError && phases.length === 0 ? (
          <View style={{ gap: 8 }}>
            <InlineError text={detailError} />
            <Button
              title="重试读取阶段"
              variant="secondary"
              icon="refresh-cw"
              onPress={onRetryDetail}
            />
          </View>
        ) : phases.length === 0 ? (
          <Footnote style={{ paddingHorizontal: 4 }}>此次运行未记录阶段信息。</Footnote>
        ) : (
          <View style={[cardStyle(colors), { paddingVertical: 4 }]}>
            {phases.map((phase, index) => (
              <View key={`${phase.index}:${index}`}>
                {index > 0 ? (
                  <View style={{ height: 1, marginLeft: 44, backgroundColor: colors.hair }} />
                ) : null}
                <View
                  accessible
                  accessibilityLabel={`第 ${index + 1} 阶段，${phase.title}`}
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 11,
                      backgroundColor: colors.fill,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Mono style={{ fontSize: 12, fontWeight: '600', color: colors.ink2 }}>
                      {String(index + 1)}
                    </Mono>
                  </View>
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 15,
                      lineHeight: 20,
                      fontWeight: '500',
                      color: colors.ink,
                    }}
                  >
                    {phase.title}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function MetaRow({
  label,
  value,
  valueColor,
  mono,
}: {
  label: string
  value: string
  valueColor?: string
  mono?: boolean
}) {
  const colors = useColors()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ fontSize: 13, color: colors.ink3 }}>{label}</Text>
      {mono ? (
        <Mono style={{ fontSize: 13, color: valueColor ?? colors.ink }}>{value}</Mono>
      ) : (
        <Text style={{ fontSize: 13, fontWeight: '500', color: valueColor ?? colors.ink }}>{value}</Text>
      )}
    </View>
  )
}
