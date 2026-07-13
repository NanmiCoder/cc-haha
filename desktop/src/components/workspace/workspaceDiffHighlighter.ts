import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from 'shiki'
import type { WorkspaceDiffFile, WorkspaceDiffRow } from './workspaceDiffModel'

export const WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH = 1_000
const WORKSPACE_DIFF_WORD_MAX_SEGMENTS = 240
const WORKSPACE_DIFF_WORD_MIN_SIMILARITY = 0.6

export interface WorkspaceDiffHighlightToken {
  content: string
  color?: string
  fontStyle?: number
}

export interface WorkspaceDiffWordRange {
  start: number
  end: number
}

export interface WorkspaceDiffHighlightResult {
  engine: 'shiki' | 'plain'
  tokensByRowId: Record<string, WorkspaceDiffHighlightToken[]>
  wordRangesByRowId: Record<string, WorkspaceDiffWordRange[]>
}

interface WordSegment extends WorkspaceDiffWordRange {
  text: string
}

const workspaceDiffShikiTheme: ThemeRegistration = {
  name: 'codex-workspace-diff',
  type: 'dark',
  fg: 'var(--color-diff-syntax-foreground)',
  bg: 'transparent',
  settings: [
    {
      settings: {
        foreground: 'var(--color-diff-syntax-foreground)',
        background: 'transparent',
      },
    },
    {
      scope: [
        'comment',
        'punctuation.definition.comment',
        'string.quoted.docstring',
      ],
      settings: { foreground: 'var(--color-diff-syntax-comment)' },
    },
    {
      scope: [
        'string',
        'string.quoted',
        'string.template',
        'string.other.link',
        'markup.inline.raw.string.markdown',
      ],
      settings: { foreground: 'var(--color-diff-syntax-string)' },
    },
    {
      scope: ['string.regexp', 'constant.other.character-class.regexp'],
      settings: { foreground: 'var(--color-diff-syntax-regexp)' },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language.boolean',
        'constant.language.null',
        'constant.language.undefined',
      ],
      settings: { foreground: 'var(--color-diff-syntax-number)' },
    },
    {
      scope: [
        'constant',
        'punctuation.definition.constant',
        'variable.other.constant',
      ],
      settings: { foreground: 'var(--color-diff-syntax-variable)' },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.operator.new',
        'keyword.operator.expression.instanceof',
        'keyword.operator.expression.typeof',
        'keyword.operator.expression.void',
        'keyword.operator.expression.delete',
        'keyword.operator.expression.in',
        'keyword.operator.expression.of',
        'keyword.operator.expression.keyof',
      ],
      settings: { foreground: 'var(--color-diff-syntax-keyword)' },
    },
    {
      scope: [
        'entity.name.function',
        'meta.function-call',
        'meta.require',
        'support.function',
        'support.function.any-method',
        'variable.function',
      ],
      settings: { foreground: 'var(--color-diff-syntax-function)' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.type.alias',
        'entity.name.class',
        'entity.other.inherited-class',
        'support.class',
        'support.type',
        'support.type.primitive',
        'support.type.primitive.ts',
        'support.type.builtin.ts',
        'support.type.primitive.tsx',
        'support.type.builtin.tsx',
      ],
      settings: { foreground: 'var(--color-diff-syntax-type)' },
    },
    {
      scope: [
        'variable.parameter',
        'meta.parameters variable.other.readwrite',
        'meta.parameter variable.other.readwrite',
      ],
      settings: { foreground: 'var(--color-diff-syntax-parameter)' },
    },
    {
      scope: [
        'variable.other.property',
        'variable.other.object.property',
        'support.type.property-name',
        'meta.object-literal.key',
        'support.variable.property',
      ],
      settings: { foreground: 'var(--color-diff-syntax-property)' },
    },
    {
      scope: [
        'variable',
        'variable.other',
        'variable.other.readwrite',
        'variable.other.constant',
        'variable.other.enummember',
        'identifier',
        'meta.definition.variable',
        'entity.name.namespace',
      ],
      settings: { foreground: 'var(--color-diff-syntax-variable)' },
    },
    {
      scope: ['keyword.operator'],
      settings: { foreground: 'var(--color-diff-syntax-punctuation)' },
    },
    {
      scope: [
        'keyword.operator.logical',
        'keyword.operator.bitwise',
        'keyword.operator.channel',
        'keyword.operator.arithmetic',
        'keyword.operator.comparison',
        'keyword.operator.relational',
        'keyword.operator.increment',
        'keyword.operator.decrement',
        'keyword.operator.assignment',
      ],
      settings: { foreground: 'var(--color-diff-syntax-number)' },
    },
    {
      scope: ['keyword.operator.assignment.compound'],
      settings: { foreground: 'var(--color-diff-syntax-keyword)' },
    },
    {
      scope: [
        'keyword.operator.assignment.compound.js',
        'keyword.operator.assignment.compound.ts',
      ],
      settings: { foreground: 'var(--color-diff-syntax-number)' },
    },
    {
      scope: ['keyword.operator.ternary', 'keyword.operator.optional'],
      settings: { foreground: 'var(--color-diff-syntax-keyword)' },
    },
    {
      scope: [
        'punctuation',
        'punctuation.definition',
        'punctuation.separator',
        'meta.brace',
        'meta.bracket',
      ],
      settings: { foreground: 'var(--color-diff-syntax-punctuation)' },
    },
    { scope: ['entity.name.tag'], settings: { foreground: 'var(--color-diff-syntax-keyword)' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: 'var(--color-diff-syntax-number)' } },
    {
      scope: ['source.json meta.structure.dictionary.json > string.quoted.json', 'support.type.property-name.json'],
      settings: { foreground: 'var(--color-diff-syntax-keyword)' },
    },
    {
      scope: ['support.type.property-name.css', 'support.type.vendored.property-name.css'],
      settings: { foreground: 'var(--color-diff-syntax-number)' },
    },
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: {
        foreground: 'var(--color-diff-syntax-function)',
        fontStyle: 'bold',
      },
    },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  ],
}

