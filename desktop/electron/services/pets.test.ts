import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION,
  CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION,
  CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE,
  CUSTOM_PET_SPRITESHEET_PIXELS,
  createCustomPetFromAtlas,
  createCustomPetCatalogLoader,
  createCustomPetFromImage,
  ensureCustomPetsRoot,
  getPetPackageErrorCode,
  loadCustomPets,
  resolveCustomPetsRoot,
  type CustomPetLoadResult,
  type ImageSizeInspector,
} from './pets'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-pets-'))
  tempDirs.push(dir)
  return dir
}

function pngHeader(width = 1536, height = 2288): Buffer {
  const data = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'ascii')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + payload.length)
  chunk.writeUInt32BE(payload.length, 0)
  chunk.write(type, 4, 'ascii')
  payload.copy(chunk, 8)
  return chunk
}

function apngHeader(width = 1536, height = 2288): Buffer {
  const ihdrPayload = Buffer.alloc(13)
  ihdrPayload.writeUInt32BE(width, 0)
  ihdrPayload.writeUInt32BE(height, 4)
  const animationControl = Buffer.alloc(8)
  animationControl.writeUInt32BE(2, 0)
  animationControl.writeUInt32BE(0, 4)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdrPayload),
    pngChunk('acTL', animationControl),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function webpHeader(width = 1536, height = 2288): Buffer {
  const data = Buffer.alloc(30)
  data.write('RIFF', 0, 'ascii')
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WEBP', 8, 'ascii')
  data.write('VP8X', 12, 'ascii')
  data.writeUInt32LE(10, 16)
  data.writeUIntLE(width - 1, 24, 3)
  data.writeUIntLE(height - 1, 27, 3)
  return data
}

function animatedWebpHeader(kind: 'flag' | 'ANIM' | 'ANMF'): Buffer {
  const header = webpHeader()
  if (kind === 'flag') {
    header[20] = header[20]! | 0x02
    return header
  }

  const animationChunk = Buffer.alloc(8)
  animationChunk.write(kind, 0, 'ascii')
  animationChunk.writeUInt32LE(0, 4)
  const data = Buffer.concat([header, animationChunk])
  data.writeUInt32LE(data.length - 8, 4)
  return data
}

type PetManifest = {
  displayName: string
  description: string
  spriteVersionNumber: number
  spritesheetPath: string
  [key: string]: unknown
}

type SingleImageManifest = {
  displayName: string
  description: string
  manifestVersion: number
  renderer: {
    kind: string
    version: number
    imagePath: string
    motionProfile?: string
  }
  [key: string]: unknown
}

function validManifest(overrides: Partial<PetManifest> = {}): PetManifest {
  return {
    displayName: 'Pixel Pal',
    description: 'A tiny test companion.',
    spriteVersionNumber: 2,
    spritesheetPath: 'spritesheet.webp',
    ...overrides,
  }
}

function writePet(
  root: string,
  entry: string,
  manifest: PetManifest = validManifest(),
  image: Buffer = webpHeader(),
): string {
  const petDir = path.join(root, entry)
  fs.mkdirSync(petDir, { recursive: true })
  fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(manifest))
  const imagePath = path.join(petDir, manifest.spritesheetPath)
  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, image)
  return petDir
}

function validSingleImageManifest(
  overrides: Partial<SingleImageManifest> = {},
): SingleImageManifest {
  return {
    displayName: 'Spring Pal',
    description: 'A locally animated single-image companion.',
    manifestVersion: CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION,
    renderer: {
      kind: 'single-image',
      version: 1,
      imagePath: 'pet.webp',
      motionProfile: CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE,
    },
    ...overrides,
  }
}

function writeSingleImagePet(
  root: string,
  entry: string,
  manifest: SingleImageManifest = validSingleImageManifest(),
  image: Buffer = webpHeader(512, 640),
): string {
  const petDir = path.join(root, entry)
  fs.mkdirSync(petDir, { recursive: true })
  fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(manifest))
  const renderer = manifest.renderer as SingleImageManifest['renderer'] | undefined
  const relativeImagePath = typeof renderer?.imagePath === 'string' && !renderer.imagePath.includes('..')
    ? renderer.imagePath
    : 'pet.webp'
  const imagePath = path.join(petDir, relativeImagePath)
  fs.mkdirSync(path.dirname(imagePath), { recursive: true })
  fs.writeFileSync(imagePath, image)
  return petDir
}

