import { Alert, View } from 'react-native'
import type { TeamPlanRecord, TeamPlanSurface } from '../../core/teamPlan'
import { Button, Callout, InlineError, useColors } from '../kit'
import { Text } from '../Text'
import type { TeamPlanController } from './useTeamPlan'
import { plural } from '../../core/plural'

/**
 * Team card above the input, like desktop it does not block the input or stop key: 
 * awaiting approval → open the configuration sheet; launch failed → review again or cancel; interrupted at runtime → end team (member records kept).
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
  /** Open the configuration sheet. */
  onOpen(): void
}) {
  const colors = useColors()
  const locked = !ready || team.pending !== null
  if (surface === 'review') {
    const addition = !!plan.parentPlanId
    const names = plan.members.map((member) => member.name).join(', ')
    return (
      <Callout icon="users">
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '600', color: colors.attnInk }}>
            {addition ? 'New members awaiting your confirmation' : 'Team is ready, awaiting your confirmation'}
          </Text>
          <Text numberOfLines={2} style={{ fontSize: 13, lineHeight: 19, color: colors.attnInk }}>
            {plural(plan.members.length, 'member')} · {plural(plan.tasks.length, 'task')}{names ? `: ${names}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
            <Button title="View and configure" size="sm" pill onPress={onOpen} />
          </View>
        </View>
      </Callout>
    )
  }
  const failed = surface === 'failed'
  // Launch failure reasons are specific to members and exit codes and should be shown; interruption reasons are fixed wording already explained by the title.
  const detail = failed ? plan.launch?.error : undefined
  const end = () =>
    Alert.alert('End this team?', 'All members will be stopped and the team deleted; members’ conversation records are kept.', [
      { text: 'Think again', style: 'cancel' },
      { text: 'End team', style: 'destructive', onPress: () => void team.act('end') },
    ])
  return (
    <Callout tone={failed ? 'error' : 'info'}>
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, lineHeight: 20, fontWeight: '600', color: failed ? colors.err : colors.ink }}>
          {failed ? `Team “${plan.teamName}” failed to start` : `Team “${plan.teamName}” was interrupted; started tasks will not rerun automatically`}
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
                title="Cancel team"
                size="sm"
                variant="outline"
                pill
                disabled={locked}
                busy={team.pending === 'cancel'}
                onPress={() => void team.act('cancel')}
              />
              <Button
                title="Review again"
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
              title="End team"
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
