import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { DEFAULT_LOCALE, normalizeStoredLocale, resolveBrowserLocale, resolveRootRedirect } from './locale.js'

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((script) => script.includes('window.location.pathname'))

function runBootstrap({ pathname = '/', stored = null, languages, language = '' }) {
  let redirectedTo = null
  const document = { documentElement: { lang: 'en' } }
  runInNewContext(bootstrap, {
    document,
    localStorage: { getItem: () => stored },
    navigator: { languages, language },
    window: { location: { pathname, search: '?from=homepage', hash: '#discover', replace: (url) => { redirectedTo = url } } }
  })
  return { redirectedTo, lang: document.documentElement.lang }
}

describe('normalizeStoredLocale', () => {
  it('只接受 zh / en', () => {
    assert.equal(normalizeStoredLocale('zh'), 'zh')
    assert.equal(normalizeStoredLocale('en'), 'en')
    assert.equal(normalizeStoredLocale('fr'), null)
    assert.equal(normalizeStoredLocale(''), null)
    assert.equal(normalizeStoredLocale(null), null)
  })
})

describe('resolveBrowserLocale', () => {
  it('浏览器首选语言是中文时选择中文，包括地区与繁简体标记', () => {
    for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant', 'ZH-hk']) {
      assert.equal(resolveBrowserLocale({ languages: [language, 'en-US'] }), 'zh', language)
    }
  })

  it('其他语言及缺失的浏览器语言都选择英文', () => {
    assert.equal(DEFAULT_LOCALE, 'en')
    for (const language of ['en-US', 'ja-JP', 'fr-FR', '', 'zho']) {
      assert.equal(resolveBrowserLocale({ languages: [language] }), 'en', language)
    }
    assert.equal(resolveBrowserLocale(), 'en')
  })

  it('优先使用浏览器的语言列表，并在没有列表时回退到 language', () => {
    assert.equal(resolveBrowserLocale({ languages: ['ja-JP', 'zh-CN'], language: 'zh-CN' }), 'en')
    assert.equal(resolveBrowserLocale({ languages: [], language: 'zh-CN' }), 'zh')
  })
})

describe('resolveRootRedirect', () => {
  it('没有保存偏好时按浏览器首选语言分流', () => {
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/' }), null)
    assert.equal(resolveRootRedirect({ languages: ['zh-TW'], pathname: '/' }), null)
    assert.equal(resolveRootRedirect({ languages: ['en-US', 'zh-CN'], pathname: '/' }), '/en')
    assert.equal(resolveRootRedirect({ languages: ['ja-JP'], pathname: '/' }), '/en')
    assert.equal(resolveRootRedirect({ pathname: '/' }), '/en')
  })

  it('根路径的尾斜杠和空串都算根', () => {
    for (const pathname of ['/', '', '//']) {
      assert.equal(resolveRootRedirect({ pathname }), '/en', JSON.stringify(pathname))
    }
  })

  it('只动根路径，明确访问的中英文文档都保持原路由', () => {
    for (const pathname of ['/en', '/en/', '/start', '/en/start', '/desktop/pets', '/internals']) {
      assert.equal(resolveRootRedirect({ pathname }), null, pathname)
    }
  })

  it('手动选择中文后保留中文首页，选择英文后进入英文首页', () => {
    assert.equal(resolveRootRedirect({ pathname: '/', stored: 'zh', languages: ['ja-JP'] }), null)
    assert.equal(resolveRootRedirect({ pathname: '/', stored: 'en', languages: ['zh-CN'] }), '/en')
  })

  it('保存值无效时仍按浏览器语言处理', () => {
    assert.equal(resolveRootRedirect({ pathname: '/', stored: 'garbage', languages: ['zh-CN'] }), null)
    assert.equal(resolveRootRedirect({ pathname: '/', stored: '' }), '/en')
  })
})

describe('index.html 首帧语言分流', () => {
  it('中文浏览器留在中文首页，其他语言带查询和锚点进入英文首页', () => {
    assert.deepEqual(runBootstrap({ languages: ['zh-CN'] }), { redirectedTo: null, lang: 'zh-CN' })
    assert.deepEqual(runBootstrap({ languages: ['ja-JP'] }), { redirectedTo: '/en?from=homepage#discover', lang: 'en' })
  })

  it('手动选择优先于浏览器语言，明确路径不重定向', () => {
    assert.deepEqual(runBootstrap({ languages: ['zh-CN'], stored: 'en' }), { redirectedTo: '/en?from=homepage#discover', lang: 'en' })
    assert.deepEqual(runBootstrap({ languages: ['ja-JP'], stored: 'zh' }), { redirectedTo: null, lang: 'zh-CN' })
    assert.deepEqual(runBootstrap({ pathname: '/start', languages: ['ja-JP'] }), { redirectedTo: null, lang: 'en' })
  })
})