const validSizeInspector: ImageSizeInspector = vi.fn(async () => ({ width: 1536, height: 2288 }))

afterEach(() => {
  vi.clearAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('custom pet root', () => {
  it('uses CLAUDE_CONFIG_DIR and never derives the runtime root from CODEX_HOME', () => {
    expect(resolveCustomPetsRoot({
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/forbidden-codex-home',
      },
      homeDir: '/Users/test',
    })).toBe(path.resolve('/tmp/claude-config/cc-haha/pets'))

    expect(resolveCustomPetsRoot({
      env: { CODEX_HOME: '/tmp/forbidden-codex-home' },
      homeDir: '/Users/test',
    })).toBe(path.resolve('/Users/test/.claude/cc-haha/pets'))
  })

  it('creates and returns the isolated custom-pets directory using only filesystem APIs', async () => {
    const homeDir = makeTempDir()
    const root = await ensureCustomPetsRoot({ env: {}, homeDir })

    expect(root).toBe(path.join(homeDir, '.claude', 'cc-haha', 'pets'))
    expect(fs.statSync(root).isDirectory()).toBe(true)
  })
})

describe('custom pet catalog loading', () => {
  it('shares one bounded loader invocation across concurrent IPC requests', async () => {
    let finish: ((result: { root: string; pets: []; errors: [] }) => void) | undefined
    const load = vi.fn(() => new Promise<{ root: string; pets: []; errors: [] }>((resolve) => {
      finish = resolve
    }))
    const loadCatalog = createCustomPetCatalogLoader(load)

    const first = loadCatalog()
    const second = loadCatalog()
    expect(second).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)

    finish?.({ root: '/owned/pets', pets: [], errors: [] })
    await Promise.all([first, second])
    await Promise.resolve()

    const third = loadCatalog()
    expect(load).toHaveBeenCalledTimes(2)
    finish?.({ root: '/owned/pets', pets: [], errors: [] })
    await third
  })

  it('starts a fresh scan after an overlapping pet installation invalidates the catalog', async () => {
    type DeferredCatalog = {
      promise: Promise<CustomPetLoadResult>
      resolve: (result: CustomPetLoadResult) => void
    }
    const scans: DeferredCatalog[] = []
    const load = vi.fn(() => {
      let resolve!: DeferredCatalog['resolve']
      const promise = new Promise<Awaited<DeferredCatalog['promise']>>(finish => {
        resolve = finish
      })
      scans.push({ promise, resolve })
      return promise
    })
    const loadCatalog = createCustomPetCatalogLoader(load)
    let finishInstall: (() => void) | undefined

    const beforeInstall = loadCatalog()
    const install = loadCatalog.invalidateAfter(() => new Promise<void>(resolve => {
      finishInstall = resolve
    }))
    expect(loadCatalog()).toBe(beforeInstall)

    finishInstall?.()
    await install
    const afterInstall = loadCatalog()

    expect(afterInstall).not.toBe(beforeInstall)
    expect(load).toHaveBeenCalledTimes(2)

    scans[0]!.resolve({ root: '/owned/pets', pets: [], errors: [] })
    await expect(beforeInstall).resolves.toEqual({ root: '/owned/pets', pets: [], errors: [] })
    expect(loadCatalog()).toBe(afterInstall)

    scans[1]!.resolve({
      root: '/owned/pets',
      pets: [{
        id: 'custom:new-pet',
        displayName: 'New Pet',
        description: 'Installed while the first scan was in flight.',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.webp',
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,AA==',
      }],
      errors: [],
    })
    await expect(afterInstall).resolves.toEqual({
      root: '/owned/pets',
      pets: [{
        id: 'custom:new-pet',
        displayName: 'New Pet',
        description: 'Installed while the first scan was in flight.',
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.webp',
        mimeType: 'image/webp',
        dataUrl: 'data:image/webp;base64,AA==',
      }],
      errors: [],
    })
  })
})

