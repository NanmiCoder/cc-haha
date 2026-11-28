import { expect, test } from 'bun:test'
import { SDKControlRequestSchema } from './controlSchemas.js'

test.each([undefined, true, false])('preserves the context summary request mode', summaryOnly => {
  const request = {
    type: 'control_request', request_id: 'context-summary',
    request: {
      subtype: 'get_context_usage', estimateOnly: true,
      ...(summaryOnly === undefined ? {} : { summaryOnly }),
    },
  }
  expect(SDKControlRequestSchema().parse(request)).toEqual(request)
})