const workspaceDiffLanguageLoaders: Record<string, () => Promise<LanguageRegistration[]>> = {
  bash: () => import('@shikijs/langs/bash').then((module) => module.default),
  c: () => import('@shikijs/langs/c').then((module) => module.default),
  cpp: () => import('@shikijs/langs/cpp').then((module) => module.default),
  csharp: () => import('@shikijs/langs/csharp').then((module) => module.default),
  css: () => import('@shikijs/langs/css').then((module) => module.default),
  dockerfile: () => import('@shikijs/langs/dockerfile').then((module) => module.default),
  go: () => import('@shikijs/langs/go').then((module) => module.default),
  graphql: () => import('@shikijs/langs/graphql').then((module) => module.default),
  html: () => import('@shikijs/langs/html').then((module) => module.default),
  java: () => import('@shikijs/langs/java').then((module) => module.default),
  javascript: () => import('@shikijs/langs/javascript').then((module) => module.default),
  json: () => import('@shikijs/langs/json').then((module) => module.default),
  jsonc: () => import('@shikijs/langs/jsonc').then((module) => module.default),
  jsx: () => import('@shikijs/langs/jsx').then((module) => module.default),
  kotlin: () => import('@shikijs/langs/kotlin').then((module) => module.default),
  less: () => import('@shikijs/langs/less').then((module) => module.default),
  lua: () => import('@shikijs/langs/lua').then((module) => module.default),
  makefile: () => import('@shikijs/langs/makefile').then((module) => module.default),
  markdown: () => import('@shikijs/langs/markdown').then((module) => module.default),
  php: () => import('@shikijs/langs/php').then((module) => module.default),
  prisma: () => import('@shikijs/langs/prisma').then((module) => module.default),
  python: () => import('@shikijs/langs/python').then((module) => module.default),
  ruby: () => import('@shikijs/langs/ruby').then((module) => module.default),
  rust: () => import('@shikijs/langs/rust').then((module) => module.default),
  sass: () => import('@shikijs/langs/sass').then((module) => module.default),
  scss: () => import('@shikijs/langs/scss').then((module) => module.default),
  sql: () => import('@shikijs/langs/sql').then((module) => module.default),
  svelte: () => import('@shikijs/langs/svelte').then((module) => module.default),
  swift: () => import('@shikijs/langs/swift').then((module) => module.default),
  toml: () => import('@shikijs/langs/toml').then((module) => module.default),
  tsx: () => import('@shikijs/langs/tsx').then((module) => module.default),
  typescript: () => import('@shikijs/langs/typescript').then((module) => module.default),
  vue: () => import('@shikijs/langs/vue').then((module) => module.default),
  xml: () => import('@shikijs/langs/xml').then((module) => module.default),
  yaml: () => import('@shikijs/langs/yaml').then((module) => module.default),
}

