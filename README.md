# 27c.site

[中文说明](README.zh-CN.md)

27c.site is an AI-first website publishing platform built on Cloudflare Workers. An AI that can run commands can install or connect to the 27c.site MCP server, write the website, generate assets, and publish it. If MCP is not available, the same agent can use the HTTP API fallback.

The platform serves user sites at `<subdomain>.27c.site` or `<subdomain>.27ai.cloud`, with deployment history, rollback, built-in data storage, and no manual management dashboard.

## What it provides

- AI-driven website creation and one-click publishing
- Standard MCP server at `POST /mcp`
- HTTP API for clients that cannot install MCP
- Static HTML, CSS, JavaScript, images, video, and other assets
- Per-site subdomains on `27c.site` and `27ai.cloud`
- Deployment history and rollback
- Built-in site data storage shaped around the site's real features, including orders, bookings, products, directories, inventory, comments, votes, and more
- English and Simplified Chinese platform pages
- No ads or third-party tracking scripts on platform or hosted sites

## Local development

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

The local Worker runs at `http://localhost:8788` by default.

Run the checks before publishing:

```bash
npx tsc --noEmit
npm test
```

## Cloudflare setup and deployment

The Worker configuration is in `wrangler.toml`. It uses:

- KV namespace `SITE_STORAGE` for accounts, sessions, subdomains, and deployment metadata
- R2 bucket `SITE_ASSETS` for deployed files and snapshot assets

Create or configure those resources in the Cloudflare account that owns the Worker, then deploy with:

```bash
npx wrangler deploy --minify
```

Do not commit API tokens, `.dev.vars`, `.env` files, `.wrangler/`, or local logs.

## AI and MCP workflow

The public MCP endpoint is:

```text
https://27c.site/mcp
```

The machine-readable configuration is available at `https://27c.site/mcp-config`.

An AI client may install the MCP server in its own client, or call `https://27c.site/agent-prompt` for the full instructions. Clients without MCP support can use the documented HTTP API directly. MCP and HTTP API are internal execution choices; users should not need to configure either one.

Before changing a site, the AI asks for the account, site brief, preferred subdomain, and platform domain. A complete example brief can provide the site brief itself, so only the remaining publishing details need to be asked. The AI must keep the user's language and mixed Chinese/English requirements intact while using the best language for code and tool instructions.

## Repository layout

- `src/index.ts` — Worker entry point and routing
- `src/routes/` — API and hosted-site routes
- `src/mcp.ts` — Streamable HTTP MCP server and tool dispatch
- `src/agent-prompt.ts` — installer and full agent instructions
- `src/pages/` — platform HTML pages
- `src/locales/` — English and Simplified Chinese UI dictionaries
- `src/example-prompts.ts` — verbatim example website briefs
- `src/database.ts` — built-in site data storage
- `src/db.ts` — KV/R2 metadata and file storage
- `src/skills/` — frontend design skill served to new-site agents

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
