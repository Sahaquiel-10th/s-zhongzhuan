# 超级中转站

小规模、单实例部署的多租户模型 API 网关。管理员为每个客户配置独立供应商凭证和可用模型；客户只使用超级中转站签发的 API Key，通过统一地址调用、查看计量并充值。

## 为什么使用 SQLite

当前用户量和数据量较小时，PostgreSQL 会增加数据库服务、连接配置、备份和运维成本。本项目使用 SQLite WAL：

- 数据保存在 `data/super-relay.db` 一个文件中。
- WAL 模式允许读取和写入并行，余额事务仍然串行执行。
- Docker 部署只需要应用容器和一个持久化磁盘。
- 备份数据库文件即可，不需要单独维护数据库服务。

限制是只能部署一个应用实例，数据库文件必须位于本机持久化磁盘，不能放在普通网络共享盘。需要横向扩容、多地域或高并发写入时再迁移 PostgreSQL。

## 当前能力

- 管理员与客户两种登录角色
- 客户、余额、API Key、模型和调用记录按租户隔离
- 每个客户可以配置一把或多把独立供应商 Key
- 同一客户的不同模型可以绑定不同供应商 Key
- OpenAI `models`、`chat/completions`、`responses` 和 Anthropic `messages` 代理
- 普通响应和 SSE 流式响应
- 请求前预留人民币余额，请求后按供应商返回的实际 Token 事务结算
- 每个模型独立配置官网输入、缓存输入和输出价格，全站只设置一个客户折扣
- 余额不足时由 API 网关返回 `402`，不会把请求转发给供应商
- 客户 API Key 单向哈希；供应商 Key 使用 AES-256-GCM 加密
- 客户提交充值订单，管理员确认后幂等入账

## 管理员如何登录

管理员账号由 `.env` 中这两个变量决定：

```dotenv
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me-now
```

首次运行 `npm run db:migrate` 时会自动创建管理员。然后打开网站，直接在统一登录页输入这组账号即可；系统会根据角色自动进入管理员后台。

如果数据库已经创建、后来修改了管理员密码，执行：

```bash
npm run admin:reset
```

该命令会使用当前 `.env` 的管理员邮箱和密码重置账号。

## 供应商侧需要什么

最小配置是：

1. `Base URL`，即供应商提供的 OpenAI 或 Anthropic 兼容地址。
2. `API Key`，建议在供应商控制台为每个客户单独创建。
3. `模型 ID`，必须与供应商模型列表中的名称完全一致。

如果创建 Key 时还要求选择“分组/线路”，也应记录。分组通常已经绑定在 Key 上，本项目保留该字段供管理员识别，不会展示给客户。

供应商 Key 不放环境变量。环境变量只保存加密主密钥，实际供应商 Key 使用 AES-256-GCM 加密后存入 SQLite。

## 本地启动

需要 Node.js 22.13+，生产 Docker 使用 Node.js 24。

```bash
cp .env.example .env
openssl rand -base64 32
# 把结果填入 UPSTREAM_KEY_ENCRYPTION_KEY，并修改管理员密码
npm install
npm run db:migrate
npm start
```

打开 `http://localhost:4173`。

Docker 部署：

```bash
docker compose up --build -d
```

Docker 卷 `super_relay_data` 用于持久化 SQLite 文件，不能删除或使用临时文件系统。

## 首次配置顺序

1. 使用 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 登录管理员后台。
2. 创建客户和客户登录账号。
3. 在供应商控制台为该客户创建独立 Key，并确认分组包含所需模型。
4. 在“模型配置”录入该客户的 Base URL 和供应商 Key。
5. 在“模型配置”上架客户模型，只填写客户模型 ID 和供应商模型 ID。
6. 添加模型时填写官网输入、缓存输入和输出价格，在“折扣设置”配置统一客户折扣。
7. 客户登录后，在“接入说明”查看自己的 Base URL 和示例，再生成 API Key。
8. 客户调用 `GET /v1/models` 获取已开通模型。
9. 客户提交充值订单，管理员确认收款后入账。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `DATABASE_PATH` | SQLite 文件路径，默认 `./data/super-relay.db` |
| `SESSION_SECRET` | 登录 Cookie 签名，生产至少 32 字符 |
| `UPSTREAM_KEY_ENCRYPTION_KEY` | 加密供应商 Key 的 32 字节 Base64 主密钥 |
| `ADMIN_EMAIL` | 管理员登录邮箱 |
| `ADMIN_PASSWORD` | 首次创建或重置管理员时使用的密码 |
| `PUBLIC_BASE_URL` | 客户看到的超级中转站域名 |

模型计费不读取环境变量中的价格或折扣。管理员为每个客户模型填写官网人民币 Token 单价，再在后台设置统一客户折扣，例如 `0.8` 表示官网价格的 8 折。充值金额按人民币 `1:1` 进入客户余额。

不要提交 `.env`。加密主密钥丢失后，数据库里的供应商 Key 无法恢复，必须保存在部署平台 Secret 和独立密码库中。

前端余额提示只负责用户体验。客户可以绕过网页直接调用 API，因此最终权限检查、余额预占、失败释放和实际扣费全部在服务端完成，SQLite 账本是余额的唯一真相源。

## 备份

应用运行时不能只复制主数据库文件并忽略 `-wal` 文件。推荐先停止容器后备份整个 `data` 目录，或者使用 SQLite 在线备份工具。至少保留每日异地备份。

## 上线注意

- 只能运行一个应用实例，必须挂载持久化本地磁盘。
- 正式域名必须启用 HTTPS，并正确配置 `PUBLIC_BASE_URL`。
- 当前充值是人工确认；接微信或支付宝后，在支付回调验签成功时复用订单确认事务。
- 管理后台不会向客户返回供应商名称、Base URL、供应商模型 ID 或供应商 Key。
- 反向代理或云平台应增加 IP 限流、日志脱敏、数据库目录监控和告警。

## GitHub

已配置远端：`git@github.com:Sahaquiel-10th/s-zhongzhuan.git`

```bash
git add .
git commit -m "feat: build super relay gateway"
git push -u origin main
```
