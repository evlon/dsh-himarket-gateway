#!/usr/bin/env node
/**
 * copy-ui — 把 src/ui/ 静态资源拷到 lib/ui/（lib 是编译产物目录，npm 发布时随 files 走）。
 * build/test 前运行：tsc 只编译 .ts，不搬 .html，需显式拷贝。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src', 'ui')
const dst = join(root, 'lib', 'ui')
if (!existsSync(src)) {
  console.error('[copy-ui] src/ui not found:', src)
  process.exit(1)
}
mkdirSync(dst, { recursive: true })
cpSync(src, dst, { recursive: true })
console.log('[copy-ui] copied src/ui -> lib/ui')
