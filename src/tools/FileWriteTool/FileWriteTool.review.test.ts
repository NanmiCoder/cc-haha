import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { normalizeToolInput } from '../../utils/api.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { FileWriteTool } from './FileWriteTool.js'

test('Write aliases preserve actual provider schema and normalization of markdown/non-markdown', () => {
  const schema = zodToJsonSchema(FileWriteTool.inputSchema)
  expect(schema.properties).toHaveProperty('file_path')
  expect(schema.properties).toHaveProperty('content')
  expect(schema.properties).not.toHaveProperty('path')
  expect(schema.additionalProperties).toBe(false)
  for (const extension of ['md', 'txt']) {
    const path = `/tmp/review-file.${extension}`
    const content = 'line  \nnext\n'
    const canonical = normalizeToolInput(FileWriteTool, { file_path: path, content })
    const alias = normalizeToolInput(FileWriteTool, { path, file_text: content } as never)
    expect(alias).toEqual(canonical)
    if (extension === 'md') expect(alias.content).toBe(content)
  }
})

test('Write aliases normalize before hook path expansion without modifying raw input', () => {
  const raw = { path: './relative-review-fixture', file_text: 'test' }
  const parsed = FileWriteTool.inputSchema.parse(raw)
  const observable = { ...parsed }
  FileWriteTool.backfillObservableInput!(observable)
  expect(observable.file_path).toBe(resolve(raw.path))
  expect(parsed.file_path).toBe(raw.path)
  expect(FileWriteTool.toAutoClassifierInput!(observable)).toBe(`${observable.file_path}: test`)
  expect(raw).toEqual({ path: './relative-review-fixture', file_text: 'test' })
})
