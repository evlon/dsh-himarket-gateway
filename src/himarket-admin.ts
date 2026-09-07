/**
 * HiMarket 管理员客户端（服务端持有管理员凭据，绝不暴露给前端）。
 *
 * 封装 HiMarket /api/v1 的管理员端点：
 *  - 分类幂等（确保「数字员工岗位」分类存在）
 *  - 建/复用产品（按 name 幂等）
 *  - 上传 zip（multipart/form-data，文件名带时间戳强制新版本）
 *  - 创建 draft 版本（baseVersion 递增）
 *  - 发布 online（force）
 *  - 发布到门户（可选）
 *
 * 逻辑移植自 dsh-himarket/src/himarket-client.ts 的 publishSkillPackage，
 * 但管理员 token 从服务端配置读取，代码中不出现任何前端传入的管理员密码。
 *
 * @module dsh-himarket-gateway/himarket-admin
 */

const API_PREFIX = '/api/v1'

interface Wrapped<T> {
  code?: string
  message?: string
  data?: T
}

interface CategoryItem {
  categoryId?: string
  name?: string
}
interface ProductItem {
  productId?: string
  name?: string
}
interface SkillVersion {
  version?: string
  status?: string
}

export interface PublishResult {
  productId: string
  version: string
  created: boolean
}

export class AdminClientError extends Error {}

export class HimarketAdminClient {
  private readonly baseUrl: string
  private readonly adminUsername: string
  private readonly adminPassword: string
  private adminToken = ''
  private fetchFn: typeof fetch

  constructor(opts: {
    baseUrl: string
    adminUsername: string
    adminPassword: string
    fetchFn?: typeof fetch
  }) {
    const trimmed = opts.baseUrl.trim().replace(/\/+$/u, '')
    if (trimmed === '') throw new AdminClientError('未配置 HiMarket 地址')
    this.baseUrl = trimmed
    this.adminUsername = opts.adminUsername
    this.adminPassword = opts.adminPassword
    this.fetchFn = opts.fetchFn ?? globalThis.fetch
  }

  private async loginAdmin(): Promise<string> {
    if (this.adminPassword === '') {
      throw new AdminClientError('服务端未配置 HiMarket 管理员密码')
    }
    const wrapped = await this.adminRequest<{ access_token?: string }>('/admins/login', {
      method: 'POST',
      body: JSON.stringify({ username: this.adminUsername, password: this.adminPassword }),
    })
    const token = wrapped.access_token
    if (token === undefined || token === '') {
      throw new AdminClientError('管理员登录成功但未返回 access_token')
    }
    this.adminToken = token
    return token
  }

