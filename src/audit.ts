/**
 * 审计存储：记录「谁上传了什么 / 谁下载了什么 / 谁更新了什么」。
 *
 * 弥补 HiMarket 本体无操作审计日志的缺口（其 DBCollector 仅是查询面板）。
 * 企业后续可从 /audit 查询这些行为，用于合规与运营统计。
 *
 * 写失败不影响主流程（仅 warn 级），保证发布/同步不被审计拖累。
 *
 * @module dsh-himarket-gateway/audit
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'

export type AuditAction = 'publish' | 'update' | 'delete' | 'download'

export interface AuditEntry {
  id: number
  actor: string
  action: AuditAction
  targetType: string
  targetId: string
  productName: string
  at: number
  metaJson: string
}

export interface AuditQuery {
  actor?: string
  action?: AuditAction
  from?: number
  to?: number
  limit?: number
}

export class AuditStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dbPath.replace(/[^/\\]+$/, ''), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        product_name TEXT NOT NULL DEFAULT '',
        at          INTEGER NOT NULL,
        meta_json   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
    `)
  }

  /** 追加一条审计记录。 */
  append(entry: {
    actor: string
    action: AuditAction
    targetType: string
    targetId: string
    productName?: string
    meta?: Record<string, unknown>
  }): void {
    const meta = entry.meta === undefined ? '{}' : JSON.stringify(entry.meta)
    this.db
      .prepare(
        'INSERT INTO audit_log (actor, action, target_type, target_id, product_name, at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.actor,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.productName ?? '',
        Date.now(),
        meta,
      )
  }

  /** 查询审计记录（按时间倒序）。 */
  query(q: AuditQuery): AuditEntry[] {
    const wheres: string[] = []
    const params: (string | number)[] = []
    if (q.actor !== undefined && q.actor !== '') {
      wheres.push('actor = ?')
      params.push(q.actor)
    }
    if (q.action !== undefined) {
      wheres.push('action = ?')
      params.push(q.action)
    }
    if (q.from !== undefined) {
      wheres.push('at >= ?')
      params.push(q.from)
    }
    if (q.to !== undefined) {
      wheres.push('at <= ?')
      params.push(q.to)
    }
    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const limit = q.limit !== undefined && q.limit > 0 ? Math.min(q.limit, 1000) : 200
    const sql = `SELECT id, actor, action, target_type, target_id, product_name, at, meta_json FROM audit_log ${whereSql} ORDER BY at DESC LIMIT ?`
    params.push(limit)
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number
      actor: string
      action: string
      target_type: string
      target_id: string
      product_name: string
      at: number
      meta_json: string
    }>
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action as AuditAction,
      targetType: r.target_type,
      targetId: r.target_id,
      productName: r.product_name,
      at: r.at,
      metaJson: r.meta_json,
    }))
  }
}