const shikiLanguageAliases: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  dockerfile: 'dockerfile',
  go: 'go',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
  kotlin: 'kotlin',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  prisma: 'prisma',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  rs: 'rust',
  rust: 'rust',
  sass: 'sass',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

let workspaceDiffHighlighterPromise: Promise<HighlighterCore> | null = null
const workspaceDiffLanguagePromises = new Map<string, Promise<void>>()

function getWorkspaceDiffHighlighter() {
  workspaceDiffHighlighterPromise ??= createHighlighterCore({
    themes: [workspaceDiffShikiTheme],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })
  return workspaceDiffHighlighterPromise
}

async function ensureWorkspaceDiffLanguage(highlighter: HighlighterCore, language: string) {
  if (language === 'text' || highlighter.getLoadedLanguages().includes(language)) return
  const loader = workspaceDiffLanguageLoaders[language]
  if (!loader) return

  let loading = workspaceDiffLanguagePromises.get(language)
  if (!loading) {
    loading = loader().then(async (registrations) => {
      await highlighter.loadLanguage(...registrations)
    })
    workspaceDiffLanguagePromises.set(language, loading)
  }
  await loading
}

function basename(path: string) {
  return path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
}

export function getWorkspaceDiffShikiLanguage(path: string) {
  const name = basename(path)
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore') return 'text'
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  return shikiLanguageAliases[extension] ?? 'text'
}

function tokenizeWords(value: string): WordSegment[] {
  const segments: WordSegment[] = []
  const pattern = /\s+|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]+/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    segments.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return segments
}

function mergeRanges(value: string, ranges: WorkspaceDiffWordRange[]) {
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  const merged: WorkspaceDiffWordRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && /^\s*$/.test(value.slice(previous.end, range.start))) {
      previous.end = range.end
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function diffWordRanges(oldValue: string, newValue: string) {
  if (
    oldValue.length > WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH
    || newValue.length > WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH
  ) return null

  const oldSegments = tokenizeWords(oldValue)
  const newSegments = tokenizeWords(newValue)
  if (
    oldSegments.length > WORKSPACE_DIFF_WORD_MAX_SEGMENTS
    || newSegments.length > WORKSPACE_DIFF_WORD_MAX_SEGMENTS
  ) return null

  const matrix = Array.from(
    { length: oldSegments.length + 1 },
    () => new Uint16Array(newSegments.length + 1),
  )
  for (let oldIndex = oldSegments.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newSegments.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex]![newIndex] = oldSegments[oldIndex]!.text === newSegments[newIndex]!.text
        ? matrix[oldIndex + 1]![newIndex + 1]! + 1
        : Math.max(matrix[oldIndex + 1]![newIndex]!, matrix[oldIndex]![newIndex + 1]!)
    }
  }

  const matchedOld = new Set<number>()
  const matchedNew = new Set<number>()
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldSegments.length && newIndex < newSegments.length) {
    if (oldSegments[oldIndex]!.text === newSegments[newIndex]!.text) {
      matchedOld.add(oldIndex)
      matchedNew.add(newIndex)
      oldIndex += 1
      newIndex += 1
    } else if (matrix[oldIndex + 1]![newIndex]! >= matrix[oldIndex]![newIndex + 1]!) {
      oldIndex += 1
    } else {
      newIndex += 1
    }
  }

  const oldMeaningfulCount = oldSegments.filter((segment) => !/^\s+$/.test(segment.text)).length
  const newMeaningfulCount = newSegments.filter((segment) => !/^\s+$/.test(segment.text)).length
  const matchedMeaningfulCount = [...matchedOld]
    .filter((index) => !/^\s+$/.test(oldSegments[index]!.text))
    .length
  const similarity = oldMeaningfulCount + newMeaningfulCount === 0
    ? 1
    : (2 * matchedMeaningfulCount) / (oldMeaningfulCount + newMeaningfulCount)
  if (similarity < WORKSPACE_DIFF_WORD_MIN_SIMILARITY) return null

  const toRanges = (value: string, segments: WordSegment[], matched: Set<number>) => mergeRanges(
    value,
    segments.flatMap((segment, index) => (
      matched.has(index) || /^\s+$/.test(segment.text)
        ? []
        : [{ start: segment.start, end: segment.end }]
    )),
  )

  return {
    oldRanges: toRanges(oldValue, oldSegments, matchedOld),
    newRanges: toRanges(newValue, newSegments, matchedNew),
  }
}

