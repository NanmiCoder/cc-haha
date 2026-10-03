import { describe, expect, it } from 'vitest'
import { extractAssistantOutputTargets } from './assistantOutputTargets'

const workDir = '/Users/nanmi/project/demo'

describe('extractAssistantOutputTargets', () => {
  it('extracts markdown links for workspace html, markdown, and images', () => {
    const content = [
      '已完成：',
      '- [index.html](/Users/nanmi/project/demo/index.html)',
      '- [notes](docs/result.md)',
      '- [preview](assets/hero.png)',
    ].join('\n')

    const targets = extractAssistantOutputTargets(content, { workDir })

    expect(targets.map((target) => [target.kind, target.href, target.normalizedPath])).toEqual([
      ['local-html', '/Users/nanmi/project/demo/index.html', 'index.html'],
      ['markdown', 'docs/result.md', 'docs/result.md'],
      ['image', 'assets/hero.png', 'assets/hero.png'],
    ])
  })

  it('extracts Markdown images with empty alt text or a destination title', () => {
    const targets = extractAssistantOutputTargets(
      '![](outputs/empty-alt.png) ![preview](outputs/titled.png "Rendered preview")',
      { workDir },
    )

    expect(targets).toMatchObject([
      {
        kind: 'image',
        title: 'empty-alt.png',
        href: 'outputs/empty-alt.png',
        normalizedPath: 'outputs/empty-alt.png',
      },
      {
        kind: 'image',
        title: 'preview',
        href: 'outputs/titled.png',
        normalizedPath: 'outputs/titled.png',
      },
    ])
  })

  it('detects a naked relative video path as a video target', () => {
    const targets = extractAssistantOutputTargets('渲染完成，见 outputs/clip.mp4 。', { workDir })

    expect(targets).toMatchObject([
      {
        kind: 'video',
        href: 'outputs/clip.mp4',
        normalizedPath: 'outputs/clip.mp4',
        source: 'plain-path',
      },
    ])
  })

  it('detects a markdown link to a video as a video target', () => {
    const targets = extractAssistantOutputTargets('[v](demo.webm)', { workDir })

    expect(targets).toMatchObject([
      {
        kind: 'video',
        href: 'demo.webm',
        normalizedPath: 'demo.webm',
        source: 'markdown-link',
      },
    ])
  })

  it('extracts office documents as resources while source references stay inline', () => {
    const targets = extractAssistantOutputTargets(
      '交付物见 [合同](reports/brief.docx)，实现位于 src/main.ts。',
      { workDir },
    )

    expect(targets).toMatchObject([
      { kind: 'file', href: 'reports/brief.docx', normalizedPath: 'reports/brief.docx' },
    ])
    expect(targets.some((target) => target.normalizedPath === 'src/main.ts')).toBe(false)
  })

  it('preserves explicit video identity outside the workspace for the backend route', () => {
    const targets = extractAssistantOutputTargets('[bad](/etc/x.mp4)', { workDir })

    expect(targets).toMatchObject([{ href: '/etc/x.mp4', normalizedPath: '/etc/x.mp4' }])
  })

  it('normalizes markdown destinations with angle brackets, spaces, and line suffixes', () => {
    const content = [
      '[html](</Users/nanmi/project/demo/My Page/index.html>)',
      '[lined](/Users/nanmi/project/demo/index.html:12)',
    ].join('\n')

    const targets = extractAssistantOutputTargets(content, { workDir })

    expect(targets.map((target) => [target.href, target.normalizedPath])).toEqual([
      ['/Users/nanmi/project/demo/My Page/index.html', 'My Page/index.html'],
      ['/Users/nanmi/project/demo/index.html', 'index.html'],
    ])
  })

  it('accepts safe Windows workspace paths with case-insensitive segments', () => {
    const targets = extractAssistantOutputTargets(
      '[Preview](C:/users/nanmi/project/demo/out/index.html)',
      { workDir: 'C:/Users/nanmi/project/demo' },
    )

    expect(targets).toMatchObject([
      {
        kind: 'local-html',
        href: 'C:/users/nanmi/project/demo/out/index.html',
        normalizedPath: 'out/index.html',
      },
    ])
  })

  it('accepts absolute paths when the workdir is filesystem root', () => {
    const targets = extractAssistantOutputTargets(
      '[Preview](/tmp/demo/index.html)',
      { workDir: '/' },
    )

    expect(targets).toMatchObject([
      {
        kind: 'local-html',
        href: '/tmp/demo/index.html',
        normalizedPath: 'tmp/demo/index.html',
      },
    ])
  })

  it('extracts naked localhost and loopback URLs', () => {
    const targets = extractAssistantOutputTargets(
      'Open http://localhost:5173 and http://127.0.0.1:3000/app and http://[::1]:4173/app now.',
      { workDir },
    )

    expect(targets).toMatchObject([
      { kind: 'localhost-url', href: 'http://localhost:5173' },
      { kind: 'localhost-url', href: 'http://127.0.0.1:3000/app' },
      { kind: 'localhost-url', href: 'http://[::1]:4173/app' },
    ])
  })

  it('trims markdown/code punctuation around naked localhost URLs', () => {
    const targets = extractAssistantOutputTargets(
      '地址：`http://localhost:9527/`，备用：http://127.0.0.1:3000/app)。',
      { workDir },
    )

    expect(targets.map((target) => target.href)).toEqual([
      'http://localhost:9527/',
      'http://127.0.0.1:3000/app',
    ])
  })

  it('ignores localhost URLs printed inside fenced log output', () => {
    const targets = extractAssistantOutputTargets(
      [
        '日志前 50 行：',
        '```log',
        '[08:29:36][INFO] 代理服务已启动: 127.0.0.1:15721',
        '[08:29:36][INFO] Claude Live 配置已接管，代理地址: http://127.0.0.1:15721',
        '```',
      ].join('\n'),
      { workDir },
    )

    expect(targets).toEqual([])
  })

  it('ignores markdown links printed inside fenced code blocks', () => {
    const targets = extractAssistantOutputTargets(
      ['```md', '调试输出: [preview](http://localhost:5173/) [page](index.html)', '```'].join('\n'),
      { workDir },
    )

    expect(targets).toEqual([])
  })

  it('keeps markdown localhost links as markdown-link targets with authored labels', () => {
    const targets = extractAssistantOutputTargets(
      '[Preview](http://localhost:4173) then http://localhost:4173',
      { workDir },
    )

    expect(targets).toMatchObject([
      {
        kind: 'localhost-url',
        href: 'http://localhost:4173',
        title: 'Preview',
        source: 'markdown-link',
      },
    ])
    expect(targets).toHaveLength(1)
  })

  it('preserves paths outside the active workspace', () => {
    const targets = extractAssistantOutputTargets(
      '[secret](/Users/nanmi/private/secret.html) [ok](/Users/nanmi/project/demo/public/index.html)',
      { workDir },
    )

    expect(targets).toHaveLength(2)
    expect(targets[0]?.normalizedPath).toBe('/Users/nanmi/private/secret.html')
    expect(targets[1]).toMatchObject({
      kind: 'local-html',
      normalizedPath: 'public/index.html',
    })
  })

  it('deduplicates repeated targets while preserving order', () => {
    const content = [
      '[index](index.html)',
      'Again: http://localhost:5173',
      '[index copy](./index.html)',
      'Again: http://localhost:5173',
    ].join('\n')

    const targets = extractAssistantOutputTargets(content, { workDir })

    expect(targets.map((target) => target.href)).toEqual(['index.html', 'http://localhost:5173'])
  })

  it('extracts files from absolute-root directory trees inside code blocks', () => {
    const targets = extractAssistantOutputTargets(
      [
        '目录结构',
        '```',
        '/Users/nanmi/project/demo/generated/',
        '├── README.md                    # Markdown 说明文件',
        '├── index.html                   # 静态页面',
        '└── todo-app/',
        '    └── index.html',
        '```',
      ].join('\n'),
      { workDir },
    )

    expect(targets.map((target) => [target.href, target.normalizedPath])).toEqual([
      ['/Users/nanmi/project/demo/generated/README.md', 'generated/README.md'],
      ['/Users/nanmi/project/demo/generated/index.html', 'generated/index.html'],
      ['/Users/nanmi/project/demo/generated/todo-app/index.html', 'generated/todo-app/index.html'],
    ])
  })

  it('ignores orphan preview file names inside code blocks', () => {
    const targets = extractAssistantOutputTargets(
      ['```', 'index.html', 'README.md', '```'].join('\n'),
      { workDir },
    )

    expect(targets).toEqual([])
  })

  it('preserves first-seen order across mixed target types', () => {
    const targets = extractAssistantOutputTargets(
      'Open http://localhost:5173 first, then [index](index.html), then docs/guide.md.',
      { workDir },
    )

    expect(targets.map((target) => target.href)).toEqual([
      'http://localhost:5173',
      'index.html',
      'docs/guide.md',
    ])
  })

  it('keeps explicit generated document paths while ignoring remote and file URLs', () => {
    const targets = extractAssistantOutputTargets(
      'Read https://example.com and maybe file:///etc/passwd, but use report.pdf only externally.',
      { workDir },
    )

    expect(targets).toMatchObject([
      { kind: 'file', href: 'report.pdf', normalizedPath: 'report.pdf' },
    ])
  })

  it('caps results at 6 by default', () => {
    const targets = extractAssistantOutputTargets(
      [
        '[one](one.html)',
        '[two](two.html)',
        '[three](three.html)',
        '[four](four.html)',
        '[five](five.html)',
        '[six](six.html)',
        '[seven](seven.html)',
      ].join('\n'),
      { workDir },
    )

    expect(targets.map((target) => target.href)).toEqual([
      'one.html',
      'two.html',
      'three.html',
      'four.html',
      'five.html',
      'six.html',
    ])
  })

  it('respects an explicit limit override', () => {
    const targets = extractAssistantOutputTargets(
      '[one](one.html) [two](two.html) [three](three.html)',
      { workDir, limit: 2 },
    )

    expect(targets.map((target) => target.href)).toEqual(['one.html', 'two.html'])
  })
})

