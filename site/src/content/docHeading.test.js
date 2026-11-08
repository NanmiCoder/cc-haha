import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Lexer, Parser } from 'marked'
import { getDocHeading } from './docHeading.js'

function heading(markdown) {
  const [{ tokens }] = Lexer.lex(markdown)
  return getDocHeading(tokens, Parser.parseInline(tokens))
}

test('formatted guide headings keep their readable label and existing share link', () => {
  assert.deepEqual(heading('### The `.agents/skills` convention'), {
    text: 'The .agents/skills convention',
    baseSlug: 'theagentsskillsconvention'
  })
})

test('heading labels follow nested markup and keep punctuation in inline code', () => {
  assert.equal(
    heading('## Choose [**this *and* that**](./start) (`foo_bar`).').text,
    'Choose this and that (foo_bar).'
  )
})
