# 项目分析报告：27c.site（静态站点托管平台）

> 分析时间：2026-08-28 ｜ 工作目录：`C:\Users\viole\Documents\27c`
> 分析范围：全量源码（21 个 `.ts` 文件，约 5093 行）、配置、文档、测试

---

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 名称 | `27c-site` / 27c.site |
| 定位 | **面向 AI agent 的 API 优先静态站点托管平台**（Cloudflare Workers） |
| 核心能力 | 注册/登录、API Key 派生、静态文件部署（JSON / multipart）、子域分配、部署回滚、自定义域名（CNAME + Cloudflare for SaaS）、WebMCP（浏览器端 AI 工具）、中英文 i18n |
| 入口 | `src/index.ts` → 按 hostname 路由到 API / 站点文件 / 平台页面 |
| 部署目标 | Cloudflare Workers（`wrangler deploy`，`main = src/index.ts`） |

**一句话**：用户（或 AI agent）调 REST API 把静态文件推到 R2，平台按 `*.27c.site` 子域或自定义域名对外提供访问，并自带回滚快照。

---

## 2. 技术栈

- **运行时**：Cloudflare Workers，wrangler `^4.126`，`compatibility_date = 2025-08-26`，`nodejs_compat`
- **语言**：TypeScript，`strict` 全开（`noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` 等）
- **存储**：
  - KV `SITE_STORAGE`（id `d593065d…`）——用户、API Key、部署元数据、子域/自定义域映射、限流计数、CF challenge
  - R2 `SITE_ASSETS`（bucket `27c-site-assets`）——站点文件、部署快照
- **自定义域名**：Cloudflare for SaaS Custom Hostnames，SSL 走 HTTP challenge（`/.well-known/cf-custom-hostname-challenge/<token>`）
- **前端**：服务端渲染 HTML（无框架，模板字符串注入），通过 `/webmcp.js` 注入 WebMCP 脚本
- **可观测**：wrangler observability 开启；每个请求结构化 JSON 日志 + `X-Request-Id` 响应头
- **测试**：Vitest，`@cloudflare/vitest-pool-workers` **已安装但禁用**（workerd 在部分机器崩溃），改用 Node pool + 内存 `MockKV`/`MockR2`

---

## 3. 目录结构与各文件职责

```
src/
├─ index.ts            (124)  Worker 入口：路由分发、请求日志、错误捕获、CF challenge、CDN 反代识别
├─ types.ts            (47)   Env / User / ApiKey / Deployment / SiteFile / ApiResponse 类型
├─ auth.ts             (129)  PBKDF2 哈希、API Key 生成、子域清理/校验、路径校验、MIME 映射
├─ db.ts               (334)  数据层：用户/Key/部署/文件/快照/自定义域/CF challenge/删除用户
├─ ratelimit.ts        (62)   KV 固定窗口限流 + 客户端 IP 提取 + 限流头
├─ reserved.ts         (766)  保留子域集合（www/api/admin/mail/git/blog/docs… 数百项）
├─ routes/
│  ├─ api.ts           (724)  全部 REST API（鉴权、注册、登录、部署、上传、回滚、子域、自定义域、删账户）
│  └─ site.ts          (63)   子域/自定义域站点文件服务
├─ webmcp.ts           (623)  WebMCP 浏览器脚本：register/login/deploy/upload/rollback/delete 等工具
├─ pages/
│  ├─ index.ts         (58)   平台页面路由（/ /docs /terms /privacy /zh/*）+ favicon
│  ├─ home.ts           (540)  首页 HTML（hero/特性/对比表/WebMCP 介绍）
│  ├─ docs.ts           (176)  文档页 HTML
│  ├─ policy.ts         (128)  服务条款 / 隐私政策 HTML
│  ├─ layout.ts         (78)   安全头、主题 CSS、nav/footer 模板
│  └─ notFound.ts       (154)  站点不存在 / 文件不存在 / 平台 404 页
├─ locales/
│  ├─ index.ts         (41)   i18n 选择：路径 / Accept-Language / Cookie
│  ├─ en.ts             (216)  英文字典（zh.ts 必须保持同形状，受类型校验）
│  └─ zh.ts             (214)  中文字典
└─ test/
   ├─ mocks.ts          (111)  内存 MockKV / MockR2（兼容 Workers 子集 API）
   ├─ auth.test.ts      (60)   认证单元测试
   └─ integration.test.ts (445) 全流程集成测试
```

---

## 4. 架构与数据流

### 4.1 路由分发（`src/index.ts`）
1. 先拦截 CF 自定义主机名 SSL 验证 challenge（`/.well-known/cf-custom-hostname-challenge/*`）
2. 平台域名（`27c.site` / `www.27c.site` / `localhost` / `*.workers.dev`）：
   - 支持 CDN（如 EdgeOne）反代：读 `X-Forwarded-Host` 解析真实自定义域名
   - `/api/*` → API 处理；`/webmcp.js` → 返回脚本；其余 → 平台页面
3. `*.27c.site` 子域 → 按子域查 owner 服务站点文件
4. 未识别域名 → 查自定义域映射 → 命中则服务；否则 404

### 4.2 部署与回滚
- **部署**：`PUT` R2 `user/{userId}/{path}` → 写部署元数据（KV `deployment:{userId}:{id}`）→ 生成**全量快照**到 R2 `snapshot/{userId}/{id}`（合并本次 + 已有文件，`>512KB` 文件仅存 metadata）→ 保留最近 50 个部署
- **服务**：按 owner 取 R2 文件，`/index.html` 映射为 `/`，`Cache-Control: public, max-age=3600`
- **回滚**：清空现有文件 → 从快照重写可恢复文件（过大文件需重新上传）

