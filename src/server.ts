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
import { readFile } from 'node:fs/promises'
import { loadConfig, type GatewayConfig } from './config.js'
import { HimarketAdminClient, AdminClientError } from './himarket-admin.js'
import { OwnershipStore, resolveSource } from './ownership.js'
import { AuditStore, type AuditAction } from './audit.js'
import { DeveloperAuth, DeveloperAuthError } from './auth.js'

interface Session {
  developerId: string
  token: string
}

const sessions = new Map<string, Session>()
let seq = 0

function isAllowed(ip: string, allowlist: string[]): boolean {
  const normalized = ip === '::1' ? '127.0.0.1' : ip.replace(/^::ffff:/, '')
  return allowlist.includes(normalized) || allowlist.includes(ip)
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
      // 1) 登录
      //    支持两种身份：
      //     - 普通开发者：username/password 走 HiMarket /developers/login（员工共建）
      //     - 企业管理员：username==adminUsername 且 password==配置的 adminPassword →
      //       网关直接签发 admin session（不发开发者请求）；admin 在白名单 → 发布标 OFFICIAL
      if (method === 'POST' && pathname === '/auth/login') {
        const body = await readBody(req)
        const username = String(body.username ?? '')
        const password = String(body.password ?? '')
        if (username === config.adminUsername && password === config.adminPassword) {
          const sessionId = `sess-${(seq += 1)}-${Date.now()}`
          sessions.set(sessionId, { developerId: config.adminUsername, token: '' })
          return sendJson(res, 200, { ok: true, sessionId, developerId: config.adminUsername, role: 'admin' })
        }
        const identity = await devAuth.login(username, password)
        const sessionId = `sess-${(seq += 1)}-${Date.now()}`
        sessions.set(sessionId, { developerId: identity.username, token: identity.token })
        return sendJson(res, 200, { ok: true, sessionId, developerId: identity.username, role: 'developer' })
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

        // 登记/更新归属（含来源：官方账号白名单 → 企业发布，否则员工共建）
        const source = resolveSource(actor, config.officialDeveloperIds)
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

      // 4) 审计查询
      if (method === 'GET' && pathname === '/audit') {
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

      // 5) 下载代理（记录「谁下载了什么」）
      if (method === 'GET' && pathname.startsWith('/download/')) {
        const productId = decodeURIComponent(pathname.slice('/download/'.length))
        const target = `http://127.0.0.1:3090/api/v1/skills/${encodeURIComponent(productId)}/download`
        const upstream = await fetch(target)
        audit.append({ actor, action: 'download', targetType: 'AGENT_SKILL', targetId: productId })
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
