import { describe, expect, it } from 'vitest'

import {
  createAssistantMarkdownAudioResolver,
  createAssistantMarkdownImageResolver,
  createWorkspaceMarkdownAudioResolver,
  createWorkspaceMarkdownImageResolver,
  isLocalAudioName,
  isMarkdownAudioDestination,
  isSafeMarkdownAudioSource,
  isSafeMarkdownImageSource,
  localPathFromMarkdownImageUrl,
  normalizeMarkdownImageDestination,
} from './markdownImages'

const CONTEXT = {
  baseUrl: 'http://127.0.0.1:3456',
  sessionId: 'session-1',
  filePath: 'docs/guide.md',
  workDir: '/repo',
}

describe('isSafeMarkdownImageSource', () => {
  it('accepts blob and base64 data image sources', () => {
    expect(isSafeMarkdownImageSource('blob:https://desktop.invalid/1234')).toBe(true)
    expect(isSafeMarkdownImageSource('data:image/png;base64,AAAA')).toBe(true)
    expect(isSafeMarkdownImageSource('data:image/svg+xml;base64,AAAA')).toBe(false)
  })

  it('rejects network and relative sources', () => {
    expect(isSafeMarkdownImageSource('https://example.com/a.png')).toBe(false)
    expect(isSafeMarkdownImageSource('assets/a.png')).toBe(false)
    expect(isSafeMarkdownImageSource(null)).toBe(false)
  })
})