describe('createCustomPetFromAtlas', () => {
  it('installs a validated atlas atomically into the app-owned pet root', async () => {
    const homeDir = makeTempDir()
    const atlasPath = path.join(homeDir, 'chosen.webp')
    fs.writeFileSync(atlasPath, webpHeader())

    const pet = await createCustomPetFromAtlas({
      slug: 'tiny-orbit',
      displayName: 'Tiny Orbit',
      description: 'A focused little companion.',
      atlasPath,
    }, {
      env: { CODEX_HOME: path.join(homeDir, 'forbidden-codex-home') },
      homeDir,
      inspectImageSize: validSizeInspector,
    })

    const root = path.join(homeDir, '.claude', 'cc-haha', 'pets')
    expect(pet.id).toBe('custom:tiny-orbit')
    expect(fs.existsSync(path.join(homeDir, 'forbidden-codex-home'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'tiny-orbit', 'pet.json'), 'utf-8'))).toEqual({
      id: 'tiny-orbit',
      displayName: 'Tiny Orbit',
      description: 'A focused little companion.',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
    })
    expect(fs.readFileSync(path.join(root, 'tiny-orbit', 'spritesheet.webp'))).toEqual(webpHeader())
  })

  it('rejects duplicate IDs and invalid or symlinked atlases without replacing an installed pet', async () => {
    const root = makeTempDir()
    const atlasPath = path.join(root, 'chosen.png')
    fs.writeFileSync(atlasPath, pngHeader())
    const input = {
      slug: 'safe-pet',
      displayName: 'Safe Pet',
      description: 'Created locally.',
      atlasPath,
    }
    await createCustomPetFromAtlas(input, { root, inspectImageSize: validSizeInspector })

    await expect(createCustomPetFromAtlas(input, {
      root,
      inspectImageSize: validSizeInspector,
    })).rejects.toThrow('already exists')
    expect(fs.readFileSync(path.join(root, 'safe-pet', 'spritesheet.png'))).toEqual(pngHeader())

    const symlinkPath = path.join(root, 'linked.png')
    fs.symlinkSync(atlasPath, symlinkPath)
    await expect(createCustomPetFromAtlas({
      ...input,
      slug: 'linked-pet',
      atlasPath: symlinkPath,
    }, { root, inspectImageSize: validSizeInspector })).rejects.toThrow('cannot be a symlink')
    expect(fs.existsSync(path.join(root, 'linked-pet'))).toBe(false)

    await expect(createCustomPetFromAtlas({
      ...input,
      slug: '../escape',
    }, { root, inspectImageSize: validSizeInspector })).rejects.toThrow('lowercase kebab-case')
  })
})