describe('extractAssistantOutputTargets with changedFiles reconciliation', () => {
  it('surfaces a generated office artifact even when the assistant forgot to name it', () => {
    const targets = extractAssistantOutputTargets('已经生成完成。', {
      workDir: '/work',
      changedFiles: ['/work/reports/brief.docx', '/work/src/main.ts'],
    })

    expect(targets).toMatchObject([
      {
        kind: 'file',
        href: 'reports/brief.docx',
        normalizedPath: 'reports/brief.docx',
        source: 'changed-file',
      },
    ])
    expect(targets.some((target) => target.normalizedPath === 'src/main.ts')).toBe(false)
  })

  it('reconciles mentioned paths without sweeping unmentioned artifacts for a non-owner reply', () => {
    const targets = extractAssistantOutputTargets('正在处理 `index.html`。', {
      workDir: '/work',
      changedFiles: ['/work/app/index.html', '/work/reports/brief.docx'],
      includeChangedFileFallback: false,
    })

    expect(targets).toMatchObject([
      {
        kind: 'local-html',
        href: 'app/index.html',
        normalizedPath: 'app/index.html',
      },
    ])
    expect(targets.some((target) => target.normalizedPath === 'reports/brief.docx')).toBe(false)
  })

  it('corrects a bare mention to the real changed path in a subfolder', () => {
    // The reported bug: the model writes /private/tmp/todo-app/index.html but the
    // prose only says `index.html`, so the chip used to point at the (missing)
    // workdir-root index.html. With the turn's real changed files it is corrected.
    const targets = extractAssistantOutputTargets('已创建 `index.html`，直接用浏览器打开。', {
      workDir: '/private/tmp',
      changedFiles: [
        '/private/tmp/todo-app/index.html',
        '/private/tmp/todo-app/style.css',
        '/private/tmp/todo-app/app.js',
      ],
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      kind: 'local-html',
      href: 'todo-app/index.html',
      normalizedPath: 'todo-app/index.html',
      subtitle: 'todo-app/index.html',
    })
  })

  it('drops a mentioned file that the turn never changed', () => {
    const targets = extractAssistantOutputTargets('参考旧文件 old-report.html 和新结果 result.html', {
      workDir: '/work',
      changedFiles: ['/work/out/result.html'],
    })

    expect(targets.map((target) => target.normalizedPath)).toEqual(['out/result.html'])
  })

  it('keeps localhost url chips untouched while reconciling files', () => {
    const targets = extractAssistantOutputTargets('启动后访问 http://localhost:5173/ ，源码见 index.html', {
      workDir: '/work',
      changedFiles: ['/work/app/index.html'],
    })

    const byKind = new Map(targets.map((target) => [target.kind, target]))
    expect(byKind.get('localhost-url')?.href).toBe('http://localhost:5173/')
    expect(byKind.get('local-html')?.normalizedPath).toBe('app/index.html')
  })

  it('applies the limit after dropping stale file mentions', () => {
    const targets = extractAssistantOutputTargets('旧文件 old.html，服务在 http://localhost:5173/', {
      workDir: '/work',
      changedFiles: [],
      limit: 1,
    })

    expect(targets).toMatchObject([
      { kind: 'localhost-url', href: 'http://localhost:5173/' },
    ])
  })

  it('rewrites a changed file outside the workdir to its absolute posix path', () => {
    const targets = extractAssistantOutputTargets('已创建 todo.html', {
      workDir: 'C:/Users/me/tmp/session',
      changedFiles: ['D:\\workspace\\demo\\todo.html'],
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      kind: 'local-html',
      href: 'D:/workspace/demo/todo.html',
      normalizedPath: 'D:/workspace/demo/todo.html',
    })
  })

  it('keeps a generated document the turn wrote through a shell command', () => {
    // `Write plan.md` plus `python make_report.py`: the checkpoint records only
    // the first, so reconciling the mention of the second against it used to drop
    // the actual deliverable.
    const targets = extractAssistantOutputTargets(
      '计划见 plan.md，报告已生成：out/report.docx',
      { workDir: '/w', changedFiles: ['/w/plan.md'] },
    )

    expect(targets.map((target) => target.normalizedPath))
      .toEqual(['plan.md', 'out/report.docx'])
  })

  describe('a file named in an inline code span', () => {
    // The span, not the sentence, bounds the name: a CJK basename inside backticks
    // is one file. Scanning it as prose (CJK excluded on purpose) cut
    // `开题报告2.docx` down to `2.docx` — a card that opens a file that is not there.
    it('keeps the whole CJK basename', () => {
      const targets = extractAssistantOutputTargets(
        '- `开题报告2.docx` — 9/10\n- `开题报告3.docx` — 9/14\n- `开题报告_v2.docx` — 9/17',
        { workDir: '/w', changedFiles: [] },
      )

      expect(targets.map((target) => target.normalizedPath))
        .toEqual(['开题报告2.docx', '开题报告3.docx', '开题报告_v2.docx'])
    })

    it('keeps a CJK directory', () => {
      const targets = extractAssistantOutputTargets(
        '见 `论文/开题报告终稿.docx`',
        { workDir: '/w', changedFiles: [] },
      )

      expect(targets.map((target) => target.normalizedPath)).toEqual(['论文/开题报告终稿.docx'])
    })

    it('does not turn a command into a file card', () => {
      const targets = extractAssistantOutputTargets('运行 `open 开题报告.docx` 即可', {
        workDir: '/w',
        changedFiles: [],
      })

      expect(targets.map((target) => target.normalizedPath)).not.toContain('开题报告.docx')
    })

    it('still stops prose at the Chinese verb flush against an ASCII path', () => {
      const targets = extractAssistantOutputTargets('生成了out/report.docx', { workDir: '/w', changedFiles: [] })

      expect(targets.map((target) => target.normalizedPath)).toEqual(['out/report.docx'])
    })
  })

  it('places a bare deliverable name in the directory the turn actually wrote into', () => {
    // The real shape of a "generate three documents" turn: the prose gives the
    // directory once and then lists basenames. Resolved against the work dir those
    // point nowhere, and the card renders but cannot be opened.
    const targets = extractAssistantOutputTargets(
      '三个文档已完成，都在 /private/tmp/three_docs/：`sales_data.xlsx`、`sales_report.docx`',
      {
        workDir: '/private/tmp',
        changedFiles: ['/private/tmp/three_docs/make_xlsx.py', '/private/tmp/three_docs/make_docx.js'],
      },
    )

    expect(targets.map((target) => target.normalizedPath))
      .toEqual(['three_docs/sales_data.xlsx', 'three_docs/sales_report.docx'])
  })

  it('leaves a bare name alone when the turn wrote into more than one directory', () => {
    // Two candidate directories is no evidence at all, and picking one would give
    // the same dead card less predictably.
    const targets = extractAssistantOutputTargets(
      '产出：`report.docx`',
      { workDir: '/w', changedFiles: ['/w/a/make.py', '/w/b/other.py'] },
    )

    expect(targets.map((target) => target.normalizedPath)).toEqual(['report.docx'])
  })

  it('does not re-anchor a deliverable that already carries a directory', () => {
    const targets = extractAssistantOutputTargets(
      '产出：`out/report.docx`',
      { workDir: '/w', changedFiles: ['/w/scripts/make.py'] },
    )

    expect(targets.map((target) => target.normalizedPath)).toEqual(['out/report.docx'])
  })

  it('still drops an unmatched markdown mention, which is as often a file being read', () => {
    // Markdown is a deliverable *and* the format this product reads all day, so a
    // mention of one carries no evidence that the turn produced it.
    const targets = extractAssistantOutputTargets(
      '我正准备查看 test123.md',
      { workDir: '/w', changedFiles: ['/w/src/first.ts'] },
    )

    expect(targets).toEqual([])
  })

  it('still drops an unmatched source file, so reconciliation keeps doing its job', () => {
    const targets = extractAssistantOutputTargets(
      '改了 plan.md，也看了 src/helper.ts',
      { workDir: '/w', changedFiles: ['/w/plan.md'] },
    )

    expect(targets.map((target) => target.normalizedPath)).toEqual(['plan.md'])
  })

  it('does not list a generated document twice when it is also a changed file', () => {
    // The mention and the changed-file sweep must share one seen-set, or the
    // document gets a card from each.
    const targets = extractAssistantOutputTargets(
      '报告已生成：report.docx',
      { workDir: '/w', changedFiles: ['/w/report.docx'] },
    )

    expect(targets.map((target) => target.normalizedPath)).toEqual(['report.docx'])
  })

  it('drops file mentions when changedFiles explicitly confirms no files changed', () => {
    const targets = extractAssistantOutputTargets(
      '我正准备查看 test123.md，服务地址是 http://localhost:5173/',
      {
        workDir: '/private/tmp',
        changedFiles: [],
      },
    )

    expect(targets).toHaveLength(1)
    expect(targets).toMatchObject([
      { kind: 'localhost-url', href: 'http://localhost:5173/' },
    ])
  })

  it('falls back to text-only behavior when changedFiles is unavailable', () => {
    const targets = extractAssistantOutputTargets('已创建 `index.html`', {
      workDir: '/private/tmp',
    })

    expect(targets).toMatchObject([{ kind: 'local-html', normalizedPath: 'index.html' }])
  })

  it('does not correct when the basename is ambiguous across changed files', () => {
    const targets = extractAssistantOutputTargets('见 index.html', {
      workDir: '/work',
      changedFiles: ['/work/a/index.html', '/work/b/index.html'],
    })

    // Ambiguous basename match → no unique target, mention dropped rather than guessed.
    expect(targets).toHaveLength(0)
  })
})

