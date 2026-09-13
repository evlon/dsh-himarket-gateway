/**
 * 包装层 HTTP 服务入口。
 *
 * 负责：
 *  - 仅白名单（默认本机）可访问
 *  - 开发者登录（/auth/login）→ 返回开发者 token（由网关持有，前端只保留 session token）
 *  - 发布岗位（/publish）：开发者身份 + 归属校验 → 管理员代发 → 登记归属 + 写审计
 *  - 更新/迭代（复用 /publish，同名即迭代；归属不符则 403）
 *  - 删除（/delete）：仅 owner 可删
 *  - 审计查询（/audit）：企业查看「谁上传/下载/更新了什么」
 *  - 下载代理（/download）：记录「谁下载了什么」后，回源 HiMarket 的技能 zip
 *
 * 注意：前端（dsh-himarket 插件）不再持有管理员密码；管理员凭据只在服务端。
 *
 * @module dsh-himarket-gateway/server
 */

import { createServer } from 'node:http'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, type GatewayConfig } from './config.js'
import { HimarketAdminClient, AdminClientError } from './himarket-admin.js'
import { OwnershipStore, resolveSource } from './ownership.js'
import { AuditStore, type AuditAction } from './audit.js'
import { DeveloperAuth, DeveloperAuthError } from './auth.js'

interface Session {
  developerId: string
  token: string
  /** 'admin'（企业管理员）或 'developer'（普通开发者）。admin 可看全量审计。 */
  role: 'admin' | 'developer'
  /** 是否具备「企业发布」身份（Keycloak 角色或静态白名单命中）。 */
  publisher: boolean
  /** 从 OIDC token 解析出的 realm 角色（便于审计与排错）。 */
  roles: string[]
}

const sessions = new Map<string, Session>()
let seq = 0

/** 判断角色列表中是否命中任一目标角色。 */
function hasAnyRole(roles: string[], targets: string[]): boolean {
  if (targets.length === 0) return false
  for (const r of roles) if (targets.includes(r)) return true
  return false
}

// Web UI 静态页（构建时拷到 lib/ui/index.html；启动读一次缓存在内存）。
let uiHtml: string | null = null
async function loadUiHtml(): Promise<string | null> {
  if (uiHtml !== null) return uiHtml
  try {
    const uiPath = join(fileURLToPath(new URL('.', import.meta.url)), 'ui', 'index.html')
    uiHtml = await readFile(uiPath, 'utf8')
  } catch {
    uiHtml = ''
  }
  return uiHtml
}

/**
 * 判断来源 IP 是否在白名单内。
 *
 * 支持三种写法：
 *   - 精确 IP：`127.0.0.1`
 *   - CIDR 网段：`10.233.0.0/16`（IPv4）
 *   - 通配全部：`*` 或 `0.0.0.0/0`
 *
 * 说明：容器/集群部署时来源 IP 通常是网关 Pod 的地址且会变化，
 * 因此需要 CIDR 或通配能力，而不是只能列举固定 IP。
 */
function isAllowed(ip: string, allowlist: string[]): boolean {
  const normalized = ip === '::1' ? '127.0.0.1' : ip.replace(/^::ffff:/, '')
  for (const rule of allowlist) {
    if (rule === '*' || rule === '0.0.0.0/0' || rule === '::/0') return true
    if (rule.includes('/')) {
      if (ipInCidr(normalized, rule)) return true
    } else if (rule === normalized || rule === ip) {
      return true
    }
  }
  return false
}

/** IPv4 CIDR 匹配（覆盖集群 Pod/Service 网段场景） */
function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  if (slash < 0) return false
  const net = cidr.slice(0, slash)
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const toInt = (s: string): number | null => {
    const parts = s.split('.')
    if (parts.length !== 4) return null
    let n = 0
    for (const p of parts) {
      const v = Number(p)
      if (!Number.isInteger(v) || v < 0 || v > 255) return null
      n = (n << 8) | v
    }
    return n >>> 0
  }

  const a = toInt(ip)
  const b = toInt(net)
  if (a === null || b === null) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

