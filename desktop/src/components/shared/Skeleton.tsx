type SkeletonVariant = 'text' | 'circle' | 'rect'

type SkeletonProps = {
  variant?: SkeletonVariant
  width?: string | number
  height?: string | number
  className?: string
  count?: number
}

export function Skeleton({ variant = 'text', width, height, className = '', count = 1 }: SkeletonProps) {
  const baseClass = 'animate-pulse bg-[var(--color-surface-container-high)]'
  const variantClass = {
    text: 'rounded',
    circle: 'rounded-full',
    rect: 'rounded-[var(--radius-md)]',
  }[variant]

  const style: React.CSSProperties = {}
  if (width) style.width = width
  if (height) style.height = height

  if (count > 1) {
    return (
      <div className="space-y-2" role="status" aria-label="Loading">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={`${baseClass} ${variantClass} ${className}`} style={style} />
        ))}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-label="Loading"
      className={`${baseClass} ${variantClass} ${className}`}
      style={style}
    />
  )
}

export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return <Skeleton variant="text" count={lines} height={12} className={className} />
}

export function SkeletonCircle({ size = 32, className = '' }: { size?: number; className?: string }) {
  return <Skeleton variant="circle" width={size} height={size} className={className} />
}