### 4.3 自定义域名
CNAME 到 `27c.site` → 调 CF API 创建 custom hostname（HTTP challenge）→ 写入 challenge 到 KV → 验证通过后由 CF 签发 SSL。删账户时同步清理 CF hostname 与 challenge。

### 4.4 WebMCP
`/webmcp.js` 注入的 IIFE 脚本把平台 API 注册为浏览器原生工具（`document.modelContext.registerTool` / `window.__27cTools`），让任意 WebMCP-aware AI agent 自助完成 register→login→deploy→rollback。**密钥不硬编码**，由工具运行时获取并存 `localStorage`，工具描述强制要求"绝不向用户展示 key"。

---

## 5. 安全评估

### ✅ 做得扎实的部分
- 密码 PBKDF2 100k 迭代 SHA-256 + 每用户 salt
- API Key 256-bit 随机 hex（32 字节）
- 路径遍历防护（`..` / `\\` / `//` / 起始 `/`）
- 保留子域防护（766 行集合）
- 四档限流（register 5/h·IP、login 20/h·IP、deploy 60/h·user、upload 60/h·user），429 带 `Retry-After`
- 安全响应头齐全：CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`frame-ancestors 'none'`
- 删除账户两步确认（`confirm: true`）
- WebMCP 从设计上规避 key 泄露（不硬编码、工具提示禁止回显）
- 子域并发竞态做"重读 claim"缩小窗口

### ⚠️ 风险与不足
1. **未纳入版本控制**：项目目录**不是 git 仓库**（无 `.git`），仅有一个 `.gitignore`。无提交历史、无回溯能力。强烈建议 `git init` 并提交。
2. **README 与代码严重脱节**：架构章节写 `src/routes/pages.ts`，实为 `src/pages/*`；缺失 WebMCP、i18n、自定义域名、健康检查、可观测性、CSP 等内容；Security 章节未提及限流与响应头。文档需重写。
3. **WebMCP 自定义域工具被注释禁用**（`webmcp.ts` 306–368 行），但后端 `/api/custom-domain` 仍完全可用——前端与后端功能不对齐（疑似未完成）。
4. **`handleListApiKeys` 边界退化**（`api.ts` 151–163）：当用户无 key 时会**全量扫描** `apikey:global:` 前缀，高基数 KV 下列举成本随用户数线性增长。正常注册都带默认 key，概率低但应修。
5. **部署快照膨胀**：每次部署存全量快照，`handleDeploy` 内 `listSiteFiles` 对每个文件各自 `get`+`arrayBuffer`，文件多时 R2 请求数线性增长、慢且贵；频繁部署致 R2 存储膨胀（虽有 prune 50）。
6. **KV 最终一致性**：子域并发注册竞态仅靠"重读 claim"缩小、非原子；限流计数器跨边缘节点近似。代码注释已承认，属已知限制。
7. **`CF_ZONE_ID` 硬编码在源码**（`api.ts:466`），非密钥但暴露账户 zone id；token 走 `env.CF_API_TOKEN` 正确。
8. **CSP 含 `script-src 'unsafe-inline' https://unpkg.com`**：因动态加载 WebMCP polyfill。当前页面无用户可控输入注入 inline script（i18n 字典为内部常量），风险可控，但 unpkg 属第三方供应链依赖点，建议 self-host polyfill 或改用 nonce。
9. **测试未在 workerd 下运行**：依赖内存 mock 跑通整条管线，真实 R2/KV 行为（一致性、大对象、限流跨节点）未被端到端验证。

---

## 6. 代码质量与测试

- **类型与规范**：TS strict 全套开启，类型清晰，分层合理（auth / db / ratelimit / routes / pages / locales）
- **可改进**：`db.ts` 大量函数重复内联签名 `{ SITE_STORAGE: KVNamespace; SITE_ASSETS: R2Bucket }`，建议抽取为 `SiteEnv` 子接口
- **测试覆盖**：
  - `auth.test.ts`：哈希/验证、Key 生成、保留子域、子域清洗、路径校验、MIME、ID 唯一
  - `integration.test.ts`：完整生命周期（注册→部署→服务→回滚）、路径穿越拒绝、重复/保留子域、限流
  - **缺口**：无真实 Workers 集成测试、无限流跨节点验证、无自定义域 CF 流程测试、无前端页面渲染断言

---

## 7. 成熟度与优先级建议

### P0（立即处理）
- `git init` + 首次提交，建立版本控制
- 重写 README 架构/功能章节，对齐实际代码（pages、webmcp、i18n、自定义域、健康检查、可观测性）
- 激活 workerd 测试或补充真实 Workers 集成测试，弥合 mock 与运行时差异

### P1（近期）
- 修复 `handleListApiKeys` 全量扫描边界
- 决策 WebMCP 自定义域工具：要么启用、要么后端收敛暴露面
- 评估部署快照策略（增量/压缩/生命周期），缓解 R2 膨胀与部署延迟

### P2（优化）
- self-host WebMCP polyfill，消除 unpkg 第三方依赖
- `db.ts` 内联类型抽取为 `SiteEnv` 接口
- 加 CI（lint + test + deploy），避免手动部署漂移
- 为 `CF_ZONE_ID` 等常量迁入 `wrangler.toml` 的 `vars` 或 env，减少源码硬编码

---

## 8. 结论

项目**架构清晰、功能完整、安全基线到位**，是一个可用于生产的 AI 友好静态托管平台雏形。主要短板集中在**工程化与文档**：尚未纳入 git、README 严重过时、WebMCP 与后端存在功能错位、测试未覆盖真实运行时。优先补齐版本控制与文档，即可显著降低后续维护与协作风险。
