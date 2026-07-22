import { constants, type Dirent } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const CUSTOM_PET_SPRITESHEET_WIDTH = 1536
export const CUSTOM_PET_SPRITESHEET_HEIGHT = 2288
export const CUSTOM_PET_SPRITESHEET_PIXELS =
  CUSTOM_PET_SPRITESHEET_WIDTH * CUSTOM_PET_SPRITESHEET_HEIGHT
export const CUSTOM_PET_SINGLE_IMAGE_MIN_DIMENSION = 32
export const CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION = 4096
export const CUSTOM_PET_SINGLE_IMAGE_MAX_PIXELS =
  CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION * CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION
export const CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION = 1
export const CUSTOM_PET_SINGLE_IMAGE_RENDERER_VERSION = 1
export const CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE = 'soft-spring-v1' as const
export const CUSTOM_PET_FOLDER_MAX_LENGTH = 73
export const DEFAULT_CUSTOM_PET_MAX_ENTRIES = 128
export const DEFAULT_CUSTOM_PET_MAX_DECODED_PIXELS = CUSTOM_PET_SPRITESHEET_PIXELS * 16
export const DEFAULT_CUSTOM_PET_MAX_MANIFEST_BYTES = 64 * 1024
export const DEFAULT_CUSTOM_PET_MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const DEFAULT_CUSTOM_PET_MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024
export const DEFAULT_CUSTOM_PET_MAX_TOTAL_DATA_URL_BYTES = 12 * 1024 * 1024

const MAX_DISPLAY_NAME_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 500
const MAX_IMAGE_PATH_LENGTH = 512
const MIN_CUSTOM_PET_IMAGE_BYTES = 20
const PET_FOLDER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export type CustomPetImageMimeType = 'image/png' | 'image/webp'

export type ImageSize = {
  width: number
  height: number
}

export type ImageSizeInspectorInput = {
  data: Buffer
  mimeType: CustomPetImageMimeType
}

export type ImageSizeInspector = (
  input: ImageSizeInspectorInput,
) => ImageSize | Promise<ImageSize>

type LoadedCustomPetBase = {
  id: string
  displayName: string
  description: string
  mimeType: CustomPetImageMimeType
  dataUrl: string
}

export type LoadedCustomAtlasPet = LoadedCustomPetBase & {
  spriteVersionNumber: 2
  spritesheetPath: string
}

export type LoadedCustomImagePet = LoadedCustomPetBase & {
  manifestVersion: 1
  spriteVersionNumber: 1
  imagePath: string
  motionProfile: typeof CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE
}

export type LoadedCustomPet = LoadedCustomAtlasPet | LoadedCustomImagePet

export type CustomPetLoadErrorCode =
  | 'root-invalid'
  | 'entry-limit'
  | 'invalid-id'
  | 'symlink-entry'
  | 'missing-manifest'
  | 'symlink-manifest'
  | 'manifest-too-large'
  | 'invalid-manifest'
  | 'invalid-display-name'
  | 'invalid-description'
  | 'invalid-manifest-version'
  | 'invalid-renderer'
  | 'invalid-sprite-version'
  | 'invalid-spritesheet-path'
  | 'invalid-image-path'
  | 'unsupported-image-format'
  | 'missing-image'
  | 'symlink-image'
  | 'image-too-large'
  | 'total-image-bytes-exceeded'
  | 'decode-budget-exceeded'
  | 'invalid-image'
  | 'invalid-image-dimensions'
  | 'duplicate-id'
  | 'directory-changed'
  | 'io-error'

export type CustomPetLoadError = {
  entry?: string
  code: CustomPetLoadErrorCode
  message: string
}

export type CustomPetLoadResult = {
  root: string
  pets: LoadedCustomPet[]
  errors: CustomPetLoadError[]
}

export type CustomPetCatalogLoader = (() => Promise<CustomPetLoadResult>) & {
  invalidate: () => void
  invalidateAfter: <T>(mutation: () => Promise<T>) => Promise<T>
}

export function createCustomPetCatalogLoader(
  load: () => Promise<CustomPetLoadResult>,
): CustomPetCatalogLoader {
  let inFlight: Promise<CustomPetLoadResult> | null = null
  const loadCatalog = (() => {
    if (inFlight) return inFlight
    const current = load()
    inFlight = current
    void current.finally(() => {
      if (inFlight === current) inFlight = null
    }).catch(() => undefined)
    return current
  }) as CustomPetCatalogLoader
  loadCatalog.invalidate = () => {
    inFlight = null
  }
  loadCatalog.invalidateAfter = async mutation => {
    const result = await mutation()
    loadCatalog.invalidate()
    return result
  }
  return loadCatalog
}

