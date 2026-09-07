/**
 * 包装层核心逻辑验证（不依赖真实 HiMarket）：
 *  - 开发者登录（mock /developers/login + /developers/profile）
 *  - 发布（mock 管理员端点）
 *  - 归属隔离：李四不能改张三的包
 *  - 审计：publish/update/download 都被记录且可按 actor 查询
 *
 * 用内存版 node:sqlite + 注入 mock fetch。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'

import { loadConfig } from '../lib/config.js'
import { buildServer } from '../lib/server.js'
import { HimarketAdminClient } from '../lib/himarket-admin.js'
import { OwnershipStore } from '../lib/ownership.js'
import { AuditStore } from '../lib/audit.js'
import { DeveloperAuth } from '../lib/auth.js'

// ---- 内存 mock HiMarket ----
// 记录被调用的管理员端点，模拟登录/分类/产品/上传/版本/门户。
function makeMockFetch(presetProducts = []) {
  const calls = []
  const createdProducts = new Set(presetProducts)
  const handler = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body })
    const u = String(url)
    // 开发者登录
    if (u.endsWith('/api/v1/developers/login')) {
      const parsed = JSON.parse(opts.body ?? '{}')
      return json({ code: 'SUCCESS', data: { access_token: `dev-token-${parsed.username}` } })
    }
    // 开发者 profile
    if (u.endsWith('/api/v1/developers/profile')) {
      const auth = (opts.headers?.Authorization ?? '').replace('Bearer ', '')
      const username = auth.replace('dev-token-', '')
      return json({ code: 'SUCCESS', data: { username } })
    }
    // 管理员登录
    if (u.endsWith('/api/v1/admins/login')) {
      return json({ code: 'SUCCESS', data: { access_token: 'admin-token' } })
    }
    // 分类列表
    if (u.includes('/api/v1/product-categories?')) {
      return json({ code: 'SUCCESS', data: { content: [] } })
    }
    // 创建分类
    if (u.endsWith('/api/v1/product-categories') && (opts.method ?? 'GET') === 'POST') {
      return json({ code: 'SUCCESS', data: { categoryId: 'cat-1' } })
    }
    // 产品列表（返回已创建产品）
    if (u.includes('/api/v1/products?')) {
      const content = [...createdProducts].map((name) => ({ productId: `prod-${name}`, name }))
      return json({ code: 'SUCCESS', data: { content } })
    }
    // 创建产品
    if (u.endsWith('/api/v1/products') && (opts.method ?? 'GET') === 'POST') {
      const parsed = JSON.parse(opts.body ?? '{}')
      createdProducts.add(parsed.name)
      return json({ code: 'SUCCESS', data: { productId: `prod-${parsed.name}` } })
    }
    // 上传 zip
    if (u.includes('/api/v1/skills/') && u.endsWith('/package')) {
      return json({ code: 'SUCCESS', data: {} })
    }
    // 版本列表
    if (u.includes('/api/v1/skills/') && u.endsWith('/versions')) {
      return json({ code: 'SUCCESS', data: [] })
    }
    // 创建 draft
    if (u.includes('/api/v1/skills/') && u.endsWith('/draft')) {
      return json({ code: 'SUCCESS', data: {} })
    }
    // 发布版本
    if (u.includes('/api/v1/skills/') && /\/versions\//.test(u)) {
      return json({ code: 'SUCCESS', data: {} })
    }
    // 门户发布
    if (u.includes('/api/v1/products/') && u.endsWith('/publications')) {
      return json({ code: 'SUCCESS', data: {} })
    }
    // 删除产品
    if (u.includes('/api/v1/products/') && (opts.method ?? 'GET') === 'DELETE') {
      return json({ code: 'SUCCESS', data: {} })
    }
    return json({ code: 'SUCCESS', data: {} })
  }
  return { handler, calls }
}

function json(obj) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  }
}

// ---- 工具：起服务 + 请求 ----
function makeConfig() {
  const cfg = loadConfig()
  cfg.port = 0
  cfg.allowlist = ['127.0.0.1']
  cfg.adminUsername = 'admin'
  cfg.adminPassword = 'x' // 测试统一 admin 凭据（本机无 .env 时 loadConfig 默认空）
  return cfg
}

async function startGateway(overrides) {
  const cfg = makeConfig()
  const server = buildServer(cfg, overrides)
  await new Promise((r) => server.listen(0, r))
  const addr = server.address()
  const base = `http://127.0.0.1:${addr.port}`
  return { server, base }
}

async function req(base, method, path, body, sessionId) {
  const headers = { 'content-type': 'application/json' }
  if (sessionId) headers['authorization'] = `Bearer ${sessionId}`
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

let tmpDb
let zipFile

before(async () => {
  tmpDb = join(tmpdir(), `hm-gw-test-${Date.now()}.db`)
  zipFile = join(tmpdir(), `hm-gw-test-${Date.now()}.zip`)
  writeFileSync(zipFile, Buffer.from([1, 2, 3, 4]))
})

after(() => {
  try {
    rmSync(tmpDb, { force: true })
  } catch {}
  try {
    rmSync(zipFile, { force: true })
  } catch {}
})

test('张三发布 pm 成功，登记归属并写审计', async () => {
  const { handler } = makeMockFetch()
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  const admin = new HimarketAdminClient({
    baseUrl: 'http://mock',
    adminUsername: 'admin',
    adminPassword: 'x',
    fetchFn: handler,
  })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    // 登录
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    assert.equal(login.status, 200)
    assert.equal(login.data.developerId, 'zhangsan')
    const sid = login.data.sessionId

    // 发布
    const pub = await req(base, 'POST', '/publish', { name: 'pm', zipPath: zipFile }, sid)
    assert.equal(pub.status, 200, JSON.stringify(pub.data))
    assert.equal(pub.data.created, true)
    assert.equal(pub.data.action, 'publish')

    // 归属登记
    const own = ownership.getByName('pm')
    assert.ok(own, '应有归属记录')
    assert.equal(own.developerId, 'zhangsan')

    // 审计
    const rows = audit.query({ actor: 'zhangsan' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'publish')
    assert.equal(rows[0].productName, 'pm')
  } finally {
    server.close()
  }
})

test('李四不能修改张三的 pm（403 归属隔离）', async () => {
  const { handler } = makeMockFetch()
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  // 预置：pm 属 zhangsan
  ownership.upsert({ productId: 'prod-pm', name: 'pm', developerId: 'zhangsan', type: 'AGENT_SKILL', source: 'COMMUNITY' })
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'lisi', password: 'p' })
    const sid = login.data.sessionId
    const pub = await req(base, 'POST', '/publish', { name: 'pm', zipPath: zipFile }, sid)
    assert.equal(pub.status, 403, JSON.stringify(pub.data))
    assert.match(pub.data.error, /zhangsan/)

    // 审计里不应有 lisi 的 publish
    assert.equal(audit.query({ actor: 'lisi' }).length, 0)
  } finally {
    server.close()
  }
})

test('owner 迭代 pm 记为 update 审计', async () => {
  const { handler, calls } = makeMockFetch(['pm'])
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  ownership.upsert({ productId: 'prod-pm', name: 'pm', developerId: 'zhangsan', type: 'AGENT_SKILL', source: 'COMMUNITY' })
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    const sid = login.data.sessionId
    const pub = await req(base, 'POST', '/publish', { name: 'pm', zipPath: zipFile }, sid)
    assert.equal(pub.status, 200)
    assert.equal(pub.data.created, false, '已存在产品，应走迭代')
    assert.equal(pub.data.action, 'update')

    const rows = audit.query({ actor: 'zhangsan', action: 'update' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'update')
  } finally {
    server.close()
  }
})

test('下载代理记录 download 审计', async () => {
  const { handler } = makeMockFetch()
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    const sid = login.data.sessionId
    // 下载代理会试图 fetch http://127.0.0.1:3090/...，本机无服务会失败，
    // 但我们的 mock fetch 不处理该 url，会走默认 SUCCESS；这里断言审计先写。
    await req(base, 'GET', '/download/prod-pm', undefined, sid)
    const rows = audit.query({ actor: 'zhangsan', action: 'download' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].targetId, 'prod-pm')
  } finally {
    server.close()
  }
})

test('官方账号发布的包标记为 OFFICIAL，且 /products/sources 可查', async () => {
  const { handler } = makeMockFetch(['official-pkg'])
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  // 官方白名单默认含 'admin'
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'admin', password: 'p' })
    const sid = login.data.sessionId
    const pub = await req(base, 'POST', '/publish', { name: 'official-pkg', zipPath: zipFile }, sid)
    assert.equal(pub.status, 200)

    const own = ownership.getByName('official-pkg')
    assert.ok(own, '应有归属')
    assert.equal(own.source, 'OFFICIAL', '官方账号应标记企业发布')

    // /products/sources 批量标签
    const src = await req(base, 'GET', '/products/sources?ids=prod-official-pkg', undefined, sid)
    assert.equal(src.status, 200)
    assert.equal(src.data.sources['prod-official-pkg'].source, 'OFFICIAL')
    assert.equal(src.data.sources['prod-official-pkg'].publisher, 'admin')
  } finally {
    server.close()
  }
})

test('普通员工发布的包标记为 COMMUNITY', async () => {
  const { handler } = makeMockFetch(['community-pkg'])
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    const sid = login.data.sessionId
    await req(base, 'POST', '/publish', { name: 'community-pkg', zipPath: zipFile }, sid)
    const own = ownership.getByName('community-pkg')
    assert.equal(own.source, 'COMMUNITY', '普通员工应标记员工共建')
  } finally {
    server.close()
  }
})

test('员工发布带 overrides 的覆盖版成功，官方产品 sources 返回 overriddenBy', async () => {
  const { handler } = makeMockFetch(['secretary'])
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  // 预置：secretary 是官方产品（admin 发的 OFFICIAL）
  ownership.upsert({ productId: 'prod-secretary', name: 'secretary', developerId: 'admin', type: 'AGENT_SKILL', source: 'OFFICIAL' })
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'lisi', password: 'p' })
    const sid = login.data.sessionId
    // lisi 发布秘书的社区覆盖版（独立包名，overrides 指向 secretary）
    const pub = await req(base, 'POST', '/publish', { name: 'secretary-lisi', zipPath: zipFile, overrides: 'secretary' }, sid)
    assert.equal(pub.status, 200, JSON.stringify(pub.data))

    const own = ownership.getByName('secretary-lisi')
    assert.ok(own)
    assert.equal(own.overrides, 'secretary', '应登记覆盖目标')
    assert.equal(own.source, 'COMMUNITY')

    // /products/sources 查官方 secretary 应带 overriddenBy
    const src = await req(base, 'GET', '/products/sources?ids=prod-secretary', undefined, sid)
    assert.equal(src.data.sources['prod-secretary'].source, 'OFFICIAL')
    assert.ok(Array.isArray(src.data.sources['prod-secretary'].overriddenBy), '官方产品应有 overriddenBy 数组')
    assert.equal(src.data.sources['prod-secretary'].overriddenBy[0].publisher, 'lisi')
  } finally {
    server.close()
  }
})

test('覆盖目标不存在时报 400', async () => {
  const { handler } = makeMockFetch()
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })

  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    const sid = login.data.sessionId
    const pub = await req(base, 'POST', '/publish', { name: 'ghost-cover', zipPath: zipFile, overrides: 'no-such-product' }, sid)
    assert.equal(pub.status, 400, JSON.stringify(pub.data))
    assert.match(pub.data.error, /覆盖目标/)
  } finally {
    server.close()
  }
})

test('GET / 返回 Web UI 页面', async () => {
  const { handler } = makeMockFetch()
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })
  try {
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /HiMarket 岗位发布台/)
    assert.match(html, /api\/catalog/)
  } finally {
    server.close()
  }
})

test('/api/me 返回身份；全量审计仅 admin 可见', async () => {
  const { handler } = makeMockFetch(['secretary'])
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  ownership.upsert({ productId: 'prod-secretary', name: 'secretary', developerId: 'admin', type: 'AGENT_SKILL', source: 'OFFICIAL' })
  audit.append({ actor: 'admin', action: 'publish', targetType: 'AGENT_SKILL', targetId: 'prod-secretary', productName: 'secretary' })
  audit.append({ actor: 'zhangsan', action: 'publish', targetType: 'AGENT_SKILL', targetId: 'prod-x', productName: 'x' })
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })
  try {
    // 开发者登录
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    const sid = login.data.sessionId
    assert.equal(login.data.role, 'developer')
    // /api/me
    const me = await req(base, 'GET', '/api/me', undefined, sid)
    assert.equal(me.data.developerId, 'zhangsan')
    assert.equal(me.data.role, 'developer')
    // 开发者访问全量审计 → 403
    const denied = await req(base, 'GET', '/api/audit', undefined, sid)
    assert.equal(denied.status, 403)
    // 开发者看自己的审计
    const mine = await req(base, 'GET', '/api/my-audit', undefined, sid)
    assert.equal(mine.data.ok, true)

    // admin 登录
    const alogin = await req(base, 'POST', '/auth/login', { username: 'admin', password: 'x' })
    assert.equal(alogin.data.role, 'admin')
    const asid = alogin.data.sessionId
    const full = await req(base, 'GET', '/api/audit', undefined, asid)
    assert.equal(full.data.ok, true)
    // 共享 tmpDb 会累积前面测试的审计行；断言能看到 admin 与 zhangsan 的记录即可
    const actors = full.data.rows.map((r) => r.actor)
    assert.ok(actors.includes('admin'))
    assert.ok(actors.includes('zhangsan'))
  } finally {
    server.close()
  }
})

test('/api/catalog 返回带来源标注的产品列表', async () => {
  const { handler } = makeMockFetch(['secretary', 'pm'])
  const ownership = new OwnershipStore(tmpDb)
  const audit = new AuditStore(tmpDb)
  ownership.upsert({ productId: 'prod-secretary', name: 'secretary', developerId: 'admin', type: 'AGENT_SKILL', source: 'OFFICIAL' })
  ownership.upsert({ productId: 'prod-pm', name: 'pm', developerId: 'admin', type: 'AGENT_SKILL', source: 'COMMUNITY' })
  const admin = new HimarketAdminClient({ baseUrl: 'http://mock', adminUsername: 'admin', adminPassword: 'x', fetchFn: handler })
  const devAuth = new DeveloperAuth('http://mock', handler)
  const { server, base } = await startGateway({ admin, ownership, audit, devAuth })
  try {
    const login = await req(base, 'POST', '/auth/login', { username: 'zhangsan', password: 'p' })
    const sid = login.data.sessionId
    const cat = await req(base, 'GET', '/api/catalog', undefined, sid)
    assert.equal(cat.data.ok, true)
    const byName = Object.fromEntries(cat.data.products.map((p) => [p.name, p]))
    assert.equal(byName['secretary']?.source, 'OFFICIAL')
    assert.equal(byName['pm']?.source, 'COMMUNITY')
    assert.equal(byName['pm']?.publisher, 'admin')
  } finally {
    server.close()
  }
})
