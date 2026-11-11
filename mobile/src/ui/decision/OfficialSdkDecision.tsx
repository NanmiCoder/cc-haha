import { useState } from 'react'
import { ScrollView, View, useWindowDimensions } from 'react-native'
import { openURL } from 'expo-linking'
import { safeDialogUrl, type OfficialSdkDialog } from '../../../../src/shared/officialAgentSdkDialogs'
import type { ClientMessage } from '../../core/types'
import { Button, Checkbox, Mono, useColors } from '../kit'
import { Text } from '../Text'
import { DecisionHeader, DecisionSurface, NoteInput, SubmittedRow } from './parts'
import { initialDialogValues, sdkChoiceLabel, sdkDialogResponse } from './sdkDialog'

export function OfficialSdkDecision({ requestId, dialog, ready, sent, send, position }: {
  requestId: string
  dialog: OfficialSdkDialog
  ready: boolean
  sent: boolean
  send(message: ClientMessage): boolean
  position?: { index: number; total: number }
}) {
  const colors = useColors()
  const { height } = useWindowDimensions()
  const [values, setValues] = useState(() => initialDialogValues(dialog))
  const [openedUrl, setOpenedUrl] = useState<string>()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const locked = !ready || sent
  const url = safeDialogUrl(dialog.url)
  const title = dialog.nativeKind === 'refusal_fallback_prompt' ? '选择继续使用的模型'
    : dialog.nativeKind === 'fable_overage_consent_prompt' ? '确认额度使用' : dialog.title
  const setField = (name: string, value: unknown) => { setValues(previous => ({ ...previous, [name]: value })); setError('') }
  function answer(result: Record<string, unknown>) {
    if (locked) return
    const response = sdkDialogResponse(requestId, dialog, result, openedUrl)
    if (!response) { setError('请检查必填项、格式和范围后重试。'); return }
    send(response)
  }
  async function openPage() {
    if (!url || opening || locked) return
    setOpening(true)
    setError('')
    try { await openURL(url); setOpenedUrl(url) }
    catch { setError('页面未打开，请重试或取消。') }
    finally { setOpening(false) }
  }
  return <DecisionSurface label={title}>
    <DecisionHeader title={title} position={position} />
    <ScrollView style={{ maxHeight: height * 0.5 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
      {dialog.serverName ? <Text style={{ color: colors.ink3 }}>{dialog.serverName}</Text> : null}
      {dialog.refusal ? <Text style={{ color: colors.ink2 }}>{dialog.refusal.originalModel} 暂停了回复，可选择 {dialog.refusal.fallbackModel} 重试。</Text> : null}
      {dialog.creditConsent ? <View style={{ gap: 6 }}>
        <Text style={{ color: colors.ink2 }}>{dialog.creditConsent.modelName} 需要使用额外额度，请选择是否继续。</Text>
        {typeof dialog.creditConsent.balanceCents === 'number' && dialog.creditConsent.currency ?
          <Text style={{ color: colors.ink2 }}>当前余额：{(dialog.creditConsent.balanceCents / 100).toFixed(2)} {dialog.creditConsent.currency}</Text> : null}
        {!dialog.creditConsent.overagesEnabled ? <Text style={{ color: colors.ink2 }}>账户尚未启用额外额度。</Text> : null}
      </View> : null}
      {dialog.message ? <Text selectable style={{ color: colors.ink2, lineHeight: 22 }}>{dialog.message}</Text> : null}
      {dialog.unsupportedSchema ? <Text accessibilityRole="alert">此表单暂不支持，请在电脑处理，或拒绝、取消。</Text> : null}
      {dialog.kind === 'elicitation' && dialog.mode === 'form' && !dialog.unsupportedSchema ? (dialog.fields ?? []).map(field => {
        const label = `${field.title}${field.required ? ' *' : ''}`
        const value = values[field.name]
        return <View key={field.name} style={{ gap: 6 }}>
          <Text style={{ color: colors.ink, fontWeight: '600' }}>{label}</Text>
          {field.description ? <Text style={{ color: colors.ink3 }}>{field.description}</Text> : null}
          {field.type === 'array' ? field.choices?.map(choice => <Checkbox key={choice.value} accessibilityLabel={`${label}：${choice.label}`}
            disabled={locked} checked={Array.isArray(value) && value.includes(choice.value)} onChange={checked => {
              const selected = Array.isArray(value) ? value : []
              setField(field.name, checked ? [...selected, choice.value] : selected.filter(item => item !== choice.value))
            }}><Text>{choice.label}</Text></Checkbox>)
            : field.type === 'boolean' || field.choices ? <View style={{ gap: 6 }}>
              {(field.type === 'boolean' ? [{ value: true, label: '是' }, { value: false, label: '否' }] : field.choices!).map(choice =>
                <Button key={String(choice.value)} title={choice.label} variant={value === choice.value ? 'primary' : 'secondary'}
                  disabled={locked} onPress={() => setField(field.name, choice.value)} />)}
              {!field.required ? <Button title="清除选择" variant="secondary" disabled={locked} onPress={() => setField(field.name, undefined)} /> : null}
            </View> : <NoteInput accessibilityLabel={label} minHeight={48} multiline={false} editable={!locked} autoCorrect={false} autoCapitalize="none"
              keyboardType={field.type === 'number' || field.type === 'integer' ? 'numbers-and-punctuation' : field.format === 'email' ? 'email-address' : 'default'}
              value={value === undefined ? '' : String(value)} onChangeText={text => setField(field.name,
                field.type === 'number' || field.type === 'integer' ? text === '' ? undefined : Number(text) : text)} />}
        </View>
      }) : null}
      {url ? <View style={{ gap: 6 }}><Mono selectable>{url}</Mono>
        <Button title={opening ? '正在打开…' : '打开网页'} disabled={locked || opening} variant="secondary" onPress={() => { void openPage() }} /></View> : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </ScrollView>
    {sent ? <SubmittedRow /> : <View style={{ gap: 8 }}>
      {dialog.kind === 'choice' ? dialog.choices?.map(choice => <Button key={choice.value} title={sdkChoiceLabel(choice.value, choice.label)}
        disabled={locked} variant="secondary" onPress={() => answer({ choice: choice.value })} />)
        : <Button title={dialog.mode === 'url' ? '已完成网页操作' : '提交'}
          disabled={locked || dialog.unsupportedSchema || dialog.mode === 'url' && openedUrl !== url}
          onPress={() => answer({ action: 'accept', content: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) })} />}
      {dialog.kind === 'elicitation' ? <Button title="拒绝" variant="secondary" disabled={locked} onPress={() => answer({ action: 'decline' })} /> : null}
      {!dialog.choices?.some(choice => choice.value === 'cancelled') ? <Button title="取消" variant="secondary" disabled={locked} onPress={() => answer({ action: 'cancel' })} /> : null}
    </View>}
  </DecisionSurface>
}
