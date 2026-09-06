/**
 * dsh-himarket-gateway 公开入口。
 *
 * 包装层：HiMarket 发布/权限/审计网关。零改动 HiMarket 本体。
 *
 * @module dsh-himarket-gateway
 */

export { loadConfig, type GatewayConfig } from './config.js'
export { buildServer } from './server.js'
export { HimarketAdminClient } from './himarket-admin.js'
export { OwnershipStore, resolveSource, type ProductSource } from './ownership.js'
export { AuditStore, type AuditAction, type AuditEntry } from './audit.js'
export { DeveloperAuth } from './auth.js'