export type CustomPetsRootOptions = {
  root?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

export type LoadCustomPetsOptions = CustomPetsRootOptions & {
  inspectImageSize?: ImageSizeInspector
  maxEntries?: number
  maxManifestBytes?: number
  maxImageBytes?: number
  maxTotalImageBytes?: number
  maxTotalDataUrlBytes?: number
  maxDecodedPixels?: number
}

export type CreateCustomPetFromAtlasInput = {
  slug: string
  displayName: string
  description: string
  atlasPath: string
}

export type CreateCustomPetFromAtlasOptions = CustomPetsRootOptions & {
  inspectImageSize?: ImageSizeInspector
}

export type CreateCustomPetFromImageInput = {
  slug: string
  displayName: string
  description: string
  imagePath: string
  motionProfile?: typeof CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE
}

export type CreateCustomPetFromImageOptions = CustomPetsRootOptions & {
  inspectImageSize?: ImageSizeInspector
}

type SanitizedAtlasManifest = Omit<LoadedCustomAtlasPet, 'mimeType' | 'dataUrl'>
type SanitizedImageManifest = Omit<LoadedCustomImagePet, 'mimeType' | 'dataUrl'>
type SanitizedManifest = SanitizedAtlasManifest | SanitizedImageManifest

type ManifestCandidate = {
  entry: string
  imagePath: string
  mimeType: CustomPetImageMimeType
  imageKind: 'atlas-v2' | 'single-image'
  directoryIdentities: DirectoryIdentity[]
  metadata: SanitizedManifest
}

type DirectoryIdentity = {
  directoryPath: string
  realPath: string
  dev: number
  ino: number
  missingCode: CustomPetLoadErrorCode
  symlinkCode: CustomPetLoadErrorCode
  invalidCode: CustomPetLoadErrorCode
  changedCode: CustomPetLoadErrorCode
  invalidMessage: string
  changedMessage: string
}

class PetPackageError extends Error {
  readonly code: CustomPetLoadErrorCode

  constructor(code: CustomPetLoadErrorCode, message: string) {
    super(message)
    this.name = 'PetPackageError'
    this.code = code
  }
}

export function getPetPackageErrorCode(error: unknown): CustomPetLoadErrorCode {
  return error instanceof PetPackageError ? error.code : 'io-error'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0
    ? value
    : fallback
}

function resolveHomePath(input: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2))
  }
  return input
}

export function resolveCustomPetsRoot(options: CustomPetsRootOptions = {}): string {
  if (options.root) return path.resolve(options.root)

  const env = options.env ?? process.env
  const homeDir = path.resolve(options.homeDir ?? os.homedir())
  const configuredRoot = env.CLAUDE_CONFIG_DIR?.trim()
  const claudeConfigDir = configuredRoot
    ? path.resolve(resolveHomePath(configuredRoot, homeDir))
    : path.join(homeDir, '.claude')
  return path.join(claudeConfigDir, 'cc-haha', 'pets')
}

export async function ensureCustomPetsRoot(options: CustomPetsRootOptions = {}): Promise<string> {
  const root = resolveCustomPetsRoot(options)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootStat = await lstat(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Custom pets root must be a real directory')
  }
  return root
}

function sanitizeErrorEntry(entry: string): string | undefined {
  if (!entry || entry.length > 256 || CONTROL_CHARACTER_PATTERN.test(entry)) return undefined
  return entry
}

function packageError(entry: string, error: unknown): CustomPetLoadError {
  const safeEntry = sanitizeErrorEntry(entry)
  const normalized = error instanceof PetPackageError
    ? { code: error.code, message: error.message }
    : { code: 'io-error' as const, message: 'Unable to read this custom pet package.' }
  return safeEntry ? { entry: safeEntry, ...normalized } : normalized
}

function rootError(code: CustomPetLoadErrorCode, message: string): CustomPetLoadError {
  return { code, message }
}

type DirectoryIdentityOptions = Pick<
  DirectoryIdentity,
  | 'missingCode'
  | 'symlinkCode'
  | 'invalidCode'
  | 'changedCode'
  | 'invalidMessage'
  | 'changedMessage'
>

async function captureDirectoryIdentity(
  directoryPath: string,
  options: DirectoryIdentityOptions,
): Promise<DirectoryIdentity> {
  let beforeStat
  try {
    beforeStat = await lstat(directoryPath)
  } catch {
    throw new PetPackageError(options.missingCode, options.invalidMessage)
  }
  if (beforeStat.isSymbolicLink()) {
    throw new PetPackageError(options.symlinkCode, options.invalidMessage)
  }
  if (!beforeStat.isDirectory()) {
    throw new PetPackageError(options.invalidCode, options.invalidMessage)
  }

  let resolvedPath: string
  let afterStat
  try {
    resolvedPath = await realpath(directoryPath)
    afterStat = await lstat(directoryPath)
  } catch {
    throw new PetPackageError(options.changedCode, options.changedMessage)
  }
  if (
    afterStat.isSymbolicLink() ||
    !afterStat.isDirectory() ||
    beforeStat.dev !== afterStat.dev ||
    beforeStat.ino !== afterStat.ino
  ) {
    throw new PetPackageError(options.changedCode, options.changedMessage)
  }

  return {
    ...options,
    directoryPath,
    realPath: path.resolve(resolvedPath),
    dev: afterStat.dev,
    ino: afterStat.ino,
  }
}

async function assertDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  const current = await captureDirectoryIdentity(identity.directoryPath, identity)
  if (
    current.realPath !== identity.realPath ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new PetPackageError(identity.changedCode, identity.changedMessage)
  }
}

async function assertDirectoryIdentities(identities: DirectoryIdentity[]): Promise<void> {
  for (const identity of identities) {
    await assertDirectoryIdentity(identity)
  }
}

function assertDirectRealChild(parent: DirectoryIdentity, child: DirectoryIdentity): void {
  if (path.dirname(child.realPath) !== parent.realPath) {
    throw new PetPackageError(
      child.changedCode,
      child.changedMessage,
    )
  }
}

const ROOT_DIRECTORY_OPTIONS: DirectoryIdentityOptions = {
  missingCode: 'root-invalid',
  symlinkCode: 'root-invalid',
  invalidCode: 'root-invalid',
  changedCode: 'root-invalid',
  invalidMessage: 'Custom pets root must be a real directory.',
  changedMessage: 'Custom pets root changed while loading.',
}

const PACKAGE_DIRECTORY_OPTIONS: DirectoryIdentityOptions = {
  missingCode: 'directory-changed',
  symlinkCode: 'symlink-entry',
  invalidCode: 'directory-changed',
  changedCode: 'directory-changed',
  invalidMessage: 'The custom pet package must be a real directory.',
  changedMessage: 'The custom pet package changed while loading.',
}

