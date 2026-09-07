/**
 * 资源管理（主机、概念、凭据、引用、清单）纯领域类型。
 *
 * 本文件只描述数据形状，不引用 Zod、Electron、ssh2 或数据库驱动。
 * 形状固定对应 `design/linux-hosts-knowledge/02-functional-technical-design.md`
 * 与 `05-database-redis-design.md` 的 v2 设计。
 *
 * v1 形状仅用于迁移 fixture，本文件不导出 v1 DTO。
 */

import type { DataConnection } from './dataConnectionTypes.js'

export type Id = string
export type Revision = number
export type Iso8601Utc = string

/**
 * 实体通用元数据。revision 从 1 起递增；同一 id 下单调。
 */
export type EntityMeta = {
  id: Id
  revision: Revision
  createdAt: Iso8601Utc
  updatedAt: Iso8601Utc
}

/**
 * 标签命名空间。同一 namespace 下 normalizedName 必须唯一；
 * 不同 namespace 允许同名标签共存（如 host 与 concept 各有一个 "prod"）。
 */
export type TagNamespace = 'host' | 'database' | 'redis' | 'concept'

export type ResourceTag = EntityMeta & {
  namespace: TagNamespace
  /** 展示名，1–120 字符。 */
  name: string
  /** 归一化比较名：`NFKC -> trim -> 折叠空白 -> locale-independent lower case`。 */
  normalizedName: string
  colorToken: string | null
}

export type HostAuthType = 'password' | 'privateKey'

export type HostAuth = {
  type: HostAuthType
  credentialId: Id | null
}

export type HostApplicationAccount = {
  id: Id
  label: string
  username: string
  credentialId: Id | null
}

export type HostApplication = {
  id: Id
  name: string
  version: string | null
  installPaths: string[]
  accessDescription: string
  /** 仅允许 http/https，且不带凭据 userinfo。 */
  accessUrls: string[]
  loginUrl: string | null
  accounts: HostApplicationAccount[]
  notes: string
}

export type Host = EntityMeta & {
  name: string
  /** IP 或 DNS；不含协议、端口、用户名、路径。 */
  address: string
  port: number
  username: string
  auth: HostAuth
  tagIds: Id[]
  /** 远端绝对 POSIX 路径或 null。 */
  initialDirectory: string | null
  applications: HostApplication[]
  notes: string
}

export type Concept = EntityMeta & {
  title: string
  summary: string
  /** 正文，最大 64 KiB。 */
  bodyMarkdown: string
  tagIds: Id[]
  dependsOnIds: Id[]
  referenceIds: Id[]
}

/**
 * 凭据种类。`backend` 决定密文是否可被本进程解密；公开 DTO 只暴露
 * kind/label/credentialId/hasSecret，不暴露 ciphertext。
 */
export type CredentialKind =
  | 'ssh-password'
  | 'ssh-private-key'
  | 'application-password'
  | 'database-password'
  | 'redis-password'
  | 'tls-client-key'

export type CredentialBackend = 'electron-safe-storage-v1'

export type CredentialRecord = EntityMeta & {
  kind: CredentialKind
  label: string
  backend: CredentialBackend
  /** canonical Base64 编码（RFC 4648，含 `+/=` 子集；不含 `+/=` 之外的字符）。 */
  ciphertextBase64: string
}

/**
 * canonical endpoint（IPv6 显式括号形式）+ algorithm + OpenSSH SHA-256 指纹。
 * 字段 `sha256` 仅保存 `SHA256:` 后 43 字符无填充 Base64 主体。
 * 修改主机 address/port 不继承原 endpoint 信任。
 */
export type KnownHostKey = {
  endpoint: string
  algorithm: string
  /** 43 字符无填充 Base64，含 `+`/`/`，不含 `=` 填充；其它长度或字符集被拒绝。 */
  sha256: string
  trustedAt: Iso8601Utc
}

/**
 * 单个 resources.json 文档的根类型。
 * 通过 Zod `.passthrough()` 保留未知字段以兼容已部署数据。
 */
export type ResourceDocument = {
  schemaVersion: 2
  revision: number
  hosts: Host[]
  tags: ResourceTag[]
  concepts: Concept[]
  dataConnections: DataConnection[]
  credentials: CredentialRecord[]
  knownHostKeys: KnownHostKey[]
}

/**
 * 上下文引用里的实体版本指针。解析时不重新按 id 查询资源；发送前
 * 必须复查实体当前 revision 与 credential revision 仍与 ref 一致。
 */
export type EntityVersionRef = {
  id: Id
  revision: Revision
}

/**
 * 一个 sourceTag 描述一次“按标签选中”。同一 namespace+tagId 只允许
 * 一个来源；解析时 memberIds 与 direct* 列表并集，重复 id 自动去重。
 */
export type SourceTag = {
  namespace: TagNamespace
  id: Id
  labelAtSelection: string
  memberIds: Id[]
}

/**
 * v2 选择对象。schemaVersion 必须为 2。
 * sourceTags 与 direct* 列表允许重叠（如同一主机既被某个标签选中又被直接选择）。
 * credentialRefs 仅在 includePasswords=true 时实际持有；false 时数组为空。
 */
export type ConversationContextSelectionV2 = {
  schemaVersion: 2
  hostRefs: EntityVersionRef[]
  conceptRootRefs: EntityVersionRef[]
  dependencyRefs: EntityVersionRef[]
  databaseRefs: EntityVersionRef[]
  redisRefs: EntityVersionRef[]
  credentialRefs: EntityVersionRef[]
  sourceTags: SourceTag[]
  directHostIds: Id[]
  directConceptIds: Id[]
  directDatabaseIds: Id[]
  directRedisIds: Id[]
  includePasswords: boolean
}

export type PublicDatabaseSummary = {
  id: Id
  name: string
  engine: 'mysql' | 'mariadb' | 'postgresql'
  address: string
  port: number
  database: string
  schema: string | null
}

export type PublicRedisSummary = {
  id: Id
  name: string
  address: string
  port: number
  topology: 'standalone'
  databaseIndex: number
}

/**
 * v2 公开清单。绝不包含任何密码、私钥、PEM、密文、含凭据 URL 或其他
 * 秘密字段；保留安全的未知未来字段。Secret denylist 在 schema 中实现。
 */
export type PublicContextManifestV2 = {
  schemaVersion: 2
  requestId: Id
  selection: ConversationContextSelectionV2
  hosts: { id: Id; name: string; address: string; port: number }[]
  concepts: {
    id: Id
    title: string
    includedAs: 'root' | 'dependency'
  }[]
  databases: PublicDatabaseSummary[]
  redisConnections: PublicRedisSummary[]
  resolvedAt: Iso8601Utc
  containsSecrets: boolean
  secretFieldCount: number
  estimatedTokens: number
}
