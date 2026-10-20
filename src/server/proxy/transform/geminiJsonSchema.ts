/**
 * Tool schema projection for Gemini's `parametersJsonSchema`.
 *
 * Gemini accepts standard JSON Schema there but rejects a few shapes that
 * published tool schemas commonly contain. Only those are rewritten; everything
 * else is sent unchanged. Ported from opencode's Gemini projection
 * (packages/ai/src/protocols/utils/gemini-json-schema.ts), which serves the same
 * OpenCode Go endpoint.
 */

type JsonObject = Record<string, unknown>

const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
])
// Keywords whose values are data, never schemas.
const VALUES = new Set(['const', 'default', 'enum', 'examples', 'dependentRequired'])

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mapValues(record: JsonObject, map: (value: unknown, key: string) => unknown): JsonObject {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value, key)]))
}

function normalizeNode(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeNode)
  if (!isRecord(schema)) return schema
  const properties = isRecord(schema.properties) ? schema.properties : undefined
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]) => {
    if (VALUES.has(key)) return [[key, value]]
    if (SCHEMA_MAPS.has(key) && isRecord(value)) return [[key, mapValues(value, normalizeNode)]]
    // `required` may only name declared properties.
    if (key === 'required' && properties && Array.isArray(value)) {
      return [[key, value.filter(name => typeof name === 'string' && Object.hasOwn(properties, name))]]
    }
    // Draft-04 boolean exclusive bounds become the numeric form.
    if (key === 'exclusiveMinimum' && typeof value === 'boolean') {
      return value && typeof schema.minimum === 'number' ? [[key, schema.minimum]] : []
    }
    if (key === 'exclusiveMaximum' && typeof value === 'boolean') {
      return value && typeof schema.maximum === 'number' ? [[key, schema.maximum]] : []
    }
    if (key === 'minimum' && schema.exclusiveMinimum === true) return []
    if (key === 'maximum' && schema.exclusiveMaximum === true) return []
    // Draft-07 tuples (`items` array plus `additionalItems`) are `prefixItems` plus `items` in 2020-12.
    if (key === 'items' && Array.isArray(value)) return [['prefixItems', value.map(normalizeNode)]]
    if (key === 'additionalItems' && Array.isArray(schema.items)) return [['items', normalizeNode(value)]]
    return [[key, normalizeNode(value)]]
  }))
}

// Gemini accepts a recursive `$ref` only when the loop passes through an optional
// property or potentially empty array `items`. Other self-references become an
// unconstrained schema.
function cutLoops(schema: unknown, target: string, safe: boolean): unknown {
  if (Array.isArray(schema)) return schema.map(item => cutLoops(item, target, safe))
  if (!isRecord(schema)) return schema
  if (schema.$ref === target && !safe) return {}
  const required = Array.isArray(schema.required) ? schema.required : []
  return mapValues(schema, (value, key) => {
    if (VALUES.has(key)) return value
    if (key === 'items') return cutLoops(value, target, safe || !(Number(schema.minItems) > 0))
    if (key === 'properties' && isRecord(value)) {
      return mapValues(value, (child, name) => cutLoops(child, target, safe || !required.includes(name)))
    }
    if (SCHEMA_MAPS.has(key) && isRecord(value)) return mapValues(value, child => cutLoops(child, target, safe))
    return cutLoops(value, target, safe)
  })
}

/** Project an Anthropic tool `input_schema` onto what Gemini accepts. */
export function toGeminiParametersSchema(schema: unknown): JsonObject {
  const normalized = normalizeNode(isRecord(schema) ? schema : {})
  if (!isRecord(normalized)) return { type: 'object' }
  // The draft marker is metadata for validators, not part of the tool contract.
  const { $schema: _draft, ...rest } = normalized
  const result = cutLoops(
    mapValues(rest, (value, key) =>
      (key === '$defs' || key === 'definitions') && isRecord(value)
        ? mapValues(value, (definition, name) => cutLoops(definition, `#/${key}/${name}`, false))
        : value),
    '#',
    false,
  )
  if (!isRecord(result)) return { type: 'object' }
  // Tool arguments are always an object; a root without a type is read as one.
  return result.type === undefined ? { type: 'object', ...result } : result
}
