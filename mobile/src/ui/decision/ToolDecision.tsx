import { useState } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import type { PermissionRequest } from '../../core/types'
import {
  Button,
  Checkbox,
  CodeBlock,
  DiffStat,
  DiffView,
  Mono,
  useColors,
} from '../kit'
import { Text } from '../Text'
import {
  appendSuggestion,
  approvalDescription,
  approvalSubject,
  approvalTitle,
  denySuggestions,
  denySummary,
  denyTitle,
  isFileChange,
  rememberLabel,
  toolKind,
  workDirCaption,
} from './decisionCopy'
import { fileChange } from './fileDiff'
import { relativePath } from '../chat/steps'
import {
  DecisionHeader,
  DecisionSurface,
  NoteChip,
  NoteInput,
  QuietButton,
  SubmittedRow,
} from './parts'

export type ToolRespond = (options: {
  allowed: boolean
  remember?: boolean
  note?: string
}) => boolean

/** Regular tool approval: command / file edit bases, plus a "deny with note" state. */
export function ToolDecision({
  request,
  input,
  ready,
  sent,
  respond,
  position,
  onStop,
  workDir,
}: {
  request: PermissionRequest
  input: Record<string, unknown>
  ready: boolean
  sent: boolean
  respond: ToolRespond
  position?: { index: number; total: number }
  onStop?(): void
  workDir?: string
}) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const [denying, setDenying] = useState(false)
  const [note, setNote] = useState('')
  const [remember, setRemember] = useState(false)
  const toolName = request.toolName
  const locked = !ready || sent
  const change = isFileChange(toolName) ? fileChange(toolName, input) : null

  const stop = onStop ? (
    <QuietButton title="Stop the whole task" onPress={onStop} />
  ) : null

  if (denying)
    return (
      <DecisionSurface label="Deny with note">
        <View style={{ gap: 4 }}>
          <Text accessibilityRole="header" style={{ fontSize: 16, lineHeight: 22, fontWeight: '600', color: colors.ink }}>
            {denyTitle(toolName)}
          </Text>
          <Mono numberOfLines={1} style={{ fontSize: 12.5, lineHeight: 17, color: colors.ink3 }}>
            {denySummary(toolName, input)}
          </Mono>
        </View>
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.ink3 }}>
            Tell it what to do (optional)
          </Text>
          <NoteInput
            accessibilityLabel="Tell it what to do (optional)"
            autoFocus
            value={note}
            onChangeText={setNote}
            editable={!sent}
          />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {denySuggestions(toolName).map((suggestion) => (
            <NoteChip
              key={suggestion}
              label={suggestion}
              disabled={sent}
              onPress={() => setNote((value) => appendSuggestion(value, suggestion))}
            />
          ))}
        </View>
        {sent ? (
          <SubmittedRow />
        ) : (
          <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
            <Button
              title="Back"
              variant="secondary"
              size="lg"
              style={{ flex: 1 }}
              onPress={() => setDenying(false)}
            />
            <Button
              title={note.trim() ? 'Deny and send' : 'Just deny'}
              size="lg"
              style={{ flex: 1 }}
              disabled={!ready}
              onPress={() => respond({ allowed: false, note })}
            />
          </View>
        )}
      </DecisionSurface>
    )

  const decide = sent ? (
    <SubmittedRow />
  ) : (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Button
        title="Deny…"
        accessibilityLabel="Deny, optionally with a note"
        variant="secondary"
        size="lg"
        style={{ flex: 1 }}
        disabled={!ready}
        onPress={() => setDenying(true)}
      />
      <Button
        title="Allow"
        size="lg"
        style={{ flex: 1 }}
        disabled={!ready}
        onPress={() =>
          respond({ allowed: true, remember })
        }
      />
    </View>
  )

  if (change)
    return (
      <DecisionSurface label="Approvals" style={{ height: Math.max(360, height - 196) }}>
        <DecisionHeader title={approvalTitle(toolName)} position={position} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {/* Shown relative to the project directory; if it still does not fit truncate from the start, keeping the file name always visible. */}
          <Mono
            selectable
            numberOfLines={1}
            ellipsizeMode="head"
            style={{ flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 19, color: colors.ink }}
          >
            {change.path ? relativePath(change.path, workDir) : toolName}
          </Mono>
          <DiffStat added={change.added} removed={change.removed} size={13} />
        </View>
        <View
          style={{
            flex: 1,
            minHeight: 0,
            backgroundColor: colors.code,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: `inset 0 0 0 1px ${colors.hair}`,
          }}
        >
          <ScrollView contentContainerStyle={{ paddingVertical: 2 }}>
            <DiffView lines={change.lines} numbers="single" />
          </ScrollView>
        </View>
        <Checkbox
          checked={remember}
          onChange={setRemember}
          disabled={locked}
          accessibilityLabel={rememberLabel(toolName)}
        >
          {rememberLabel(toolName)}
        </Checkbox>
        {decide}
        {sent ? null : stop}
      </DecisionSurface>
    )

  const subject = approvalSubject(toolName, input)
  const description = approvalDescription(request.description, input)
  const command = toolKind(toolName) === 'command'
  return (
    <DecisionSurface label="Approvals">
      <DecisionHeader title={approvalTitle(toolName)} position={position} />
      {description ? (
        <Text style={{ fontSize: 14, lineHeight: 21, color: colors.ink2 }}>{description}</Text>
      ) : null}
      <ScrollView style={{ maxHeight: height * 0.32, flexGrow: 0 }}>
        <CodeBlock
          prompt={subject.prompt}
          caption={command ? workDirCaption(workDir) : undefined}
        >
          {subject.text}
        </CodeBlock>
      </ScrollView>
      <Checkbox
        checked={remember}
        onChange={setRemember}
        disabled={locked}
        accessibilityLabel={
          rememberLabel(toolName)
        }
      >
        {rememberLabel(toolName)}
      </Checkbox>
      {decide}
      {sent ? null : stop}
    </DecisionSurface>
  )
}
