import { Pressable, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { Text } from '../Text'
import { Button, Card, HaloDot, Mono, useColors } from '../kit'
import { formatDuration, relativeLabel, type DashboardRow } from '../../core/dashboard'
import {
  approvalPreview,
  decisionAction,
  decisionKind,
  planPreview,
  previewText,
  projectOf,
} from './homeModel'
import { useNow } from './parts'
import { plural } from '../../core/plural'

export type DecisionResponse = 'allow' | 'deny'

/** A card under "Waiting for your decision": approval / question / plan / team plan / other waits. */
export function DecisionCard({
  row,
  onOpen,
  onRespond,
}: {
  row: DashboardRow
  onOpen(): void
  onRespond(action: DecisionResponse, requestId: string): void
}) {
  const colors = useColors()
  const { session, activity } = row
  const kind = decisionKind(activity)
  const project = projectOf(session)?.name
  const action = decisionAction(activity)
  const title = session.title || 'Untitled task'
  const question = kind === 'question' ? previewText(activity) : ''
  const plan = kind === 'plan' ? planPreview(activity) : null
  const command = kind === 'approval' ? approvalPreview(activity) : ''
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${project ? `${project}, ` : ''}${action}${question ? `: ${question}` : ''}`}
        onPress={onOpen}
        style={({ pressed }) => ({ gap: 3, opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
            <HaloDot />
          </View>
          <Text
            numberOfLines={1}
            style={{ flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }}
          >
            {title}
          </Text>
          <Text style={{ fontSize: 13, color: colors.ink3 }}>
            {relativeLabel(session.modifiedAt)}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ paddingLeft: 26, fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
          {project ? `${project} · ` : ''}
          <Text style={{ color: colors.attn }}>{action}</Text>
        </Text>
        {question ? (
          <Text style={{ paddingLeft: 26, paddingTop: 6, fontSize: 15, lineHeight: 22, color: colors.ink }}>
            {question}
          </Text>
        ) : null}
      </Pressable>
      {command ? (
        <Mono
          numberOfLines={1}
          style={{
            marginLeft: 26,
            backgroundColor: colors.bg,
            borderRadius: 10,
            overflow: 'hidden',
            paddingVertical: 10,
            paddingHorizontal: 12,
            fontSize: 13,
            lineHeight: 18,
            color: colors.ink,
          }}
        >
          {command}
        </Mono>
      ) : null}
      {plan ? (
        <View
          style={{
            marginLeft: 26,
            borderLeftWidth: 2,
            borderLeftColor: colors.hair,
            paddingVertical: 2,
            paddingLeft: 12,
            gap: 4,
          }}
        >
          {plan.lines.map((line, index) => (
            <Text key={index} numberOfLines={1} style={{ fontSize: 14, lineHeight: 20, color: colors.ink2 }}>
              {line}
            </Text>
          ))}
          {plan.more ? (
            <Text style={{ fontSize: 14, lineHeight: 20, color: colors.ink3 }}>
              {plural(plan.more, 'more step')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {kind === 'approval' && activity?.requestId ? (
        <View style={{ marginLeft: 26, flexDirection: 'row', gap: 8 }}>
          <Button
            title="Deny"
            variant="secondary"
            accessibilityLabel={`Deny: ${title}`}
            onPress={() => onRespond('deny', activity.requestId!)}
            style={{ flex: 1 }}
          />
          <Button
            title="Allow"
            accessibilityLabel={`Allow: ${title}`}
            onPress={() => onRespond('allow', activity.requestId!)}
            style={{ flex: 1 }}
          />
        </View>
      ) : kind === 'question' ? (
        <View style={{ marginLeft: 26, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {typeof activity?.autoAnswerDeadline === 'number' ? (
              <AutoAnswerCountdown deadline={activity.autoAnswerDeadline} />
            ) : null}
          </View>
          <Button title="Answer" variant="secondary" accessibilityLabel={`Answer: ${title}`} onPress={onOpen} />
        </View>
      ) : (
        <Button
          title={openTitle(kind)}
          variant="secondary"
          accessibilityLabel={`${openTitle(kind)}: ${title}`}
          onPress={onOpen}
          style={{ marginLeft: 26 }}
        />
      )}
    </Card>
  )
}

const openTitle = (kind: ReturnType<typeof decisionKind>) =>
  kind === 'plan' ? 'See full plan' : kind === 'team' ? 'View and configure' : 'Open to handle'

/** Ring icon + "AI answers with the recommended option in m:ss", ticking every second. */
function AutoAnswerCountdown({ deadline }: { deadline: number }) {
  const colors = useColors()
  const now = useNow(1000)
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000))
  return (
    <View
      accessibilityLabel={
        seconds > 0 ? `${formatDuration(seconds)} until AI answers with the recommended option` : 'AI Answering with the recommended option'
      }
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <Svg width={16} height={16} viewBox="0 0 16 16">
        <Circle cx={8} cy={8} r={6.5} fill="none" stroke={colors.fill} strokeWidth={2} />
        <Path
          d="M8 1.5a6.5 6.5 0 0 1 6.2 8.4"
          fill="none"
          stroke={colors.ink3}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </Svg>
      {seconds > 0 ? (
        <>
          <Mono style={{ fontSize: 13, color: colors.ink3 }}>{formatDuration(seconds)}</Mono>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: colors.ink3 }}>
            until AI answers with the recommended option
          </Text>
        </>
      ) : (
        <Text style={{ fontSize: 13, color: colors.ink3 }}>AI Answering with the recommended option</Text>
      )}
    </View>
  )
}
