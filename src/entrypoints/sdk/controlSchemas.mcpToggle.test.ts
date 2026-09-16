import { expect, test } from 'bun:test'
import { SDKControlRequestSchema } from './controlSchemas.js'

test.each([undefined, true, false])('preserves MCP toggle persistence ownership: %s', alreadyPersisted => {
  const request = {
    type: 'control_request',
    request_id: 'toggle',
    request: {
      subtype: 'mcp_toggle',
      serverName: 'local-fixture',
      enabled: false,
      ...(alreadyPersisted === undefined ? {} : { alreadyPersisted }),
    },
  }
  expect(SDKControlRequestSchema().parse(request)).toEqual(request)
})