const IMAGE_DIRECTORY_OPTIONS: DirectoryIdentityOptions = {
  missingCode: 'missing-image',
  symlinkCode: 'symlink-image',
  invalidCode: 'invalid-image',
  changedCode: 'directory-changed',
  invalidMessage: 'The pet image path must contain only real directories.',
  changedMessage: 'The pet image directory changed while loading.',
}

async function readDirectEntries(
  root: string,
  maxEntries: number,
  validateRoot: () => Promise<void>,
): Promise<{ entries: Dirent[], capped: boolean }> {
  await validateRoot()
  const directory = await opendir(root)
  const entries: Dirent[] = []
  try {
    await validateRoot()
    while (entries.length <= maxEntries) {
      const entry = await directory.read()
      if (!entry) break
      entries.push(entry)
    }
    await validateRoot()
  } finally {
    try {
      await directory.close()
    } catch {
      // A completed scan can already close the handle on some runtimes.
    }
  }

  return {
    entries: entries.slice(0, maxEntries).sort((left, right) => left.name.localeCompare(right.name)),
    capped: entries.length > maxEntries,
  }
}

async function readBoundedRegularFile(options: {
  filePath: string
  maxBytes: number
  validatePathContext?: () => Promise<void>
  onBytesRead?: (bytes: number) => void
  missingCode: CustomPetLoadErrorCode
  symlinkCode: CustomPetLoadErrorCode
  tooLargeCode: CustomPetLoadErrorCode
  invalidCode: CustomPetLoadErrorCode
  missingMessage: string
  symlinkMessage: string
  tooLargeMessage: string
  invalidMessage: string
}): Promise<Buffer> {
  await options.validatePathContext?.()
  let pathStat
  try {
    pathStat = await lstat(options.filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new PetPackageError(options.missingCode, options.missingMessage)
    }
    throw new PetPackageError(options.invalidCode, options.invalidMessage)
  }

  if (pathStat.isSymbolicLink()) {
    throw new PetPackageError(options.symlinkCode, options.symlinkMessage)
  }
  if (!pathStat.isFile()) {
    throw new PetPackageError(options.invalidCode, options.invalidMessage)
  }
  if (pathStat.size > options.maxBytes) {
    throw new PetPackageError(options.tooLargeCode, options.tooLargeMessage)
  }
  await options.validatePathContext?.()

  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  let file
  try {
    file = await open(options.filePath, constants.O_RDONLY | noFollow)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new PetPackageError(options.missingCode, options.missingMessage)
    }
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new PetPackageError(options.symlinkCode, options.symlinkMessage)
    }
    throw new PetPackageError(options.invalidCode, options.invalidMessage)
  }

  try {
    const openedStat = await file.stat()
    if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new PetPackageError(options.invalidCode, options.invalidMessage)
    }
    if (openedStat.size > options.maxBytes) {
      throw new PetPackageError(options.tooLargeCode, options.tooLargeMessage)
    }
    await options.validatePathContext?.()
    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes < openedStat.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, openedStat.size - totalBytes))
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      options.onBytesRead?.(bytesRead)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const afterReadStat = await file.stat()
    if (
      !afterReadStat.isFile() ||
      afterReadStat.dev !== openedStat.dev ||
      afterReadStat.ino !== openedStat.ino ||
      afterReadStat.size !== openedStat.size ||
      totalBytes !== openedStat.size
    ) {
      if (afterReadStat.size > options.maxBytes) {
        throw new PetPackageError(options.tooLargeCode, options.tooLargeMessage)
      }
      throw new PetPackageError(options.invalidCode, options.invalidMessage)
    }
    await options.validatePathContext?.()
    return Buffer.concat(chunks, totalBytes)
  } finally {
    await file.close()
  }
}

function decodeManifest(data: Buffer): Record<string, unknown> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    throw new PetPackageError('invalid-manifest', 'pet.json must contain valid UTF-8 JSON.')
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new PetPackageError('invalid-manifest', 'pet.json must contain valid JSON.')
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new PetPackageError('invalid-manifest', 'pet.json must contain a JSON object.')
  }
  return manifest as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizedTextField(
  value: unknown,
  maxLength: number,
  code: CustomPetLoadErrorCode,
  fieldName: string,
): string {
  if (typeof value !== 'string') {
    throw new PetPackageError(code, `${fieldName} must be a string.`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new PetPackageError(code, `${fieldName} is invalid.`)
  }
  return trimmed
}

function resolvePortableRelativePath(
  packageDir: string,
  value: unknown,
  options: {
    code: 'invalid-spritesheet-path' | 'invalid-image-path'
    fieldName: 'spritesheetPath' | 'imagePath'
  },
): {
  relativePath: string
  absolutePath: string
} {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new PetPackageError(options.code, `${options.fieldName} must be a relative path.`)
  }
  if (value.length > MAX_IMAGE_PATH_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new PetPackageError(options.code, `${options.fieldName} is invalid.`)
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new PetPackageError(options.code, `${options.fieldName} must be relative.`)
  }

  const portablePath = value.replaceAll('\\', '/')
  const segments = portablePath.split('/')
  if (
    segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':')) ||
    path.posix.normalize(portablePath) !== portablePath
  ) {
    throw new PetPackageError(options.code, `${options.fieldName} cannot traverse the package.`)
  }

  const absolutePath = path.resolve(packageDir, ...segments)
  const relativeToPackage = path.relative(packageDir, absolutePath)
  if (!relativeToPackage || relativeToPackage.startsWith('..') || path.isAbsolute(relativeToPackage)) {
    throw new PetPackageError(options.code, `${options.fieldName} must stay inside the package.`)
  }
  return { relativePath: segments.join('/'), absolutePath }
}

