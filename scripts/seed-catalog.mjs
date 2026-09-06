#!/usr/bin/env node
/**
 * seed-catalog — 历史产品归属打标（幂等，可重复跑）。
 *
 * 背景：HiMarket 本体没有产品 owner，且历史上所有产品都是 admin 建的，
 * 但按「官方最小可用稳定集」的产品语义，只有 officialProducts 清单内的名字
 * 属于官方轨（OFFICIAL），其余历史产品划到社区轨（COMMUNITY）供员工覆盖迭代。
 *
 * 规则（幂等）：
 *  - 已在归属库的产品：不动（保留网关后续判定结果）。
 *  - 不在归属库的产品：name ∈ OFFICIAL_PRODUCTS → OFFICIAL/admin；否则 COMMUNITY/admin。
 *  - 不写审计（不是真实发布操作）。
 *
 * 用法：node scripts/seed-catalog.mjs
 * 依赖 env：HIMARKET_BASE_URL / HIMARKET_ADMIN_USERNAME / HIMARKET_ADMIN_PASSWORD /
 *          GATEWAY_DB_PATH / OFFICIAL_PRODUCTS（未设则从 caddy/himarket-gateway.env 读）
 */
import { readFileSync, existsSync } from 'node:fs'

// ---- 若 env 未注入，从部署 .env 读取（caddy 部署环境） ----
const envCandidates = [
  process.env.GATEWAY_ENV_FILE,
  'E:/ai-works/caddy/himarket-gateway.env',
  process.cwd() + '/himarket-gateway.env',
]
for (const f of envCandidates) {
  if (f && existsSync(f)) {
    for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim()
      if (key !== '' && process.env[key] === undefined) process.env[key] = val
    }
  }
}

const { loadConfig } = await import('../lib/config.js')
const { OwnershipStore } = await import('../lib/ownership.js')

const config = loadConfig()
const base = config.himarketBaseUrl.replace(/\/+$/u, '')
const store = new OwnershipStore(config.dbPath)

if (config.adminPassword === '') {
  console.error('[seed-catalog] HIMARKET_ADMIN_PASSWORD 未配置')
  process.exit(1)
}

// ---- admin 登录 ----
const loginRes = await fetch(`${base}/api/v1/admins/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword }),
})
const loginJson = await loginRes.json().catch(() => ({}))
const token = loginJson?.data?.access_token
if (!token) {
  console.error('[seed-catalog] admin 登录失败:', loginJson?.code ?? loginRes.status)
  process.exit(1)
}

// ---- 拉全量产品（翻页，最多 5 页 × 200） ----
async function listProducts(page) {
  const res = await fetch(`${base}/api/v1/products?pageNum=${page}&pageSize=200`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const json = await res.json().catch(() => ({}))
  return json?.data?.content ?? []
}

let page = 1
let all = []
for (;;) {
  const batch = await listProducts(page)
  if (batch.length === 0) break
  all = all.concat(batch)
  if (batch.length < 200) break
  page += 1
  if (page > 5) break
}

const officialSet = new Set(config.officialProducts)
let markedOfficial = 0
let markedCommunity = 0
let skippedExisting = 0
for (const p of all) {
  const pid = p.productId ?? ''
  const name = p.name ?? ''
  if (pid === '' || name === '') continue
  if (store.getByProduct(pid) !== undefined) {
    skippedExisting += 1 // 已有归属（网关判定过），保留
    continue
  }
  const source = officialSet.has(name) ? 'OFFICIAL' : 'COMMUNITY'
  store.upsert({ productId: pid, name, developerId: 'admin', type: p.type ?? 'AGENT_SKILL', source })
  if (source === 'OFFICIAL') markedOfficial += 1
  else markedCommunity += 1
  console.log(`[seed-catalog] ${source.padEnd(9)} ${name}  (${pid})`)
}
console.log(`[seed-catalog] done: +${markedOfficial} OFFICIAL, +${markedCommunity} COMMUNITY, ${skippedExisting} already-existing kept`)
