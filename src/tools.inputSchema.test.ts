import { expect, test } from 'bun:test'
import { getAllBaseTools } from './tools.js'
import { zodToJsonSchema } from './utils/zodToJsonSchema.js'

// Providers reject a tool whose top-level input_schema is not `type: "object"`
// (e.g. a bare discriminated-union `oneOf`), failing every request with a 400.
test('every built-in tool sends a top-level object input schema', () => {
  const offenders = getAllBaseTools()
    .filter(tool => {
      const schema = (tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema)) as { type?: unknown }
      return schema.type !== 'object'
    })
    .map(tool => tool.name)
  expect(offenders).toEqual([])
})
