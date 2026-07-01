import { describe, expect, it } from 'vitest'
import { extractFakeToolUseBlocks } from './fakeToolUseDetection'

describe('extractFakeToolUseBlocks', () => {
  it('returns input unchanged when no <tool_use> sequence is present', () => {
    const text = 'Hello world. Just some markdown with `code`.'
    const out = extractFakeToolUseBlocks(text)
    expect(out.cleanText).toBe(text)
    expect(out.blocks).toEqual([])
  })

  it('extracts a complete closed block and strips it from the text', () => {
    const input = [
      'Sure, let me check.',
      '<tool_use id="tooluse_NS9MjB3a1XuhVvgU52uHpE" name="Bash">',
      '{"command":"ls -la /tmp","description":"list tmp"}',
      '</tool_use>',
      'Done.',
    ].join('\n')

    const out = extractFakeToolUseBlocks(input)

    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]).toMatchObject({
      name: 'Bash',
      id: 'tooluse_NS9MjB3a1XuhVvgU52uHpE',
      unterminated: false,
    })
    expect(out.blocks[0]!.inner).toContain('ls -la /tmp')
    // Block sat between two paragraphs — removing it should leave a single
    // paragraph break, not a hard line join. (squashWhitespace caps at \n\n.)
    expect(out.cleanText).toBe(['Sure, let me check.', '', 'Done.'].join('\n'))
  })

  it('handles a half-open block at end of streaming chunk', () => {
    const input = 'Working on it.\n<tool_use id="tooluse_abc" name="Bash">\n{"command":"echo hi"'
    const out = extractFakeToolUseBlocks(input)

    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]).toMatchObject({
      name: 'Bash',
      id: 'tooluse_abc',
      unterminated: true,
    })
    // Half-open block is stripped to end of input — no dangling tag.
    expect(out.cleanText).toBe('Working on it.')
    expect(out.cleanText).not.toContain('<tool_use')
  })

  it('extracts multiple consecutive blocks (model retries after self-correcting)', () => {
    const input = [
      'First try:',
      '<tool_use id="t1" name="Bash">{"command":"ls"}</tool_use>',
      'Apologies, retrying:',
      '<tool_use id="t2" name="Bash">{"command":"ls -la"}</tool_use>',
      'Done.',
    ].join('\n')

    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toHaveLength(2)
    expect(out.blocks.map((b) => b.id)).toEqual(['t1', 't2'])
    expect(out.cleanText).not.toContain('<tool_use')
    expect(out.cleanText).toContain('First try:')
    expect(out.cleanText).toContain('Apologies, retrying:')
    expect(out.cleanText).toContain('Done.')
  })

  it('tolerates attribute order swap (name before id) and unquoted values', () => {
    const input = '<tool_use name=Bash id=tooluse_xyz>cmd</tool_use>'
    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]).toMatchObject({ name: 'Bash', id: 'tooluse_xyz' })
  })

  it('handles single-quoted attribute values', () => {
    const input = "<tool_use name='Bash' id='abc'>cmd</tool_use>"
    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks[0]).toMatchObject({ name: 'Bash', id: 'abc' })
  })

  it('handles a self-closing tag (rare but seen)', () => {
    const input = 'Before. <tool_use name="Bash" id="abc" /> After.'
    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]).toMatchObject({
      name: 'Bash',
      id: 'abc',
      inner: '',
      unterminated: false,
    })
    expect(out.cleanText).toMatch(/Before\.\s+After\./)
  })

  it('falls back to "unknown" when name attribute is missing', () => {
    const input = '<tool_use id="abc">cmd</tool_use>'
    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks[0]?.name).toBe('unknown')
  })

  it('does NOT strip <tool_use> sequences inside fenced code blocks', () => {
    const input = [
      'For example, this provider emits:',
      '```xml',
      '<tool_use name="Bash" id="t1">{"command":"ls"}</tool_use>',
      '```',
      'Then it gets stuck.',
    ].join('\n')

    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toEqual([])
    expect(out.cleanText).toBe(input)
  })

  it('does NOT strip <tool_use> sequences inside an open-ended code fence (still typing example)', () => {
    const input = [
      'Like this:',
      '```',
      '<tool_use name="Bash" id="t1">{"command":"ls"}</tool_use>',
    ].join('\n')

    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toEqual([])
    expect(out.cleanText).toBe(input)
  })

  it('preserves the JSON-with-quoted-strings inner text', () => {
    const input =
      '<tool_use id="t1" name="Bash">{"command":"echo \\"hello world\\"","description":"echo"}</tool_use>'
    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]!.inner).toContain('echo \\"hello world\\"')
  })

  it('squashes leftover blank-line gaps after extraction', () => {
    const input = [
      'Line 1',
      '',
      '<tool_use id="t1" name="Bash">cmd</tool_use>',
      '',
      '',
      'Line 2',
    ].join('\n')

    const out = extractFakeToolUseBlocks(input)
    expect(out.cleanText).toBe('Line 1\n\nLine 2')
  })

  it('does not interpret malformed strings without a real opener', () => {
    const input = 'I just want to mention <tool_user> which is a different element.'
    const out = extractFakeToolUseBlocks(input)
    expect(out.blocks).toEqual([])
    expect(out.cleanText).toBe(input)
  })

  it('is idempotent — extracting from already-clean output is a no-op', () => {
    const input = '<tool_use id="t1" name="Bash">cmd</tool_use>Result.'
    const first = extractFakeToolUseBlocks(input)
    const second = extractFakeToolUseBlocks(first.cleanText)
    expect(second.blocks).toEqual([])
    expect(second.cleanText).toBe(first.cleanText)
  })
})
