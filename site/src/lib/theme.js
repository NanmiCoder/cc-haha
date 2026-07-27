import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'cch-theme'

export function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'dark' || stored === 'light' ? stored : null
  } catch {
    return null
  }
}

export function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
}

/**
 * 深浅色跟随系统，用户手动切过之后以用户的选择为准。
 * 首帧的主题由 index.html 里的引导脚本设置，避免闪白。
 */
export function useTheme() {
  const [theme, setTheme] = useState(() =>
    (typeof document === 'undefined' ? 'light' : document.documentElement.dataset.theme || 'light')
  )

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return undefined

    const onChange = () => {
      if (readStoredTheme()) return
      const next = media.matches ? 'dark' : 'light'
      applyTheme(next)
      setTheme(next)
    }

    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        /* 隐私模式下写不进去，忽略即可 */
      }
      return next
    })
  }, [])

  return { theme, toggle }
}
