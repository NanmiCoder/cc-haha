import { describe, expect, it } from 'vitest'
import {
  AMBIGUOUS_STANDALONE_EXTENSIONS,
  LINKABLE_FILE_EXTENSIONS,
  isFilePathOnly,
  isLinkableFilePath,
  matchFilePath,
  matchGitHubRef,
  parseFilePathRef,
  splitTextByFilePaths,
} from './filePathBoundary'

type Case = {
  input: string
  path: string | null
  line?: number
  column?: number
  why: string
}

const BOUNDARY_CASES: Case[] = [
  // ─── the shape our own system prompt asks the model for ────────────────────
  { input: 'desktop/src/lib/foo.ts', path: 'desktop/src/lib/foo.ts', why: 'relative path' },
  { input: 'desktop/src/lib/foo.ts:42', path: 'desktop/src/lib/foo.ts', line: 42, why: 'file_path:line_number — the prompt contract' },
  { input: 'desktop/src/lib/foo.ts:42:8', path: 'desktop/src/lib/foo.ts', line: 42, column: 8, why: 'line:column' },
  { input: 'src/foo.ts#L42', path: 'src/foo.ts', line: 42, why: 'GitHub anchor form' },
  { input: 'src/foo.ts#L42-L60', path: 'src/foo.ts', line: 42, why: 'GitHub range starts at the first line' },
  { input: 'src/foo.ts:L42', path: 'src/foo.ts', line: 42, why: ':L form from tool output' },

  // ─── prefixes ──────────────────────────────────────────────────────────────
  { input: './scripts/build.sh', path: './scripts/build.sh', why: 'dot-slash relative' },
  { input: '../shared/util.ts', path: '../shared/util.ts', why: 'parent relative' },
  { input: '/Users/me/project/main.rs', path: '/Users/me/project/main.rs', why: 'POSIX absolute' },
  { input: '~/notes/todo.md', path: '~/notes/todo.md', why: 'home relative' },
  { input: 'C:\\Users\\me\\app.ts', path: 'C:\\Users\\me\\app.ts', why: 'Windows drive path — #1146 was filed from Windows 11' },
  { input: 'C:\\Users\\me\\app.ts:42', path: 'C:\\Users\\me\\app.ts', line: 42, why: 'drive path + line, the colon must not confuse the suffix' },
  { input: 'desktop\\src\\foo.ts', path: 'desktop\\src\\foo.ts', why: 'backslash separators' },

  // ─── bare filenames ────────────────────────────────────────────────────────
  { input: 'package.json', path: 'package.json', why: 'bare filename with an unambiguous extension' },
  { input: 'README.md', path: 'README.md', why: 'bare doc' },
  { input: 'Dockerfile', path: 'Dockerfile', why: 'extension-less but unambiguous' },
  { input: '.gitignore', path: '.gitignore', why: 'dotfile' },
  { input: '.env.local', path: '.env.local', why: 'dotfile variant' },

  // ─── the property-access traps ─────────────────────────────────────────────
  { input: 'console.log', path: null, why: 'the single most common false positive' },
  { input: 'process.env', path: null, why: '.env is a file, process.env is not' },
  { input: 'array.map', path: null, why: 'method call' },
  { input: 'regex.test', path: null, why: 'method call' },
  { input: 'String.raw', path: null, why: 'method call' },
  { input: 'logger.conf', path: null, why: 'ambiguous standalone extension' },
  { input: 'src/logger.conf', path: 'src/logger.conf', why: 'a slash proves it is a path' },
  { input: 'src/app.log', path: 'src/app.log', why: 'same for .log' },
  { input: 'a.c', path: null, why: 'single-letter extension needs path shape' },
  { input: 'src/a.c', path: 'src/a.c', why: 'single-letter extension with a slash' },

  // ─── other non-paths ───────────────────────────────────────────────────────
  { input: 'example.com', path: null, why: 'TLD is not an extension' },
  { input: 'cchaha.ai', path: null, why: 'TLD is not an extension' },
  { input: 'v0.5.0', path: null, why: 'version number' },
  { input: '1.2.3', path: null, why: 'version number' },
  { input: '@types/node', path: null, why: 'package name, no extension' },
  { input: 'lodash/fp', path: null, why: 'subpath import, no extension' },
  { input: '12:30', path: null, why: 'a time' },

  // ─── sentence boundaries (the #1145 lesson, mirrored) ──────────────────────
  { input: 'lib/foo.ts。', path: 'lib/foo.ts', why: 'full-width period is not a path character' },
  { input: 'lib/foo.ts，然后重启', path: 'lib/foo.ts', why: 'full-width comma ends the path' },
  { input: 'lib/foo.ts:42，重启', path: 'lib/foo.ts', line: 42, why: 'line number then full-width comma' },
  { input: 'lib/foo.ts.', path: 'lib/foo.ts', why: 'ASCII period trimmed without eating .ts' },
  { input: 'lib/foo.ts)', path: 'lib/foo.ts', why: 'closing paren trimmed' },
  { input: 'lib/foo.ts:42:', path: 'lib/foo.ts', line: 42, why: 'trailing colon trimmed' },
  { input: 'lib/foo.ts 和 lib/bar.ts', path: 'lib/foo.ts', why: 'space ends the path (matcher is anchored)' },
  { input: '见 lib/foo.ts', path: null, why: 'matcher is anchored at index 0' },
]

