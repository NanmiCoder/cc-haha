/**
 * Pinned download sources shared by every local model: the sherpa-onnx runtime
 * (npm tarballs) and Hugging Face files at fixed commits. Sizes and digests were
 * taken from the registry and the model repositories; both registries and both
 * model hosts serve identical bytes. Each model's own files live in `models.ts`.
 */
import type { DownloadAsset } from '../download/index.js'
import type { VoiceDownloadSource } from '../types.js'

export const SHERPA_VERSION = '1.13.8'

export type RuntimePlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win-x64'

type PinnedSource = Exclude<VoiceDownloadSource, 'auto'>

/** Official host first: `auto` races both, and keeps this order as the fallback order. */
const NPM_REGISTRIES: Record<PinnedSource, string> = {
  official: 'https://registry.npmjs.org',
  mirror: 'https://registry.npmmirror.com',
}

const MODEL_ORIGINS: Record<PinnedSource, string> = {
  official: 'https://huggingface.co',
  mirror: 'https://hf-mirror.com',
}

/** A pinned source uses only that host, so a failure never silently switches hosts. */
function originsFor(origins: Record<PinnedSource, string>, source: VoiceDownloadSource): string[] {
  return source === 'auto' ? [origins.official, origins.mirror] : [origins[source]]
}

/** Runtime packages keyed by the platform they load on. Values are npm sha512 integrity. */
const RUNTIME_PACKAGES: Record<'sherpa-onnx-node' | RuntimePlatform, { bytes: number; integrity: string }> = {
  'sherpa-onnx-node': {
    bytes: 11_954,
    integrity: 'MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==',
  },
  'darwin-arm64': {
    bytes: 10_047_754,
    integrity: 'FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==',
  },
  'darwin-x64': {
    bytes: 11_191_481,
    integrity: '7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==',
  },
  'linux-x64': {
    bytes: 11_089_653,
    integrity: '6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==',
  },
  'linux-arm64': {
    bytes: 13_910_679,
    integrity: 'Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==',
  },
  'win-x64': {
    bytes: 8_894_875,
    integrity: 'oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==',
  },
}

export type InstallStep = 'runtime' | 'model' | 'vad'

/** One thing prepare() installs: a plain file or an npm package extracted into node_modules. */
export interface InstallItem {
  step: InstallStep
  kind: 'file' | 'package'
  asset: DownloadAsset
  /**
   * Package directory name for `package` items. For `file` items, the forward-slash
   * path inside `models/`; tokenizer files keep their repository subdirectory.
   */
  target: string
  /** For packages: a file that must exist after extraction and proves the layout. */
  marker?: string
}

export function resolveRuntimePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RuntimePlatform | undefined {
  const key = `${platform === 'win32' ? 'win' : platform}-${arch}`
  return key in RUNTIME_PACKAGES && key !== 'sherpa-onnx-node' ? (key as RuntimePlatform) : undefined
}

function npmAsset(pkg: string, bytes: number, integrity: string, source: VoiceDownloadSource): DownloadAsset {
  const file = `${pkg}-${SHERPA_VERSION}.tgz`
  return {
    name: file,
    bytes,
    hash: { algorithm: 'sha512', encoding: 'base64', value: integrity },
    urls: originsFor(NPM_REGISTRIES, source).map(registry => `${registry}/${pkg}/-/${file}`),
  }
}

/** A Hugging Face repository at one commit; files are resolved against that revision only. */
export interface PinnedRepository {
  repository: string
  revision: string
}

/** One pinned file of a model repository, installed at the same relative path under `models/`. */
export function huggingFaceFile(
  repo: PinnedRepository,
  path: string,
  bytes: number,
  sha256: string,
  source: VoiceDownloadSource,
  step: InstallStep = 'model',
): InstallItem {
  return {
    step,
    kind: 'file',
    target: path,
    asset: {
      name: path,
      bytes,
      hash: { algorithm: 'sha256', encoding: 'hex', value: sha256 },
      urls: originsFor(MODEL_ORIGINS, source).map(origin => `${origin}/${repo.repository}/resolve/${repo.revision}/${path}`),
    },
  }
}

const VAD_REPOSITORY: PinnedRepository = {
  repository: 'csukuangfj/vad',
  revision: 'fba88cd2e921609e7675c3aaf51e0b9b295da4bc',
}

/** Silero VAD; every model splits recordings with it, and each provider keeps its own copy. */
export function vadItem(source: VoiceDownloadSource = 'auto'): InstallItem {
  return huggingFaceFile(VAD_REPOSITORY, 'silero_vad.onnx', 1_807_522,
    'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28', source, 'vad')
}

export function runtimeItems(platform: RuntimePlatform, source: VoiceDownloadSource = 'auto'): InstallItem[] {
  const node = RUNTIME_PACKAGES['sherpa-onnx-node']
  const native = RUNTIME_PACKAGES[platform]
  return [
    {
      step: 'runtime', kind: 'package', target: 'sherpa-onnx-node', marker: 'sherpa-onnx.js',
      asset: npmAsset('sherpa-onnx-node', node.bytes, node.integrity, source),
    },
    {
      step: 'runtime', kind: 'package', target: `sherpa-onnx-${platform}`, marker: 'sherpa-onnx.node',
      asset: npmAsset(`sherpa-onnx-${platform}`, native.bytes, native.integrity, source),
    },
  ]
}

export function totalDownloadBytes(items: InstallItem[]): number {
  return items.reduce((sum, item) => sum + item.asset.bytes, 0)
}