  /**
   * 发布一个产品包（AGENT_SKILL 类型）到 HiMarket。
   * @param name 产品名（岗位 id，唯一）
   * @param zipBuffer 打包好的 zip 字节
   * @param opts.categoryName 分类名；portalId 可选
   */
  async publishPackage(
    name: string,
    zipBuffer: Uint8Array,
    opts: { categoryName: string; portalId?: string },
  ): Promise<PublishResult> {
    if (this.adminToken === '') await this.loginAdmin()

    // 1. 分类幂等
    const cats = await this.adminRequest<{ content?: CategoryItem[] }>('/product-categories?size=100')
    const catList = cats.content ?? []
    let catId = catList.find((c) => c.name === opts.categoryName)?.categoryId ?? ''
    if (catId === '') {
      const created = await this.adminRequest<CategoryItem>('/product-categories', {
        method: 'POST',
        body: JSON.stringify({
          name: opts.categoryName,
          description: '可安装的数字员工岗位包：含岗位 preset 与岗位专项技能',
        }),
      })
      catId = created.categoryId ?? ''
      if (catId === '') throw new AdminClientError('创建分类失败')
    }

    // 2. 建/复用产品（按 name 幂等）
    const prods = await this.adminRequest<{ content?: ProductItem[] }>(`/products?type=AGENT_SKILL&size=200`)
    const prodList = prods.content ?? []
    let productId = prodList.find((p) => p.name === name)?.productId ?? ''
    let created = false
    if (productId === '') {
      const createdProd = await this.adminRequest<ProductItem>('/products', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: `[岗位包] ${name} 数字员工岗位`,
          type: 'AGENT_SKILL',
          document: `# ${name} 数字员工岗位包`,
          autoApprove: true,
          categories: [catId],
        }),
      })
      productId = createdProd.productId ?? ''
      if (productId === '') throw new AdminClientError('创建产品失败')
      created = true
    }

    // 3. 上传 zip（文件名带时间戳强制新版本）
    const uploadBody = new FormData()
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    uploadBody.append('file', new Blob([zipBuffer], { type: 'application/zip' }), `${name}-${stamp}.zip`)
    const uploadUrl = `${this.baseUrl}${API_PREFIX}/skills/${encodeURIComponent(productId)}/package`
    const uploadRes = await this.fetchFn(uploadUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.adminToken}` },
      body: uploadBody,
    })
    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => '')
      throw new AdminClientError(`上传技能包失败（HTTP ${uploadRes.status}）${body.slice(0, 200)}`)
    }
    const uploadJson = (await uploadRes.json().catch(() => ({ code: 'PARSE_ERROR' }))) as Wrapped<unknown>
    if (uploadJson.code !== undefined && uploadJson.code !== 'SUCCESS') {
      throw new AdminClientError(uploadJson.message ?? '上传技能包失败')
    }

    // 4. 发布最新 draft 版本为 online（force）
    const versions = await this.adminRequest<SkillVersion[]>(`/skills/${encodeURIComponent(productId)}/versions`)
    const vlist = Array.isArray(versions) ? versions : (versions as unknown as SkillVersion[])
    const sorted = [...vlist].sort((a, b) => String(b.version).localeCompare(String(a.version)))
    const latestOnline = [...sorted].reverse().find((v) => v.status === 'online')
    const draft = [...sorted].reverse().find((v) => v.status === 'draft')
    let ver: string | undefined = draft?.version !== undefined ? String(draft.version) : undefined
    if (ver === undefined) {
      const baseVersion = latestOnline?.version !== undefined ? String(latestOnline.version) : undefined
      const nextVersion = bumpVersion(baseVersion)
      await this.adminRequest<unknown>(`/skills/${encodeURIComponent(productId)}/draft`, {
        method: 'POST',
        body: JSON.stringify({
          ...(baseVersion !== undefined ? { baseVersion } : {}),
          version: nextVersion,
        }),
      })
      ver = nextVersion
    }
    const pubResp = await this.adminRequest<unknown>(
      `/skills/${encodeURIComponent(productId)}/versions/${encodeURIComponent(ver)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status: 'online', force: true, updateLatestLabel: true }),
      },
    )
    const pubCode = (pubResp as Wrapped<unknown>).code
    if (pubCode !== undefined && pubCode !== 'SUCCESS') {
      throw new AdminClientError(`发布版本失败：${(pubResp as Wrapped<unknown>).message ?? ver}`)
    }

    // 5. 发布到门户（可选）
    if (opts.portalId !== undefined && opts.portalId.trim() !== '') {
      await this.adminRequest<unknown>(`/products/${encodeURIComponent(productId)}/publications`, {
        method: 'POST',
        body: JSON.stringify({ portalId: opts.portalId }),
      }).catch((e) => {
        throw new AdminClientError(`已发布版本，但发布到门户失败：${e instanceof Error ? e.message : String(e)}`)
      })
    }

    return { productId, version: ver, created }
  }

  /** 删除产品（管理员强制删除，调用前由归属层校验）。 */
  async deleteProduct(productId: string): Promise<void> {
    if (this.adminToken === '') await this.loginAdmin()
    await this.adminRequest<unknown>(`/products/${encodeURIComponent(productId)}`, { method: 'DELETE' })
  }

  /**
   * 列出全部产品（翻页，最多 5 页 × 200）。
   * @returns [{ productId, name, type, status }]
   */
  async listProducts(): Promise<Array<{ productId?: string; name?: string; type?: string; status?: string; description?: string }>> {
    if (this.adminToken === '') await this.loginAdmin()
    let page = 1
    let all: Array<{ productId?: string; name?: string; type?: string; status?: string; description?: string }> = []
    for (;;) {
      const res = await this.adminRequest<{ content?: Array<{ productId?: string; name?: string; type?: string; status?: string; description?: string }> }>(
        `/products?pageNum=${page}&pageSize=200&type=AGENT_SKILL`,
      )
      const content = res.content ?? []
      all = all.concat(content)
      if (content.length < 200) break
      page += 1
      if (page > 5) break
    }
    return all
  }

  private async adminRequest<T>(path: string, opts: { method?: string; body?: string } = {}): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      const res = await this.fetchFn(this.baseUrl + API_PREFIX + path, {
        method: opts.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.adminToken !== '' ? { Authorization: `Bearer ${this.adminToken}` } : {}),
        },
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      })
      return res
    }
    let res = await doFetch()
    if (res.status === 401) {
      await this.loginAdmin()
      res = await doFetch()
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new AdminClientError(`HiMarket 管理端请求失败（HTTP ${res.status}）${body.slice(0, 200)}`)
    }
    const wrapped = (await res.json().catch(() => ({ code: 'PARSE_ERROR' }))) as Wrapped<T>
    if (wrapped.code !== undefined && wrapped.code !== 'SUCCESS') {
      throw new AdminClientError(wrapped.message ?? `HiMarket 返回错误码 ${wrapped.code}`)
    }
    return (wrapped.data ?? (wrapped as unknown as T)) as T
  }
}

/** semver 递增：0.0.1 → 0.0.2；无 base 时返回 0.0.1。 */
function bumpVersion(base: string | undefined): string {
  if (base === undefined || base.trim() === '') return '0.0.1'
  const parts = base.trim().split('.').map((p) => parseInt(p, 10) || 0)
  while (parts.length < 3) parts.push(0)
  const patch = (parts[2] ?? 0) + 1
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${patch}`
}