function mimeTypeForPath(
  imagePath: string,
  fieldName: 'spritesheetPath' | 'imagePath',
): CustomPetImageMimeType {
  const extension = path.posix.extname(imagePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  throw new PetPackageError(
    'unsupported-image-format',
    `${fieldName} must point to a PNG or WebP image.`,
  )
}

async function captureImageDirectoryIdentities(
  packageIdentity: DirectoryIdentity,
  imagePath: string,
): Promise<DirectoryIdentity[]> {
  const identities = [packageIdentity]
  const relativePath = path.relative(packageIdentity.directoryPath, imagePath)
  const segments = relativePath.split(path.sep)
  let current = packageIdentity.directoryPath
  let parentIdentity = packageIdentity
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    const componentIdentity = await captureDirectoryIdentity(current, IMAGE_DIRECTORY_OPTIONS)
    assertDirectRealChild(parentIdentity, componentIdentity)
    identities.push(componentIdentity)
    parentIdentity = componentIdentity
  }
  return identities
}

function hasExpectedImageSignature(data: Buffer, mimeType: CustomPetImageMimeType): boolean {
  if (mimeType === 'image/png') {
    return data.byteLength >= 24 &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.readUInt32BE(8) === 13 &&
      data.toString('ascii', 12, 16) === 'IHDR'
  }

  return data.byteLength >= 20 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP' &&
    data.readUInt32LE(4) + 8 === data.byteLength
}

const PNG_ACTL_CHUNK = 0x6163544c
const WEBP_VP8X_CHUNK = 0x56503858
const WEBP_ANIM_CHUNK = 0x414e494d
const WEBP_ANMF_CHUNK = 0x414e4d46
const WEBP_VP8X_ANIMATION_FLAG = 0x02

function hasPngAnimationChunk(data: Buffer): boolean {
  let offset = 8
  while (offset + 12 <= data.byteLength) {
    const chunkLength = data.readUInt32BE(offset)
    if (chunkLength > data.byteLength - offset - 12) break
    if (data.readUInt32BE(offset + 4) === PNG_ACTL_CHUNK) return true
    offset += 12 + chunkLength
  }
  return false
}

function hasWebpAnimationChunk(data: Buffer): boolean {
  let offset = 12
  while (offset + 8 <= data.byteLength) {
    const chunkType = data.readUInt32BE(offset)
    const chunkLength = data.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    if (chunkLength > data.byteLength - chunkStart) break
    if (chunkType === WEBP_ANIM_CHUNK || chunkType === WEBP_ANMF_CHUNK) return true
    if (
      chunkType === WEBP_VP8X_CHUNK &&
      chunkLength >= 1 &&
      (data[chunkStart]! & WEBP_VP8X_ANIMATION_FLAG) !== 0
    ) {
      return true
    }
    offset = chunkStart + chunkLength + (chunkLength % 2)
  }
  return false
}

function hasEmbeddedImageAnimation(data: Buffer, mimeType: CustomPetImageMimeType): boolean {
  return mimeType === 'image/png'
    ? hasPngAnimationChunk(data)
    : hasWebpAnimationChunk(data)
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)
}

export function inspectPetImageSize({ data, mimeType }: ImageSizeInspectorInput): ImageSize {
  if (!hasExpectedImageSignature(data, mimeType)) {
    throw new Error('Invalid image header')
  }
  if (mimeType === 'image/png') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }

  let offset = 12
  while (offset + 8 <= data.byteLength) {
    const chunkType = data.toString('ascii', offset, offset + 4)
    const chunkLength = data.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkLength
    if (chunkEnd > data.byteLength) break

    if (chunkType === 'VP8X' && chunkLength >= 10) {
      return {
        width: readUInt24LE(data, chunkStart + 4) + 1,
        height: readUInt24LE(data, chunkStart + 7) + 1,
      }
    }
    if (chunkType === 'VP8L' && chunkLength >= 5 && data[chunkStart] === 0x2f) {
      const b1 = data[chunkStart + 1]!
      const b2 = data[chunkStart + 2]!
      const b3 = data[chunkStart + 3]!
      const b4 = data[chunkStart + 4]!
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      }
    }
    if (
      chunkType === 'VP8 ' &&
      chunkLength >= 10 &&
      data[chunkStart + 3] === 0x9d &&
      data[chunkStart + 4] === 0x01 &&
      data[chunkStart + 5] === 0x2a
    ) {
      return {
        width: data.readUInt16LE(chunkStart + 6) & 0x3fff,
        height: data.readUInt16LE(chunkStart + 8) & 0x3fff,
      }
    }

    offset = chunkEnd + (chunkLength % 2)
  }
  throw new Error('Unsupported WebP image header')
}

function isValidImageDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function imagePixels(size: ImageSize): number {
  if (!isValidImageDimension(size.width) || !isValidImageDimension(size.height)) return 0
  const pixels = size.width * size.height
  return Number.isSafeInteger(pixels) ? pixels : 0
}

function assertAtlasImageSize(size: ImageSize): void {
  if (
    size.width !== CUSTOM_PET_SPRITESHEET_WIDTH ||
    size.height !== CUSTOM_PET_SPRITESHEET_HEIGHT
  ) {
    throw new PetPackageError(
      'invalid-image-dimensions',
      `The spritesheet image must be ${CUSTOM_PET_SPRITESHEET_WIDTH}x${CUSTOM_PET_SPRITESHEET_HEIGHT}.`,
    )
  }
}

function assertSingleImageSize(size: ImageSize): void {
  const pixels = imagePixels(size)
  if (
    size.width < CUSTOM_PET_SINGLE_IMAGE_MIN_DIMENSION ||
    size.height < CUSTOM_PET_SINGLE_IMAGE_MIN_DIMENSION ||
    size.width > CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION ||
    size.height > CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION ||
    pixels === 0 ||
    pixels > CUSTOM_PET_SINGLE_IMAGE_MAX_PIXELS
  ) {
    throw new PetPackageError(
      'invalid-image-dimensions',
      `The pet image must be between ${CUSTOM_PET_SINGLE_IMAGE_MIN_DIMENSION} and ${CUSTOM_PET_SINGLE_IMAGE_MAX_DIMENSION} pixels per side and contain no more than ${CUSTOM_PET_SINGLE_IMAGE_MAX_PIXELS} pixels.`,
    )
  }
}