describe('createCustomPetFromImage', () => {
  it('installs a validated static image atomically with a versioned renderer manifest', async () => {
    const homeDir = makeTempDir()
    const imagePath = path.join(homeDir, 'chosen.webp')
    fs.writeFileSync(imagePath, webpHeader(512, 640))

    const pet = await createCustomPetFromImage({
      slug: 'spring-orbit',
      displayName: 'Spring Orbit',
      description: 'A smooth local companion.',
      imagePath,
    }, {
      env: { CODEX_HOME: path.join(homeDir, 'forbidden-codex-home') },
      homeDir,
      inspectImageSize: async () => ({ width: 512, height: 640 }),
    })

    const root = path.join(homeDir, '.claude', 'cc-haha', 'pets')
    expect(pet).toMatchObject({
      id: 'custom:spring-orbit',
      manifestVersion: 1,
      spriteVersionNumber: 1,
      imagePath: 'pet.webp',
      motionProfile: CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE,
      mimeType: 'image/webp',
    })
    expect(fs.existsSync(path.join(homeDir, 'forbidden-codex-home'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'spring-orbit', 'pet.json'), 'utf-8'))).toEqual({
      id: 'spring-orbit',
      displayName: 'Spring Orbit',
      description: 'A smooth local companion.',
      manifestVersion: 1,
      renderer: {
        kind: 'single-image',
        version: 1,
        imagePath: 'pet.webp',
        motionProfile: CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE,
      },
    })
    expect(fs.readFileSync(path.join(root, 'spring-orbit', 'pet.webp'))).toEqual(
      webpHeader(512, 640),
    )
    expect(fs.readdirSync(path.dirname(root)).some(entry => entry.startsWith('.pet-install-'))).toBe(false)
  })

  it('rejects duplicate IDs, symlinked sources, and failed validation without partial installs', async () => {
    const root = makeTempDir()
    const imagePath = path.join(root, 'chosen.png')
    fs.writeFileSync(imagePath, pngHeader(512, 640))
    const input = {
      slug: 'safe-image',
      displayName: 'Safe Image',
      description: 'Created locally.',
      imagePath,
    }

    await createCustomPetFromImage(input, {
      root,
      inspectImageSize: async () => ({ width: 512, height: 640 }),
    })
    await expect(createCustomPetFromImage(input, {
      root,
      inspectImageSize: async () => ({ width: 512, height: 640 }),
    })).rejects.toThrow('already exists')
    expect(fs.readFileSync(path.join(root, 'safe-image', 'pet.png'))).toEqual(pngHeader(512, 640))

    const symlinkPath = path.join(root, 'linked.png')
    fs.symlinkSync(imagePath, symlinkPath)
    await expect(createCustomPetFromImage({
      ...input,
      slug: 'linked-image',
      imagePath: symlinkPath,
    }, { root })).rejects.toThrow('cannot be a symlink')
    expect(fs.existsSync(path.join(root, 'linked-image'))).toBe(false)

    const animatedPath = path.join(root, 'animated.png')
    fs.writeFileSync(animatedPath, apngHeader(512, 640))
    await expect(createCustomPetFromImage({
      ...input,
      slug: 'animated-image',
      imagePath: animatedPath,
    }, {
      root,
      inspectImageSize: async () => ({ width: 512, height: 640 }),
    })).rejects.toThrow('static PNG or WebP')
    expect(fs.existsSync(path.join(root, 'animated-image'))).toBe(false)
    expect(fs.readdirSync(path.dirname(root)).some(entry => entry.startsWith('.pet-install-'))).toBe(false)
  })

  it('rejects unsupported motion profiles and unsafe image geometry before installation', async () => {
    const root = makeTempDir()
    const hugeImagePath = path.join(root, 'huge.webp')
    fs.writeFileSync(
      hugeImagePath,
      webpHeader(CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION + 1, 64),
    )

    const geometryError = await createCustomPetFromImage({
      slug: 'huge-image',
      displayName: 'Huge Image',
      description: 'Too large.',
      imagePath: hugeImagePath,
    }, { root }).then(() => null, error => error)
    expect(geometryError).toBeInstanceOf(Error)
    expect((geometryError as Error).message).toContain('between 32 and 4096 pixels')
    expect(getPetPackageErrorCode(geometryError)).toBe('invalid-image-dimensions')
    expect(getPetPackageErrorCode(new Error('unexpected'))).toBe('io-error')
    expect(fs.existsSync(path.join(root, 'huge-image'))).toBe(false)

    await expect(createCustomPetFromImage({
      slug: 'unknown-motion',
      displayName: 'Unknown Motion',
      description: 'Unsupported motion.',
      imagePath: hugeImagePath,
      motionProfile: 'unknown-profile' as typeof CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE,
    }, { root })).rejects.toThrow('motion profile is unsupported')
    expect(fs.existsSync(path.join(root, 'unknown-motion'))).toBe(false)
  })
})