function sendJson(res: any, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(json)
}

function readBody(req: any): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c))
    req.on('end', () => {
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 读整个请求体为 Buffer（multipart 上传用）。 */
function readBodyBuffer(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 极简 multipart/form-data 解析：取第一个 file 字段的字节；非 multipart 或解析失败返回 null。 */
function parseMultipartFile(buf: Buffer, contentType: string): { filename: string; data: Buffer } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundaryRaw = (m?.[1] ?? m?.[2] ?? '').trim()
  if (boundaryRaw === '') return null
  const boundary = Buffer.from('--' + boundaryRaw)
  // 按 boundary 切块
  const parts: Buffer[] = []
  let start = buf.indexOf(boundary)
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length)
    if (next === -1) break
    parts.push(buf.subarray(start + boundary.length, next))
    start = next
  }
  let filename = ''
  let data: Buffer | null = null
  for (const part of parts) {
    // 跳过结尾 --\r\n 与开头的 \r\n
    const head = part.subarray(0, Math.min(part.length, 1024))
    const headStr = head.toString('latin1')
    if (!/content-disposition/i.test(headStr)) continue
    if (!/name="file"/i.test(headStr)) continue
    const fn = /filename="([^"]*)"/i.exec(headStr)
    if (fn) filename = fn[1] ?? ''
    const sep = part.indexOf(Buffer.from('\r\n\r\n'))
    if (sep === -1) continue
    let body = part.subarray(sep + 4)
    // 去尾部 \r\n（boundary 前）
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2)
    }
    data = body
    break
  }
  if (data === null) return null
  return { filename, data }
}

export interface ServerOverrides {
  admin?: HimarketAdminClient
  ownership?: OwnershipStore
  audit?: AuditStore
  devAuth?: DeveloperAuth
}

