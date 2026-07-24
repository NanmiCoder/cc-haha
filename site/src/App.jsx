import { lazy, Suspense, useEffect, useState } from 'react'
import HomePage from './pages/home/HomePage'

const DocPage = lazy(() => import('./components/DocPage'))

function currentPath() {
  return window.location.pathname.replace(/\/+$/, '') || '/'
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
      if (
        target.pathname === window.location.pathname
        && target.search === window.location.search
      ) {
        return
      }

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

  if (path === '/' || path === '/en') {
    return <HomePage locale={path === '/en' ? 'en' : 'zh'} />
  }

  return (
    <Suspense fallback={<div className="page-loading">Opening the field manual…</div>}>
      <DocPage
        pathname={path}
        onNotFound={() => (
          <main className="not-found">
            <span>404 · OFF THE MAP</span>
            <h1>这里还没有留下脚印。</h1>
            <p>The crew could not find this page.</p>
            <a href="/">回到工作室 →</a>
          </main>
        )}
      />
    </Suspense>
  )
}