describe('explicit output path identity', () => {
  const root = '/Users/nanmi/workspace/myself_code/cchaha-promo'
  const content = `\`${root}/out/cc-haha-promo.mp4\`
顺带，项目根目录是 \`${root}/\`：
- \`out/cc-haha-promo.mp4\` — 成片
- \`public/audio/track.wav\` — 合成音轨
- \`src/lib/shots.ts\` — 分镜
- \`README.md\` — 说明`

  it.each([undefined, [], ['/session/README.md']])('preserves screenshot deliverables with checkpoint %j', (changedFiles) => {
    const targets = extractAssistantOutputTargets(content, { workDir: '/session', changedFiles })
    expect(targets.map((target) => target.href)).toEqual([
      `${root}/out/cc-haha-promo.mp4`, `${root}/public/audio/track.wav`, `${root}/README.md`,
      ...(changedFiles?.length ? ['README.md'] : []),
    ])
  })

  it('does not replace an explicit absolute file with another same-named checkpoint file', () => {
    const targets = extractAssistantOutputTargets('报告 `/external/report.pdf`', {
      workDir: '/session', changedFiles: ['/session/report.pdf'], includeChangedFileFallback: false,
    })
    expect(targets.map((target) => target.href)).toEqual(['/external/report.pdf'])
  })
})

describe('canonical output deduplication', () => {
  it.each([undefined, [], ['/work/report.pdf']])('deduplicates absolute and relative identity with checkpoint %j', (changedFiles) => {
    const targets = extractAssistantOutputTargets('`/work/report.pdf` and `report.pdf`', { workDir: '/work', changedFiles })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.href).toBe('/work/report.pdf')
  })
})
