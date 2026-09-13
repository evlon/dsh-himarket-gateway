// 验证 Keycloak 角色解析逻辑 —— 直接 import 编译产物（更可靠）
import { extractRoles, decodeJwtPayload } from '../lib/auth.js'

/** 构造测试用 JWT（仅测解码，不验签） */
function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fakesig`
}

/** hasAnyRole 是 server.js 内部函数，这里按同逻辑复刻以做对照测试 */
function hasAnyRole(roles, targets) {
  if (targets.length === 0) return false
  for (const r of roles) if (targets.includes(r)) return true
  return false
}

let pass = 0
let fail = 0

console.log('=== decodeJwtPayload ===')
const decCases = [
  ['标准 payload', makeJwt({ sub: 'abc', preferred_username: 'zhangsan' }), 'zhangsan'],
  ['空 token', '', undefined],
  ['非法 token', 'garbage', undefined],
]
for (const [desc, tok, wantUser] of decCases) {
  const p = decodeJwtPayload(tok)
  const got = p.preferred_username
  const ok = got === wantUser
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✅' : '❌'} ${desc} → preferred_username=${got}`)
}

console.log('\n=== extractRoles ===')
const cases = [
  ['Keycloak 标准 realm_access.roles',
    makeJwt({ realm_access: { roles: ['platform-admin', 'offline_access'] } }),
    ['platform-admin', 'offline_access']],
  ['无角色声明', makeJwt({ sub: 'x' }), []],
  ['扁平 roles 形式', makeJwt({ roles: ['gateway-publisher'] }), ['gateway-publisher']],
  ['两者都有（合并去重）',
    makeJwt({ realm_access: { roles: ['a'] }, roles: ['b', 'a'] }), ['a', 'b']],
  ['roles 非数组（容错）', makeJwt({ roles: 'notarray' }), []],
  ['realm_access 为 null（容错）', makeJwt({ realm_access: null }), []],
  ['realm_access.roles 非数组（容错）',
    makeJwt({ realm_access: { roles: 'x' } }), []],
  ['roles 含非字符串（过滤）',
    makeJwt({ roles: ['ok', 123, null, 'ok2'] }), ['ok', 'ok2']],
  ['非法 token', 'not-a-jwt', []],
  ['空 token', '', []],
]
for (const [desc, tok, want] of cases) {
  const got = extractRoles(tok)
  const ok = JSON.stringify([...got].sort()) === JSON.stringify([...want].sort())
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✅' : '❌'} ${desc} → [${got}]${ok ? '' : ` (期望 [${want}])`}`)
}

console.log('\n=== hasAnyRole（权限判定逻辑）===')
const roleCases = [
  [['platform-admin'], ['platform-admin', 'portal-admin'], true, '管理员命中'],
  [['developer'], ['platform-admin'], false, '普通开发者不命中'],
  [[], ['platform-admin'], false, '无角色'],
  [['x'], [], false, '目标为空'],
  [['gateway-publisher'], ['platform-admin', 'gateway-publisher'], true, '发布者命中'],
  [['platform-admin', 'other'], ['gateway-publisher'], false, '多角色但不含目标'],
]
for (const [roles, targets, want, desc] of roleCases) {
  const got = hasAnyRole(roles, targets)
  const ok = got === want
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✅' : '❌'} ${desc}: [${roles}] vs [${targets}] = ${got}`)
}

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
