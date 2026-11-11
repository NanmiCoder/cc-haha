import { Alert, View } from 'react-native'
import type { TeamPlanRecord, TeamPlanSurface } from '../../core/teamPlan'
import { Button, Callout, InlineError, useColors } from '../kit'
import { Text } from '../Text'
import type { TeamPlanController } from './useTeamPlan'

/**
 * 输入框上方的团队卡片，和桌面端一样不挡输入框和停止键：
 * 等确认 → 打开配置单；启动失败 → 重新审阅或取消；运行时中断 → 结束团队（成员记录保留）。
 */
export function TeamPlanCard({
  plan,
  surface,
  team,
  ready,
  onOpen,
}: {
  plan: TeamPlanRecord
  surface: TeamPlanSurface
  team: TeamPlanController
  ready: boolean
  /** 打开配置单。 */
  onOpen(): void
}) {
  const colors = useColors()
  const locked = !ready || team.pending !== null
  if (surface === 'review') {
    const addition = !!plan.parentPlanId
    const names = plan.members.map((member) => member.name).join('、')
    return (
      <Callout icon="users">
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.attnInk }}>
            {addition ? '要追加的成员等你确认' : '团队组好了，等你确认'}
          </Text>
          <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 19, color: colors.attnInk }}>
            {plan.members.length} 位成员 · {plan.tasks.length} 项任务{names ? `：${names}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button title="查看并配置" size="sm" pill onPress={onOpen} />
          </View>
        </View>
      </Callout>
    )
  }
  const failed = surface === 'failed'
  // 启动失败的原因具体到成员和退出码，要给人看；中断的原因是固定说法，标题已经讲清楚。
  const detail = failed ? plan.launch?.error : undefined
  const end = () =>
    Alert.alert('结束这个团队？', '会停掉所有成员并删除团队，成员的对话记录会保留。', [
      { text: '再想想', style: 'cancel' },
      { text: '结束团队', style: 'destructive', onPress: () => void team.act('end') },
    ])
  return (
    <Callout tone={failed ? 'error' : 'info'}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '600', color: failed ? colors.err : colors.ink }}>
          {failed ? `团队「${plan.teamName}」没能启动` : `团队「${plan.teamName}」已中断，已开始的任务不会自动重跑`}
        </Text>
        {detail ? (
          <Text selectable numberOfLines={4} style={{ fontSize: 13, lineHeight: 19, color: colors.err }}>
            {detail}
          </Text>
        ) : null}
        <InlineError text={team.error} />
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          {failed ? (
            <>
              <Button
                title="取消团队"
                size="sm"
                variant="outline"
                pill
                disabled={locked}
                busy={team.pending === 'cancel'}
                onPress={() => void team.act('cancel')}
              />
              <Button
                title="重新审阅"
                size="sm"
                pill
                disabled={locked}
                busy={team.pending === 'retry'}
                onPress={() => {
                  void team.act('retry').then((done) => {
                    if (done) onOpen()
                  })
                }}
              />
            </>
          ) : (
            <Button
              title="结束团队"
              size="sm"
              variant="danger"
              pill
              disabled={locked}
              busy={team.pending === 'end'}
              onPress={end}
            />
          )}
        </View>
      </View>
    </Callout>
  )
}
