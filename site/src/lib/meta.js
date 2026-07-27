const SITE_ORIGIN = 'https://claudecode-haha.relakkesyang.org'

function upsert(selector, create) {
  let node = document.head.querySelector(selector)
  if (!node) {
    node = create()
    document.head.append(node)
  }
  return node
}

function setMetaContent(attribute, key, value) {
  const selector = `meta[${attribute}="${key}"]`
  if (!value) {
    document.head.querySelector(selector)?.remove()
    return
  }
  const node = upsert(selector, () => {
    const meta = document.createElement('meta')
    meta.setAttribute(attribute, key)
    return meta
  })
  node.setAttribute('content', value)
}

function setLink(rel, href, hreflang) {
  const selector = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]:not([hreflang])`
  if (!href) {
    document.head.querySelector(selector)?.remove()
    return
  }
  const node = upsert(selector, () => {
    const link = document.createElement('link')
    link.setAttribute('rel', rel)
    if (hreflang) link.setAttribute('hreflang', hreflang)
    return link
  })
  node.setAttribute('href', href)
}

/**
 * SPA 换页时同步 title / description / canonical / hreflang。
 * 静态构建会把同样的值写进每条路由的 HTML 骨架，所以爬虫拿到的也是对的。
 */
export function setPageMeta({ alternate, canonical, description, lang, title }) {
  document.title = title
  document.documentElement.lang = lang

  setMetaContent('name', 'description', description)
  setMetaContent('property', 'og:title', title)
  setMetaContent('property', 'og:description', description)
  setMetaContent('property', 'og:url', canonical ? `${SITE_ORIGIN}${canonical}` : null)

  setLink('canonical', canonical ? `${SITE_ORIGIN}${canonical}` : null)

  if (canonical) {
    const isEnglish = canonical === '/en' || canonical.startsWith('/en/')
    setLink('alternate', `${SITE_ORIGIN}${canonical}`, isEnglish ? 'en' : 'zh-Hans')
    setLink('alternate', alternate ? `${SITE_ORIGIN}${alternate}` : null, isEnglish ? 'zh-Hans' : 'en')
  }
}
