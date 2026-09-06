/**
 * 归属存储：记录「开发者 ⇄ 产品」的 ownership 映射。
 *
 * HiMarket 本体的 product 表只有 admin_id，没有 developer/owner 字段，
 * 因此包装层自建一张 ownership 表来落地「谁开发的包」这一关键事实。
 *
 * 权限规则：
 *  - 发布时：name 首次出现 → 登记 owner（当前开发者）；同名已存在但 owner 不符 → 拒绝。
 *  - 更新/迭代、删除时：必须先校验 ownership.developer_id == 当前调用者，否则拒绝。
 *
 * 使用 Node 内置 node:sqlite（零额外依赖）。
 *
 * @module dsh-himarket-gateway/ownership
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'

export type ProductSource = 'OFFICIAL' | 'COMMUNITY'

export interface OwnershipRow {
  productId: string
  name: string
  developerId: string
  type: string
  source: ProductSource
  /** 覆盖的官方产品名（社区改进版指向它）；空=独立产品。 */
  overrides: string
  createdAt: number
  updatedAt: number
}

export class OwnershipStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dbPath.replace(/[^/\\]+$/, ''), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ownership (
        product_id   TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        developer_id TEXT NOT NULL,
        type         TEXT NOT NULL DEFAULT 'AGENT_SKILL',
        source       TEXT NOT NULL DEFAULT 'COMMUNITY',
        overrides    TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ownership_developer ON ownership(developer_id);
      CREATE INDEX IF NOT EXISTS idx_ownership_name ON ownership(name);
    `)
    // 兼容旧库：补 source 列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，忽略已存在）
    try {
      this.db.exec('ALTER TABLE ownership ADD COLUMN source TEXT NOT NULL DEFAULT \'COMMUNITY\'')
    } catch {
      // 列已存在，忽略
    }
    // 兼容旧库：补 overrides 列
    try {
      this.db.exec('ALTER TABLE ownership ADD COLUMN overrides TEXT NOT NULL DEFAULT \'\'')
    } catch {
      // 列已存在，忽略
    }
  }

  /** 查归属；不存在返回 undefined。 */
  getByProduct(productId: string): OwnershipRow | undefined {
    const row = this.db
      .prepare('SELECT product_id, name, developer_id, type, source, overrides, created_at, updated_at FROM ownership WHERE product_id = ?')
      .get(productId) as Row | undefined
    return row === undefined ? undefined : this.toOwnership(row)
  }

  /** 按 name 查（一个开发者对一个 name 通常唯一）。 */
  getByName(name: string): OwnershipRow | undefined {
    const row = this.db
      .prepare('SELECT product_id, name, developer_id, type, source, overrides, created_at, updated_at FROM ownership WHERE name = ?')
      .get(name) as Row | undefined
    return row === undefined ? undefined : this.toOwnership(row)
  }

  /** 按 (name, developerId) 查（同名多开发者共存时定位自己的那条）。 */
  getByNameAndDeveloper(name: string, developerId: string): OwnershipRow | undefined {
    const row = this.db
      .prepare('SELECT product_id, name, developer_id, type, source, overrides, created_at, updated_at FROM ownership WHERE name = ? AND developer_id = ?')
      .get(name, developerId) as Row | undefined
    return row === undefined ? undefined : this.toOwnership(row)
  }

  /** 覆盖某官方产品的全部社区版（name 是该官方产品名）。 */
  listOverrides(name: string): OwnershipRow[] {
    const rows = this.db
      .prepare('SELECT product_id, name, developer_id, type, source, overrides, created_at, updated_at FROM ownership WHERE overrides = ? ORDER BY updated_at DESC')
      .all(name) as unknown as Row[]
    return rows.map((r) => this.toOwnership(r))
  }

  /** 注册/更新归属（发布或首次认领时调用）。 */
  upsert(row: {
    productId: string
    name: string
    developerId: string
    type: string
    source: ProductSource
    overrides?: string
  }): void {
    const now = Date.now()
    const overrides = row.overrides ?? ''
    const exists = this.getByProduct(row.productId)
    if (exists === undefined) {
      this.db
        .prepare(
          'INSERT INTO ownership (product_id, name, developer_id, type, source, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.productId, row.name, row.developerId, row.type, row.source, overrides, now, now)
    } else {
      this.db
        .prepare('UPDATE ownership SET name = ?, developer_id = ?, type = ?, source = ?, overrides = ?, updated_at = ? WHERE product_id = ?')
        .run(row.name, row.developerId, row.type, row.source, overrides, now, row.productId)
    }
  }

  /** 删除归属（产品删除后调用）。 */
  remove(productId: string): void {
    this.db.prepare('DELETE FROM ownership WHERE product_id = ?').run(productId)
  }

  /** 列出某开发者的全部归属。 */
  listByDeveloper(developerId: string): OwnershipRow[] {
    const rows = this.db
      .prepare(
        'SELECT product_id, name, developer_id, type, source, overrides, created_at, updated_at FROM ownership WHERE developer_id = ? ORDER BY updated_at DESC',
      )
      .all(developerId) as unknown as Row[]
    return rows.map((r) => this.toOwnership(r))
  }

  /** 批量查 source：返回 productId → { source, publisher, overrides }；不在归属表的给 COMMUNITY 兜底。 */
  batchSources(productIds: string[]): Record<string, { source: ProductSource; publisher: string; overrides: string }> {
    const out: Record<string, { source: ProductSource; publisher: string; overrides: string }> = {}
    for (const pid of productIds) {
      const row = this.getByProduct(pid)
      out[pid] = row
        ? { source: row.source, publisher: row.developerId, overrides: row.overrides }
        : { source: 'COMMUNITY', publisher: '', overrides: '' }
    }
    return out
  }

  private toOwnership(r: Row): OwnershipRow {
    return {
      productId: r.product_id,
      name: r.name,
      developerId: r.developer_id,
      type: r.type,
      source: (r.source as ProductSource) ?? 'COMMUNITY',
      overrides: r.overrides ?? '',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  }
}

interface Row {
  product_id: string
  name: string
  developer_id: string
  type: string
  source: string
  overrides: string
  created_at: number
  updated_at: number
}

/** 根据开发者账号是否在官方白名单，判定发布来源。 */
export function resolveSource(developerId: string, officialIds: string[]): ProductSource {
  return officialIds.includes(developerId) ? 'OFFICIAL' : 'COMMUNITY'
}
