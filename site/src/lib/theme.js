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
 * Light/dark follows the system until the user toggles it manually; after that the user's choice wins.
 * The first-frame theme is set by the bootstrap script in index.html to avoid a white flash.
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
        /* Can't write in private mode; ignore */
      }
      return next
    })
  }, [])

  return { theme, toggle }
}
