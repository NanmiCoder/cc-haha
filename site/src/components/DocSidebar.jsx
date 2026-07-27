import { useEffect, useRef } from 'react'
import { toSiteHref } from '../content/docs'

export function DocSidebar({ activeRoute, label = 'Documentation', navigation, onNavigate, onRequestClose, open }) {
  const scope = useRef(null)

  // 打开靠后分区的页面时，把当前项滚进视口，别让用户以为侧栏没高亮。
  useEffect(() => {
    scope.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeRoute])

  // 窄屏抽屉是盖在正文上的模态：焦点得进去，也得留在里面，
  // 关掉之后再还给「目录」按钮。宽屏侧栏 open 恒为 false，不受影响。
  useEffect(() => {
    if (!open) return undefined
    const opener = document.activeElement
    const target = scope.current?.querySelector('[aria-current="page"]')
      || scope.current?.querySelector('a')
    target?.focus()

    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [open])

  function onKeyDown(event) {
    if (!open || event.key !== 'Tab') return
    const stops = [...(scope.current?.querySelectorAll('a[href]') || [])]
    if (stops.length === 0) return

    const first = stops[0]
    const last = stops[stops.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <nav
      aria-label={label}
      className="doc-nav"
      data-open={open}
      id="doc-nav"
      onKeyDown={onKeyDown}
      ref={scope}
    >
      {navigation.map((group) => (
        <div className="doc-nav__group" key={group.id}>
          <span className="doc-nav__title">{group.label}</span>
          <ul className="doc-nav__list">
            {group.items.map((item) => (
              <li key={item.route}>
                <a
                  aria-current={item.route === activeRoute ? 'page' : undefined}
                  className="doc-nav__link"
                  href={toSiteHref(item.route)}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey) return
                    event.preventDefault()
                    onNavigate(item.route)
                    onRequestClose?.()
                  }}
                  title={item.title}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export default DocSidebar