describe('matchFilePath', () => {
  for (const { input, path, line, column, why } of BOUNDARY_CASES) {
    it(`${path === null ? 'rejects' : 'reads'} ${JSON.stringify(input)} (${why})`, () => {
      const ref = matchFilePath(input)
      if (path === null) {
        expect(ref).toBeNull()
        return
      }
      expect(ref?.path).toBe(path)
      expect(ref?.line).toBe(line)
      expect(ref?.column).toBe(column)
    })
  }

  it('keeps the line suffix in raw so "copy path" reproduces what the prose said', () => {
    expect(matchFilePath('desktop/src/foo.ts:42')?.raw).toBe('desktop/src/foo.ts:42')
  })
})

describe('splitTextByFilePaths', () => {
  it('finds a path flush against Chinese prose', () => {
    // The reason CJK is not a segment character: this must match from `lib`,
    // not from `修`.
    expect(splitTextByFilePaths('修改了lib/foo.ts:42')).toEqual([
      { type: 'text', value: '修改了' },
      { type: 'path', value: 'lib/foo.ts:42', ref: { raw: 'lib/foo.ts:42', path: 'lib/foo.ts', line: 42 } },
    ])
  })

  it('finds every path in a sentence', () => {
    const segments = splitTextByFilePaths('先看 a/b.ts:10，再看 c/d.py')
    expect(segments.filter((s) => s.type === 'path').map((s) => s.value)).toEqual(['a/b.ts:10', 'c/d.py'])
  })

  it('never starts a path mid-token', () => {
    // A URL that autolinking left as plain text must not donate its tail.
    expect(splitTextByFilePaths('ftp://x.com/a/b.ts').some((s) => s.type === 'path')).toBe(false)
  })

  it('leaves prose without paths untouched', () => {
    expect(splitTextByFilePaths('调用 console.log 打印结果')).toEqual([
      { type: 'text', value: '调用 console.log 打印结果' },
    ])
  })

  it('preserves the original text exactly', () => {
    const text = '改了 a/b.ts:1 和 .env.local，见 README.md。'
    expect(splitTextByFilePaths(text).map((s) => s.value).join('')).toBe(text)
  })
})

describe('matchGitHubRef', () => {
  it('reads the owner/repo#123 form the prompt asks for', () => {
    // src/constants/prompts.ts:438 — "so they render as clickable links".
    expect(matchGitHubRef('NanmiCoder/cc-haha#1146')).toMatchObject({
      owner: 'NanmiCoder',
      repo: 'cc-haha',
      number: 1146,
      url: 'https://github.com/NanmiCoder/cc-haha/issues/1146',
    })
  })

  it('does not steal a file reference that happens to have an anchor', () => {
    expect(matchGitHubRef('src/app.ts#L42')).toBeNull()
    expect(matchGitHubRef('src/app.ts#42')).toBeNull()
  })

  it('rejects things that are not a repo reference', () => {
    expect(matchGitHubRef('lodash/fp')).toBeNull()
    expect(matchGitHubRef('#1146')).toBeNull()
  })

  it('is picked over the path matcher when splitting prose', () => {
    const segments = splitTextByFilePaths('见 NanmiCoder/cc-haha#1146 和 src/app.ts:4')
    expect(segments.filter((s) => s.type === 'github').map((s) => s.value)).toEqual(['NanmiCoder/cc-haha#1146'])
    expect(segments.filter((s) => s.type === 'path').map((s) => s.value)).toEqual(['src/app.ts:4'])
  })
})

describe('parseFilePathRef / isFilePathOnly', () => {
  it('accepts a span that is nothing but a reference', () => {
    expect(isFilePathOnly('desktop/src/foo.ts:42')).toBe(true)
    expect(parseFilePathRef(' src/a.py ')?.path).toBe('src/a.py')
  })

  it('rejects a command that merely contains one', () => {
    // Matches urlBoundary's rule for `` `curl http://x` ``: a command stays code.
    expect(isFilePathOnly('bun test src/a.test.ts')).toBe(false)
    expect(isFilePathOnly('rm -rf dist/')).toBe(false)
  })
})

describe('isLinkableFilePath', () => {
  it('agrees with the extension set that previewLinkRouter routes on', () => {
    for (const ext of ['ts', 'yml', 'ps1', 'rs', 'toml']) {
      expect(LINKABLE_FILE_EXTENSIONS.has(ext)).toBe(true)
      expect(isLinkableFilePath(`src/file.${ext}`)).toBe(true)
    }
  })

  it('has no dead entries in the ambiguous-standalone list', () => {
    // An extension that is not linkable at all can never reach the standalone
    // check, so listing it there is config that does nothing.
    for (const ext of AMBIGUOUS_STANDALONE_EXTENSIONS) {
      expect(LINKABLE_FILE_EXTENSIONS.has(ext), `${ext} is gated but not linkable`).toBe(true)
    }
  })

  it('covers the two files #1146 screenshots pointed at', () => {
    // Both were classified `ignored` before: .yml and .ps1 were missing from the
    // old PREVIEWABLE_EXT list.
    expect(isLinkableFilePath('.github/workflows/release-desktop.yml')).toBe(true)
    expect(isLinkableFilePath('scripts/windows-installer-smoke.ps1')).toBe(true)
  })

  it.each([
    'reports/brief.docx',
    'reports/budget.xlsx',
    'reports/launch.pptx',
    'exports/archive.zip',
  ])('keeps generated attachment paths actionable: %s', (filePath) => {
    expect(isLinkableFilePath(filePath)).toBe(true)
    expect(parseFilePathRef(filePath)?.path).toBe(filePath)
  })
})
