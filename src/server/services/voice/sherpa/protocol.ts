/**
 * Contract between the server-side recognizer and its worker process.
 *
 * The worker listens on 127.0.0.1 with a random port, prints `{"port":N}` as
 * its first stdout line once the model is loaded, and answers
 * `POST /transcribe?language=<code>` (WAV body, `Authorization: Bearer <token>`).
 * The token and configuration arrive through environment variables that the
 * worker deletes as soon as it has read them.
 */

export const WORKER_CONFIG_ENV = 'CC_HAHA_VOICE_WORKER_CONFIG'
export const WORKER_TOKEN_ENV = 'CC_HAHA_VOICE_WORKER_TOKEN'

export const WORKER_LANGUAGES: readonly string[] = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']

/** Which sherpa-onnx offline recognizer the worker builds, with that engine's files. */
export type WorkerModel =
  | {
      engine: 'sensevoice'
      model: string
      tokens: string
    }
  | {
      engine: 'funasr-nano'
      encoderAdaptor: string
      llm: string
      embedding: string
      /** Directory holding merges.txt, tokenizer.json and vocab.json. */
      tokenizer: string
      maxNewTokens: number
    }
  | {
      engine: 'qwen3-asr'
      convFrontend: string
      encoder: string
      decoder: string
      /** Directory holding merges.txt, tokenizer_config.json and vocab.json. */
      tokenizer: string
      /** KV capacity the decoder was exported with: prompt + audio + generated tokens. */
      maxTotalLen: number
      maxNewTokens: number
    }

export type WorkerEngine = WorkerModel['engine']

/** File fields each engine needs; the worker refuses a config missing any of them. */
export const WORKER_MODEL_FILES: Record<WorkerEngine, readonly string[]> = {
  sensevoice: ['model', 'tokens'],
  'funasr-nano': ['encoderAdaptor', 'llm', 'embedding', 'tokenizer'],
  'qwen3-asr': ['convFrontend', 'encoder', 'decoder', 'tokenizer'],
}

export interface WorkerConfig {
  /** Directory whose `node_modules` contains sherpa-onnx-node and its native package. */
  runtimeRoot: string
  model: WorkerModel
  vad: string
  threads: number
  maxAudioBytes: number
  vadThreshold: number
  minSilenceSeconds: number
  minSpeechSeconds: number
  /** VAD max speech duration. The VAD treats it as a soft limit and can run a few seconds over. */
  segmentSeconds: number
  /** Hard limit: a longer VAD segment is decoded in equal parts no longer than this. */
  maxSegmentSeconds?: number
}

export interface WorkerTranscript {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

/** JSON error body; `code: 'invalid-input'` marks a request the worker rejected before inference. */
export interface WorkerErrorBody {
  error: string
  code?: 'invalid-input'
}
