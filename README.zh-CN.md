# 27c.site

[English](README.md)

27c.site 是一个基于 Cloudflare Workers 的 AI 优先建站与发布平台。你可以把提示词发给 Cursor、Trae、WorkBuddy 等能够运行命令的 AI 工具，让它连接 27c.site MCP 服务，编写网站、生成素材并完成发布。如果客户端不支持 MCP，也可以使用 HTTP API 备用方式。

平台会为用户网站提供 `<subdomain>.27c.site` 或 `<subdomain>.27ai.cloud` 地址，并支持部署历史、版本回滚和内置数据存储，不需要手动维护后台。

## 功能

- AI 驱动的网站创建与一键发布
- 标准 MCP 服务：`POST /mcp`
- 为不支持 MCP 的客户端提供 HTTP API
- 支持 HTML、CSS、JavaScript、图片、视频和其他静态文件
- 为每个网站提供 `27c.site` 和 `27ai.cloud` 子域名
- 部署历史与版本回滚
- 根据网站真实功能提供数据存储，包括订单、预约、商品、目录、库存、评论、投票等
- 平台页面支持英文和简体中文
- 平台和托管网站不添加广告或第三方追踪脚本

## 本地开发

环境要求：Node.js 20+ 和 npm。

```bash
npm install
npm run dev
```

本地 Worker 默认运行于 `http://localhost:8788`。

发布前运行检查：

```bash
npx tsc --noEmit
npm test
```

## Cloudflare 配置与部署

Worker 配置位于 `wrangler.toml`，使用以下资源：

- KV 命名空间 `SITE_STORAGE`：保存账号、会话、子域名和部署元数据
- R2 存储桶 `SITE_ASSETS`：保存已发布文件和版本快照

请在拥有该 Worker 的 Cloudflare 账号中创建或配置这些资源，然后执行：

```bash
npx wrangler deploy --minify
```

不要提交 API Token、`.dev.vars`、`.env` 文件、`.wrangler/` 或本地日志。

## AI 与 MCP 工作方式

公共 MCP 地址：

```text
https://27c.site/mcp
```

机器可读的配置地址：`https://27c.site/mcp-config`。

AI 客户端可以在自己的客户端中安装 MCP 服务，也可以读取 `https://27c.site/agent-prompt` 获取完整指令。不支持 MCP 的客户端可以直接使用文档中的 HTTP API。MCP 和 HTTP API 属于内部执行方式，用户不需要自行配置。

修改网站前，AI 会询问账号、网站需求、首选子域名和平台域名。如果示例提示词已经包含完整的网站需求，就只需要继续询问发布所需的信息。AI 应保持用户当前使用的语言，并正确处理中文、英文或中英混合的需求。

## 目录结构

- `src/index.ts` — Worker 入口和路由
- `src/routes/` — API 和托管网站路由
- `src/mcp.ts` — Streamable HTTP MCP 服务与工具分发
- `src/agent-prompt.ts` — 安装提示和完整 AI 指令
- `src/pages/` — 平台 HTML 页面
- `src/locales/` — 英文和简体中文界面文案
- `src/example-prompts.ts` — 原样保留的网站示例需求
- `src/database.ts` — 网站内置数据存储
- `src/db.ts` — KV/R2 元数据和文件存储
- `src/skills/` — 提供给建站 AI 的前端设计技能

## 许可证

本项目采用 MIT License，详见 [LICENSE](LICENSE)。
