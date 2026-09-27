import { useEffect, useRef } from 'react'
import forestImage from './assets/redwood-dawn.webp'
import { createScenePlayback } from './scenePlayback'


// The photograph is projected onto a shallow relief mesh. Near trunks and the
// forest floor move farther than the distant clearing; pollen lives in 3D space.
export default function ForestScene({ paused, active }) {
  const hostRef = useRef(null)
  const sceneRef = useRef(null)
  const stateRef = useRef({ paused, active })
  stateRef.current = { paused, active }

  useEffect(() => {
    sceneRef.current?.update({ paused })
  }, [paused])

  useEffect(() => {
    const host = hostRef.current
    const hero = host.closest('section')
    let disposed = false
    let cleanup = () => {}
    import('three').then((THREE) => {
      if (disposed) return
      let renderer
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' })
      } catch {
        host.dataset.state = 'fallback'
        return
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.domElement.setAttribute('aria-hidden', 'true')
      host.appendChild(renderer.domElement)
      host.dataset.motion = 'still'
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 30)
      camera.position.z = 8
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      const coarse = window.matchMedia('(pointer: coarse)')
      const pointer = new THREE.Vector2()
      const current = new THREE.Vector2()
      let scroll = 0
      let elapsed = 0
      let previousTime = 0
      let contextLost = false
      let texture
      let surface
      const geometry = new THREE.PlaneGeometry(1, 1, 64, 40)
      const material = new THREE.MeshBasicMaterial({ transparent: false })
      const pointsGeometry = new THREE.BufferGeometry()
      const count = coarse.matches ? 32 : 86
      const positions = new Float32Array(count * 3)
      const seeds = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        // A repeatable constellation keeps route changes visually stable.
        const rand = (offset) => (Math.sin(i * 127.1 + offset) * 43758.5453) % 1
        positions[i * 3] = rand(3) * 7
        positions[i * 3 + 1] = rand(7) * 3.5
        positions[i * 3 + 2] = Math.abs(rand(13)) * 4
        seeds[i] = Math.abs(rand(31))
      }
      pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      pointsGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
      const pointsMaterial = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() } },
        vertexShader: `
          attribute float aSeed;
          uniform float uTime;
          uniform float uPixelRatio;
          varying float vGlow;
          void main() {
            vec3 p = position;
            p.x += sin(uTime * .15 + aSeed * 31.) * .18;
            p.y += sin(uTime * .22 + aSeed * 17.) * .22;
            vec4 viewPosition = modelViewMatrix * vec4(p, 1.);
            gl_Position = projectionMatrix * viewPosition;
            gl_PointSize = min(14., (1.6 + aSeed * 2.8) * uPixelRatio * 5. / -viewPosition.z);
            vGlow = .22 + .3 * pow(sin(uTime * .55 + aSeed * 40.) * .5 + .5, 2.);
          }`,
        fragmentShader: `
          varying float vGlow;
          void main() {
            float d = length(gl_PointCoord - .5) * 2.;
            float glow = pow(max(0., 1. - d), 2.);
            gl_FragColor = vec4(1., .85, .52, glow * vGlow);
            #include <colorspace_fragment>
          }`
      })
      const points = new THREE.Points(pointsGeometry, pointsMaterial)
      scene.add(points)
      function draw() {
        if (disposed) return
        renderer.render(scene, camera)
      }
      function frame(time) {
        if (disposed) return
        const delta = Math.min((time - (previousTime || time)) / 1000, .05)
        previousTime = time
        elapsed += delta
        const easing = 1 - Math.exp(-delta * 3.5)
        current.lerp(pointer, easing)
        const focus = (stateRef.current.active - 1) * .10
        camera.position.x += (current.x * .28 + focus - camera.position.x) * easing
        camera.position.y += (current.y * .14 + scroll * .08 - camera.position.y) * easing
        camera.position.z += (8 - scroll * .24 - camera.position.z) * easing
        camera.lookAt(0, 0, 0)
        pointsMaterial.uniforms.uTime.value = elapsed
        draw()
      }
      const playback = createScenePlayback({
        start: () => { previousTime = 0; renderer.setAnimationLoop(frame); host.dataset.motion = 'running' },
        stop: () => { renderer.setAnimationLoop(null); host.dataset.motion = 'still' },
        draw
      })
      sceneRef.current = playback
      playback.update({ paused: stateRef.current.paused, reduced: reduced.matches, hidden: document.hidden })
      function resize() {
        const width = host.clientWidth
        const height = host.clientHeight
        if (!width || !height) return
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height, false)
        if (surface && texture?.image) {
          const viewHeight = 2 * Math.tan(THREE.MathUtils.degToRad(20)) * 8
          const imageAspect = texture.image.width / texture.image.height
          const coverHeight = Math.max(viewHeight, viewHeight * camera.aspect / imageAspect) * 1.12
          const coverWidth = coverHeight * imageAspect
          const position = geometry.attributes.position
          const uv = geometry.attributes.uv
          for (let i = 0; i < position.count; i++) {
            const u = uv.getX(i)
            const v = uv.getY(i)
            const near = Math.pow(Math.abs(u - .6) / .6, 1.6) * .7 + Math.pow(1 - v, 3) * .3
            const depth = near * 1.5
            position.setXYZ(i, (u - .5) * coverWidth * (8 - depth) / 8, (v - .5) * coverHeight * (8 - depth) / 8, depth)
          }
          position.needsUpdate = true
          geometry.computeBoundingSphere()
        }
        playback.invalidate()
      }
      function onPointer(event) {
        if (reduced.matches || stateRef.current.paused || event.pointerType === 'touch') return
        const rect = hero.getBoundingClientRect()
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2)
      }
      const resetPointer = () => pointer.set(0, 0)
      const onScroll = () => { scroll = Math.min(1, Math.max(0, -hero.getBoundingClientRect().top / hero.clientHeight)) }
      const onVisibility = () => playback.update({ hidden: document.hidden })
      const onReduced = () => { resetPointer(); playback.update({ reduced: reduced.matches }) }
      const onLost = (event) => {
        event.preventDefault()
        contextLost = true
        playback.update({ ready: false })
        host.dataset.state = 'fallback'
      }
      const onRestored = () => {
        contextLost = false
        resize()
        playback.update({ ready: !!surface })
        host.dataset.state = surface ? 'ready' : 'fallback'
      }
      const resizeObserver = new ResizeObserver(resize)
      const observer = new IntersectionObserver(([entry]) => playback.update({ visible: entry.isIntersecting }), { threshold: 0 })
      resizeObserver.observe(host)
      observer.observe(hero)
      hero.addEventListener('pointermove', onPointer)
      hero.addEventListener('pointerleave', resetPointer)
      window.addEventListener('scroll', onScroll, { passive: true })
      document.addEventListener('visibilitychange', onVisibility)
      reduced.addEventListener('change', onReduced)
      renderer.domElement.addEventListener('webglcontextlost', onLost)
      renderer.domElement.addEventListener('webglcontextrestored', onRestored)
      resize()
      texture = new THREE.TextureLoader().load(forestImage, (loaded) => {
        if (disposed) { loaded.dispose(); return }
        loaded.colorSpace = THREE.SRGBColorSpace
        material.map = loaded
        surface = new THREE.Mesh(geometry, material)
        scene.add(surface)
        resize()
        playback.update({ ready: !contextLost })
        host.dataset.state = contextLost ? 'fallback' : 'ready'
      }, undefined, () => { if (!disposed) host.dataset.state = 'fallback' })
      cleanup = () => {
        playback.dispose()
        sceneRef.current = null
        resizeObserver.disconnect()
        observer.disconnect()
        hero.removeEventListener('pointermove', onPointer)
        hero.removeEventListener('pointerleave', resetPointer)
        window.removeEventListener('scroll', onScroll)
        document.removeEventListener('visibilitychange', onVisibility)
        reduced.removeEventListener('change', onReduced)
        renderer.domElement.removeEventListener('webglcontextlost', onLost)
        renderer.domElement.removeEventListener('webglcontextrestored', onRestored)
        geometry.dispose()
        material.dispose()
        texture?.dispose()
        pointsGeometry.dispose()
        pointsMaterial.dispose()
        renderer.dispose()
        renderer.domElement.remove()
      }
    }).catch(() => { if (!disposed) host.dataset.state = 'fallback' })
    return () => { disposed = true; cleanup() }
  }, [])

  return <div className="forest-scene" aria-hidden="true">
    <img className="forest-scene__image" src={forestImage} alt="" fetchPriority="high" />
    <div className="forest-scene__canvas" data-state="loading" ref={hostRef} />
  </div>
}
