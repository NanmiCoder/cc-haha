import { useEffect, useRef, useState } from 'react'
import Icon from './icons'

export default function ImageViewer({ image, locale, onClose }) {
  const dialogRef = useRef(null)
  const [actualSize, setActualSize] = useState(false)
  const en = locale === 'en'
  useEffect(() => {
    const dialog = dialogRef.current
    const previousOverflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => {
      dialog.close()
      document.body.style.overflow = previousOverflow
      if (image.opener?.isConnected) image.opener.focus({ preventScroll: true })
    }
  }, [image])

  return <dialog ref={dialogRef} className="doc-image-dialog" aria-label={en ? 'Image preview' : '图片预览'} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="doc-image-viewer">
      <div className="doc-image-viewer__bar"><span>{image.alt || (en ? 'A closer look' : '看看细节')}</span><div>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? (en ? 'Fit to screen' : '适应屏幕') : (en ? 'Actual size' : '原始尺寸')}</button>
        <button type="button" aria-label={en ? 'Close image' : '关闭图片'} onClick={onClose}><Icon name="close" size={20} /></button>
      </div></div>
      <div className="doc-image-viewer__image" data-actual={actualSize}><img src={image.src} alt={image.alt} /></div>
      <p>{en ? 'Press Esc to return to reading' : '按 Esc 返回阅读'}</p>
    </div>
  </dialog>
}
