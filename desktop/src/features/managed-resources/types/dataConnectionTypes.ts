/**
 * 数据库与 Redis 连接的纯领域类型。
 *
 * 形状固定对应 `design/linux-hosts-knowledge/05-database-redis-design.md`
 * 第 3 节的 v2 设计；与 `resourceTypes.ts` 的实体共同构成
 * `ResourceDocument.dataConnections`。
 *
 * 本文件只描述类型，不引用 Zod、Electron 或驱动。
 */

import type { EntityMeta, Id, TagNamespace } from './resourceTypes.js'

export type DatabaseEngine = 'mysql' | 'mariadb' | 'postgresql'

export type RedisTopology = 'standalone'

export type ConnectionEnvironment =
  | 'development'
  | 'test'
  | 'staging'
  | 'production'
  | 'unspecified'

export type ConnectionMode = 'inspection' | 'query'

/**
 * TLS 配置。caCertificate 为公共 CA PEM；clientKeyCredentialId
 * 指向 vault 中的 `tls-client-key` 凭据。开启时必须验证证书链，
 * 不允许 `rejectUnauthorized:false` 隐式回退。
 */
export type ConnectionTls = {
  enabled: boolean
  serverName: string | null
  caCertificate: string | null
  clientCertificate: string | null
  clientKeyCredentialId: Id | null
}

/**
 * 数据库 / Redis 共用的连接基础。
 * `tagIds` 元素属于同一 `host | database | redis | concept` 命名空间。
 */
export type ConnectionBase = EntityMeta & {
  name: string
  address: string
  port: number
  username: string | null
  credentialId: Id | null
  tagIds: Id[]
  /** 仅说明服务部署关系；不自动将该主机的 SSH 密码加入上下文。 */
  relatedHostId: Id | null
  environment: ConnectionEnvironment
  tls: ConnectionTls
  description: string
  accessInstructions: string
}

/**
 * SQL 连接。`mode` 决定是否能直接由用户输入任意 SQL。
 */
export type SqlConnection = ConnectionBase & {
  kind: 'database'
  engine: DatabaseEngine
  database: string
  schema: string | null
  mode: ConnectionMode
}

/**
 * Redis 连接（首版仅 standalone）。
 * `keyPrefixDescription` 仅是说明，不参与匹配；空字符串合法。
 */
export type RedisConnection = ConnectionBase & {
  kind: 'redis'
  topology: RedisTopology
  databaseIndex: number
  keyPrefixDescription: string
}

/**
 * `ResourceDocument.dataConnections` 的判别联合。
 * 通过 `kind` 在 schema 中做 exhaustive 校验。
 */
export type DataConnection = SqlConnection | RedisConnection

/**
 * 给 `sourceTags.namespace` 用的 namespace 枚举，
 * 与 `ResourceTag.namespace` 保持一致；这里再次导出避免
 * 选择器代码绕开 resourceTypes 直接依赖 TagNamespace。
 */
export type DataConnectionTagNamespace = Extract<TagNamespace, 'database' | 'redis'>
