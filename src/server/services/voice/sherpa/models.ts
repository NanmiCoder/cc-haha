/**
 * The local recognition models that run on the downloaded sherpa-onnx runtime.
 *
 * Each model installs into its own directory with its own copy of the runtime
 * and VAD, so removing one never breaks another. File sizes and sha256 digests
 * are the Hugging Face LFS records at the pinned commit (small non-LFS files
 * were downloaded and hashed); hf-mirror.com serves the same bytes.
 */
import { join } from 'node:path'
import type { VoiceDownloadSource, VoiceLanguage } from '../types.js'
import {
  huggingFaceFile,
  runtimeItems,
  vadItem,
  type InstallItem,
  type PinnedRepository,
  type RuntimePlatform,
} from './assets.js'
import type { WorkerModel } from './protocol.js'

export interface WorkerTuning {
  threads: number
  /** VAD max speech duration (soft: the VAD can overshoot it by a few seconds). */
  segmentSeconds: number
  /** Hard cap enforced by the worker; longer segments are decoded in equal parts. */
  maxSegmentSeconds?: number
}

export interface LocalModelSpec {
  id: string
  name: string
  /** Directory under the voice data root; deleting the model deletes exactly this. */
  dirName: string
  languages: VoiceLanguage[]
  /** The model's own files in install order; the runtime goes before them and the VAD after. */
  files(source: VoiceDownloadSource): InstallItem[]
  /** Engine section of the worker config for files installed under `models`. */
  workerModel(models: string): WorkerModel
  tuning: WorkerTuning
}

const SENSEVOICE_REPOSITORY: PinnedRepository = {
  repository: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
  revision: '2365baeacb507f821a0c8120fcee3d484dba7a07',
}

/**
 * This export is not byte-identical to the GitHub-release tarball (the three ONNX
 * files differ in size). On 570 scored real dictation clips it matched it within
 * noise: term recall 0.433 vs 0.445 and case-exact 0.227 vs 0.218 (paired
 * McNemar |z| 1.24 / 0.89), CER 0.141 vs 0.142.
 */
const FUNASR_NANO_REPOSITORY: PinnedRepository = {
  repository: 'csukuangfj/sherpa-onnx-funasr-nano-int8-2025-12-30',
  revision: '6f16bd378457e13f36ccf3910df9017f96c346fb',
}

/** Byte-identical to the GitHub-release tarball the benchmark used. */
const QWEN3_ASR_REPOSITORY: PinnedRepository = {
  repository: 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
  revision: '68818b2313fe77bd06f6a7c5068ff3ef59d02b8a',
}