function flushChangeGroup(
  deletions: WorkspaceDiffRow[],
  additions: WorkspaceDiffRow[],
  rangesByRowId: Record<string, WorkspaceDiffWordRange[]>,
) {
  if (deletions.length !== additions.length) {
    deletions.length = 0
    additions.length = 0
    return
  }
  const pairCount = Math.min(deletions.length, additions.length)
  for (let index = 0; index < pairCount; index += 1) {
    const deletion = deletions[index]!
    const addition = additions[index]!
    const ranges = diffWordRanges(deletion.text, addition.text)
    if (!ranges) continue
    if (ranges.oldRanges.length > 0) rangesByRowId[deletion.id] = ranges.oldRanges
    if (ranges.newRanges.length > 0) rangesByRowId[addition.id] = ranges.newRanges
  }
  deletions.length = 0
  additions.length = 0
}

export function buildWorkspaceDiffWordRanges(files: WorkspaceDiffFile[]) {
  const rangesByRowId: Record<string, WorkspaceDiffWordRange[]> = {}
  for (const file of files) {
    const deletions: WorkspaceDiffRow[] = []
    const additions: WorkspaceDiffRow[] = []
    let activeHunkId: string | null = null

    for (const row of file.rows) {
      const isChange = row.kind === 'deletion' || row.kind === 'addition'
      if (!isChange || row.hunkId !== activeHunkId) {
        flushChangeGroup(deletions, additions, rangesByRowId)
        activeHunkId = isChange ? row.hunkId : null
      }
      if (row.kind === 'deletion') deletions.push(row)
      else if (row.kind === 'addition') additions.push(row)
    }
    flushChangeGroup(deletions, additions, rangesByRowId)
  }
  return rangesByRowId
}

function getHighlightDocuments(file: WorkspaceDiffFile) {
  const documents: Array<{ rows: WorkspaceDiffRow[]; path: string }> = []
  const hunkIds = [...new Set(file.rows.flatMap((row) => row.hunkId ? [row.hunkId] : []))]
  const path = file.newPath ?? file.oldPath ?? ''
  for (const hunkId of hunkIds) {
    const hunkRows = file.rows.filter((row) => row.hunkId === hunkId && row.selectable)
    const oldRows = hunkRows.filter((row) => row.kind === 'context' || row.kind === 'deletion')
    const newRows = hunkRows.filter((row) => row.kind === 'context' || row.kind === 'addition')
    if (oldRows.length > 0) documents.push({ rows: oldRows, path: file.oldPath ?? path })
    if (newRows.length > 0) documents.push({ rows: newRows, path: file.newPath ?? path })
  }
  return documents
}

export async function highlightWorkspaceDiff({
  files,
  path,
}: {
  files: WorkspaceDiffFile[]
  path: string
}): Promise<WorkspaceDiffHighlightResult> {
  const tokensByRowId: Record<string, WorkspaceDiffHighlightToken[]> = {}
  const wordRangesByRowId = buildWorkspaceDiffWordRanges(files)

  try {
    const highlighter = await getWorkspaceDiffHighlighter()
    for (const file of files) {
      for (const document of getHighlightDocuments(file)) {
        const language = getWorkspaceDiffShikiLanguage(document.path || path)
        await ensureWorkspaceDiffLanguage(highlighter, language)
        const result = highlighter.codeToTokens(document.rows.map((row) => row.text).join('\n'), {
          lang: workspaceDiffLanguageLoaders[language] ? language : 'text',
          theme: workspaceDiffShikiTheme,
          tokenizeMaxLineLength: WORKSPACE_DIFF_TOKENIZE_MAX_LINE_LENGTH,
        })
        document.rows.forEach((row, index) => {
          tokensByRowId[row.id] = (result.tokens[index] ?? []).map((token) => ({
            content: token.content,
            color: token.color,
            fontStyle: token.fontStyle,
          }))
        })
      }
    }
    return { engine: 'shiki', tokensByRowId, wordRangesByRowId }
  } catch {
    return { engine: 'plain', tokensByRowId: {}, wordRangesByRowId }
  }
}
