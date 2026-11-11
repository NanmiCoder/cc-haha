import { expect, test } from 'bun:test'
import { initialDialogValues, sdkChoiceLabel, sdkDialogResponse } from './sdkDialog'
import { parseElicitationFields, type OfficialSdkDialog } from '../../../../src/shared/officialAgentSdkDialogs'

const form: OfficialSdkDialog = { sdkDialog: true, kind: 'elicitation', mode: 'form', title: 'Fixture', message: '',
  fields: parseElicitationFields({ type: 'object', required: ['wire-name', 'count', 'flags'], properties: {
    'wire-name': { type: 'string', title: 'Display label', minLength: 2 },
    count: { type: 'integer', minimum: 1, maximum: 4 },
    flags: { type: 'array', items: { enum: ['wire-a', 'wire-b'] }, minItems: 1 },
    enabled: { type: 'boolean', default: false },
  } }) }
test('SDK form uses wire field identities and shared schema constraints, never display labels or unvalidated values', () => {
  expect(initialDialogValues(form)).toEqual({ enabled: false })
  const content = { 'wire-name': 'OK', count: 2, flags: ['wire-a'], enabled: false }
  expect(sdkDialogResponse('request-id', form, { action: 'accept', content })).toEqual({
    type: 'permission_response', requestId: 'request-id', allowed: true, updatedInput: { sdkDialogResult: { action: 'accept', content } },
  })
  for (const invalid of [{ ...content, count: 1.5 }, { ...content, count: 5 }, { ...content, flags: ['Display A'] }, { ...content, extra: true }, { ...content, 'wire-name': '' }])
    expect(sdkDialogResponse('request-id', form, { action: 'accept', content: invalid })).toBeNull()
  expect(sdkDialogResponse('request-id', { ...form, unsupportedSchema: true }, { action: 'accept', content })).toBeNull()
  expect(sdkDialogResponse('request-id', form, { action: 'cancel', content: { leaked: true } })?.updatedInput).toEqual({ sdkDialogResult: { action: 'cancel' } })
})
test('URL acceptance requires the exact safe URL to have been opened, choices retain protocol values', () => {
  const dialog: OfficialSdkDialog = { sdkDialog: true, kind: 'elicitation', mode: 'url', title: 'Fixture', message: '', url: 'https://login.fixture.invalid/confirm' }
  expect(sdkDialogResponse('request', dialog, { action: 'accept' })).toBeNull()
  expect(sdkDialogResponse('request', dialog, { action: 'accept' }, 'https://attacker.invalid')).toBeNull()
  expect(sdkDialogResponse('request', { ...dialog, url: 'javascript:alert(1)' }, { action: 'accept' }, 'javascript:alert(1)')).toBeNull()
  expect(sdkDialogResponse('request', dialog, { action: 'accept' }, dialog.url)?.updatedInput).toEqual({ sdkDialogResult: { action: 'accept', openedUrl: dialog.url } })
  const choice: OfficialSdkDialog = { sdkDialog: true, kind: 'choice', title: 'Choose', message: '', choices: [{ value: 'switch_default', label: 'sdkDialog.switchDefault' }] }
  expect(sdkDialogResponse('request', choice, { choice: '切回默认模型' })).toBeNull()
  expect(sdkDialogResponse('request', choice, { choice: 'switch_default' })?.updatedInput).toEqual({ sdkDialogResult: { choice: 'switch_default' } })
  expect(sdkChoiceLabel('switch_default', 'sdkDialog.switchDefault')).toBe('切回默认模型')
})
