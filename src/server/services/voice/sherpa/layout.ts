import { join } from 'node:path'
import { getCcHahaDir } from '../../../../utils/envUtils.js'
import { SHERPA_VERSION, type InstallItem } from './assets.js'

/** `<CLAUDE_CONFIG_DIR>/cc-haha/voice`, resolved lazily so tests can redirect the config dir. */
export function defaultVoiceDataRoot(): string {
  return join(getCcHahaDir(), 'voice')
}

export interface ModelLayout {
  /** `<dataRoot>/<model dir>`; deleting it removes everything this provider installed. */
  base: string
  models: string
  /** Deterministic `.part` files live here, so an interrupted download can continue. */
  downloads: string
  staging: string
  /** Directory whose `node_modules` holds sherpa-onnx-node and its native package. */
  runtimeRoot: string
  manifest: string
}

/**
 * One provider's directory. The shape is the one SenseVoice has always used
 * (`<dataRoot>/sensevoice/...`), so installs made before more models existed stay valid.
 */
export function modelLayout(dataRoot: string, dirName: string): ModelLayout {
  const base = join(dataRoot, dirName)
  return {
    base,
    models: join(base, 'models'),
    downloads: join(base, 'downloads'),
    staging: join(base, 'staging'),
    runtimeRoot: join(base, 'runtime', SHERPA_VERSION),
    manifest: join(base, 'verified.json'),
  }
}

/** Where an item's final payload lives (file path, or package directory). */
export function itemPath(layout: ModelLayout, item: InstallItem): string {
  return item.kind === 'package'
    ? join(layout.runtimeRoot, 'node_modules', item.target)
    : join(layout.models, ...item.target.split('/'))
}

/** Destination of the downloaded bytes; for packages this is the tarball. */
export function itemDownloadPath(layout: ModelLayout, item: InstallItem): string {
  return item.kind === 'package' ? join(layout.downloads, item.asset.name) : itemPath(layout, item)
}

/** File whose size and mtime prove the item is still installed. */
export function itemProofPath(layout: ModelLayout, item: InstallItem): string {
  return item.kind === 'package' ? join(itemPath(layout, item), item.marker!) : itemPath(layout, item)
}

/** Manifest key: forward-slash path relative to `base`. */
export function itemManifestName(layout: ModelLayout, item: InstallItem): string {
  const relative = itemProofPath(layout, item).slice(layout.base.length + 1)
  return relative.split(/[\\/]/).join('/')
}
