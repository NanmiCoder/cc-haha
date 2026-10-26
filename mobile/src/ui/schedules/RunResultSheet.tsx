import { ScrollView, View, useWindowDimensions } from 'react-native'
import type { TaskRun } from '../../core/operations'
import { dayTimeLabel } from '../../core/schedulesView'
import { InlineError, Mono, Sheet, type, useColors } from '../kit'
import { Text } from '../Text'

/** 没有关联会话的运行结果：错误只在红色提示里出现一次，输出单独显示。 */
export function RunResultSheet({ run, onClose }: { run: TaskRun | null; onClose(): void }) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  return (
    <Sheet visible={!!run} onClose={onClose} scroll={false}>
      {run && (
        <View style={{ gap: 12 }}>
          <View style={{ alignItems: 'center', gap: 2, paddingTop: 6, paddingBottom: 4 }}>
            <Text style={[type.nav, { color: colors.ink }]}>执行结果</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 16, color: colors.ink3 }}>
              {[run.taskName, dayTimeLabel(run.startedAt)].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <InlineError text={run.error} />
          {run.output ? (
            <ScrollView
              style={{ maxHeight: height * 0.55, borderRadius: 12, backgroundColor: colors.code }}
              contentContainerStyle={{ padding: 12 }}
            >
              <Mono selectable style={{ fontSize: 12, lineHeight: 18, color: colors.ink }}>
                {run.output}
              </Mono>
            </ScrollView>
          ) : !run.error ? (
            <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink3, textAlign: 'center', paddingVertical: 12 }}>
              电脑尚未记录输出。
            </Text>
          ) : null}
        </View>
      )}
    </Sheet>
  )
}
