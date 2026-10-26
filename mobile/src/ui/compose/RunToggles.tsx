import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { Text } from '../Text'
import { Button, Sheet, Switch, useColors } from '../kit'
import type { ApiClient } from '../../core/client'
import type { ComputerUse } from '../../core/useComputerUse'
import { ComputerUseConsent, ComputerUseRow } from '../ComputerUseControl'
import { runSheetReasons, teamNote } from './runLogic'
import { useTeamsSetting } from './useTeamsSetting'

/**
 * 「＋」里「运行方式」那一组：Agent 团队（只对下一条消息生效）和操作电脑（整台电脑的开关）。
 * 和桌面端一致，这两个开关属于「这次带什么」，不放在模型和权限的底单里。
 * `visible` 为真时重新读取电脑上的团队设置和电脑授权状态。
 */
export function RunToggles({
  visible,
  client,
  team,
  onTeam,
  lean,
  computer,
  accepted,
  onAccept,
}: {
  visible: boolean
  client: ApiClient | null
  team: boolean
  onTeam(value: boolean): void
  lean: boolean
  computer: ComputerUse
  /** 费用确认已经点过「使用团队」。状态在「＋」底单这一层，进二级页、搜索再返回不会重置。 */
  accepted: boolean
  onAccept(): void
}) {
  const colors = useColors()
  const [teamConsent, setTeamConsent] = useState(false)
  // 每次打开都重读电脑上的设置，在渲染期间调整，避免 effect 里再 setState。
  const [shown, setShown] = useState(visible)
  const [epoch, setEpoch] = useState(0)
  if (shown !== visible) {
    setShown(visible)
    if (visible) setEpoch(epoch + 1)
  }
  const { refresh } = computer
  useEffect(() => {
    if (visible) refresh()
  }, [visible, refresh])
  const disarm = useCallback(() => onTeam(false), [onTeam])
  const teams = useTeamsSetting(client, epoch, team, disarm)
  const reasons = runSheetReasons({ lean, teams })

  function toggleTeam(value: boolean) {
    if (!value) onTeam(false)
    else if (accepted) onTeam(true)
    else setTeamConsent(true)
  }

  return (
    <>
      <View style={{ backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' }}>
        <View style={{ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
          <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
            <Text style={{ fontSize: 16, color: colors.ink }}>Agent 团队</Text>
            <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{teamNote(reasons.team)}</Text>
          </View>
          <Switch label="Agent 团队" value={team} disabled={!!reasons.team} onValueChange={toggleTeam} />
        </View>
        <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: 14 }} />
        <ComputerUseRow computer={computer} />
      </View>
      <Sheet visible={teamConsent} onClose={() => setTeamConsent(false)} title="使用 Agent 团队">
        <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>
          队长会拆分任务并协调多个成员。每个成员会独立调用模型，可能增加用量和费用。
        </Text>
        <Button
          title="使用团队"
          onPress={() => {
            onAccept()
            setTeamConsent(false)
            onTeam(true)
          }}
        />
        <Button title="取消" variant="secondary" onPress={() => setTeamConsent(false)} />
      </Sheet>
      <ComputerUseConsent computer={computer} />
    </>
  )
}
