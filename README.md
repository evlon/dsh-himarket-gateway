# dsh-himarket-gateway

HiMarket 的**发布/权限/审计包装层**（独立服务，零改动 HiMarket 本体）。

## 为什么需要它

HiMarket 本体的产品写操作（创建/更新/删除/发布）全部是 `@AdminAuth`——只有管理员能改，
开发者账号没有任何「改自己产品」的端点，且 `product` 表不记录 owner。这导致：

1. 现有 `dsh-himarket` 插件只能让小白**直接填管理员密码**去发布，没有归属约束，也没有审计；
2. 企业无法回答「谁上传了什么 / 谁下载了什么」。

本服务作为 DSH 侧的统一包装层，承接三件事：

- **权限代理**：服务端持有管理员凭据，代开发者执行变更；按「开发者归属」做隔离——只能改自己名下的包。
- **归属登记**：自建 `ownership` 表，落地「谁开发的包」这一 HiMarket 缺失的事实。
- **审计补充**：记录 `publish / update / delete / download` 行为，供企业查询（弥补 HiMarket 无操作审计的缺口）。

## 架构

```
DSH web(小白) ──开发者token──> dsh-himarket-gateway
                                    │ 校验归属(ownership)
                                    │ 写审计(audit)
                                    │ 用管理员token ──> HiMarket /api/v1 管理员端点
小白 ──只读──> HiMarket /cli-providers (同步/安装，不变)
企业审计查询 ──> dsh-himarket-gateway /audit
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATEWAY_PORT` | `3091` | 监听端口 |
| `GATEWAY_ALLOWLIST` | `127.0.0.1,::1` | 允许访问的 IP（逗号分隔） |
| `HIMARKET_BASE_URL` | `http://ai-market.ict.cmcc` | HiMarket 后端地址 |
| `HIMARKET_ADMIN_USERNAME` | `admin` | 管理员账号（**服务端持有，不下发前端**） |
| `HIMARKET_ADMIN_PASSWORD` | 空 | 管理员密码（**服务端持有**） |
| `GATEWAY_DB_PATH` | `~/.dsh-himarket-gateway/audit.db` | SQLite 存储路径（归属+审计同一库） |
| `HIMARKET_CATEGORY` | `数字员工岗位` | 发布包默认分类名 |

> 凭据只从服务端环境变量注入，绝不通过前端/API 暴露给开发者。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/login` | 开发者登录（用户名+密码）→ 返回 `sessionId` |
| POST | `/publish` | 发布/迭代岗位包（需 session）。body: `{ name, zipPath, portalId? }`。同名且 owner 不符 → 403 |
| DELETE | `/products/:productId` | 删除产品（仅 owner） |
| GET | `/audit?actor=&action=&from=&to=&limit=` | 审计查询（企业用） |
| GET | `/download/:productId` | 下载代理，记录「谁下载了什么」 |

所有写操作都先经归属校验，再代发管理员端点；审计在主流程之后追加（写失败仅 warn，不阻断）。

## 运行

```bash
pnpm install
pnpm build
GATEWAY_PORT=3091 HIMARKET_BASE_URL=http://ai-market.ict.cmcc \
  HIMARKET_ADMIN_USERNAME=admin HIMARKET_ADMIN_PASSWORD=*** \
  node lib/server.js
```

## 测试

```bash
pnpm test
```

用内存 SQLite + mock fetch 验证：发布/归属登记/审计、跨用户 403 隔离、迭代 update 审计、下载审计。

## 与 dsh-himarket 插件的配合（下一步）

插件侧待改造：
- 设置页移除「管理员密码」输入框，改为填「包装层地址」（默认 `http://127.0.0.1:3091`）；
- `publishJob` 改为带开发者 token 调 `/publish`，不再 `loginAdmin`、不再存 `adminToken`；
- 同步/安装逻辑不变（仍直连 HiMarket 只读）。
