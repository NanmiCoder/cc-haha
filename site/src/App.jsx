import { lazy, Suspense, useEffect, useState } from 'react'
import HomePage from './pages/home/HomePage'
import { resolveLegacyRoute, toSiteHref } from './content/docs'

const DocPage = lazy(() => import('./components/DocPage'))

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/'
}

function NotFound({ pathname }) {
  const isEnglish = pathname.startsWith('/en')
  return (
    <main className="not-found">
      <p>404</p>
      <h1>{isEnglish ? 'This page moved or never existed.' : '这个页面搬走了，或者从来没存在过。'}</h1>
      <p className="not-found__hint">
        {isEnglish
          ? 'The documentation was reorganised in July 2026. Try the two entry points below.'
          : '文档在 2026 年 7 月重新分区过。从下面两个入口找找看。'}
      </p>
      <div className="not-found__actions">
        <a className="btn btn--primary" href={toSiteHref(isEnglish ? '/en/start' : '/start')}>
          {isEnglish ? 'Get started' : '开始使用'}
        </a>
        <a className="btn btn--ghost" href={toSiteHref(isEnglish ? '/en/internals' : '/internals')}>
          {isEnglish ? 'Internals' : '深入原理'}
        </a>
      </div>
    </main>
  )
}

export default function App() {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onPopState = () => setPath(currentPath())

    const onClick = (event) => {
      const anchor = event.target.closest('a')
      if (
        !anchor
        || event.defaultPrevented
        || anchor.target === '_blank'
        || anchor.hasAttribute('download')
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) {
        return
      }

      const target = new URL(anchor.href, window.location.href)
      if (target.origin !== window.location.origin) return
      if (/\.html$/i.test(target.pathname)) return
      if (target.pathname === window.location.pathname && target.search === window.location.search) return

      event.preventDefault()
      window.history.pushState({}, '', `${target.pathname}${target.search}${target.hash}`)
      setPath(currentPath())
    }

    window.addEventListener('popstate', onPopState)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('popstate', onPopState)
      document.removeEventListener('click', onClick)
    }
  }, [])

  // 老路由一律换到新地址，别让重组把外部链接打死在 404 上。
  useEffect(() => {
    const legacy = resolveLegacyRoute(path)
    if (!legacy) return
    window.history.replaceState({}, '', toSiteHref(legacy) + window.location.hash)
    setPath(currentPath())
  }, [path])

  if (path === '/' || path === '/en') {
    return <HomePage locale={path === '/en' ? 'en' : 'zh'} />
  }

  return (
    <Suspense fallback={<div className="page-loading" />}>
      <DocPage pathname={path} onNotFound={(pathname) => <NotFound pathname={pathname} />} />
    </Suspense>
  )
}
