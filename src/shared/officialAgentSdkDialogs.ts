/** One host-owned permission envelope; this name is never advertised as a model tool. */
export const OFFICIAL_SDK_DIALOG_TOOL = '__cc_haha_sdk_dialog'

export type DialogChoice = { value: string; label: string; description?: string }
export type ElicitationField = {
  name: string
  title: string
  description?: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  required: boolean
  choices?: DialogChoice[]
  default?: string | number | boolean | string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  format?: string
}
export type OfficialSdkDialog = {
  sdkDialog: true
  kind: 'elicitation' | 'choice'
  title: string
  message: string
  serverName?: string
  elicitationId?: string
  mode?: 'form' | 'url'
  fields?: ElicitationField[]
  unsupportedSchema?: boolean
  url?: string
  choices?: DialogChoice[]
  nativeKind?: 'refusal_fallback_prompt' | 'fable_overage_consent_prompt' | 'mcp_elicitation_waiting'
  refusal?: {
    originalModel: string
    fallbackModel: string
    apiRefusalCategory?: string | null
    retractedMessageUuids: string[]
  }
  creditConsent?: {
    overagesEnabled: boolean
    modelName: string
    model?: string
    balanceCents?: number | null
    currency?: string | null
  }
}

export type OfficialSdkRefusalResolution = NonNullable<OfficialSdkDialog['refusal']> & {
  requestId: string
  choice: 'retry_fallback' | 'edit_prompt' | 'cancelled'
  retired: boolean
}

export function isDialogRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function safeDialogUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}

function enumChoices(schema: Record<string, unknown>, multi = false): DialogChoice[] | undefined {
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 256 && schema.enum.every(value => typeof value === 'string')) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    return schema.enum.map((value, index) => ({ value, label: typeof names[index] === 'string' ? names[index] : value }))
  }
  const variants = multi ? schema.anyOf : schema.oneOf
  if (Array.isArray(variants) && variants.length > 0 && variants.length <= 256 && variants.every(value => isDialogRecord(value) && typeof value.const === 'string')) {
    return variants.map(value => ({ value: value.const as string, label: typeof value.title === 'string' ? value.title : value.const as string }))
  }
  return undefined
}

/** MCP elicitation's flat primitive schema, including both enum formats and multi-select. */
export function parseElicitationFields(schema: unknown): ElicitationField[] | undefined {
  if (!isDialogRecord(schema) || schema.type !== 'object' || !isDialogRecord(schema.properties)) return undefined
  if (Object.keys(schema.properties).length > 64 || ['$ref', 'allOf', 'anyOf', 'oneOf', 'not'].some(key => key in schema)) return undefined
  if (schema.required !== undefined && !Array.isArray(schema.required)) return undefined
  const required = Array.isArray(schema.required) ? schema.required : []
  if (required.some(name => typeof name !== 'string' || !Object.hasOwn(schema.properties as object, name))) return undefined
  const fields: ElicitationField[] = []
  for (const [name, value] of Object.entries(schema.properties)) {
    if (!isDialogRecord(value) || !['string', 'number', 'integer', 'boolean', 'array'].includes(String(value.type)) ||
      ['$ref', 'allOf', 'not', 'pattern', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum'].some(key => key in value)) return undefined
    const type = value.type as ElicitationField['type']
    const choices = type === 'string' ? enumChoices(value) : type === 'array' && isDialogRecord(value.items) ? enumChoices(value.items, true) : undefined
    if (type === 'array' && !choices || type !== 'array' && ('enum' in value || 'oneOf' in value) && !choices || 'anyOf' in value) return undefined
    if (value.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(value.format))) return undefined
    const field: ElicitationField = { name, title: typeof value.title === 'string' ? value.title : name, type, required: required.includes(name),
      ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(choices ? { choices } : {}),
      ...(typeof value.format === 'string' ? { format: value.format } : {}) }
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
      if (value[key] !== undefined) {
        if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return undefined
        field[key] = value[key]
      }
    }
    if (value.default !== undefined && validElicitationValue(field, value.default)) field.default = value.default as ElicitationField['default']
    fields.push(field)
  }
  return fields
}

export function validElicitationValue(field: ElicitationField, value: unknown): boolean {
  if (field.type === 'boolean') return typeof value === 'boolean'
  if (field.type === 'number' || field.type === 'integer') return typeof value === 'number' && Number.isFinite(value) &&
    (field.type !== 'integer' || Number.isInteger(value)) && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum)
  if (field.type === 'array') return Array.isArray(value) && value.every(item => typeof item === 'string' && field.choices?.some(choice => choice.value === item)) &&
    new Set(value).size === value.length && value.length >= (field.minItems ?? 0) && value.length <= (field.maxItems ?? 256)
  if (typeof value !== 'string') return false
  const length = Array.from(value).length
  if (length < (field.minLength ?? 0) || length > (field.maxLength ?? 65536)) return false
  if (field.choices && !field.choices.some(choice => choice.value === value)) return false
  if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false
  if (field.format === 'uri') { try { new URL(value) } catch { return false } }
  if (field.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return false
  if (field.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) return false
  return true
}

export function validElicitationContent(fields: ElicitationField[], value: unknown): value is Record<string, string | number | boolean | string[]> {
  return isDialogRecord(value) && Object.keys(value).every(key => fields.some(field => field.name === key)) && fields.every(field =>
    Object.hasOwn(value, field.name) ? validElicitationValue(field, value[field.name]) : !field.required)
}

export function isOfficialSdkDialog(value: unknown): value is OfficialSdkDialog {
  return isDialogRecord(value) && value.sdkDialog === true && ['elicitation', 'choice'].includes(String(value.kind)) &&
    typeof value.title === 'string' && typeof value.message === 'string'
}
