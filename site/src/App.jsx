import { lazy, Suspense, useEffect, useState } from 'react'
import HomePage from './pages/home/HomePage'
import { resolveLegacyRoute, toSiteHref } from './content/docs'

const DocPage = lazy(() => import('./components/DocPage'))

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/'
}

function NotFound() {
  return (
    <main className="not-found">
      <p>404</p>
      <h1>This page moved or never existed.</h1>
      <p className="not-found__hint">
        The documentation was reorganised in July 2026. Try the two entry points below.
      </p>
      <div className="not-found__actions">
        <a className="btn btn--primary" href={toSiteHref('/start')}>Get started</a>
        <a className="btn btn--ghost" href={toSiteHref('/internals')}>Internals</a>
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

  // Send every old route to its new address so the reorganization (and the dropped /en prefix) doesn't break external links.
  useEffect(() => {
    const legacy = resolveLegacyRoute(path)
    if (!legacy) return
    window.history.replaceState({}, '', toSiteHref(legacy) + window.location.hash)
    setPath(currentPath())
  }, [path])

  if (path === '/') {
    return <HomePage />
  }

  return (
    <Suspense fallback={<div className="page-loading" />}>
      <DocPage pathname={path} onNotFound={() => <NotFound />} />
    </Suspense>
  )
}