export function buildServer(config: GatewayConfig, overrides: ServerOverrides = {}) {
  const admin =
    overrides.admin ??
    new HimarketAdminClient({
      baseUrl: config.himarketBaseUrl,
      adminUsername: config.adminUsername,
      adminPassword: config.adminPassword,
    })
  const ownership = overrides.ownership ?? new OwnershipStore(config.dbPath)
  const audit = overrides.audit ?? new AuditStore(config.dbPath)
  const devAuth = overrides.devAuth ?? new DeveloperAuth(config.himarketBaseUrl)

  const server = createServer(async (req, res) => {
    const ip = (req.socket?.remoteAddress ?? '') as string
    if (!isAllowed(ip, config.allowlist)) {
      return sendJson(res, 403, { ok: false, error: '仅允许白名单访问' })
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    try {
      // 0) Web UI 静态页
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = await loadUiHtml()
        if (html === null || html === '') {
          return sendJson(res, 500, { ok: false, error: 'UI 资源未找到（build 时需拷贝 src/ui → lib/ui）' })
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
        return
      }

      // 1) 登录
      //    支持三种身份：
      //     - 企业管理员（配置密码）：username==adminUsername 且 password==adminPassword →
      //       网关直接签发 admin session（不发开发者请求）
      //     - 开发者：username/password 走 HiMarket /developers/login
      //       → 若其 OIDC token 带 Keycloak 管理员角色，同样获得 admin 权限
      //     - 发布者：token 带 gateway-publisher / platform-admin 角色 → 企业发布身份
      if (method === 'POST' && pathname === '/auth/login') {
        const body = await readBody(req)
        const username = String(body.username ?? '')
        const password = String(body.password ?? '')
        if (username === config.adminUsername && password === config.adminPassword) {
          const sessionId = `sess-${(seq += 1)}-${Date.now()}`
          sessions.set(sessionId, {
            developerId: config.adminUsername,
            token: '',
            role: 'admin',
            publisher: true,
            roles: ['(local-admin)'],
          })
          return sendJson(res, 200, {
            ok: true,
            sessionId,
            developerId: config.adminUsername,
            role: 'admin',
            publisher: true,
            roles: ['(local-admin)'],
          })
        }
        const identity = await devAuth.login(username, password)
        // 角色判定优先走 IdP（Keycloak），静态白名单作为兜底
        const byRole = hasAnyRole(identity.roles, config.adminRoles)
        const byWhitelist = config.officialDeveloperIds.includes(identity.username)
        const isAdmin = byRole || byWhitelist
        const isPublisher =
          isAdmin || hasAnyRole(identity.roles, config.publisherRoles)
        const sessionId = `sess-${(seq += 1)}-${Date.now()}`
        sessions.set(sessionId, {
          developerId: identity.username,
          token: identity.token,
          role: isAdmin ? 'admin' : 'developer',
          publisher: isPublisher,
          roles: identity.roles,
        })
        return sendJson(res, 200, {
          ok: true,
          sessionId,
          developerId: identity.username,
          role: isAdmin ? 'admin' : 'developer',
          publisher: isPublisher,
          roles: identity.roles,
        })
      }

      // 公开只读：批量来源标签（小白同步时查，不需登录）
      // source: OFFICIAL(企业发布) / COMMUNITY(员工共建)
      // 附加：官方产品 → overriddenBy（谁在覆盖它）；社区覆盖版 → overrides（覆盖了谁）
      if (method === 'GET' && pathname === '/products/sources') {
        const ids = url.searchParams.get('ids')
        const idList = ids
          ? ids.split(',').map((s) => s.trim()).filter((s) => s !== '')
          : []
        const map = ownership.batchSources(idList)
        // 为被覆盖的产品补充"谁在覆盖它"（不限来源：官方基线与社区基线都可被员工改进）
        for (const pid of idList) {
          const row = ownership.getByProduct(pid)
          if (row === undefined) continue
          if (row.overrides === '') {
            const ovs = ownership.listOverrides(row.name).map((o) => ({
              productId: o.productId,
              name: o.name,
              publisher: o.developerId,
            }))
            if (ovs.length > 0) {
              const entry = map[pid] as { source: string; publisher: string; overrides: string; overriddenBy?: unknown[] }
              entry.overriddenBy = ovs
            }
          }
        }
        return sendJson(res, 200, { ok: true, sources: map })
      }

      // 其余接口都需要 session
      const authHeader = (req.headers['authorization'] ?? '') as string
      const sessionId = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      const session = sessions.get(sessionId)
      if (session === undefined) {
        return sendJson(res, 401, { ok: false, error: '未登录或会话已失效' })
      }
      const actor = session.developerId
      const role = session.role

      // 1.5) Web UI 数据端点
      // 我的身份 + role + 角色（供前端展示，便于确认权限来源）
      if (method === 'GET' && pathname === '/api/me') {
        return sendJson(res, 200, {
          ok: true,
          developerId: actor,
          role,
          publisher: session.publisher,
          roles: session.roles,
        })
      }

      // 我的归属产品列表（含来源/覆盖信息）
      if (method === 'GET' && pathname === '/api/me/products') {
        const mine = ownership.listByDeveloper(actor)
        const rows = mine.map((r) => {
          const ovs = r.overrides === '' ? ownership.listOverrides(r.name).map((o) => ({ productId: o.productId, name: o.name, publisher: o.developerId })) : []
          return {
            productId: r.productId,
            name: r.name,
            source: r.source,
            overrides: r.overrides,
            overriddenBy: ovs,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }
        })
        return sendJson(res, 200, { ok: true, products: rows })
      }

      // 市场目录：HiMarket 全部产品 + 网关归属来源标注（登录后浏览、选覆盖目标用）
      if (method === 'GET' && pathname === '/api/catalog') {
        const products = await admin.listProducts()
        const rows = products.map((p) => {
          const pid = p.productId ?? ''
          const own = pid !== '' ? ownership.getByProduct(pid) : undefined
          const ovs = own !== undefined && own.overrides === '' ? ownership.listOverrides(own.name).map((o) => ({ productId: o.productId, name: o.name, publisher: o.developerId })) : []
          return {
            productId: pid,
            name: p.name ?? '',
            type: p.type ?? '',
            status: p.status ?? '',
            description: p.description ?? '',
            source: own?.source ?? 'COMMUNITY',
            publisher: own?.developerId ?? '',
            overrides: own?.overrides ?? '',
            overriddenBy: ovs,
          }
        })
        return sendJson(res, 200, { ok: true, products: rows })
      }

      // 上传岗位 zip：multipart → 暂存临时目录 → 返回 zipPath 供 /publish
      if (method === 'POST' && pathname === '/api/upload') {
        const ctype = (req.headers['content-type'] ?? '') as string
        if (!ctype.toLowerCase().includes('multipart/form-data')) {
          return sendJson(res, 400, { ok: false, error: '需 multipart/form-data（file 字段 + name 字段）' })
        }
        const buf = await readBodyBuffer(req)
        const parsed = parseMultipartFile(buf, ctype)
        if (parsed === null) {
          return sendJson(res, 400, { ok: false, error: '未找到 file 字段，或请求体不是合法 multipart' })
        }
        if (parsed.data.length === 0) {
          return sendJson(res, 400, { ok: false, error: '上传内容为空' })
        }
        const dir = await mkdtemp(join(tmpdir(), 'hmgw-upload-'))
        const safeName = parsed.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'package.zip'
        const zipPath = join(dir, safeName)
        await writeFile(zipPath, parsed.data)
        return sendJson(res, 200, { ok: true, zipPath, filename: safeName, bytes: parsed.data.length })
      }

      // 2) 发布 / 迭代岗位
      //    同名覆盖语义：body.overrides = 被覆盖的官方产品名（可选）。
      //    - 用户想发一个"覆盖官方 pm"的社区改进版：name 取自己的包名（如 pm-community 或 pm-<dev>），
      //      overrides=pm → 网关登记"这个包是 pm 的社区覆盖版"。
      //    - HiMarket 产品 name 全局唯一：物理上用户不能真用同名，故覆盖关系由网关维护，
      //      同步时客户端把它与官方版并排展示（官方默认、覆盖可选）。
      if (method === 'POST' && pathname === '/publish') {
        const body = await readBody(req)
        const name = String(body.name ?? '').trim()
        const zipPath = String(body.zipPath ?? '').trim()
        const portalId = body.portalId !== undefined ? String(body.portalId) : undefined
        const overrides = body.overrides !== undefined ? String(body.overrides).trim() : ''
        if (name === '') return sendJson(res, 400, { ok: false, error: '缺少岗位 name' })
        if (zipPath === '') return sendJson(res, 400, { ok: false, error: '缺少 zipPath' })

        // 覆盖目标校验：overrides 指向的产品必须已存在（任何来源均可被覆盖——官方默认、覆盖可选，不锁死）
        if (overrides !== '') {
          const target = ownership.getByName(overrides)
          if (target === undefined) {
            return sendJson(res, 400, { ok: false, error: `覆盖目标「${overrides}」不存在于归属库` })
          }
        }

        // 归属校验：允许不同开发者同名（各持覆盖版），只禁止"同一产品被别人改名占用"
        const mine = ownership.getByNameAndDeveloper(name, actor)
        if (mine === undefined) {
          // 全新发布；若名字已被他人占用（非覆盖场景的裸同名）→ 拒绝，要求显式 overrides
          const occupied = ownership.getByName(name)
          if (occupied !== undefined && occupied.developerId !== actor && overrides === '') {
            return sendJson(res, 403, {
              ok: false,
              error: `岗位「${name}」已由 ${occupied.developerId} 发布；如需发布自己的覆盖版，请带 overrides 指向官方产品`,
            })
          }
        }

        const zipBytes = new Uint8Array(await readFile(zipPath))
        const result = await admin.publishPackage(name, zipBytes, {
          categoryName: config.categoryName,
          portalId,
        })

        // 登记/更新归属（来源判定：Keycloak 角色 / 静态白名单 → 企业发布，否则员工共建）
        const source = session.publisher
          ? 'OFFICIAL'
          : resolveSource(actor, config.officialDeveloperIds)
        ownership.upsert({
          productId: result.productId,
          name,
          developerId: actor,
          type: 'AGENT_SKILL',
          source,
          overrides,
        })

        // 审计
        const action: AuditAction = result.created ? 'publish' : 'update'
        audit.append({
          actor,
          action,
          targetType: 'AGENT_SKILL',
          targetId: result.productId,
          productName: name,
          meta: { version: result.version, portalId: portalId ?? null },
        })

        // 发布成功后清理本次上传的临时目录（仅清理网关自己 mkdtemp 的 hmgw-upload-*）
        const uploadDir = dirname(zipPath)
        if (/hmgw-upload-/.test(uploadDir)) {
          void rm(uploadDir, { recursive: true, force: true }).catch(() => {})
        }

        return sendJson(res, 200, {
          ok: true,
          productId: result.productId,
          version: result.version,
          created: result.created,
          action,
        })
      }

      // 3) 删除岗位（仅 owner）
      if (method === 'DELETE' && pathname.startsWith('/products/')) {
        const productId = decodeURIComponent(pathname.slice('/products/'.length))
        const existing = ownership.getByProduct(productId)
        if (existing !== undefined && existing.developerId !== actor) {
          return sendJson(res, 403, {
            ok: false,
            error: `产品 ${productId} 由 ${existing.developerId} 发布，你无权删除`,
          })
        }
        await admin.deleteProduct(productId)
        if (existing !== undefined) ownership.remove(productId)
        audit.append({ actor, action: 'delete', targetType: 'AGENT_SKILL', targetId: productId, productName: existing?.name ?? '' })
        return sendJson(res, 200, { ok: true })
      }

      // 4) 审计查询：全量仅管理员可见；普通开发者只能看自己的
      if (method === 'GET' && pathname === '/api/audit') {
        if (role !== 'admin') {
          return sendJson(res, 403, { ok: false, error: '仅企业管理员可查看全量审计' })
        }
        const actorQ = url.searchParams.get('actor') ?? undefined
        const actionQ = url.searchParams.get('action') as AuditAction | null
        const fromQ = url.searchParams.get('from')
        const toQ = url.searchParams.get('to')
        const limitQ = url.searchParams.get('limit')
        const rows = audit.query({
          actor: actorQ,
          action: actionQ ?? undefined,
          from: fromQ ? Number(fromQ) : undefined,
          to: toQ ? Number(toQ) : undefined,
          limit: limitQ ? Number(limitQ) : undefined,
        })
        return sendJson(res, 200, { ok: true, count: rows.length, rows })
      }
      if (method === 'GET' && pathname === '/api/my-audit') {
        const actionQ = url.searchParams.get('action') as AuditAction | null
        const limitQ = url.searchParams.get('limit')
        const rows = audit.query({
          actor,
          action: actionQ ?? undefined,
          limit: limitQ ? Number(limitQ) : undefined,
        })
        return sendJson(res, 200, { ok: true, count: rows.length, rows })
      }

      // 5) 下载代理（记录「谁下载了什么」）
      if (method === 'GET' && pathname.startsWith('/download/')) {
        const productId = decodeURIComponent(pathname.slice('/download/'.length))
        // 先记录下载审计（含回源失败的尝试），再回源 HiMarket 技能 zip
        audit.append({ actor, action: 'download', targetType: 'AGENT_SKILL', targetId: productId })
        const target = `http://127.0.0.1:3090/api/v1/skills/${encodeURIComponent(productId)}/download`
        const upstream = await fetch(target)
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' })
        if (upstream.body) {
          for await (const chunk of upstream.body) res.write(chunk)
        }
        res.end()
        return
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const status = error instanceof AdminClientError || error instanceof DeveloperAuthError ? 400 : 500
      return sendJson(res, status, { ok: false, error: msg })
    }
  })

  return server
}

// 直接运行：启动监听
import { pathToFileURL } from 'node:url'
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href ||
  import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const config = loadConfig()
  const server = buildServer(config)
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[dsh-himarket-gateway] listening on :${config.port} (allowlist=${config.allowlist.join(',')})`)
  })
}
