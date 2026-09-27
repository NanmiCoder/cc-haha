import { useEffect, useRef, useState } from 'react'
import { createAmbientPlayback } from './ambientPlayback.js'

type AmbientSceneProps = {
  src: string
  poster: string
  paused: boolean
  className?: string
  onPlaybackChange?: (playing: boolean) => void
}

export default function AmbientScene({ src, poster, paused, className = '', onPlaybackChange }: AmbientSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pausedRef = useRef(paused)
  const callbackRef = useRef(onPlaybackChange)
  const syncRef = useRef<(() => void) | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [autoplayAllowed, setAutoplayAllowed] = useState(false)

  pausedRef.current = paused
  callbackRef.current = onPlaybackChange

  useEffect(() => {
    const video = videoRef.current
    const scene = sceneRef.current
    if (!video || !scene) return

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const policy = {
      ready: video.readyState >= 2,
      visible: !('IntersectionObserver' in window),
      hidden: document.hidden,
      paused: pausedRef.current,
      reduced: motion.matches,
      failed: Boolean(video.error)
    }
    let mounted = true
    setLoaded(policy.ready && !policy.failed)
    setPlaying(false)
    const playback = createAmbientPlayback({
      media: video,
      onPlaybackChange: (value: boolean) => {
        if (!mounted) return
        setPlaying(value)
        callbackRef.current?.(value)
      }
    })

    function sync() {
      policy.paused = pausedRef.current
      policy.hidden = document.hidden
      policy.reduced = motion.matches
      setAutoplayAllowed(policy.ready && policy.visible && !policy.hidden && !policy.paused && !policy.reduced && !policy.failed)
      playback.update(policy)
    }

    function handleLoaded() {
      policy.ready = true
      policy.failed = false
      setLoaded(true)
      sync()
    }

    function handleError() {
      policy.failed = true
      setLoaded(false)
      sync()
    }

    // Always keep the DOM element silent, including before autoplay begins on
    // WebKit. The poster remains present if loading or autoplay is unavailable.
    video.muted = true
    video.defaultMuted = true
    video.addEventListener('loadeddata', handleLoaded)
    video.addEventListener('error', handleError)
    video.addEventListener('playing', playback.onPlaying)
    video.addEventListener('pause', playback.onPause)
    document.addEventListener('visibilitychange', sync)
    motion.addEventListener('change', sync)
    const observer = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => {
      policy.visible = entry.isIntersecting
      sync()
    }, { threshold: 0 }) : null
    observer?.observe(scene)
    syncRef.current = sync
    sync()

    return () => {
      mounted = false
      syncRef.current = null
      observer?.disconnect()
      document.removeEventListener('visibilitychange', sync)
      motion.removeEventListener('change', sync)
      video.removeEventListener('loadeddata', handleLoaded)
      video.removeEventListener('error', handleError)
      video.removeEventListener('playing', playback.onPlaying)
      video.removeEventListener('pause', playback.onPause)
      playback.dispose()
    }
  }, [src])

  useEffect(() => {
    syncRef.current?.()
  }, [paused])

  return (
    <div ref={sceneRef} className={`ambient-scene ${className}`.trim()} data-playing={playing} data-loaded={loaded} aria-hidden="true">
      <img className="ambient-scene__poster" src={poster} alt="" aria-hidden="true" fetchPriority="high" />
      <video
        ref={videoRef}
        className="ambient-scene__video"
        src={src}
        poster={poster}
        autoPlay={autoplayAllowed}
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        disablePictureInPicture
        disableRemotePlayback
      />
    </div>
  )
}