/** Both LLM exports ship the same Qwen3 BPE files. */
const QWEN_MERGES = { bytes: 1_671_853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' }
const QWEN_VOCAB = { bytes: 2_776_833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' }

/*
 * Segment limits. Both LLM exports have a 512-token KV cache shared by the prompt,
 * the audio placeholders and the generated text; past it sherpa silently drops
 * audio. Measured with sherpa-onnx-node 1.13.8 on pause-free speech built from
 * real dictation clips (~7 characters/s, Chinese with English terms):
 *
 * - Fun-ASR-Nano: 29 prompt tokens + ~16.6 audio tokens/s, ~3.5 output tokens/s.
 *   One-piece decode: 15-23 s complete; 28.6 s produced 6 tokens; 30-43 s produced
 *   nothing. Through the VAD on three ~121 s recordings: cap 15 s -> segments up
 *   to 18.1 s, coverage 0.98-1.01, CER 0.089-0.112; cap 20 s -> segments up to
 *   24.4 s, coverage 0.94-0.97; cap 25 s -> coverage 0.53-0.71.
 * - Qwen3-ASR: 15 prompt tokens + 13 audio tokens/s. One-piece decode: 15-23 s
 *   complete; 28.6-30.1 s coverage 0.93-0.95; 35-43 s coverage 0.02-0.24. Through
 *   the VAD: cap 20 s -> segments up to 24.4 s, coverage 0.96-1.01, CER 0.083-0.148
 *   (cap 15 s: CER 0.098-0.158; cap 25 s: CER 0.126-0.148).
 *
 * The VAD overshot its cap by up to 4.4 s, so each LLM engine also gets a hard
 * cap that still leaves room for ~7 output tokens/s, twice the measured rate.
 * With a VAD that never cuts (cap 60 s) on 35-122 s recordings, the hard cap kept
 * coverage at 0.95-1.03 where whole-segment decoding fell to 0.00-0.15.
 * maxNewTokens (256) sits above what the KV cache can hold at those lengths, so
 * only the cache bounds generation; 128 truncated long segments in the benchmark.
 *
 * Threads (60 real clips of ~7.6 s, Apple M5 Pro, identical text at every count):
 * Fun-ASR-Nano 661/515/484 ms and Qwen3-ASR 777/607/584 ms per clip at 2/4/6
 * threads. 4 takes most of the gain and leaves cores for the app; both hold
 * ~2.7 GB resident while loaded.
 */
const LLM_MAX_NEW_TOKENS = 256

export const SENSEVOICE_MODEL: LocalModelSpec = {
  id: 'sensevoice-local',
  name: 'SenseVoice Small (INT8)',
  dirName: 'sensevoice',
  languages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
  files: source => [
    huggingFaceFile(SENSEVOICE_REPOSITORY, 'model.int8.onnx', 239_233_841,
      'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', source),
    huggingFaceFile(SENSEVOICE_REPOSITORY, 'tokens.txt', 315_894,
      'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', source),
  ],
  workerModel: models => ({
    engine: 'sensevoice',
    model: join(models, 'model.int8.onnx'),
    tokens: join(models, 'tokens.txt'),
  }),
  // A CTC model: long segments cost nothing extra, so the VAD cap alone is enough.
  tuning: { threads: 2, segmentSeconds: 30 },
}

export const FUNASR_NANO_MODEL: LocalModelSpec = {
  id: 'funasr-nano-local',
  name: 'Fun-ASR-Nano',
  dirName: 'funasr-nano',
  languages: ['auto'],
  files: source => [
    huggingFaceFile(FUNASR_NANO_REPOSITORY, 'encoder_adaptor.int8.onnx', 237_792_748,
      'f36dea2e30fbc33b5db1d7a7265cc976c5e5586c77b042d5adb1ad27c72db422', source),
    huggingFaceFile(FUNASR_NANO_REPOSITORY, 'llm.int8.onnx', 600_356_593,
      'dfbf9aa3be41bccc257587f151e15c63fbe1b549f2b517f5ccd5bdce3bf4322a', source),
    huggingFaceFile(FUNASR_NANO_REPOSITORY, 'embedding.int8.onnx', 155_584_380,
      '95e61cd0c9c3b9543339a4cf973c95c116815e745ccc1e0285cbd81f76d18644', source),
    huggingFaceFile(FUNASR_NANO_REPOSITORY, 'Qwen3-0.6B/merges.txt', QWEN_MERGES.bytes, QWEN_MERGES.sha256, source),
    huggingFaceFile(FUNASR_NANO_REPOSITORY, 'Qwen3-0.6B/tokenizer.json', 11_422_654,
      'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4', source),
    huggingFaceFile(FUNASR_NANO_REPOSITORY, 'Qwen3-0.6B/vocab.json', QWEN_VOCAB.bytes, QWEN_VOCAB.sha256, source),
  ],
  workerModel: models => ({
    engine: 'funasr-nano',
    encoderAdaptor: join(models, 'encoder_adaptor.int8.onnx'),
    llm: join(models, 'llm.int8.onnx'),
    embedding: join(models, 'embedding.int8.onnx'),
    tokenizer: join(models, 'Qwen3-0.6B'),
    maxNewTokens: LLM_MAX_NEW_TOKENS,
  }),
  // 20 s: 29 + 332 audio tokens leaves 151 for text.
  tuning: { threads: 4, segmentSeconds: 15, maxSegmentSeconds: 20 },
}

export const QWEN3_ASR_MODEL: LocalModelSpec = {
  id: 'qwen3-asr-local',
  name: 'Qwen3-ASR 0.6B',
  dirName: 'qwen3-asr',
  languages: ['auto'],
  files: source => [
    huggingFaceFile(QWEN3_ASR_REPOSITORY, 'conv_frontend.onnx', 44_148_281,
      'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e', source),
    huggingFaceFile(QWEN3_ASR_REPOSITORY, 'encoder.int8.onnx', 182_491_662,
      '60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9', source),
    huggingFaceFile(QWEN3_ASR_REPOSITORY, 'decoder.int8.onnx', 755_914_231,
      '4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771', source),
    huggingFaceFile(QWEN3_ASR_REPOSITORY, 'tokenizer/merges.txt', QWEN_MERGES.bytes, QWEN_MERGES.sha256, source),
    huggingFaceFile(QWEN3_ASR_REPOSITORY, 'tokenizer/tokenizer_config.json', 12_487,
      '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c', source),
    huggingFaceFile(QWEN3_ASR_REPOSITORY, 'tokenizer/vocab.json', QWEN_VOCAB.bytes, QWEN_VOCAB.sha256, source),
  ],
  workerModel: models => ({
    engine: 'qwen3-asr',
    convFrontend: join(models, 'conv_frontend.onnx'),
    encoder: join(models, 'encoder.int8.onnx'),
    decoder: join(models, 'decoder.int8.onnx'),
    tokenizer: join(models, 'tokenizer'),
    maxTotalLen: 512,
    maxNewTokens: LLM_MAX_NEW_TOKENS,
  }),
  // 25 s: 15 + 325 audio tokens leaves 172 for text.
  tuning: { threads: 4, segmentSeconds: 20, maxSegmentSeconds: 25 },
}

/** Catalog order: the default model first. */
export const LOCAL_MODELS: readonly LocalModelSpec[] = [SENSEVOICE_MODEL, FUNASR_NANO_MODEL, QWEN3_ASR_MODEL]

/** Everything a model needs on a platform, in install order. Unsupported platforms get files only. */
export function installItems(
  spec: LocalModelSpec,
  platform: RuntimePlatform | undefined,
  source: VoiceDownloadSource = 'auto',
): InstallItem[] {
  return [...(platform ? runtimeItems(platform, source) : []), ...spec.files(source), vadItem(source)]
}