function assertCandidateImageSize(
  size: ImageSize,
  imageKind: ManifestCandidate['imageKind'],
): void {
  if (imageKind === 'atlas-v2') assertAtlasImageSize(size)
  else assertSingleImageSize(size)
}

function parseManifestRenderer(
  packageDir: string,
  entry: string,
  manifest: Record<string, unknown>,
  displayName: string,
  description: string,
): Pick<ManifestCandidate, 'imagePath' | 'mimeType' | 'imageKind' | 'metadata'> {
  if (manifest.manifestVersion === undefined) {
    if (manifest.renderer !== undefined || manifest.spriteVersionNumber !== 2) {
      throw new PetPackageError(
        'invalid-sprite-version',
        'spriteVersionNumber must be 2 for a legacy atlas pet.',
      )
    }
    const resolvedImage = resolvePortableRelativePath(
      packageDir,
      manifest.spritesheetPath,
      { code: 'invalid-spritesheet-path', fieldName: 'spritesheetPath' },
    )
    return {
      imagePath: resolvedImage.absolutePath,
      mimeType: mimeTypeForPath(resolvedImage.relativePath, 'spritesheetPath'),
      imageKind: 'atlas-v2',
      metadata: {
        id: `custom:${entry}`,
        displayName,
        description,
        spriteVersionNumber: 2,
        spritesheetPath: resolvedImage.relativePath,
      },
    }
  }

  if (manifest.manifestVersion !== CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION) {
    throw new PetPackageError(
      'invalid-manifest-version',
      `manifestVersion must be ${CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION}.`,
    )
  }
  if (!isRecord(manifest.renderer)) {
    throw new PetPackageError('invalid-renderer', 'renderer must be an object.')
  }
  const renderer = manifest.renderer
  if (
    renderer.kind !== 'single-image' ||
    renderer.version !== CUSTOM_PET_SINGLE_IMAGE_RENDERER_VERSION
  ) {
    throw new PetPackageError(
      'invalid-renderer',
      `renderer must use single-image version ${CUSTOM_PET_SINGLE_IMAGE_RENDERER_VERSION}.`,
    )
  }
  const motionProfile = renderer.motionProfile ?? CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE
  if (motionProfile !== CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE) {
    throw new PetPackageError('invalid-renderer', 'The single-image motion profile is unsupported.')
  }
  const resolvedImage = resolvePortableRelativePath(
    packageDir,
    renderer.imagePath,
    { code: 'invalid-image-path', fieldName: 'imagePath' },
  )
  return {
    imagePath: resolvedImage.absolutePath,
    mimeType: mimeTypeForPath(resolvedImage.relativePath, 'imagePath'),
    imageKind: 'single-image',
    metadata: {
      id: `custom:${entry}`,
      displayName,
      description,
      manifestVersion: CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION,
      spriteVersionNumber: 1,
      imagePath: resolvedImage.relativePath,
      motionProfile,
    },
  }
}

async function readManifestCandidate(
  root: string,
  rootIdentity: DirectoryIdentity,
  entry: Dirent,
  maxManifestBytes: number,
): Promise<ManifestCandidate | null> {
  const packageDir = path.join(root, entry.name)
  if (entry.isSymbolicLink()) {
    throw new PetPackageError('symlink-entry', 'Custom pet package symlinks are not allowed.')
  }
  if (!entry.isDirectory()) return null
  if (entry.name.length > CUSTOM_PET_FOLDER_MAX_LENGTH || !PET_FOLDER_PATTERN.test(entry.name)) {
    throw new PetPackageError('invalid-id', 'Custom pet folder name is not a safe slug.')
  }

  await assertDirectoryIdentity(rootIdentity)
  const packageIdentity = await captureDirectoryIdentity(
    packageDir,
    PACKAGE_DIRECTORY_OPTIONS,
  )
  assertDirectRealChild(rootIdentity, packageIdentity)
  const manifestDirectoryIdentities = [rootIdentity, packageIdentity]

  const manifestData = await readBoundedRegularFile({
    filePath: path.join(packageDir, 'pet.json'),
    maxBytes: maxManifestBytes,
    validatePathContext: () => assertDirectoryIdentities(manifestDirectoryIdentities),
    missingCode: 'missing-manifest',
    symlinkCode: 'symlink-manifest',
    tooLargeCode: 'manifest-too-large',
    invalidCode: 'invalid-manifest',
    missingMessage: 'The custom pet package is missing pet.json.',
    symlinkMessage: 'pet.json cannot be a symlink.',
    tooLargeMessage: 'pet.json exceeds the allowed size.',
    invalidMessage: 'pet.json must be a regular file.',
  })
  const manifest = decodeManifest(manifestData)
  const displayName = sanitizedTextField(
    manifest.displayName,
    MAX_DISPLAY_NAME_LENGTH,
    'invalid-display-name',
    'displayName',
  )
  const description = sanitizedTextField(
    manifest.description,
    MAX_DESCRIPTION_LENGTH,
    'invalid-description',
    'description',
  )
  const renderer = parseManifestRenderer(
    packageDir,
    entry.name,
    manifest,
    displayName,
    description,
  )
  const imageDirectoryIdentities = await captureImageDirectoryIdentities(
    packageIdentity,
    renderer.imagePath,
  )
  const directoryIdentities = [rootIdentity, ...imageDirectoryIdentities]
  await assertDirectoryIdentities(directoryIdentities)

  return {
    entry: entry.name,
    ...renderer,
    directoryIdentities,
  }
}

