import { useEffect, useState } from 'react'
import { AppWindow, Code2, ExternalLink, FolderOpen } from 'lucide-react'
import type { OpenTarget } from '../../stores/openTargetStore'

export function getFallbackIcon(kind: OpenTarget['kind'], size = 17) {
  if (kind === 'file_manager') {
    return <FolderOpen size={size} strokeWidth={1.9} />
  }
  if (kind === 'application') return <AppWindow size={size} strokeWidth={1.9} />
  if (kind === 'system_default') return <ExternalLink size={size} strokeWidth={1.9} />
  return <Code2 size={size} strokeWidth={1.9} />
}

export function TargetIcon({ target, size = 18 }: { target: OpenTarget; size?: number }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [target.iconUrl])

  if (target.iconUrl && !failed) {
    return (
      <img
        src={target.iconUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(true)}
        className="block shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    )
  }

  return getFallbackIcon(target.kind, Math.max(16, size - 1))
}
