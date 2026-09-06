/**
 * 开发者身份鉴权：小白用 HiMarket 开发者账号登录，网关用其 access_token
 * 识别「当前开发者是谁」，作为归属（ownership）与审计（audit）的 actor。
 *
 * 设计：
 *  - 网关不存开发者密码，只转发 /developers/login 拿 token；
 *  - 后续写操作都带开发者 token，网关解析出 username 作为 actor；
 *  - 若 HiMarket 暴露 /developers/profile（PublicAccess），用它校验 token 并取 username。
 *
 * @module dsh-himarket-gateway/auth
 */

const API_PREFIX = '/api/v1'

export interface DeveloperIdentity {
  username: string
  token: string
}

export class DeveloperAuthError extends Error {}

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
    return { username, token }
  }
}
