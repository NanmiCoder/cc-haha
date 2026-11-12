const SITE_ORIGIN = 'https://cchaha.ai'

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

function setLink(rel, href) {
  const selector = `link[rel="${rel}"]`
  if (!href) {
    document.head.querySelector(selector)?.remove()
    return
  }
  const node = upsert(selector, () => {
    const link = document.createElement('link')
    link.setAttribute('rel', rel)
    return link
  })
  node.setAttribute('href', href)
}

/**
 * Sync title / description / canonical on SPA page changes.
 * The static build writes the same values into each route's HTML shell, so crawlers get them right too.
 */
export function setPageMeta({ canonical, description, title }) {
  document.title = title

  setMetaContent('name', 'description', description)
  setMetaContent('property', 'og:title', title)
  setMetaContent('property', 'og:description', description)
  setMetaContent('property', 'og:url', canonical ? `${SITE_ORIGIN}${canonical}` : null)

  setLink('canonical', canonical ? `${SITE_ORIGIN}${canonical}` : null)
}
