/**
 * sharedSchemas — Host / DataConnection / 持久化对象共用的 Zod 原语。
 *
 * 本文件依赖方向：
 *   sharedSchemas -> zod
 *   dataConnectionSchemas -> sharedSchemas
 *   resourceSchemas -> sharedSchemas + dataConnectionSchemas
 *
 * 严格同步、静态；禁止 dynamic import、Promise、可变缓存、
 * `z.unknown()` 回退或 `z.ZodTypeAny` 兜底。
 */

import { z } from 'zod'

// ---------- 基础原语 ----------

/** UUID v4，符合 `crypto.randomUUID()` 产出。 */
export const IdSchema = z.uuidv4()
export const RevisionSchema = z.number().int().min(1)
/** 仅接受 UTC Z 结尾的时间字符串；拒绝带 offset 的形式。 */
export const Iso8601UtcSchema = z.iso.datetime()

/** 端口整数 1–65535。 */
export const PortSchema = z.number().int().min(1).max(65535)

/** 用户名非空且不含控制字符。 */
export const UsernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, 'username must not contain control characters')

/** 名称 1–120 字符。 */
export const NameSchema = z.string().min(1).max(120)

/** 标签名 1–80 字符。 */
export const TagNameSchema = z.string().min(1).max(80)

/**
 * 概念正文 ≤ 65536 UTF-8 字节（不是 UTF-16 code units）。
 * Canonical 名称：BodyMarkdownSchema。
 * ConceptBodyMarkdownSchema 是同对象别名，保留 a2 调用接口。
 *
 * 双层校验：
 *  - `.max(64 * 1024)` 按 UTF-16 code units（JS string length）做前置快速拒绝，
 *    当字符串以 ASCII/BMP 单码元字符为主时等同于 UTF-8 字节上限。
 *  - `.refine(...)` 严格按 UTF-8 字节长度校验，确保中文 / emoji 等多字节
 *    输入不被绕过。TextEncoder 是浏览器与 Node 全局 API，无需 Node Buffer。
 *  不做 trim、不截断、不改写正文。
 */
const UTF8_BODY_LIMIT = 64 * 1024
const bodyUtf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength
export const BodyMarkdownSchema = z
  .string()
  .min(1)
  .max(64 * 1024)
  .refine((s) => bodyUtf8Bytes(s) <= UTF8_BODY_LIMIT, {
    message: `bodyMarkdown must be at most ${UTF8_BODY_LIMIT} UTF-8 bytes`,
  })
export const ConceptBodyMarkdownSchema = BodyMarkdownSchema

// ---------- AddressSchema ----------
//
// 顺序：
//   1. raw 输入先拒绝 NUL/CR/LF（trim 之前，否则换行被吃掉导致误判）
//   2. trim 两端空白
//   3. trim 后拒绝剩余内部空白
//   4. 拒 scheme 前缀、userinfo、路径、hostname:port
//   5. 仅接受 IPv4 / DNS（至少一个字母）/ raw IPv6
//
// Host 与 DataConnection 必须共享同一个 AddressSchema 实例。

function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return false
  for (const part of m.slice(1)) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return false
  }
  return true
}

function isIPv6(s: string): boolean {
  if (!s.includes(':')) return false
  if (s.includes('@') || s.includes('/')) return false
  try {
    const u = new URL(`http://[${s}]`)
    if (u.port) return false
    return u.hostname.includes(':')
  } catch {
    return false
  }
}

function isDNS(s: string): boolean {
  if (!s || s.length > 253) return false
  if (!/[A-Za-z]/.test(s)) return false
  return s.split('.').every((label) => {
    if (label.length === 0 || label.length > 63) return false
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  })
}

export const AddressSchema = z
  .string()
  .max(1024)
  // 1) raw 拒绝 NUL/CR/LF；trim 会把 '\n' 抹掉，故必须先检查
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), {
    message: 'address must not contain NUL or newline characters',
  })
  // 2) trim 两端空白
  .transform((s) => s.trim())
  // 3) trim 后拒绝剩余内部空白
  .pipe(
    z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !/\s/.test(v), {
        message: 'address must not contain internal whitespace',
      })
      // 4) 拒 scheme/userinfo/path/hostname:port
      .refine((v) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v), {
        message: 'address must not include a URL scheme prefix',
      })
      .refine((v) => !v.includes('@'), {
        message: 'address must not include userinfo',
      })
      .refine((v) => !v.includes('/'), {
        message: 'address must not include a path',
      })
      // 5) IPv4 / DNS / raw IPv6
      .refine((v) => isIPv4(v) || isIPv6(v) || isDNS(v), {
        message: 'address must be IPv4, DNS, or raw IPv6',
      }),
  )

// ---------- AccessUrlSchema ----------
//
// 仅 http/https；URL.username/password 必为空。

export const AccessUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((v, ctx) => {
    let u: URL
    try {
      u = new URL(v)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid URL' })
      return
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'access URL must be http or https' })
    }
    if (u.username !== '' || u.password !== '') {
      ctx.addIssue({
        code: 'custom',
        message: 'access URL must not embed credentials',
      })
    }
  })

