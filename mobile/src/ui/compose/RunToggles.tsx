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
 * The "Run mode" group in "+": agent team and computer use are both selected into the next message.
 * Global authorization for computer use is confirmed only on first enable, independent of this selection.
 * Consistent with desktop, these two toggles belong to "what to bring this time" and are not in the model and permissions sheet.
 * `visible` When true, reread team settings and computer authorization status from the computer.
 */
export function RunToggles({
  visible,
  client,
  team,
  onTeam,
  lean,
  computer,
  computerSelected,
  onComputerSelected,
  accepted,
  onAccept,
}: {
  visible: boolean
  client: ApiClient | null
  team: boolean
  onTeam(value: boolean): void
  lean: boolean
  computer: ComputerUse
  computerSelected: boolean
  onComputerSelected(value: boolean): void
  /** The cost confirmation "Use team" was already tapped. State lives at the "+" sheet level, so entering subpages, searching and returning does not reset it. */
  accepted: boolean
  onAccept(): void
}) {
  const colors = useColors()
  const [teamConsent, setTeamConsent] = useState(false)
  // Every open rereads settings from the computer, adjusted during render to avoid another setState in an effect.
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
            <Text style={{ fontSize: 16, color: colors.ink }}>Agent Team</Text>
            <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>{teamNote(reasons.team)}</Text>
          </View>
          <Switch label="Agent Team" value={team} disabled={!!reasons.team} onValueChange={toggleTeam} />
        </View>
        <View style={{ height: 1, backgroundColor: colors.hair, marginLeft: 14 }} />
        <ComputerUseRow computer={computer} selected={computerSelected} onSelected={onComputerSelected} />
      </View>
      <Sheet visible={teamConsent} onClose={() => setTeamConsent(false)} title="Use agent team">
        <Text style={{ fontSize: 15, lineHeight: 23, color: colors.ink }}>
          The lead splits the task and coordinates multiple members. Each member calls the model independently, which may increase usage and cost.
        </Text>
        <Button
          title="Use team"
          onPress={() => {
            onAccept()
            setTeamConsent(false)
            onTeam(true)
          }}
        />
        <Button title="Cancel" variant="secondary" onPress={() => setTeamConsent(false)} />
      </Sheet>
      <ComputerUseConsent computer={computer} />
    </>
  )
}
