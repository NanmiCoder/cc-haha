import type { ImgHTMLAttributes } from 'react'
import { useAuthedImageFallback } from '../../lib/useAuthedImageFallback'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'onError'> & {
  /** Runs once the image has failed even with the app's credential. */
  onFailure?: () => void
}

/** An `<img>` for a local-server URL that also loads where a bare request is refused (web UI, H5). */
export function AuthedImage({ src, onFailure, alt = '', ...rest }: Props) {
  const image = useAuthedImageFallback(src, onFailure)
  return <img {...rest} alt={alt} src={image.src} onError={image.onError} />
}
