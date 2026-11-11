import { expect, test } from 'bun:test'
import { hasCapabilitySentence, parseUserMessageSegments } from './userMessageCapabilities'

test('shared native and desktop reader preserves escaped skill identities and surrounding text', () => {
  const id = 'owner:skill-"quoted"'
  const modelText = `Use the Skill tool with skill: ${JSON.stringify(id)} for this request.`
  expect(parseUserMessageSegments(`before ${modelText} after`)).toEqual([
    { type: 'text', text: 'before ' },
    { type: 'skill', id, label: 'skill-"quoted"', modelText },
    { type: 'text', text: ' after' },
  ])
  expect(parseUserMessageSegments('ordinary @skill and /folder/file')).toEqual([{ type: 'text', text: 'ordinary @skill and /folder/file' }])
})
test('repeated transcript renders do not retain global regular-expression cursors', () => {
  const sentence = 'Use the Skill tool with skill: "review" for this request.'
  for (let index = 0; index < 3; index++) {
    expect(hasCapabilitySentence(sentence)).toBe(true)
    expect(parseUserMessageSegments(sentence)).toEqual([{ type: 'skill', id: 'review', label: 'review', modelText: sentence }])
    expect(hasCapabilitySentence('not a capability')).toBe(false)
  }
})
