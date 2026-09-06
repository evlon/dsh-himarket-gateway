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
  /** HiMarket 后端 baseUrl（如 http://ai-market.ict.cmcc）。 */
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

  return {
    port: envInt('GATEWAY_PORT', 3091),
    allowlist: allowlist.length > 0 ? allowlist : ['127.0.0.1', '::1'],
    himarketBaseUrl: env('HIMARKET_BASE_URL', 'http://ai-market.ict.cmcc'),
    adminUsername: env('HIMARKET_ADMIN_USERNAME', 'admin'),
    adminPassword: env('HIMARKET_ADMIN_PASSWORD', ''),
    dbPath,
    categoryName: env('HIMARKET_CATEGORY', '数字员工岗位'),
    officialDeveloperIds: officialDeveloperIds.length > 0 ? officialDeveloperIds : ['admin'],
    officialProducts,
  }
}
