import { describe, expect, it } from 'vitest'
import {
  AMBIGUOUS_STANDALONE_EXTENSIONS,
  bareNameCandidates,
  findUnicodeExtensionNames,
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

  describe('a CJK file name in prose (#1423)', () => {
    const paths = (text: string) => splitTextByFilePaths(text)
      .filter((s) => s.type === 'path')
      .map((s) => s.value)

    it.each([
      ['已找到 测试文档1.docx 和 测试文档2.docx', ['测试文档1.docx', '测试文档2.docx']],
      ['- 测试文档1.docx', ['测试文档1.docx']],
      ['| 测试文档1.docx | 12KB |', ['测试文档1.docx']],
      ['已生成：开题报告_v2.docx。', ['开题报告_v2.docx']],
      ['见 资料/report.docx', ['资料/report.docx']],
      ['改了 src/中文/a.ts:3', ['src/中文/a.ts:3']],
      ['已找到 D:/资料/测试文档1.docx', ['D:/资料/测试文档1.docx']],
      ['已找到 C:\\Users\\a\\Desktop\\测试文档1.docx', ['C:\\Users\\a\\Desktop\\测试文档1.docx']],
      ['在 /Users/a/论文/开题报告4.pdf', ['/Users/a/论文/开题报告4.pdf']],
    ])('keeps the whole name: %s', (text, expected) => {
      expect(paths(text)).toEqual(expected)
    })

    it('still leaves a CJK verb glued to an ASCII name in the sentence', () => {
      expect(paths('修改了foo.ts')).toEqual(['foo.ts'])
      expect(paths('修改了/Users/a/foo.ts')).toEqual(['/Users/a/foo.ts'])
    })

    it('preserves the original text exactly', () => {
      const text = '已找到 测试文档1.docx，以及 D:/资料/测试文档2.docx。'
      expect(splitTextByFilePaths(text).map((s) => s.value).join('')).toBe(text)
    })
  })

  it('links no name made only of CJK and an extension: prose about formats reads the same', () => {
    // `开题报告.docx` and `后缀为.docx的文件` cannot be told apart by their text.
    for (const text of ['已生成 开题报告.docx', '只支持后缀为.docx的文件', '把它另存为.pdf格式']) {
      expect(splitTextByFilePaths(text).some((s) => s.type === 'path')).toBe(false)
    }
  })

  describe('findUnicodeExtensionNames', () => {
    const names = (text: string) => findUnicodeExtensionNames(text).map((match) => text.slice(match.start, match.end))

    it('reads the whole token in front of the extension, for a caller that checks the disk', () => {
      expect(names('已生成 开题报告.docx 和 摘要.pdf。')).toEqual(['开题报告.docx', '摘要.pdf'])
      expect(names('只支持后缀为.docx的文件')).toEqual(['只支持后缀为.docx'])
    })

    it('leaves names the prose scan already reads, and non-file extensions', () => {
      expect(names('见 测试文档1.docx、report.docx、Node.js、版本2.0')).toEqual([])
    })
  })

  describe('bareNameCandidates', () => {
    const at = (text: string, name: string) => {
      const start = text.indexOf(name)
      return bareNameCandidates(text, start, start + name.length, 0)
    }

    it('offers the longer names a space or full-width bracket may belong to', () => {
      const text = '任务书在 毕业设计（论文）任务书 张三.docx 里'
      expect(at(text, '三.docx')).toEqual(expect.arrayContaining([
        '毕业设计（论文）任务书 张三.docx',
        '任务书 张三.docx',
        '张三.docx',
      ]))
    })

    it('offers the shorter names at each CJK boundary of a glued token', () => {
      const text = '已找到测试文档1.docx和测试文档2.docx'
      const candidates = at(text, '已找到测试文档1.docx')
      expect(candidates).toEqual(expect.arrayContaining(['测试文档1.docx', '1.docx']))
      expect(candidates).not.toContain('已找到测试文档1.docx')
    })

    it('lists longer names first and never crosses a sentence mark, a line or the previous path', () => {
      const text = '前一句。\n见：报告 v2.docx'
      const candidates = at(text, 'v2.docx')
      expect(candidates[0]).toBe('报告 v2.docx')
      expect(candidates.every((name) => !/[。：\n]/.test(name))).toBe(true)
      expect(bareNameCandidates('a.docx 报告v2.docx', 9, 16, 6)).toEqual(['报告v2.docx', '告v2.docx'])
    })

    it('does not trim inside an ASCII word', () => {
      expect(at('见 report.docx', 'report.docx')).toEqual(['见 report.docx'])
    })
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

  it('round-trips a CJK filename a turn actually wrote', () => {
    // Output cards and code spans carry real paths from disk; rejecting CJK here
    // made the README-拍摄大纲.md card render yet die silently on click.
    expect(parseFilePathRef('README-拍摄大纲.md')?.path).toBe('README-拍摄大纲.md')
    expect(parseFilePathRef('文档/说明.md')?.path).toBe('文档/说明.md')
    expect(parseFilePathRef('review-02-技术视角.md:12')).toMatchObject({
      path: 'review-02-技术视角.md',
      line: 12,
    })
  })

  it('keeps CJK sentence punctuation out of the path', () => {
    expect(parseFilePathRef('说明.md。')).toBeNull()
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
