/**
 * 开发者身份鉴权：小白用 HiMarket 开发者账号登录，网关用其 access_token
 * 识别「当前开发者是谁」，作为归属（ownership）与审计（audit）的 actor。
 *
 * 设计：
 *  - 网关不存开发者密码，只转发 /developers/login 拿 token；
 *  - 后续写操作都带开发者 token，网关解析出 username 作为 actor；
 *  - 若 HiMarket 暴露 /developers/profile（PublicAccess），用它校验 token 并取 username。
 *
 * 角色来源（两种，可并存）：
 *  1. **Keycloak 角色**（推荐）：若 HiMarket 的 token 中带 realm_access.roles，
 *     则据此判定角色 —— 身份与权限统一由 IdP 管理。
 *  2. **静态白名单**：`OFFICIAL_DEVELOPER_IDS`（向后兼容，无 Keycloak 时使用）。
 *
 * @module dsh-himarket-gateway/auth
 */

/**
 * API 路径前缀。
 *
 * HiMarket 后端自身**不带** `/api/v1` 前缀（那是前端 nginx 加的），
 * 但生产入口（经 nginx/Higress）需要带前缀。
 * 因此做成可配置：默认 `/api/v1`（指向前端/网关入口），
 * 直连后端时设 `HIMARKET_API_PREFIX=""`（空字符串）。
 */
const API_PREFIX = (() => {
  const v = process.env.HIMARKET_API_PREFIX
  if (v === undefined) return '/api/v1'
  return v.trim().replace(/\/+$/u, '')
})()

export interface DeveloperIdentity {
  username: string
  token: string
  /** 从 token 解析出的 realm 角色（Keycloak），无则为空数组。 */
  roles: string[]
}

export class DeveloperAuthError extends Error {}

/** 解码 JWT payload（不验签 —— 验签由签发方 HiMarket/Keycloak 负责，此处仅取声明）。 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  const segment = parts[1]
  if (segment === undefined || segment === '') return {}
  let p = segment.replace(/-/g, '+').replace(/_/g, '/')
  p += '='.repeat((4 - (p.length % 4)) % 4)
  try {
    const json = Buffer.from(p, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * 从 JWT 中提取 realm 角色。
 *
 * 支持两种声明位置：
 *  - `realm_access.roles`（Keycloak 标准）
 *  - `roles`（简化形式，部分实现使用）
 */
export function extractRoles(token: string): string[] {
  const payload = decodeJwtPayload(token)
  const out = new Set<string>()

  const realmAccess = payload.realm_access
  if (realmAccess !== null && typeof realmAccess === 'object') {
    const roles = (realmAccess as Record<string, unknown>).roles
    if (Array.isArray(roles)) {
      for (const r of roles) if (typeof r === 'string') out.add(r)
    }
  }

  const flat = payload.roles
  if (Array.isArray(flat)) {
    for (const r of flat) if (typeof r === 'string') out.add(r)
  }

  return [...out]
}

export class DeveloperAuth {
  private readonly baseUrl: string
  private fetchFn: typeof fetch

  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    const trimmed = baseUrl.trim().replace(/\/+$/u, '')
    if (trimmed === '') throw new DeveloperAuthError('未配置 HiMarket 地址')
    this.baseUrl = trimmed
    this.fetchFn = fetchFn ?? globalThis.fetch
  }

  /** 开发者登录，返回身份（token）。 */
  async login(username: string, password: string): Promise<DeveloperIdentity> {
    if (username.trim() === '' || password.trim() === '') {
      throw new DeveloperAuthError('开发者账号用户名或密码为空')
    }
    const res = await this.fetchFn(`${this.baseUrl}${API_PREFIX}/developers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new DeveloperAuthError(`开发者登录失败（HTTP ${res.status}）${body.slice(0, 120)}`)
    }
    const json = (await res.json().catch(() => ({ code: 'PARSE_ERROR' }))) as {
      code?: string
      message?: string
      data?: { access_token?: string }
    }
    if (json.code !== undefined && json.code !== 'SUCCESS') {
      throw new DeveloperAuthError(json.message ?? '开发者登录失败')
    }
    const token = json.data?.access_token
    if (token === undefined || token === '') {
      throw new DeveloperAuthError('登录成功但未返回 access_token')
    }
    // 用 token 取 profile 拿到真实 username（避免前端传错/伪造）。
    const identity = await this.resolveProfile(token)
    return identity
  }

  /** 用开发者 token 取 profile，确认 token 有效并解析出 username。 */
  async resolveProfile(token: string): Promise<DeveloperIdentity> {
    const res = await this.fetchFn(`${this.baseUrl}${API_PREFIX}/developers/profile`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      throw new DeveloperAuthError(`开发者 token 校验失败（HTTP ${res.status}）`)
    }
    const json = (await res.json().catch(() => ({ code: 'PARSE_ERROR' }))) as {
      code?: string
      message?: string
      data?: { username?: string; userId?: string }
    }
    if (json.code !== undefined && json.code !== 'SUCCESS') {
      throw new DeveloperAuthError(json.message ?? '开发者 token 校验失败')
    }
    const data = json.data
    const username = data?.username ?? data?.userId
    if (username === undefined || username === '') {
      throw new DeveloperAuthError('无法从 profile 解析开发者身份')
    }
    return { username, token, roles: extractRoles(token) }
  }
}
