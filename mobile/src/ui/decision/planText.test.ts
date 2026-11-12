import { expect, test } from 'bun:test'
import {
  planBlocks,
  planExcerpt,
  planFilePath,
  planSource,
  planSpans,
} from './planText'

const fixturePlan =
  '# Pair by scanning the desktop QR code with the camera\n\n1. Scan page: read the address and access token from the QR code\n   `src/app/connect.tsx`\n2. Validate the address; reject addresses with a path or username/password\n   `src/core/connection.ts`\n\n3. Add tests\n\n## Files to change\n\n- src/app/connect.tsx\n- src/core/client.ts\n\n```sh\nbun test\n```\nFirst line of a normal paragraph\nSecond line'

test('plans parse into title, numbered steps with continuations, sections, lists and code', () => {
  expect(planBlocks(fixturePlan)).toEqual([
    { type: 'title', text: 'Pair by scanning the desktop QR code with the camera' },
    {
      type: 'ordered',
      items: [
        { marker: '1', lines: ['Scan page: read the address and access token from the QR code', '`src/app/connect.tsx`'] },
        { marker: '2', lines: ['Validate the address; reject addresses with a path or username/password', '`src/core/connection.ts`'] },
        { marker: '3', lines: ['Add tests'] },
      ],
    },
    { type: 'heading', text: 'Files to change' },
    {
      type: 'bullets',
      items: [
        { marker: '•', lines: ['src/app/connect.tsx'] },
        { marker: '•', lines: ['src/core/client.ts'] },
      ],
    },
    { type: 'code', text: 'bun test' },
    { type: 'paragraph', text: 'First line of a normal paragraph\nSecond line' },
  ])
})

test('nested bullets stay under their step and rules are skipped', () => {
  expect(planBlocks('1. Step\n   - Sub-item\n---\nBody')).toEqual([
    { type: 'ordered', items: [{ marker: '1', lines: ['Step', '· Sub-item'] }] },
    { type: 'paragraph', text: 'Body' },
  ])
})

test('inline code, bold and bare file paths become monospace spans', () => {
  expect(planSpans('Add `schedules.test.ts` for **interaction** tests')).toEqual([
    { text: 'Add ' },
    { text: 'schedules.test.ts', code: true },
    { text: ' for ' },
    { text: 'interaction', bold: true },
    { text: ' tests' },
  ])
  expect(planSpans('Change src/app/schedule/[id].tsx and README')).toEqual([
    { text: 'Change ' },
    { text: 'src/app/schedule/[id].tsx', code: true },
    { text: ' and README' },
  ])
})

test('the compact card excerpt is the first two meaningful lines without markup', () => {
  expect(planExcerpt(fixturePlan)).toBe(
    'Pair by scanning the desktop QR code with the camera\n1. Scan page: read the address and access token from the QR code'
  )
  expect(planExcerpt('```\ncode\n```\n**Only one line**')).toBe('Only one line')
})

test('plan text and file path come only from real input fields', () => {
  expect(planSource({ plan: '  ', planContent: '# plan' })).toBe('# plan')
  expect(planSource({ plan: 3 })).toBeNull()
  expect(planFilePath({ planFilePath: '/p.md' })).toBe('/p.md')
  expect(planFilePath({ filePath: '' })).toBeUndefined()
})
