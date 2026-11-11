import { safeDialogUrl, validElicitationContent, validElicitationValue, type OfficialSdkDialog } from '../../../../src/shared/officialAgentSdkDialogs'
import type { DecisionResponse } from '../approvalData'

export function initialDialogValues(dialog: OfficialSdkDialog): Record<string, unknown> {
  return Object.fromEntries((dialog.fields ?? []).flatMap(field => {
    if (field.default !== undefined && validElicitationValue(field, field.default)) return [[field.name, field.default]]
    const empty = field.type === 'string' && !field.choices ? '' : field.type === 'array' ? [] : undefined
    return field.required && empty !== undefined && validElicitationValue(field, empty) ? [[field.name, empty]] : []
  }))
}
export function sdkChoiceLabel(value: string, label: string): string {
  const labels: Record<string, string> = {
    'sdkDialog.retry': '重试', 'sdkDialog.completed': '已完成', 'sdkDialog.continue': '继续',
    'sdkDialog.interrupt': '停止', 'sdkDialog.stop': '停止', 'sdkDialog.useCredits': '使用额度',
    'sdkDialog.switchDefault': '切回默认模型', 'sdkDialog.cancel': '取消', 'sdkDialog.editPrompt': '修改提示词',
  }
  return labels[label] ?? (value === 'retry_fallback' ? `使用 ${label} 重试` : label)
}

/** Uses exactly the desktop SDK envelope; labels and native field names are never interchangeable. */
export function sdkDialogResponse(requestId: string, dialog: OfficialSdkDialog,
  result: Record<string, unknown>, openedUrl?: string): DecisionResponse | null {
  if (result.action === 'cancel' || result.action === 'decline') {
    result = { action: result.action }
  } else if (dialog.kind === 'choice') {
    if (typeof result.choice !== 'string' || !dialog.choices?.some(choice => choice.value === result.choice)) return null
    result = { choice: result.choice }
  } else if (result.action === 'accept' && !dialog.unsupportedSchema) {
    if (dialog.mode === 'url') {
      const url = safeDialogUrl(dialog.url)
      if (!url || openedUrl !== url) return null
      result = { action: 'accept', openedUrl: url }
    } else {
      if (!dialog.fields || !validElicitationContent(dialog.fields, result.content)) return null
      result = { action: 'accept', content: result.content }
    }
  } else return null
  return { type: 'permission_response', requestId, allowed: true, updatedInput: { sdkDialogResult: result } }
}
