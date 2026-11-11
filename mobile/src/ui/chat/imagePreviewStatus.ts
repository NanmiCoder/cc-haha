import { useEffect, useState } from 'react'
import { Image } from 'react-native'

/** The native gallery has no error callback; keep failed sources recoverable. */
export function useImagePreviewStatus(uri: string) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ uri: string; attempt: number; failed: boolean } | null>(null)
  useEffect(() => {
    let current = true
    const finish = (failed: boolean) => {
      if (!current) return
      clearTimeout(timeout)
      setResult({ uri, attempt, failed })
    }
    // Bad/expired local files must not leave the library's spinner running forever.
    const timeout = setTimeout(() => finish(true), 10_000)
    try {
      Image.getSize(uri, (width, height) => finish(width <= 0 || height <= 0), () => finish(true))
    } catch {
      finish(true)
    }
    return () => {
      current = false
      clearTimeout(timeout)
    }
  }, [uri, attempt])
  return {
    attempt,
    failed: result?.uri === uri && result.attempt === attempt && result.failed,
    retry: () => setAttempt((value) => value + 1),
  }
}
