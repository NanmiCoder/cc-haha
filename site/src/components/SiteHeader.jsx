import { useEffect, useState } from 'react'
import Icon from './icons'
import { toSiteHref } from '../content/docs'
import { useTheme } from '../lib/theme'
import SearchDialog from './SearchDialog'

export const GITHUB_URL = 'https://github.com/NanmiCoder/cc-haha'
export const DOWNLOAD_URL = 'https://github.com/NanmiCoder/cc-haha/releases/latest'

const copy = {
  download: 'Download',
  entries: [
    ['/start', 'Get started'],
    ['/cases', 'Cases'],
    ['/desktop/settings', 'Settings'],
    ['/desktop', 'Desktop app']
  ],
  menu: 'Open navigation',
  // The footer also has a "Docs" nav, so the main nav needs a distinct landmark name.
  nav: 'Main',
  search: 'Search docs',
  theme: 'Toggle theme'
}

export default function SiteHeader({ activeSection }) {
  const [open, setOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const c = copy

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
        return
      }
      // The expanded mobile menu must close on Esc; clicking elsewhere doesn't help keyboard users.
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const home = '/'

  return (
    <>
      <header className="site-header">
        <div className="site-header__inner">
          <a className="brand" href={toSiteHref(home)}>
            <img alt="" src={toSiteHref('/images/app-icon.png')} width="26" height="26" />
            <span>cc-haha</span>
          </a>

          <nav aria-label={c.nav} className="site-nav" data-open={open} id="site-nav">
            {c.entries.map(([href, label]) => (
              <a
                aria-current={activeSection && href.endsWith(`/${activeSection}`) ? 'page' : undefined}
                href={toSiteHref(href)}
                key={href}
                onClick={() => setOpen(false)}
              >
                {label}
              </a>
            ))}
          </nav>

          <div className="header-tools">
            <button aria-label={c.search} className="icon-btn" onClick={() => setSearchOpen(true)} type="button">
              <Icon name="search" />
            </button>
            <button aria-label={c.theme} className="icon-btn" onClick={toggle} type="button">
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <a aria-label="GitHub" className="icon-btn" href={GITHUB_URL} rel="noreferrer" target="_blank">
              <Icon name="github" />
            </a>
            <a className="btn btn--primary header-download" href={DOWNLOAD_URL}>
              <Icon name="download" size={16} />
              {c.download}
            </a>
            <button
              aria-controls="site-nav"
              aria-expanded={open}
              aria-label={c.menu}
              className="icon-btn header-menu-btn"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              <Icon name={open ? 'close' : 'menu'} />
            </button>
          </div>
        </div>
      </header>

      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </>
  )
}