describe('createWorkspaceMarkdownImageResolver', () => {
  const resolve = createWorkspaceMarkdownImageResolver(CONTEXT)

  it('resolves same-directory relative paths against the markdown file directory', () => {
    expect(resolve('assets/logo.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
  })

  it('resolves ./ prefixes and parent traversal inside the workspace', () => {
    expect(resolve('./assets/logo.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
    expect(resolve('../shared/banner.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/shared/banner.png',
    )
  })

  it('resolves images of a root-level markdown file', () => {
    const rootResolve = createWorkspaceMarkdownImageResolver({ ...CONTEXT, filePath: 'README.md' })
    expect(rootResolve('docs/assets/logo.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
  })

  it('keeps remote http(s) image URLs untouched', () => {
    expect(resolve('https://img.shields.io/badge/stars-1k.svg')).toBe(
      'https://img.shields.io/badge/stars-1k.svg',
    )
    expect(resolve('http://127.0.0.1:8787/frame.png')).toBe('http://127.0.0.1:8787/frame.png')
  })

  it('keeps safe inline image sources untouched', () => {
    expect(resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(resolve('blob:https://desktop.invalid/1234')).toBe('blob:https://desktop.invalid/1234')
  })

  it('routes absolute local paths through /local-file', () => {
    expect(resolve('/Users/me/pic.png')).toBe(
      'http://127.0.0.1:3456/local-file/Users/me/pic.png',
    )
  })

  it('routes the Windows shape the renderer writes for file:///C:/... and C:\\..., through /local-file as a drive path', () => {
    expect(resolve('/C:/Users/me/pic.png')).toBe('http://127.0.0.1:3456/local-file/C%3A/Users/me/pic.png')
  })

  it('routes workspace escapes through /local-file when the workDir is known', () => {
    expect(resolve('../../outside.png')).toBe(
      'http://127.0.0.1:3456/local-file/outside.png',
    )
  })

  it('rejects workspace escapes when the workDir is unknown', () => {
    const noWorkDir = createWorkspaceMarkdownImageResolver({ ...CONTEXT, workDir: null })
    expect(noWorkDir('../../outside.png')).toBeNull()
  })

  it('escapes spaces and unicode, so the server decodes the name that was written', () => {
    expect(resolve('截图/界面 1.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/%E6%88%AA%E5%9B%BE/%E7%95%8C%E9%9D%A2%201.png',
    )
  })

  it('cannot be made to leave the session route by a double-escaped dot segment', () => {
    const url = resolve('%252e%252e/%252e%252e/api/status.png')

    expect(url).not.toBeNull()
    expect(new URL(url!).pathname.startsWith('/preview-fs/session-1/')).toBe(true)
  })

  it('drops query strings and fragments from local paths', () => {
    expect(resolve('assets/logo.png?v=2#frag')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/docs/assets/logo.png',
    )
  })

  it('rejects non-loadable sources', () => {
    expect(resolve('')).toBeNull()
    expect(resolve('#anchor')).toBeNull()
    expect(resolve('javascript:alert(1)')).toBeNull()
    expect(resolve('file:///etc/passwd')).toBeNull()
    expect(resolve('data:text/html;base64,AAAA')).toBeNull()
  })
})

describe('createAssistantMarkdownImageResolver', () => {
  const resolve = createAssistantMarkdownImageResolver({
    baseUrl: 'http://127.0.0.1:3456',
    sessionId: 'session-1',
  })

  it('routes relative and absolute local paths through the session workspace sandbox', () => {
    expect(resolve('images/../01.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1/01.png',
    )
    expect(resolve('/repo/output/02.png')).toBe(
      'http://127.0.0.1:3456/preview-fs/session-1//repo/output/02.png',
    )
  })

  it('keeps safe in-memory images without opening a network path', () => {
    expect(resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(resolve('blob:https://desktop.invalid/1234')).toBe('blob:https://desktop.invalid/1234')
  })

  it('rejects remote, loopback, schemes, and workspace escapes', () => {
    expect(resolve('https://attacker.example/track.png')).toBeNull()
    expect(resolve('http://127.0.0.1:3456/status.png')).toBeNull()
    expect(resolve('//attacker.example/track.png')).toBeNull()
    expect(resolve('file:///repo/01.png')).toBeNull()
    expect(resolve('../outside.png')).toBeNull()
    expect(resolve('#fragment')).toBeNull()
  })
})

describe('createAssistantMarkdownImageResolver with the session workdir known', () => {
  const BASE = 'http://127.0.0.1:3456'
  const resolve = createAssistantMarkdownImageResolver({ baseUrl: BASE, sessionId: 'session-1', workDir: '/repo' })
  const filesystem = (path: string) => `${BASE}/api/filesystem/file?path=${encodeURIComponent(path)}`

  it('keeps a picture inside the workdir on the session sandbox route, which needs no registered root', () => {
    expect(resolve('/repo/output/02.png')).toBe(`${BASE}/preview-fs/session-1//repo/output/02.png`)
    expect(resolve('/repo/01.png')).toBe(`${BASE}/preview-fs/session-1//repo/01.png`)
  })

  it('serves a picture outside the workdir from the filesystem route, where it used to be a broken image', () => {
    expect(resolve('/Users/me/Pictures/chart.png')).toBe(filesystem('/Users/me/Pictures/chart.png'))
  })

  it('does not take a sibling directory that merely starts with the same letters for the workdir', () => {
    expect(resolve('/repo-old/a.png')).toBe(filesystem('/repo-old/a.png'))
  })

  it('reads ../ in an absolute path before deciding where it lands', () => {
    // Lexically /repo/../etc/a.png is /etc/a.png: outside, and the route decides whether it may be read.
    expect(resolve('/repo/../etc/a.png')).toBe(filesystem('/etc/a.png'))
    expect(resolve('/elsewhere/../repo/a.png')).toBe(`${BASE}/preview-fs/session-1//repo/a.png`)
  })

  it('leaves a home-relative path to the filesystem route, which expands it', () => {
    expect(resolve('~/Pictures/chart.png')).toBe(filesystem('~/Pictures/chart.png'))
  })

  it('does so whether or not the workdir is known: the session route could never place a home path', () => {
    const unknown = createAssistantMarkdownImageResolver({ baseUrl: BASE, sessionId: 'session-1' })

    expect(unknown('~/Pictures/chart.png')).toBe(filesystem('~/Pictures/chart.png'))
  })

  it('normalizes home paths but leaves leading parents for the server to expand and authorize', () => {
    expect(resolve('~/Pictures/../Desktop/chart.png')).toBe(filesystem('~/Desktop/chart.png'))
    // QA-003: the home alias is not a sandbox root. This can name an allowed
    // /tmp image; only the server knows where HOME is and which roots are allowed.
    expect(resolve('~/../../tmp/qa/sample.png')).toBe(filesystem('~/../../tmp/qa/sample.png'))
    expect(resolve('~/../Pictures/../../chart.png')).toBe(filesystem('~/../../chart.png'))
    expect(resolve('~/%2e%2e/%2e%2e/tmp/qa/sample.png')).toBe(filesystem('~/../../tmp/qa/sample.png'))
    expect(resolve('~/../../etc/x.png')).toBe(filesystem('~/../../etc/x.png'))
    expect(resolve('../outside.png')).toBeNull()
  })

  it('takes a bare Windows drive path, as it does the shape the renderer writes', () => {
    expect(resolve('C:/Users/me/chart.png')).toBe(filesystem('C:/Users/me/chart.png'))
    expect(resolve('C:\\Users\\me\\chart.png')).toBe(filesystem('C:/Users/me/chart.png'))
  })

  it('does not stumble over a Windows workdir that is deeper than the picture is', () => {
    const deep = createAssistantMarkdownImageResolver({ baseUrl: BASE, sessionId: 'session-1', workDir: 'C:\\Proj\\Thesis\\Deep' })

    expect(deep('/C:/Proj/chart.png')).toBe(filesystem('C:/Proj/chart.png'))
    expect(deep('/C:/chart.png')).toBe(filesystem('C:/chart.png'))
    // A parent of the workdir: every segment it has matches, and the workdir has one more.
    expect(deep('/C:/Proj/Thesis')).toBeNull()
  })

  it('reads the Windows shape the renderer writes for file:///C:/... and C:\\..., as a Windows path', () => {
    expect(resolve('/C:/Users/me/chart.png')).toBe(filesystem('C:/Users/me/chart.png'))
  })

  it('compares a Windows workdir without regard to case or slash direction', () => {
    const windows = createAssistantMarkdownImageResolver({ baseUrl: BASE, sessionId: 'session-1', workDir: 'C:\\Proj\\Thesis' })

    expect(windows('/c:/proj/thesis/fig/a.png')).toBe(`${BASE}/preview-fs/session-1/c%3A/proj/thesis/fig/a.png`)
    expect(windows('/C:/Users/me/a.png')).toBe(filesystem('C:/Users/me/a.png'))
  })

  it('takes percent-escapes and drops a query string and fragment, as for any local path', () => {
    expect(resolve('/Users/me/My%20Pics/chart.png?v=2#top')).toBe(filesystem('/Users/me/My Pics/chart.png'))
  })

  it('refuses a malformed percent-escape rather than guess which file it meant', () => {
    expect(resolve('/Users/me/100%.png')).toBeNull()
    expect(resolve('/repo/output/%E0%A4%A.png')).toBeNull()
    expect(resolve('output/%zz.png')).toBeNull()
  })

  it('cannot be made to leave the session route by a double-escaped dot segment', () => {
    for (const source of ['%252e%252e/%252e%252e/api/status.png', '/repo/%252e%252e/%252e%252e/api/status.png']) {
      const url = resolve(source)

      expect(url).not.toBeNull()
      expect(new URL(url!).pathname.startsWith('/preview-fs/session-1/')).toBe(true)
    }
  })

  it('keeps a percent sign that is part of the name, rather than reading it as an escape twice', () => {
    expect(resolve('/repo/out/a%2523b.png')).toBe(`${BASE}/preview-fs/session-1//repo/out/a%2523b.png`)
  })

  it('serves only pictures from outside the workdir: another kind of file is not the filesystem route\'s business', () => {
    expect(resolve('/Users/me/notes.txt')).toBeNull()
    expect(resolve('/etc/passwd')).toBeNull()
    expect(resolve('/Users/me/archive.png.zip')).toBeNull()
    expect(resolve('/Users/me/.png')).toBeNull()
  })

  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'PNG', 'JpEg'])('serves a .%s from outside the workdir', (extension) => {
    expect(resolve(`/Users/me/pic.${extension}`)).toBe(filesystem(`/Users/me/pic.${extension}`))
  })

  it('leaves a relative path on the session sandbox route, whatever it is called', () => {
    expect(resolve('images/../01.png')).toBe(`${BASE}/preview-fs/session-1/01.png`)
    expect(resolve('figure')).toBe(`${BASE}/preview-fs/session-1/figure`)
  })

  it('still refuses what it always refused', () => {
    expect(resolve('https://attacker.example/track.png')).toBeNull()
    expect(resolve('//attacker.example/track.png')).toBeNull()
    expect(resolve('javascript:alert(1)')).toBeNull()
    expect(resolve('file:///Users/me/a.png')).toBeNull()
    expect(resolve('../outside.png')).toBeNull()
    expect(resolve('#fragment')).toBeNull()
  })

  it('keeps the in-memory sources', () => {
    expect(resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('without a workdir, still sends an absolute path through the session sandbox as before', () => {
    const unknown = createAssistantMarkdownImageResolver({ baseUrl: BASE, sessionId: 'session-1' })

    expect(unknown('/repo/output/02.png')).toBe(`${BASE}/preview-fs/session-1//repo/output/02.png`)
  })
})

describe('normalizeMarkdownImageDestination', () => {
  it.each([
    ['file:///C:/Users/me/a.png', '/C:/Users/me/a.png'],
    ['file:///Users/me/a.png', '/Users/me/a.png'],
    ['FILE:///Users/me/a.png', '/Users/me/a.png'],
    ['file://localhost/Users/me/a.png', '/Users/me/a.png'],
    ['file:///Users/me/My%20Pics/a.png', '/Users/me/My%20Pics/a.png'],
    ['C:\\Users\\me\\a.png', '/C:/Users/me/a.png'],
    ['c:/Users/me/a.png', '/c:/Users/me/a.png'],
  ])('writes %s as %s, the one shape that survives sanitization', (href, expected) => {
    expect(normalizeMarkdownImageDestination(href)).toBe(expected)
  })

  it.each([
    'images/a.png',
    './a.png',
    '/Users/me/a.png',
    '~/Pictures/a.png',
    'https://example.com/a.png',
    'data:image/png;base64,AAAA',
    'blob:https://desktop.invalid/1234',
    'javascript:alert(1)',
    'file://server/share/a.png',
    'C:relative.png',
    '',
  ])('leaves %s alone', (href) => {
    expect(normalizeMarkdownImageDestination(href)).toBe(href)
  })

  describe('reading a Windows path back from what the author wrote', () => {
    // Markdown lets a backslash escape the punctuation after it, so the parser hands
    // over `C:\Users\me\.claude\a.png` as `C:\Users\me.claude\a.png`.
    it.each([
      ['a hidden folder', 'C:\\Users\\me\\.claude\\a.png', 'C:\\Users\\me.claude\\a.png', '/C:/Users/me/.claude/a.png'],
      ['an underscored folder', 'C:\\Users\\me\\_out\\a.png', 'C:\\Users\\me_out\\a.png', '/C:/Users/me/_out/a.png'],
      ['a hidden folder straight after the drive', 'C:\\.cache\\a.png', 'C:.cache\\a.png', '/C:/.cache/a.png'],
      ['a folder in parentheses, in angle brackets', '<C:\\Users\\me\\(new) pics\\a.png>', 'C:\\Users\\me(new) pics\\a.png', '/C:/Users/me/(new) pics/a.png'],
      ['a title after the path', 'C:\\Users\\me\\.claude\\a.png "the chart"', 'C:\\Users\\me.claude\\a.png', '/C:/Users/me/.claude/a.png'],
    ])('restores the separators before punctuation: %s', (_label, written, parsed, expected) => {
      expect(normalizeMarkdownImageDestination(parsed, `![chart](${written})`)).toBe(expected)
    })

    it('leaves alone a path the parser did not change', () => {
      expect(normalizeMarkdownImageDestination('C:\\Users\\me\\a.png', '![chart](C:\\Users\\me\\a.png)')).toBe('/C:/Users/me/a.png')
    })

    it('trusts the parser when the text it was given does not explain the destination', () => {
      // Only text that, unescaped, is exactly what the parser produced can replace it.
      expect(normalizeMarkdownImageDestination('C:\\other\\a.png', '![a](C:\\x\\.y\\z.png)')).toBe('/C:/other/a.png')
      // An alt text with `](` in it moves the apparent destination.
      expect(normalizeMarkdownImageDestination('C:\\Users\\me\\a.png', '![a](b)](C:\\Users\\me\\.x\\a.png)')).toBe('/C:/Users/me/a.png')
      expect(normalizeMarkdownImageDestination('C:\\Users\\me\\a.png', '')).toBe('/C:/Users/me/a.png')
    })

    it('does not rewrite anything that is not a drive path', () => {
      expect(normalizeMarkdownImageDestination('/Users/me/.claude/a.png', '![chart](/Users/me/\\.claude/a.png)')).toBe('/Users/me/.claude/a.png')
      expect(normalizeMarkdownImageDestination('figures/a_b.png', '![chart](figures/a\\_b.png)')).toBe('figures/a_b.png')
    })
  })
})

describe('localPathFromMarkdownImageUrl', () => {
  const context = { baseUrl: 'http://127.0.0.1:3456', workDir: '/repo' }

  it('finds the file behind a session sandbox URL for a path inside the workdir', () => {
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/preview-fs/session-1/output/02.png', context)).toBe('/repo/output/02.png')
  })

  it('finds the file behind a session sandbox URL that carries an absolute path', () => {
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/preview-fs/session-1//repo/output/02.png', context)).toBe('/repo/output/02.png')
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/preview-fs/session-1/C:/proj/a.png', { ...context, workDir: null })).toBe('C:/proj/a.png')
  })

  it('decodes what the URL builders encoded', () => {
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/preview-fs/session-1/%E6%88%AA%E5%9B%BE/a%20b.png', context)).toBe('/repo/截图/a b.png')
  })

  it('finds the file behind a filesystem-route URL', () => {
    const url = `http://127.0.0.1:3456/api/filesystem/file?path=${encodeURIComponent('/Users/me/My Pics/a.png')}`
    expect(localPathFromMarkdownImageUrl(url, context)).toBe('/Users/me/My Pics/a.png')
    expect(localPathFromMarkdownImageUrl(`http://127.0.0.1:3456/api/filesystem/file?path=${encodeURIComponent('~/a.png')}`, context)).toBe('~/a.png')
  })

  it('finds the file behind a /local-file URL', () => {
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/local-file/Users/me/a%20b.png', context)).toBe('/Users/me/a b.png')
  })

  // "Open original" hands the path to the system's default application, so it is
  // only ever for a picture — a link to the same file is not opened at all.
  it.each([
    'http://127.0.0.1:3456/preview-fs/session-1/run.terminal',
    'http://127.0.0.1:3456/preview-fs/session-1/notes.txt',
    'http://127.0.0.1:3456/preview-fs/session-1/figure',
    'http://127.0.0.1:3456/preview-fs/session-1/archive.png.zip',
    'http://127.0.0.1:3456/local-file/Users/me/setup.command',
    `http://127.0.0.1:3456/api/filesystem/file?path=${encodeURIComponent('/Users/me/run.jar')}`,
  ])('offers no file for %s, which is not a picture', (url) => {
    expect(localPathFromMarkdownImageUrl(url, context)).toBeNull()
  })

  // A `..` the URL parser would collapse never reaches this far; what can is one
  // hidden behind an escaped slash, which the server decodes into a real climb.
  it.each([
    'http://127.0.0.1:3456/preview-fs/session-1/src%2F..%2F..%2Fetc%2Fhosts.png',
    'http://127.0.0.1:3456/preview-fs/session-1/%2E%2E%2Fetc%2Fhosts.png',
    'http://127.0.0.1:3456/local-file/Users/me/..%2F..%2Fetc%2Fhosts.png',
    `http://127.0.0.1:3456/api/filesystem/file?path=${encodeURIComponent('/Users/me/../../etc/hosts.png')}`,
  ])('offers no file for %s, which climbs', (url) => {
    expect(localPathFromMarkdownImageUrl(url, context)).toBeNull()
  })

  it('knows no file behind a URL whose path has a malformed percent-escape', () => {
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/preview-fs/session-1/output/100%.png', context)).toBeNull()
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/local-file/Users/me/%E0%A4%A.png', context)).toBeNull()
  })

  it('cannot place a workdir-relative URL without a workdir', () => {
    expect(localPathFromMarkdownImageUrl('http://127.0.0.1:3456/preview-fs/session-1/output/02.png', { ...context, workDir: null })).toBeNull()
  })

  it.each([
    'blob:https://desktop.invalid/1234',
    'data:image/png;base64,AAAA',
    'https://attacker.example/preview-fs/session-1/a.png',
    'http://127.0.0.1:9999/preview-fs/session-1/a.png',
    'http://127.0.0.1:3456/api/status',
    'not a url',
    '',
  ])('knows no file behind %s', (url) => {
    expect(localPathFromMarkdownImageUrl(url, context)).toBeNull()
  })

  it('agrees with the resolver: what it resolves, this puts back', () => {
    const resolver = createAssistantMarkdownImageResolver({ baseUrl: context.baseUrl, sessionId: 'session-1', workDir: context.workDir })

    for (const source of ['/repo/output/02.png', '/Users/me/My Pics/chart.png', 'sub/dir/x.png', '~/Pictures/a.png']) {
      const url = resolver(source)!
      const expected = source.startsWith('sub/') ? '/repo/sub/dir/x.png' : source
      expect(localPathFromMarkdownImageUrl(url, context)).toBe(expected)
    }
  })
})

describe('markdown audio helpers and resolvers', () => {
  it('recognizes supported audio filenames and data URIs without hijacking blob: images', () => {
    for (const ext of ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac', 'opus', 'WAV', 'Mp3']) {
      expect(isLocalAudioName(`/Users/me/sfx.${ext}`)).toBe(true)
      expect(isMarkdownAudioDestination(`N:/project/outputs/sfx/clip.${ext}?v=1#t=2`)).toBe(true)
    }
    expect(isLocalAudioName('/Users/me/pic.png')).toBe(false)
    expect(isLocalAudioName('/Users/me/.wav')).toBe(false)
    expect(isMarkdownAudioDestination('data:audio/mpeg;base64,SUQz')).toBe(true)
    expect(isMarkdownAudioDestination('data:audio/evil;base64,AAAA')).toBe(false)
    expect(isMarkdownAudioDestination('blob:https://desktop.invalid/1234')).toBe(false)
    expect(isSafeMarkdownAudioSource('blob:https://desktop.invalid/1234')).toBe(true)
    expect(isSafeMarkdownAudioSource('data:audio/wav;base64,UklGRg==')).toBe(true)
    expect(isSafeMarkdownAudioSource('data:image/png;base64,AAAA')).toBe(false)
  })

  it('routes assistant audio inside workdir via /preview-fs and outside via /api/filesystem/file', () => {
    const BASE = 'http://127.0.0.1:3456'
    const resolve = createAssistantMarkdownAudioResolver({
      baseUrl: BASE,
      sessionId: 'session-1',
      workDir: 'N:\\project',
    })
    const filesystem = (p: string) => `${BASE}/api/filesystem/file?path=${encodeURIComponent(p)}`

    expect(resolve('outputs/sfx/plane-crash.wav')).toBe(`${BASE}/preview-fs/session-1/outputs/sfx/plane-crash.wav`)
    expect(resolve('/N:/project/outputs/sfx/plane-crash.wav')).toBe(`${BASE}/preview-fs/session-1/N%3A/project/outputs/sfx/plane-crash.wav`)
    expect(resolve('/N:/other/sfx/take.flac')).toBe(filesystem('N:/other/sfx/take.flac'))
    expect(resolve('~/Music/demo.mp3')).toBe(filesystem('~/Music/demo.mp3'))
    expect(resolve('data:audio/mpeg;base64,SUQz')).toBe('data:audio/mpeg;base64,SUQz')
    expect(resolve('blob:https://desktop.invalid/audio')).toBe('blob:https://desktop.invalid/audio')

    // Rejects remote, loopback, non-audio, escapes, and malformed percent escapes.
    expect(resolve('https://attacker.example/a.mp3')).toBeNull()
    expect(resolve('http://127.0.0.1:8606/preview/a.wav')).toBeNull()
    expect(resolve('notes/readme.txt')).toBeNull()
    expect(resolve('../outside.wav')).toBeNull()
    expect(resolve('outputs/%zz.wav')).toBeNull()
  })

  it('resolves workspace markdown audio through /preview-fs and /api/filesystem/file and blocks remote https URLs', () => {
    const BASE = 'http://127.0.0.1:3456'
    const filesystem = (p: string) => `${BASE}/api/filesystem/file?path=${encodeURIComponent(p)}`
    const resolve = createWorkspaceMarkdownAudioResolver(CONTEXT)

    expect(resolve('audio/demo.wav')).toBe(`${BASE}/preview-fs/session-1/docs/audio/demo.wav`)
    expect(resolve('/repo/audio/in-workdir.mp3')).toBe(`${BASE}/preview-fs/session-1//repo/audio/in-workdir.mp3`)
    expect(resolve('/Users/me/demo.mp3')).toBe(filesystem('/Users/me/demo.mp3'))
    expect(resolve('~/Music/demo.flac')).toBe(filesystem('~/Music/demo.flac'))
    expect(resolve('../../outside.wav')).toBe(filesystem('/outside.wav'))
    expect(resolve('data:audio/ogg;base64,T2dn')).toBe('data:audio/ogg;base64,T2dn')
    expect(resolve('http://127.0.0.1:8606/preview-fs/s1/clip.wav')).toBe('http://127.0.0.1:8606/preview-fs/s1/clip.wav')

    // Remote https:// is blocked by media-src CSP and must not reach <audio>.
    expect(resolve('https://example.com/demo.mp3')).toBeNull()
    expect(resolve('data:image/png;base64,AAAA')).toBeNull()
    expect(resolve('docs/notes.txt')).toBeNull()
    expect(resolve('../../secret.txt')).toBeNull()

    // Windows non-$HOME workDir absolute path stays on /preview-fs so it needs no registered root.
    const winResolve = createWorkspaceMarkdownAudioResolver({
      baseUrl: BASE,
      sessionId: 'session-1',
      filePath: 'README.md',
      workDir: 'N:\\project',
    })
    expect(winResolve('/N:/project/outputs/sfx/plane-crash.wav')).toBe(
      `${BASE}/preview-fs/session-1/N%3A/project/outputs/sfx/plane-crash.wav`,
    )
    expect(winResolve('N:/other/sfx/take.wav')).toBe(filesystem('N:/other/sfx/take.wav'))
  })
})
