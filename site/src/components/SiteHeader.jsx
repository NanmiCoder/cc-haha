import { useEffect, useState } from 'react'
import Icon from './icons'
import { toSiteHref } from '../content/docs'
import { rememberLocale } from '../lib/locale'
import { useTheme } from '../lib/theme'
import SearchDialog from './SearchDialog'

export const GITHUB_URL = 'https://github.com/NanmiCoder/cc-haha'
export const DOWNLOAD_URL = 'https://github.com/NanmiCoder/cc-haha/releases/latest'

const copy = {
  zh: {
    docs: '文档',
    download: '下载',
    entries: [
      ['/start', '开始使用'],
      ['/cases', '实战案例'],
      ['/desktop/settings', '配置指南'],
      ['/desktop', '桌面端功能']
    ],
    menu: '打开导航',
    // 页脚也有一栏叫「文档」，主导航得换个名字，否则地标列表里两个 nav 同名。
    nav: '主导航',
    search: '搜索文档',
    theme: '切换深浅色',
    switchLanguage: 'EN',
    switchLanguageLabel: '切换为英文'
  },
  en: {
    docs: 'Docs',
    download: 'Download',
    entries: [
      ['/en/start', 'Get started'],
      ['/en/cases', 'Cases'],
      ['/en/desktop/settings', 'Settings'],
      ['/en/desktop', 'Desktop app']
    ],
    menu: 'Open navigation',
    nav: 'Main',
    search: 'Search docs',
    theme: 'Toggle theme',
    switchLanguage: '中文',
    switchLanguageLabel: 'Switch to Chinese'
  }
}

export default function SiteHeader({ activeSection, locale = 'zh', localeHref }) {
  const [open, setOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const c = copy[locale] || copy.zh

  useEffect(() => {
    function onKeyDown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
        return
      }
      // 展开的移动端菜单要能用 Esc 收起来，光靠点别处对键盘用户没用。
      if (event.key === 'Escape') setOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const home = locale === 'en' ? '/en' : '/'
  const switchHref = localeHref || (locale === 'en' ? '/' : '/en')

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
            <a
              aria-label={c.switchLanguageLabel}
              className="header-locale"
              href={toSiteHref(switchHref)}
              lang={locale === 'en' ? 'zh-CN' : 'en'}
              onClick={() => {
                rememberLocale(locale === 'en' ? 'zh' : 'en')
                setOpen(false)
              }}
            >
              {c.switchLanguage}
            </a>
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

      {searchOpen && <SearchDialog locale={locale} onClose={() => setSearchOpen(false)} />}
    </>
  )
}
