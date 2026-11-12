import { useEffect, useRef, useState } from 'react'
import Icon from './icons'

export default function ImageViewer({ image, onClose }) {
  const dialogRef = useRef(null)
  const [actualSize, setActualSize] = useState(false)
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

  return <dialog ref={dialogRef} className="doc-image-dialog" aria-label="Image preview" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="doc-image-viewer">
      <div className="doc-image-viewer__bar"><span>{image.alt || 'A closer look'}</span><div>
        <button type="button" aria-pressed={actualSize} onClick={() => setActualSize(!actualSize)}>{actualSize ? 'Fit to screen' : 'Actual size'}</button>
        <button type="button" aria-label="Close image" onClick={onClose}><Icon name="close" size={20} /></button>
      </div></div>
      <div className="doc-image-viewer__image" data-actual={actualSize}><img src={image.src} alt={image.alt} /></div>
      <p>Press Esc to return to reading</p>
    </div>
  </dialog>
}
