// Adapted from React Bits AnimatedContent (David Haz, MIT + Commons Clause).
// https://github.com/DavidHDev/react-bits/blob/main/src/content/Animations/AnimatedContent/AnimatedContent.jsx
import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

export default function AnimatedContent({ children, className = '', distance = 26, delay = 0, paused = false }) {
  const ref = useRef(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animation
    let trigger
    const clear = () => {
      trigger?.kill()
      animation?.kill()
      gsap.set(element, { clearProps: 'all' })
    }
    const setup = () => {
      clear()
      if (paused || media.matches) return
      gsap.set(element, { y: distance, opacity: 0, visibility: 'visible' })
      animation = gsap.to(element, {
        y: 0, opacity: 1, duration: 0.65, delay, ease: 'power3.out', paused: true
      })
      trigger = ScrollTrigger.create({
        trigger: element, start: 'top 90%', once: true, onEnter: () => animation.play()
      })
    }
    setup()
    media.addEventListener('change', setup)
    return () => {
      media.removeEventListener('change', setup)
      clear()
    }
  }, [distance, delay, paused])

  return <div className={className} ref={ref}>{children}</div>
}