async function loadCandidateImage(
  candidate: ManifestCandidate,
  inspectImageSize: ImageSizeInspector,
  maxImageBytes: number,
  tooLargeCode: 'image-too-large' | 'total-image-bytes-exceeded',
  onImageRead: (bytes: number) => void,
  onDecodeAttempt: (decodedPixels: number) => void,
): Promise<Buffer> {
  const data = await readBoundedRegularFile({
    filePath: candidate.imagePath,
    maxBytes: maxImageBytes,
    validatePathContext: () => assertDirectoryIdentities(candidate.directoryIdentities),
    onBytesRead: onImageRead,
    missingCode: 'missing-image',
    symlinkCode: 'symlink-image',
    tooLargeCode,
    invalidCode: 'invalid-image',
    missingMessage: 'The pet image does not exist.',
    symlinkMessage: 'The pet image cannot be a symlink.',
    tooLargeMessage: tooLargeCode === 'image-too-large'
      ? 'The pet image exceeds the allowed size.'
      : 'The total custom pet image budget has been reached.',
    invalidMessage: 'The pet image must be a regular file.',
  })
  if (!hasExpectedImageSignature(data, candidate.mimeType)) {
    throw new PetPackageError('invalid-image', 'The pet image header is invalid.')
  }
  if (hasEmbeddedImageAnimation(data, candidate.mimeType)) {
    throw new PetPackageError(
      'invalid-image',
      'The pet image must be a static PNG or WebP.',
    )
  }

  let headerSize: ImageSize
  try {
    headerSize = inspectPetImageSize({
      data,
      mimeType: candidate.mimeType,
    })
  } catch {
    throw new PetPackageError('invalid-image', 'The pet image header is invalid.')
  }
  assertCandidateImageSize(headerSize, candidate.imageKind)
  onDecodeAttempt(imagePixels(headerSize))

  if (inspectImageSize !== inspectPetImageSize) {
    let decodedSize: ImageSize
    try {
      decodedSize = await inspectImageSize({
        data,
        mimeType: candidate.mimeType,
      })
    } catch {
      throw new PetPackageError('invalid-image', 'The pet image cannot be decoded.')
    }
    assertCandidateImageSize(decodedSize, candidate.imageKind)
    if (decodedSize.width !== headerSize.width || decodedSize.height !== headerSize.height) {
      throw new PetPackageError(
        'invalid-image',
        'The decoded pet image dimensions do not match its header.',
      )
    }
  }
  await assertDirectoryIdentities(candidate.directoryIdentities)
  return data
}

function dataUrlPrefix(mimeType: CustomPetImageMimeType): string {
  return `data:${mimeType};base64,`
}

function maxRawBytesForDataUrl(mimeType: CustomPetImageMimeType, remainingBytes: number): number {
  const availableBase64Bytes = remainingBytes - dataUrlPrefix(mimeType).length
  if (availableBase64Bytes < 4) return 0
  return Math.floor(availableBase64Bytes / 4) * 3
}

function totalImageBudgetError(): PetPackageError {
  return new PetPackageError(
    'total-image-bytes-exceeded',
    'The total custom pet image budget has been reached.',
  )
}

async function assertCustomPetTargetAvailable(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw new PetPackageError('io-error', 'Unable to inspect the custom pet destination.')
  }
  throw new PetPackageError('duplicate-id', 'A custom pet with this ID already exists.')
}