// ---------- canonical Base64 ----------
//
// zod 的 z.string().base64() 接受语法上可解但非 canonical 的输入。
// 这里用纯文本解码 → 重编码 → 比较保证 canonical。
// decode/encode 表 = RFC 4648 §4（base64），无 Node Buffer，可用于浏览器。

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function canonicalBase64(input: string): boolean {
  if (input.length === 0) return false
  // 长度必须为 4 的倍数；padding 仅在末尾允许
  if (input.length % 4 !== 0) return false
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    const isAlpha =
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x30 && c <= 0x39) || // 0-9
      c === 0x2b || // +
      c === 0x2f || // /
      c === 0x3d // =
    if (!isAlpha) return false
  }
  // = 仅在末尾，0 或 2 个；canonical pad bits 必须为 0
  const stripped = input.replace(/=+$/, '')
  if (stripped.length % 4 === 1) return false
  // 解码：6 bits → 8 bits
  const bytes: number[] = []
  const table = new Int8Array(256).fill(-1)
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i
  }
  let buffer = 0
  let bits = 0
  for (let i = 0; i < stripped.length; i++) {
    const v = table[stripped.charCodeAt(i)] ?? -1
    if (v < 0) return false
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  // canonical pad bits：剩余的低位必须为 0
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return false
  // 重编码并比较；reEncoded 已正确包含 0/1/2 个 '=' 填充
  let reEncoded = ''
  let bi = 0
  while (bi < bytes.length) {
    const b0 = bytes[bi++] ?? 0
    const b1 = bi < bytes.length ? bytes[bi++] : null
    const b2 = bi < bytes.length ? bytes[bi++] : null
    const t = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    reEncoded += B64_ALPHABET[(t >> 18) & 0x3f]
    reEncoded += B64_ALPHABET[(t >> 12) & 0x3f]
    reEncoded += b1 === null ? '=' : B64_ALPHABET[(t >> 6) & 0x3f]
    reEncoded += b2 === null ? '=' : B64_ALPHABET[t & 0x3f]
  }
  return reEncoded === input
}

export const CanonicalBase64Schema = z
  .string()
  .min(1)
  .max(20 * 1024 * 1024)
  .refine(canonicalBase64, { message: 'must be canonical RFC 4648 Base64' })

// ---------- 单集合 id / 实体数组去重 ----------

export const UniqueIdArraySchema = z.array(IdSchema).superRefine((arr, ctx) => {
  const seen = new Set<string>()
  for (const [i, v] of arr.entries()) {
    if (seen.has(v)) {
      ctx.addIssue({
        code: 'custom',
        path: [i],
        message: 'duplicate id within the same collection',
      })
      return
    }
    seen.add(v)
  }
})

export function UniqueIdObjectArraySchema<T extends { id: string }>(
  element: z.ZodType<T>,
  max: number,
) {
  return z.array(element).max(max).superRefine((arr, ctx) => {
    const seen = new Set<string>()
    for (const [i, v] of arr.entries()) {
      if (seen.has(v.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [i],
          message: 'duplicate id within the same collection',
        })
        return
      }
      seen.add(v.id)
    }
  })
}

// ---------- public secret denylist 共享工具 ----------
//
// 在 public manifest 边界递归遍历对象键名（大小写不敏感），拒绝
// 已知的秘密字段名；同时在遇到 `connectionurl` 键时强制其值为合法
// URL 且无 userinfo。无 userinfo 的 future connectionUrl 仍可透传。
//
// 键集合是模块私有实现细节：不可对外导出可变容器；任何导入方
// 都不应能改变 rejectPublicSecretFields 的判定。

const PUBLIC_SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passphrase',
  'privatekey',
  'privatekeypem',
  'ciphertext',
  'ciphertextbase64',
  'secret',
  'apikey',
  'token',
])

export class PublicSecretFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicSecretFieldError'
  }
}

/**
 * 抛出 PublicSecretFieldError 而不是 ctx.addIssue，因为本工具既
 * 被 resourceSchemas 的 superRefine 也被运行时调用；抛出错误统一
 * 在外层捕获。
 */
export function rejectPublicSecretFields(value: unknown, path: (string | number)[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      rejectPublicSecretFields(value[i], [...path, i])
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase()
      if (PUBLIC_SECRET_KEYS.has(lower)) {
        throw new PublicSecretFieldError(
          `public manifest must not include secret field '${k}' at ${[...path, k].join('.')}`,
        )
      }
      if (lower === 'connectionurl') {
        if (typeof v !== 'string') {
          throw new PublicSecretFieldError(
            `connectionUrl at ${[...path, k].join('.')} must be a string URL`,
          )
        }
        let u: URL
        try {
          u = new URL(v)
        } catch {
          throw new PublicSecretFieldError(
            `connectionUrl at ${[...path, k].join('.')} is not a valid URL`,
          )
        }
        if (u.username !== '' || u.password !== '') {
          throw new PublicSecretFieldError(
            `connectionUrl at ${[...path, k].join('.')} must not embed credentials`,
          )
        }
      }
      rejectPublicSecretFields(v, [...path, k])
    }
  }
}
