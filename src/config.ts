/**
 * 包装层配置（服务端持有，绝不暴露给前端）。
 *
 * 通过环境变量 / .env 注入；管理员凭据只在服务端使用，用于以管理员身份
 * 代开发者调用 HiMarket 的写端点（创建产品 / 上传 zip / 发布版本 / 门户发布）。
 *
 * @module dsh-himarket-gateway/config
 */

export interface GatewayConfig {
  /** 监听端口。 */
  port: number
  /** 仅允许这些来源 IP 访问（默认仅本机 127.0.0.1 / ::1）。 */
  allowlist: string[]
  /**
   * HiMarket 后端 baseUrl。
   * 默认按部署环境档位给出：新 K8S 环境 http://market.ai.ict.cmcc，
   * 旧环境 http://ai-market.ict.cmcc。可经 `HIMARKET_BASE_URL` 整条覆盖，
   * 或经 `HIMARKET_DEPLOY_ENV=legacy` / `HIMARKET_DOMAIN_SUFFIX` 整体切档。
   */
  himarketBaseUrl: string
  /** HiMarket 管理员账号（服务端持有，不下发前端）。 */
  adminUsername: string
  adminPassword: string
  /** 包装层归属/审计存储的 SQLite 文件路径。 */
  dbPath: string
  /** 开发者发布包默认归属的产品分类名。 */
  categoryName: string
  /** 官方发布者账号白名单：这些账号发布的产品标记为「企业发布」，其余为「员工共建」。 */
  officialDeveloperIds: string[]
  /** 官方产品名清单（企业发布的最小可用稳定集）；不在清单内的历史产品一律按 COMMUNITY 打标。 */
  officialProducts: string[]
  /**
   * 视为「管理员」的 Keycloak realm 角色（来自 OIDC token 的 realm_access.roles）。
   * 配了此项后，角色判定优先走 IdP，实现身份与权限统一管理。
   */
  adminRoles: string[]
  /**
   * 视为「可发布（企业发布身份）」的 Keycloak realm 角色。
   * 命中任一即视为官方发布者（与 officialDeveloperIds 白名单取并集）。
   */
  publisherRoles: string[]
}

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v !== undefined && v.trim() !== '' ? v.trim() : fallback
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** 新环境域名后缀（默认）。 */
const DEFAULT_DOMAIN_SUFFIX = 'ai.ict.cmcc'

/**
 * HiMarket 门户默认地址（可切换部署环境，新旧环境并存）。
 *
 * 两套环境命名规律不同，故用「环境档位」而非单纯换后缀：
 *   新环境：`market.ai.ict.cmcc`（默认）
 *   旧环境：`ai-market.ict.cmcc`（`HIMARKET_DEPLOY_ENV=legacy`）
 * `HIMARKET_DOMAIN_SUFFIX` 可只换后缀（指向其他按新规律命名的环境）。
 * 以上任一都不合适时，用 `HIMARKET_BASE_URL` 直接给整条 URL（优先级最高）。
 */
function defaultHimarketBaseUrl(): string {
  const suffix = process.env.HIMARKET_DOMAIN_SUFFIX?.trim().replace(/^\.+/u, '')
  if (suffix !== undefined && suffix !== '') return `http://market.${suffix}`
  const legacy = process.env.HIMARKET_DEPLOY_ENV?.trim().toLowerCase() === 'legacy'
  return legacy ? 'http://ai-market.ict.cmcc' : `http://market.${DEFAULT_DOMAIN_SUFFIX}`
}

export function loadConfig(): GatewayConfig {
  const allowRaw = env('GATEWAY_ALLOWLIST', '127.0.0.1,::1')
  const allowlist = allowRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const home = process.env.DSH_HOME?.trim() || process.env.USERPROFILE || process.env.HOME || '.'
  const dbPath = env('GATEWAY_DB_PATH', `${home}/.dsh-himarket-gateway/audit.db`)

  const officialRaw = env('OFFICIAL_DEVELOPER_IDS', 'admin')
  const officialDeveloperIds = officialRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const officialProdRaw = env('OFFICIAL_PRODUCTS', 'communication,dsh-roster,secretary,reception,general')
  const officialProducts = officialProdRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  // Keycloak 角色（来自 OIDC token）——身份与权限统一由 IdP 管理
  const adminRolesRaw = env('GATEWAY_ADMIN_ROLES', 'platform-admin,portal-admin')
  const adminRoles = adminRolesRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const publisherRolesRaw = env(
    'GATEWAY_PUBLISHER_ROLES',
    'platform-admin,gateway-publisher',
  )
  const publisherRoles = publisherRolesRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  return {
    port: envInt('GATEWAY_PORT', 3091),
    allowlist: allowlist.length > 0 ? allowlist : ['127.0.0.1', '::1'],
    himarketBaseUrl: env('HIMARKET_BASE_URL', defaultHimarketBaseUrl()),
    adminUsername: env('HIMARKET_ADMIN_USERNAME', 'admin'),
    adminPassword: env('HIMARKET_ADMIN_PASSWORD', ''),
    dbPath,
    categoryName: env('HIMARKET_CATEGORY', '数字员工岗位'),
    officialDeveloperIds: officialDeveloperIds.length > 0 ? officialDeveloperIds : ['admin'],
    officialProducts,
    adminRoles,
    publisherRoles,
  }
}