export async function createCustomPetFromAtlas(
  input: CreateCustomPetFromAtlasInput,
  options: CreateCustomPetFromAtlasOptions = {},
): Promise<LoadedCustomAtlasPet> {
  const slug = input.slug.trim()
  if (
    slug !== input.slug
    || slug.length === 0
    || slug.length > CUSTOM_PET_FOLDER_MAX_LENGTH
    || !PET_FOLDER_PATTERN.test(slug)
  ) {
    throw new PetPackageError('invalid-id', 'Custom pet ID must be a lowercase kebab-case slug.')
  }
  const displayName = sanitizedTextField(
    input.displayName,
    MAX_DISPLAY_NAME_LENGTH,
    'invalid-display-name',
    'displayName',
  )
  const description = sanitizedTextField(
    input.description,
    MAX_DESCRIPTION_LENGTH,
    'invalid-description',
    'description',
  )
  const atlasPath = path.resolve(input.atlasPath)
  const mimeType = mimeTypeForPath(atlasPath, 'spritesheetPath')
  const extension = mimeType === 'image/png' ? 'png' : 'webp'
  const spritesheetPath = `spritesheet.${extension}`
  const atlasData = await readBoundedRegularFile({
    filePath: atlasPath,
    maxBytes: DEFAULT_CUSTOM_PET_MAX_IMAGE_BYTES,
    missingCode: 'missing-image',
    symlinkCode: 'symlink-image',
    tooLargeCode: 'image-too-large',
    invalidCode: 'invalid-image',
    missingMessage: 'The selected spritesheet image does not exist.',
    symlinkMessage: 'The selected spritesheet image cannot be a symlink.',
    tooLargeMessage: 'The selected spritesheet image exceeds the allowed size.',
    invalidMessage: 'The selected spritesheet image must be a regular file.',
  })

  const root = await ensureCustomPetsRoot(options)
  const rootIdentity = await captureDirectoryIdentity(root, ROOT_DIRECTORY_OPTIONS)
  const targetPath = path.join(root, slug)
  await assertCustomPetTargetAvailable(targetPath)

  const stagingRoot = await mkdtemp(path.join(path.dirname(root), '.pet-install-'))
  const packagePath = path.join(stagingRoot, slug)
  try {
    await mkdir(packagePath, { mode: 0o700 })
    await writeFile(path.join(packagePath, spritesheetPath), atlasData, { flag: 'wx', mode: 0o600 })
    await writeFile(
      path.join(packagePath, 'pet.json'),
      `${JSON.stringify({
        id: slug,
        displayName,
        description,
        spriteVersionNumber: 2,
        spritesheetPath,
      }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )

    const validation = await loadCustomPets({
      root: stagingRoot,
      inspectImageSize: options.inspectImageSize,
      maxEntries: 1,
    })
    const pet = validation.pets.find(candidate => candidate.id === `custom:${slug}`)
    const validationError = validation.errors[0]
    if (!pet || pet.spriteVersionNumber !== 2 || validationError) {
      throw new PetPackageError(
        validationError?.code ?? 'invalid-image',
        validationError?.message ?? 'The custom pet package could not be validated.',
      )
    }

    await assertDirectoryIdentity(rootIdentity)
    await assertCustomPetTargetAvailable(targetPath)
    try {
      await rename(packagePath, targetPath)
    } catch (error) {
      if (isNodeError(error) && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
        throw new PetPackageError('duplicate-id', 'A custom pet with this ID already exists.')
      }
      throw error
    }
    await assertDirectoryIdentity(rootIdentity)
    return pet
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

export async function createCustomPetFromImage(
  input: CreateCustomPetFromImageInput,
  options: CreateCustomPetFromImageOptions = {},
): Promise<LoadedCustomImagePet> {
  const slug = input.slug.trim()
  if (
    slug !== input.slug ||
    slug.length === 0 ||
    slug.length > CUSTOM_PET_FOLDER_MAX_LENGTH ||
    !PET_FOLDER_PATTERN.test(slug)
  ) {
    throw new PetPackageError('invalid-id', 'Custom pet ID must be a lowercase kebab-case slug.')
  }
  const displayName = sanitizedTextField(
    input.displayName,
    MAX_DISPLAY_NAME_LENGTH,
    'invalid-display-name',
    'displayName',
  )
  const description = sanitizedTextField(
    input.description,
    MAX_DESCRIPTION_LENGTH,
    'invalid-description',
    'description',
  )
  const motionProfile = input.motionProfile ?? CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE
  if (motionProfile !== CUSTOM_PET_SINGLE_IMAGE_MOTION_PROFILE) {
    throw new PetPackageError('invalid-renderer', 'The single-image motion profile is unsupported.')
  }

  const sourcePath = path.resolve(input.imagePath)
  const mimeType = mimeTypeForPath(sourcePath, 'imagePath')
  const extension = mimeType === 'image/png' ? 'png' : 'webp'
  const imagePath = `pet.${extension}`
  const imageData = await readBoundedRegularFile({
    filePath: sourcePath,
    maxBytes: DEFAULT_CUSTOM_PET_MAX_IMAGE_BYTES,
    missingCode: 'missing-image',
    symlinkCode: 'symlink-image',
    tooLargeCode: 'image-too-large',
    invalidCode: 'invalid-image',
    missingMessage: 'The selected pet image does not exist.',
    symlinkMessage: 'The selected pet image cannot be a symlink.',
    tooLargeMessage: 'The selected pet image exceeds the allowed size.',
    invalidMessage: 'The selected pet image must be a regular file.',
  })

  const root = await ensureCustomPetsRoot(options)
  const rootIdentity = await captureDirectoryIdentity(root, ROOT_DIRECTORY_OPTIONS)
  const targetPath = path.join(root, slug)
  await assertCustomPetTargetAvailable(targetPath)

  const stagingRoot = await mkdtemp(path.join(path.dirname(root), '.pet-install-'))
  const packagePath = path.join(stagingRoot, slug)
  try {
    await mkdir(packagePath, { mode: 0o700 })
    await writeFile(path.join(packagePath, imagePath), imageData, { flag: 'wx', mode: 0o600 })
    await writeFile(
      path.join(packagePath, 'pet.json'),
      `${JSON.stringify({
        id: slug,
        displayName,
        description,
        manifestVersion: CUSTOM_PET_SINGLE_IMAGE_MANIFEST_VERSION,
        renderer: {
          kind: 'single-image',
          version: CUSTOM_PET_SINGLE_IMAGE_RENDERER_VERSION,
          imagePath,
          motionProfile,
        },
      }, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )

    const validation = await loadCustomPets({
      root: stagingRoot,
      inspectImageSize: options.inspectImageSize,
      maxEntries: 1,
    })
    const pet = validation.pets.find(candidate => candidate.id === `custom:${slug}`)
    const validationError = validation.errors[0]
    if (!pet || pet.spriteVersionNumber !== 1 || validationError) {
      throw new PetPackageError(
        validationError?.code ?? 'invalid-image',
        validationError?.message ?? 'The custom pet package could not be validated.',
      )
    }

    await assertDirectoryIdentity(rootIdentity)
    await assertCustomPetTargetAvailable(targetPath)
    try {
      await rename(packagePath, targetPath)
    } catch (error) {
      if (isNodeError(error) && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
        throw new PetPackageError('duplicate-id', 'A custom pet with this ID already exists.')
      }
      throw error
    }
    await assertDirectoryIdentity(rootIdentity)
    return pet
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

function packageCanBeSkippedForExhaustedBudget(entry: Dirent): boolean {
  return entry.isDirectory() &&
    entry.name.length <= CUSTOM_PET_FOLDER_MAX_LENGTH &&
    PET_FOLDER_PATTERN.test(entry.name)
}

function canFitAnyCustomPetImage(options: {
  maxImageBytes: number
  remainingImageBytes: number
  remainingDataUrlBytes: number
}): boolean {
  const dataUrlRawBudget = Math.max(
    maxRawBytesForDataUrl('image/png', options.remainingDataUrlBytes),
    maxRawBytesForDataUrl('image/webp', options.remainingDataUrlBytes),
  )
  return Math.min(
    options.maxImageBytes,
    options.remainingImageBytes,
    dataUrlRawBudget,
  ) >= MIN_CUSTOM_PET_IMAGE_BYTES
}

export async function loadCustomPets(
  options: LoadCustomPetsOptions = {},
): Promise<CustomPetLoadResult> {
  const root = resolveCustomPetsRoot(options)
  const pets: LoadedCustomPet[] = []
  const errors: CustomPetLoadError[] = []
  const maxEntries = normalizeLimit(options.maxEntries, DEFAULT_CUSTOM_PET_MAX_ENTRIES)
  const maxManifestBytes = normalizeLimit(
    options.maxManifestBytes,
    DEFAULT_CUSTOM_PET_MAX_MANIFEST_BYTES,
  )
  const maxImageBytes = normalizeLimit(options.maxImageBytes, DEFAULT_CUSTOM_PET_MAX_IMAGE_BYTES)
  const maxTotalImageBytes = normalizeLimit(
    options.maxTotalImageBytes,
    DEFAULT_CUSTOM_PET_MAX_TOTAL_IMAGE_BYTES,
  )
  const maxTotalDataUrlBytes = normalizeLimit(
    options.maxTotalDataUrlBytes,
    DEFAULT_CUSTOM_PET_MAX_TOTAL_DATA_URL_BYTES,
  )
  const maxDecodedPixels = normalizeLimit(
    options.maxDecodedPixels,
    DEFAULT_CUSTOM_PET_MAX_DECODED_PIXELS,
  )
  const inspectImageSize = options.inspectImageSize ?? inspectPetImageSize

  let rootStat
  try {
    rootStat = await lstat(root)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { root, pets, errors }
    return {
      root,
      pets,
      errors: [rootError('io-error', 'Unable to read the custom pets root.')],
    }
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return {
      root,
      pets,
      errors: [rootError('root-invalid', 'Custom pets root must be a real directory.')],
    }
  }

  let rootIdentity: DirectoryIdentity
  try {
    rootIdentity = await captureDirectoryIdentity(root, ROOT_DIRECTORY_OPTIONS)
  } catch (error) {
    const normalized = error instanceof PetPackageError
      ? rootError(error.code, error.message)
      : rootError('root-invalid', 'Custom pets root changed while loading.')
    return { root, pets, errors: [normalized] }
  }

  let directEntries: { entries: Dirent[], capped: boolean }
  try {
    directEntries = await readDirectEntries(
      root,
      maxEntries,
      () => assertDirectoryIdentity(rootIdentity),
    )
  } catch (error) {
    const normalized = error instanceof PetPackageError
      ? rootError(error.code, error.message)
      : rootError('io-error', 'Unable to scan the custom pets root.')
    return {
      root,
      pets,
      errors: [normalized],
    }
  }
  if (directEntries.capped) {
    errors.push(rootError('entry-limit', `Only the first ${maxEntries} custom pet entries were scanned.`))
  }

  let remainingImageBytes = maxTotalImageBytes
  let remainingDataUrlBytes = maxTotalDataUrlBytes
  let remainingDecodedPixels = maxDecodedPixels
  for (const entry of directEntries.entries) {
    if (!canFitAnyCustomPetImage({
      maxImageBytes,
      remainingImageBytes,
      remainingDataUrlBytes,
    })) {
      if (packageCanBeSkippedForExhaustedBudget(entry)) {
        errors.push(packageError(entry.name, totalImageBudgetError()))
      } else if (entry.isSymbolicLink()) {
        errors.push(packageError(
          entry.name,
          new PetPackageError('symlink-entry', 'Custom pet package symlinks are not allowed.'),
        ))
      } else if (
        entry.isDirectory() &&
        (entry.name.length > CUSTOM_PET_FOLDER_MAX_LENGTH || !PET_FOLDER_PATTERN.test(entry.name))
      ) {
        errors.push(packageError(
          entry.name,
          new PetPackageError('invalid-id', 'Custom pet folder name is not a safe slug.'),
        ))
      }
      continue
    }

    try {
      const candidate = await readManifestCandidate(root, rootIdentity, entry, maxManifestBytes)
      if (!candidate) continue

      const remainingDataUrlRawBytes = maxRawBytesForDataUrl(
        candidate.mimeType,
        remainingDataUrlBytes,
      )
      const remainingReadBytes = Math.min(
        maxImageBytes,
        remainingImageBytes,
        remainingDataUrlRawBytes,
      )
      if (remainingReadBytes === 0) throw totalImageBudgetError()

      const data = await loadCandidateImage(
        candidate,
        inspectImageSize,
        remainingReadBytes,
        remainingReadBytes < maxImageBytes
          ? 'total-image-bytes-exceeded'
          : 'image-too-large',
        bytes => {
          remainingImageBytes -= bytes
        },
        decodedPixels => {
          if (remainingDecodedPixels < decodedPixels) {
            throw new PetPackageError(
              'decode-budget-exceeded',
              'The total custom pet decoded-pixel budget has been reached.',
            )
          }
          remainingDecodedPixels -= decodedPixels
        },
      )
      const dataUrl = `${dataUrlPrefix(candidate.mimeType)}${data.toString('base64')}`
      if (dataUrl.length > remainingDataUrlBytes) throw totalImageBudgetError()
      remainingDataUrlBytes -= dataUrl.length
      pets.push({
        ...candidate.metadata,
        mimeType: candidate.mimeType,
        dataUrl,
      })
    } catch (error) {
      errors.push(packageError(entry.name, error))
    }
  }

  try {
    await assertDirectoryIdentity(rootIdentity)
  } catch (error) {
    pets.length = 0
    const normalized = error instanceof PetPackageError
      ? rootError(error.code, error.message)
      : rootError('root-invalid', 'Custom pets root changed while loading.')
    errors.push(normalized)
  }

  return { root, pets, errors }
}