describe('loadCustomPets', () => {
  it('loads legacy v2 atlases and manifest-v1 single images without changing atlas metadata', async () => {
    const root = makeTempDir()
    writePet(root, 'atlas-pal')
    writeSingleImagePet(root, 'spring-pal')

    const result = await loadCustomPets({ root })

    expect(result.errors).toEqual([])
    expect(result.pets).toEqual([{
      id: 'custom:atlas-pal',
      displayName: 'Pixel Pal',
      description: 'A tiny test companion.',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
      mimeType: 'image/webp',
      dataUrl: `data:image/webp;base64,${webpHeader().toString('base64')}`,
    }, {
      id: 'custom:spring-pal',
      displayName: 'Spring Pal',
      description: 'A locally animated single-image companion.',
      manifestVersion: 1,
      spriteVersionNumber: 1,
      imagePath: 'pet.webp',
      motionProfile: CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE,
      mimeType: 'image/webp',
      dataUrl: `data:image/webp;base64,${webpHeader(512, 640).toString('base64')}`,
    }])
  })

  it.each([
    ['future manifest', { manifestVersion: 2 }, 'invalid-manifest-version'],
    ['missing renderer', { renderer: undefined }, 'invalid-renderer'],
    ['wrong renderer kind', { renderer: { ...validSingleImageManifest().renderer, kind: 'video' } }, 'invalid-renderer'],
    ['unsafe image path', { renderer: { ...validSingleImageManifest().renderer, imagePath: '../pet.webp' } }, 'invalid-image-path'],
    ['unsupported format', { renderer: { ...validSingleImageManifest().renderer, imagePath: 'pet.gif' } }, 'unsupported-image-format'],
    ['unsupported motion', { renderer: { ...validSingleImageManifest().renderer, motionProfile: 'jitter-v9' } }, 'invalid-renderer'],
  ])('rejects a single-image package with %s', async (_label, overrides, code) => {
    const root = makeTempDir()
    writeSingleImagePet(root, 'bad-image', validSingleImageManifest(
      overrides as Partial<SingleImageManifest>,
    ))

    const result = await loadCustomPets({ root })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'bad-image', code }),
    ])
  })

  it('rejects symlinked and animated single-image assets before runtime decoding', async () => {
    const root = makeTempDir()
    const outside = makeTempDir()
    const linkedDir = path.join(root, 'linked-image')
    fs.mkdirSync(linkedDir)
    fs.writeFileSync(path.join(linkedDir, 'pet.json'), JSON.stringify(validSingleImageManifest()))
    fs.writeFileSync(path.join(outside, 'pet.webp'), webpHeader(512, 640))
    fs.symlinkSync(path.join(outside, 'pet.webp'), path.join(linkedDir, 'pet.webp'))
    writeSingleImagePet(
      root,
      'animated-image',
      validSingleImageManifest({
        renderer: {
          ...validSingleImageManifest().renderer,
          imagePath: 'pet.png',
        },
      }),
      apngHeader(512, 640),
    )
    const inspectImageSize = vi.fn(async () => ({ width: 512, height: 640 }))

    const result = await loadCustomPets({ root, inspectImageSize })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: 'linked-image', code: 'symlink-image' }),
      expect.objectContaining({ entry: 'animated-image', code: 'invalid-image' }),
    ]))
    expect(inspectImageSize).not.toHaveBeenCalled()
  })

  it('charges a single image by its actual decoded pixels and rejects decoder/header mismatch', async () => {
    const root = makeTempDir()
    writeSingleImagePet(root, 'image-a', validSingleImageManifest(), webpHeader(512, 640))
    writeSingleImagePet(root, 'image-b', validSingleImageManifest(), webpHeader(512, 640))

    const budgetedInspector = vi.fn(async () => ({ width: 512, height: 640 }))
    const budgeted = await loadCustomPets({
      root,
      inspectImageSize: budgetedInspector,
      maxDecodedPixels: 512 * 640,
    })
    expect(budgeted.pets.map(pet => pet.id)).toEqual(['custom:image-a'])
    expect(budgeted.errors).toContainEqual(expect.objectContaining({
      entry: 'image-b',
      code: 'decode-budget-exceeded',
    }))
    expect(budgetedInspector).toHaveBeenCalledTimes(1)

    const mismatched = await loadCustomPets({
      root,
      inspectImageSize: async () => ({ width: 640, height: 512 }),
    })
    expect(mismatched.pets).toEqual([])
    expect(mismatched.errors.every(error => error.code === 'invalid-image')).toBe(true)
  })

  it('bounds native decode attempts even when compressed images are tiny', async () => {
    const root = makeTempDir()
    for (const entry of ['pet-a', 'pet-b', 'pet-c']) writePet(root, entry)
    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

    const result = await loadCustomPets({
      root,
      inspectImageSize,
      maxDecodedPixels: CUSTOM_PET_SPRITESHEET_PIXELS * 2,
    })

    expect(result.pets.map((pet) => pet.id)).toEqual(['custom:pet-a', 'custom:pet-b'])
    expect(inspectImageSize).toHaveBeenCalledTimes(2)
    expect(result.errors).toContainEqual(expect.objectContaining({
      entry: 'pet-c',
      code: 'decode-budget-exceeded',
    }))
  })

  it('loads valid direct-child packages as whitelisted metadata and an image data URL', async () => {
    const root = makeTempDir()
    writePet(root, 'pixel-pal', validManifest({
      displayName: '  Pixel Pal  ',
      description: '  A tiny test companion.  ',
      extraField: '<script>not returned</script>',
    }))

    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))
    const result = await loadCustomPets({ root, inspectImageSize })

    expect(result.errors).toEqual([])
    expect(result.pets).toEqual([{
      id: 'custom:pixel-pal',
      displayName: 'Pixel Pal',
      description: 'A tiny test companion.',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
      mimeType: 'image/webp',
      dataUrl: `data:image/webp;base64,${webpHeader().toString('base64')}`,
    }])
    expect(inspectImageSize).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.any(Buffer),
      mimeType: 'image/webp',
    }))
  })

  it('keeps loading valid packages when another package is malformed', async () => {
    const root = makeTempDir()
    writePet(root, 'good-pet')
    const badDir = path.join(root, 'bad-pet')
    fs.mkdirSync(badDir)
    fs.writeFileSync(path.join(badDir, 'pet.json'), '{bad json')

    const result = await loadCustomPets({ root, inspectImageSize: validSizeInspector })

    expect(result.pets.map(pet => pet.id)).toEqual(['custom:good-pet'])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'bad-pet', code: 'invalid-manifest' }),
    ])
    expect(JSON.stringify(result.errors)).not.toContain(root)
  })

  it.each([
    ['wrong sprite version', { spriteVersionNumber: 1 }, 'invalid-sprite-version'],
    ['absolute POSIX path', { spritesheetPath: '/tmp/pet.webp' }, 'invalid-spritesheet-path'],
    ['absolute Windows path', { spritesheetPath: 'C:\\tmp\\pet.webp' }, 'invalid-spritesheet-path'],
    ['parent traversal', { spritesheetPath: '../pet.webp' }, 'invalid-spritesheet-path'],
    ['backslash traversal', { spritesheetPath: '..\\pet.webp' }, 'invalid-spritesheet-path'],
    ['unsupported image format', { spritesheetPath: 'spritesheet.gif' }, 'unsupported-image-format'],
  ])('rejects %s', async (_label, overrides, code) => {
    const root = makeTempDir()
    const petDir = path.join(root, 'bad-pet')
    fs.mkdirSync(petDir)
    fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(validManifest(overrides)))

    const result = await loadCustomPets({ root, inspectImageSize: validSizeInspector })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'bad-pet', code }),
    ])
  })

  it.each([
    ['Uppercase', 'invalid-id'],
    [`p${'a'.repeat(73)}`, 'invalid-id'],
    ['two--dashes', 'invalid-id'],
  ])('rejects an unsafe or overlong package slug %s', async (entry, code) => {
    const root = makeTempDir()
    writePet(root, entry)

    const result = await loadCustomPets({ root, inspectImageSize: validSizeInspector })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry, code }),
    ])
  })

  it('rejects a package directory symlink', async () => {
    const root = makeTempDir()
    const outside = makeTempDir()
    writePet(outside, 'target')
    fs.symlinkSync(path.join(outside, 'target'), path.join(root, 'linked-pet'), 'dir')

    const result = await loadCustomPets({ root, inspectImageSize: validSizeInspector })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'linked-pet', code: 'symlink-entry' }),
    ])
  })

  it.each(['manifest', 'image', 'nested-directory'])('rejects a symlinked %s', async target => {
    const root = makeTempDir()
    const outside = makeTempDir()
    const petDir = path.join(root, 'linked-content')
    fs.mkdirSync(petDir)

    if (target === 'manifest') {
      fs.writeFileSync(path.join(outside, 'pet.json'), JSON.stringify(validManifest()))
      fs.symlinkSync(path.join(outside, 'pet.json'), path.join(petDir, 'pet.json'))
      fs.writeFileSync(path.join(petDir, 'spritesheet.webp'), webpHeader())
    } else if (target === 'image') {
      fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(validManifest()))
      fs.writeFileSync(path.join(outside, 'spritesheet.webp'), webpHeader())
      fs.symlinkSync(path.join(outside, 'spritesheet.webp'), path.join(petDir, 'spritesheet.webp'))
    } else {
      fs.writeFileSync(path.join(petDir, 'pet.json'), JSON.stringify(validManifest({
        spritesheetPath: 'assets/spritesheet.webp',
      })))
      fs.mkdirSync(path.join(outside, 'assets'))
      fs.writeFileSync(path.join(outside, 'assets', 'spritesheet.webp'), webpHeader())
      fs.symlinkSync(path.join(outside, 'assets'), path.join(petDir, 'assets'), 'dir')
    }

    const result = await loadCustomPets({ root, inspectImageSize: validSizeInspector })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'linked-content', code: expect.stringContaining('symlink') }),
    ])
  })

  it('derives collision-free ids from folder slugs and ignores untrusted manifest id fields', async () => {
    const root = makeTempDir()
    writePet(root, 'first', validManifest({ id: 'same-id' }))
    writePet(root, 'second', validManifest({ id: 'same-id' }))

    const result = await loadCustomPets({ root, inspectImageSize: validSizeInspector })

    expect(result.errors).toEqual([])
    expect(result.pets.map(pet => pet.id)).toEqual(['custom:first', 'custom:second'])
  })

  it('rejects malformed, mismatched, oversized, and wrongly sized images per package', async () => {
    const root = makeTempDir()
    writePet(root, 'good')
    writePet(root, 'bad-magic', validManifest(), Buffer.from('not a webp'))
    writePet(root, 'too-large', validManifest(), Buffer.concat([webpHeader(), Buffer.alloc(64)]))
    writePet(root, 'wrong-size', validManifest(), webpHeader(1536, 1872))
    const inspectImageSize = vi.fn(async ({ data }: { data: Buffer }) => {
      if (data.equals(webpHeader(1536, 1872))) return { width: 1536, height: 1872 }
      return { width: 1536, height: 2288 }
    })

    const result = await loadCustomPets({
      root,
      inspectImageSize,
      maxImageBytes: webpHeader().length + 1,
    })

    expect(result.pets.map(pet => pet.id)).toEqual(['custom:good'])
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: 'bad-magic', code: 'invalid-image' }),
      expect.objectContaining({ entry: 'too-large', code: 'image-too-large' }),
      expect.objectContaining({ entry: 'wrong-size', code: 'invalid-image-dimensions' }),
    ]))
  })

  it('rejects a giant declared canvas before invoking the runtime image decoder', async () => {
    const root = makeTempDir()
    writePet(root, 'decode-bomb', validManifest(), webpHeader(65_536, 65_536))
    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

    const result = await loadCustomPets({ root, inspectImageSize })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'decode-bomb', code: 'invalid-image-dimensions' }),
    ])
    expect(inspectImageSize).not.toHaveBeenCalled()
  })

  it('rejects APNG spritesheets before invoking the runtime image decoder', async () => {
    const root = makeTempDir()
    writePet(root, 'animated-png', validManifest({
      spritesheetPath: 'spritesheet.png',
    }), apngHeader())
    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

    const result = await loadCustomPets({ root, inspectImageSize })

    expect(result.pets).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'animated-png', code: 'invalid-image' }),
    ])
    expect(inspectImageSize).not.toHaveBeenCalled()
  })

  it.each(['flag', 'ANIM', 'ANMF'] as const)(
    'rejects animated WebP spritesheets identified by %s before runtime decoding',
    async animationMarker => {
      const root = makeTempDir()
      writePet(root, 'animated-webp', validManifest(), animatedWebpHeader(animationMarker))
      const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

      const result = await loadCustomPets({ root, inspectImageSize })

      expect(result.pets).toEqual([])
      expect(result.errors).toEqual([
        expect.objectContaining({ entry: 'animated-webp', code: 'invalid-image' }),
      ])
      expect(inspectImageSize).not.toHaveBeenCalled()
    },
  )

  it('caps manifest bytes, total image bytes, and scanned entries', async () => {
    const root = makeTempDir()
    writePet(root, 'a')
    writePet(root, 'b')
    writePet(root, 'c')

    const entryLimited = await loadCustomPets({ root, inspectImageSize: validSizeInspector, maxEntries: 1 })
    expect(entryLimited.pets).toHaveLength(1)
    expect(entryLimited.errors).toContainEqual(expect.objectContaining({ code: 'entry-limit' }))

    const manifestLimited = await loadCustomPets({ root, inspectImageSize: validSizeInspector, maxManifestBytes: 8 })
    expect(manifestLimited.pets).toEqual([])
    expect(manifestLimited.errors).toHaveLength(3)
    expect(manifestLimited.errors.every(error => error.code === 'manifest-too-large')).toBe(true)

    const totalLimited = await loadCustomPets({
      root,
      inspectImageSize: validSizeInspector,
      maxTotalImageBytes: webpHeader().length,
    })
    expect(totalLimited.pets).toHaveLength(1)
    expect(totalLimited.errors.filter(error => error.code === 'total-image-bytes-exceeded')).toHaveLength(2)
  })

  it('stops manifest IO and image decoding after the cumulative read budget is exhausted', async () => {
    const root = makeTempDir()
    writePet(root, 'pet-00')
    writePet(root, 'pet-01')
    for (let index = 2; index < 32; index += 1) {
      fs.mkdirSync(path.join(root, `pet-${index.toString().padStart(2, '0')}`))
    }
    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

    const result = await loadCustomPets({
      root,
      inspectImageSize,
      maxTotalImageBytes: webpHeader().length * 2,
    })

    expect(result.pets.map(pet => pet.id)).toEqual(['custom:pet-00', 'custom:pet-01'])
    expect(inspectImageSize).toHaveBeenCalledTimes(2)
    expect(result.errors).toHaveLength(30)
    expect(result.errors.every(error => error.code === 'total-image-bytes-exceeded')).toBe(true)
  })

  it('charges malformed image reads to the cumulative budget before decode', async () => {
    const root = makeTempDir()
    writePet(root, 'pet-00', validManifest(), Buffer.alloc(20, 0x41))
    writePet(root, 'pet-01', validManifest(), Buffer.alloc(20, 0x42))
    fs.mkdirSync(path.join(root, 'pet-02'))
    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

    const result = await loadCustomPets({
      root,
      inspectImageSize,
      maxTotalImageBytes: 40,
    })

    expect(result.pets).toEqual([])
    expect(inspectImageSize).not.toHaveBeenCalled()
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'pet-00', code: 'invalid-image' }),
      expect.objectContaining({ entry: 'pet-01', code: 'invalid-image' }),
      expect.objectContaining({ entry: 'pet-02', code: 'total-image-bytes-exceeded' }),
    ])
  })

  it('caps the aggregate base64 data sent over IPC before reading another image', async () => {
    const root = makeTempDir()
    writePet(root, 'pet-00')
    writePet(root, 'pet-01')
    const firstDataUrl = `data:image/webp;base64,${webpHeader().toString('base64')}`
    const inspectImageSize = vi.fn(async () => ({ width: 1536, height: 2288 }))

    const result = await loadCustomPets({
      root,
      inspectImageSize,
      maxTotalDataUrlBytes: firstDataUrl.length,
    })

    expect(result.pets.map(pet => pet.id)).toEqual(['custom:pet-00'])
    expect(result.pets.reduce((total, pet) => total + pet.dataUrl.length, 0)).toBeLessThanOrEqual(
      firstDataUrl.length,
    )
    expect(inspectImageSize).toHaveBeenCalledTimes(1)
    expect(result.errors).toEqual([
      expect.objectContaining({ entry: 'pet-01', code: 'total-image-bytes-exceeded' }),
    ])
  })

  it.each(['root', 'package', 'intermediate'] as const)(
    'rejects a %s directory replaced while an image is being decoded',
    async replacedDirectory => {
      const root = makeTempDir()
      const spritesheetPath = replacedDirectory === 'intermediate'
        ? 'assets/spritesheet.webp'
        : 'spritesheet.webp'
      const petDir = writePet(root, 'swap-pet', validManifest({ spritesheetPath }))
      const inspectImageSize = vi.fn(async () => {
        if (replacedDirectory === 'root') {
          const backup = `${root}-original`
          fs.renameSync(root, backup)
          tempDirs.push(backup)
          fs.mkdirSync(root)
        } else if (replacedDirectory === 'package') {
          fs.renameSync(petDir, path.join(root, 'swap-pet-original'))
          fs.mkdirSync(petDir)
        } else {
          const assetsDir = path.join(petDir, 'assets')
          fs.renameSync(assetsDir, path.join(petDir, 'assets-original'))
          fs.mkdirSync(assetsDir)
        }
        return { width: 1536, height: 2288 }
      })

      const result = await loadCustomPets({ root, inspectImageSize })

      expect(result.pets).toEqual([])
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          entry: 'swap-pet',
          code: replacedDirectory === 'root' ? 'root-invalid' : 'directory-changed',
        }),
      ]))
    },
  )

  it('uses a bounded built-in PNG/WebP header inspector when no runtime inspector is injected', async () => {
    const root = makeTempDir()
    writePet(root, 'png-pet', validManifest({
      spritesheetPath: 'spritesheet.png',
    }), pngHeader())
    writePet(root, 'webp-pet', validManifest(), webpHeader())

    const result = await loadCustomPets({ root })

    expect(result.errors).toEqual([])
    expect(result.pets.map(pet => pet.id)).toEqual(['custom:png-pet', 'custom:webp-pet'])
  })
})
