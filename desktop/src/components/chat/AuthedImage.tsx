import type { ImgHTMLAttributes } from 'react'
import { useAuthedImageFallback, type ImageFailure } from '@/lib/useAuthedImageFallback'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'onError'> & {
  /** Runs once the image has failed even with the app's credential, saying why. */
  onFailure?: (failure: ImageFailure) => void
  /** A user retry skips the potentially cached bare failure and fetches afresh. */
  retryWithCredential?: boolean
}

/** An `<img>` for a local-server URL that also loads where a bare request is refused (web UI, H5). */
export function AuthedImage({ src, onFailure, retryWithCredential = false, alt = '', ...rest }: Props) {
  const image = useAuthedImageFallback(src, onFailure, retryWithCredential)
  return <img {...rest} alt={alt} src={image.src} onError={image.onError} />
}
