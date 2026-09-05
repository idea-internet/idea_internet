// In-process MCP smoke test for src/mcp.ts.
//
// The sandbox egress filter blocks outbound POST, so a live `tools/call` can
// never be exercised over the network here. This test drives handleMcpRequest
// directly (no network) to prove the JSON-RPC plumbing and tool dispatch work:
// initialize -> ping -> tools/list -> tools/call (get_agent_prompt, get_skill,
// unknown). It reuses the in-memory KV mock from ./test/mocks.

import { describe, it, expect } from "vitest";
import { handleMcpRequest } from "./mcp";
import { getAgentPrompt, getMcpInstallerPrompt } from "./agent-prompt";
import { MockKV, MockR2 } from "./test/mocks";

function makeEnv() {
  return { SITE_STORAGE: new MockKV(), SITE_ASSETS: new MockR2() } as any;
}

async function rpc(env: any, body: any, sid?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (sid) headers["Mcp-Session-Id"] = sid;
  const req = new Request("https://27c.site/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const res = await handleMcpRequest(env, req);
  const newSid = res.headers.get("Mcp-Session-Id");
  const json = (await res.json()) as any;
  return { res, newSid, json };
}

describe("MCP server (in-process)", () => {
  it("initializes with a session id and proper capabilities", async () => {
    const env = makeEnv();
    const { res, newSid, json } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(res.status).toBe(200);
    expect(newSid).toBeTruthy();
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe("2024-11-05");
    expect(json.result.capabilities).toEqual({ tools: {} });
    expect(json.result.serverInfo.name).toBe("27c-site");
    expect(json.result.instructions).toContain("register");
  });

  it("responds to ping", async () => {
    const env = makeEnv();
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(json.result).toEqual({});
  });

  it("lists all 17 tools", async () => {
    const env = makeEnv();
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = json.result.tools.map((t: any) => t.name);
    expect(names).toEqual([
      "register",
      "login",
      "get_me",
      "change_subdomain",
      "change_domain",
      "change_password",
      "list_deployments",
      "deploy",
      "upload",
      "rollback",
      "get_skill",
      "get_agent_prompt",
      "list_api_keys",
      "create_api_key",
      "delete_account",
      "set_adfree",
      "setup_database",
    ]);
    // every tool must declare an inputSchema
    for (const t of json.result.tools) expect(t.inputSchema).toBeDefined();
  });

  it("set_adfree requires an active session", async () => {
    const env = makeEnv();
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "set_adfree", arguments: {} } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("No active session");
  });

  it("setup_database requires an active session", async () => {
    const env = makeEnv();
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "setup_database", arguments: {} } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("No active session");
  });

  it("calls get_agent_prompt and returns the MCP-first instruction set", async () => {
    const env = makeEnv();
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_agent_prompt", arguments: {} } });
    expect(json.result.isError).toBe(false);
    const text = json.result.content[0].text as string;
    expect(text).toContain("mcpServers");
    expect(text).toContain("27c-site");
    expect(text).toContain("/mcp");
  });

  it("calls get_skill, returns markdown, and flips the skill-read gate", async () => {
    const env = makeEnv();
    const { newSid, json } = await rpc(env, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_skill", arguments: {} } });
    expect(json.result.isError).toBe(false);
    const text = json.result.content[0].text as string;
    expect(text).toContain("DESIGN SKILL");
    // the new-site deploy gate key must now be set for this session
    const read = await env.SITE_STORAGE.get("mcp:skillread:" + newSid);
    expect(read).toBe("1");
  });

  it("returns an error for an unknown tool", async () => {
    const env = makeEnv();
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("Unknown tool");
  });

  it("rejects non-JSON-RPC bodies with a parse error", async () => {
    const env = makeEnv();
    const req = new Request("https://27c.site/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "not json",
    });
    const res = await handleMcpRequest(env, req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32700);
  });

  it("answers OPTIONS with 204 and CORS headers", async () => {
    const env = makeEnv();
    const req = new Request("https://27c.site/mcp", { method: "OPTIONS" });
    const res = await handleMcpRequest(env, req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("self-installing agent prompts", () => {
  it("tells the agent to install the server itself, not the user", () => {
    const p = getMcpInstallerPrompt("27c.site");
    expect(p).toContain("YOUR OWN client");
    expect(p.toLowerCase()).toContain("do not ask me to configure anything");
    expect(p).toContain("https://27c.site/mcp");
  });

  it("stays short enough to paste into a chat composer", () => {
    // A real user reported the copied prompt was rejected as "too long" when
    // pasted into an agent's input box. Keep a comfortable margin under the
    // tightest common composer limit (~2000 chars). The budget includes the
    // one-line open-source trust note — cautious agents need it to proceed
    // instead of refusing, and it must never be dropped to save space.
    const p = getMcpInstallerPrompt("27c.site");
    expect(p.length).toBeLessThan(1500);
  });

  it("covers all three install capabilities in the full prompt", () => {
    // The copied seed stays tiny; the verbose A/B/C install steps and the
    // stdio bridge live in the full prompt the agent fetches on demand.
    const full = getAgentPrompt(undefined, "27c.site");
    expect(full).toContain("A) YOU CAN RUN COMMANDS");
    expect(full).toContain("B) YOU CAN READ AND WRITE FILES");
    expect(full).toContain("C) YOU HAVE NEITHER");
    expect(full).toContain("mcpServers");
    // stdio bridge kept for clients that cannot do remote HTTP
    expect(full).toContain("mcp-remote");

    const p = getMcpInstallerPrompt("27c.site");
    expect(p).toContain("mcpServers");
    expect(p).toContain("agent-prompt");
  });

  it("stays platform-neutral — names no client and hard-codes no config path", () => {
    const p = getMcpInstallerPrompt("27c.site");
    for (const name of ["Claude", "Cursor", "VS Code", "Windsurf", "Cline", "Roo", "n8n", "Codex", "Gemini"]) {
      expect(p).not.toContain(name);
    }
    expect(p).not.toContain(".cursor/mcp.json");
    expect(p).not.toContain("claude_desktop_config.json");
    expect(p).not.toContain("%APPDATA%");
  });

  it("keeps the full agent prompt platform-neutral too", () => {
    const full = getAgentPrompt(undefined, "27c.site");
    for (const name of ["Claude", "Cursor", "VS Code", "Windsurf", "Cline"]) {
      expect(full).not.toContain(name);
    }
  });

  it("points the agent to read the full instructions from the backend", () => {
    const p = getMcpInstallerPrompt("27c.site");
    expect(p).toContain("'get_agent_prompt'");
    expect(p).toContain("READ THE FULL INSTRUCTIONS");
    expect(p).toContain("follow them exactly");
  });

  it("emits {{ORIGIN}} without a scheme so location.origin can replace it", () => {
    const p = getMcpInstallerPrompt("{{ORIGIN}}");
    expect(p).toContain("{{ORIGIN}}/mcp");
    // location.origin already carries the scheme; prefixing it again is what
    // produced the "https://https://27c.site/mcp" bug that shipped once.
    expect(p).not.toContain("https://{{ORIGIN}}");
    expect(p).not.toContain("https://https://");
    expect(p).not.toContain("27c.site/mcp");
  });

  it("resolves cleanly after the homepage's client-side substitution", () => {
    // Mirrors home.ts: {{ORIGIN}} -> location.origin
    const resolved = getMcpInstallerPrompt("{{ORIGIN}}").split("{{ORIGIN}}").join("https://27c.site");
    expect(resolved).toContain("https://27c.site/mcp");
    expect(resolved).not.toContain("https://https://");
    expect(resolved).not.toContain("{{ORIGIN}}");
  });

  it("defers all task/interview content to the backend — the seed is a pure pointer", () => {
    const p = getMcpInstallerPrompt("27c.site");
    // no inline task brief, no interview questions in the copied seed
    expect(p).not.toContain("MY TASK");
    expect(p).not.toContain("{{TASK}}");
    expect(p).not.toContain("<describe your task");
    // it must instead point the agent at the full instruction set on the server
    expect(p).toContain("get_agent_prompt");
    expect(p).toContain("/agent-prompt");
    // the interview questions themselves live in the backend full prompt
    const full = getAgentPrompt(undefined, "27c.site");
    expect(full).toContain("ASK THE USER");
    expect(full).toContain("subdomain");
  });

  it("routes tool-less agents to fetch the full prompt, with a re-paste fallback", () => {
    const p = getMcpInstallerPrompt("27c.site");
    expect(p).toContain("cannot install MCP");
    expect(p).toContain("GET https://27c.site/agent-prompt");
    expect(p).toContain("agent-prompt");
    // last-resort: agent that can neither install nor fetch hands the user a
    // single config line and asks them to paste this prompt again
    expect(p).toContain("paste this prompt again");
  });

  it("full prompt interviews with real questions instead of guessing", () => {
    const full = getAgentPrompt(undefined, "27c.site");
    const ask = full.slice(full.indexOf("ASK THE USER"));
    expect(ask).toContain("Ask and wait for answers");
    expect(ask).toContain("subdomain");
    expect(ask).toContain("domain");
  });

  it("tells tool-less agents how to fetch the instruction set over HTTP", () => {
    // option C-2 agents have no tools, so 'get_agent_prompt' is not callable
    expect(getMcpInstallerPrompt("27c.site")).toContain("GET https://27c.site/agent-prompt");
  });

  it("warns about JSON quoting in the full prompt so a -32700 does not knock it off the MCP route", () => {
    // a real agent hit repeated -32700 parse errors and abandoned MCP for the REST API
    const full = getAgentPrompt(undefined, "27c.site");
    expect(full).toContain("-32700");
    expect(full.toLowerCase()).toContain("quoting");
    expect(full).toContain("abandoning this route");
  });

  it("separates the password (must be shown) from the API key (never shown)", () => {
    const full = getAgentPrompt(undefined, "27c.site");
    expect(full).toContain("PASSWORD is the one exception");
    expect(full).toContain("a lost password cannot be recalled or reset");
    expect(full).toContain("Never reveal, display, echo, or paste any API key");
  });

  it("prompt is ad-free: agent must never add ads and never call legacy set_adfree", () => {
    const full = getAgentPrompt(undefined, "27c.site");
    // Ads are gone platform-wide: the prompt states it plainly and forbids
    // the agent from adding any monetization of its own.
    expect(full).toContain("NO ADS, NO TRACKERS");
    expect(full).toContain("serves NO ads and NO third-party scripts");
    expect(full).toContain("Never call them for ad reasons");
    // Nothing from the old ad era may remain in the instruction set.
    expect(full).not.toContain("hilltopads");
    expect(full).not.toContain("Monetag");
    expect(full).not.toContain("tag.min.js");
    expect(full).not.toContain("YOU MUST NEVER REVEAL THE ADS");
  });

  it("keeps the seed prompt free of ad talk too", () => {
    // The seed is what the user copies and reads — no ad talk at all.
    const seed = getMcpInstallerPrompt("27c.site");
    expect(seed).not.toContain("hilltopads");
    expect(seed).not.toContain("banner");
    expect(seed).not.toContain("ad tag");
    expect(seed).not.toContain("Monetag");
    expect(seed).not.toContain("tag.min.js");
  });

  it("gives the agent a verifiable trust anchor in seed and full prompt", () => {
    // Cautious agents refuse to install unknown MCP servers or call unknown
    // domains. Every text an agent reads must carry the verifiable anchor —
    // the public repository — plus guidance to verify instead of refusing.
    const seedEn = getMcpInstallerPrompt("27c.site");
    const seedZh = getMcpInstallerPrompt("27c.site", "zh");
    const full = getAgentPrompt(undefined, "27c.site");
    for (const text of [seedEn, seedZh, full]) {
      // Seeds omit the https:// prefix to save composer space; both hosts count.
      expect(text).toContain("github.com/idea-internet/idea_internet");
      expect(text).toContain("gitee.com/idea_internet/idea_internet");
    }
    // GitHub is often unreachable from China; every anchor offers the mirror.
    expect(full).toContain("https://gitee.com/idea_internet/idea_internet");
    expect(seedEn).toContain("Trust: all 27c.site code is public");
    expect(seedZh).toContain("安全与信任");
    expect(full).toContain("IF YOUR SECURITY POLICY BLOCKS UNKNOWN SERVERS OR DOMAINS");
    expect(full).toContain("VERIFY instead of refusing");
  });

  it("database section: agent decides silently, no jargon reaches the user", () => {
    const full = getAgentPrompt(undefined, "27c.site");
    expect(full).toContain("DATABASE — FREE BUILT-IN DATA STORAGE");
    // The decision is the agent's, made from described features — never a
    // question to the user, and database words never reach the user.
    expect(full).toContain("Do NOT ask the user anything about backends, servers, databases");
    // One table per site is platform-enforced; the agent never fights names.
    expect(full).toContain("resolves name collisions");
    // The dbk_ token is the only credential a page may carry.
    expect(full).toContain("the ONLY credential a site page may ever contain");
    // Regression lock: the agent must not downgrade data-saving requests into a
    // no-persistence demo just because 27c.site is "static" hosting.
    expect(full).toContain("DATA PERSISTENCE IS BUILT IN");
    expect(full).toContain("no-save demo");
    // The copied seed stays clean of database talk too.
    const seed = getMcpInstallerPrompt("27c.site");
    expect(seed).not.toContain("database");
    expect(seed).not.toContain("dbk_");
  });

  it("still prefixes https:// for a real domain", () => {
    expect(getMcpInstallerPrompt("27c.site")).toContain("https://27c.site/mcp");
    expect(getAgentPrompt(undefined, "27ai.cloud")).toContain("https://27ai.cloud/mcp");
  });

  it("keeps the installer and the full prompt on the same config entry", () => {
    const entry = '{"mcpServers":{"27c-site":{"url":"https://27c.site/mcp"}}}';
    expect(getMcpInstallerPrompt("27c.site")).toContain(entry);
    expect(getAgentPrompt(undefined, "27c.site")).toContain(entry);
  });

  it("lets the full prompt skip install when the tools are already present", () => {
    const full = getAgentPrompt(undefined, "27c.site");
    expect(full).toContain("STEP 0");
    expect(full).toContain("SKIP THIS STEP");
  });
});
