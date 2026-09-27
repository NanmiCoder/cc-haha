import { expect, it } from 'vitest'
import { splitSessionReferenceContext } from './sessionReferences'

it('restores a server envelope without showing it in the prompt bubble', () => {
  const input = 'Use @Review\n\n<session_references>\nRead the referenced history.\n[{"sessionId":"past"}]\n</session_references>'
  expect(splitSessionReferenceContext(input)).toEqual({ content: 'Use @Review', sessionReferences: [{ sessionId: 'past' }] })
})
it.each(['literal <session_references>', 'hello\n\n<session_references>\nexplanation\nnot json\n</session_references>', 'hello\n\n<session_references>\nexplanation\n[]\n</session_references>'])('preserves old or malformed history: %s', input => {
  expect(splitSessionReferenceContext(input)).toEqual({ content: input, sessionReferences: [] })
})
