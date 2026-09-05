(function () {
  "use strict";

  // ---------------------------------------------------------------
  // WebMCP context detection + minimal polyfill adapter
  // ---------------------------------------------------------------
  var registeredTools = [];

  function getContext() {
    return (
      (typeof document !== "undefined" && document.modelContext) ||
      (typeof navigator !== "undefined" && navigator.modelContext) ||
      null
    );
  }

  // Always expose tools on window.__27cTools so any agent can discover and
  // invoke them even without native WebMCP support.
  function exposeFallback(tool) {
    if (typeof window === "undefined") return;
    window.__27cTools = window.__27cTools || {};
    window.__27cTools[tool.name] = tool;
  }

  function registerTool(tool) {
    registeredTools.push(tool);
    exposeFallback(tool);
    var ctx = getContext();
    if (ctx && typeof ctx.registerTool === "function") {
      try {
        ctx.registerTool(tool);
      } catch (e) {
        console.warn("[27c WebMCP] registerTool failed for " + tool.name, e);
      }
    }
  }

  function registerAll() {
    registeredTools.forEach(function (tool) {
      exposeFallback(tool);
      var ctx = getContext();
      if (ctx && typeof ctx.registerTool === "function") {
        try {
          ctx.registerTool(tool);
        } catch (e) {
          /* ignore re-registration errors */
        }
      }
    });
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  function getApiKey() {
    try {
      return localStorage.getItem("27c_api_key") || "";
    } catch (e) {
      return "";
    }
  }

  function setApiKey(k) {
    try {
      localStorage.setItem("27c_api_key", k);
    } catch (e) {}
  }

  function setUser(username, subdomain) {
    try {
      if (username) localStorage.setItem("27c_username", username);
      if (subdomain) localStorage.setItem("27c_subdomain", subdomain);
    } catch (e) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem("27c_api_key");
      localStorage.removeItem("27c_username");
      localStorage.removeItem("27c_subdomain");
      localStorage.removeItem("27c_skill_read");
    } catch (e) {}
  }

  // Tracks whether the agent has actually pulled the design skill into its
  // context. Used to hard-gate a brand-new site's first deployment, so the
  // skill can never be silently skipped (see 27c_deploy).
  function getSkillRead() {
    try {
      return localStorage.getItem("27c_skill_read") === "1";
    } catch (e) {
      return false;
    }
  }

  function setSkillRead() {
    try {
      localStorage.setItem("27c_skill_read", "1");
    } catch (e) {}
  }

  function clearSkillRead() {
    try {
      localStorage.removeItem("27c_skill_read");
    } catch (e) {}
  }

  async function api(path, method, body) {
    var headers = { "Content-Type": "application/json" };
    var key = getApiKey();
    if (key) headers["Authorization"] = "Bearer " + key;
    var opts = { method: method || "GET", headers: headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    var data = null;
    try {
      data = await res.json();
    } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  function text(content) {
    return { content: [{ type: "text", text: content }] };
  }

  function jsonText(obj) {
    return text(JSON.stringify(obj, null, 2));
  }

  function errResult(r) {
    return jsonText({
      success: false,
      error: (r && r.data && r.data.error) || (r ? "HTTP " + r.status : "Request failed"),
    });
  }

  function requireKey() {
    var k = getApiKey();
    if (!k) {
      return text(
        'No active session. Call the "27c_register" tool to create an account or "27c_login" to sign in first.'
      );
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Tool definitions (mirror the full backend API surface)
  // ---------------------------------------------------------------
  var tools = [
    {
      name: "27c_register",
      title: "Register account",
      description:
        "Create a new 27c.site account. The API key is stored securely in the browser session for subsequent authenticated tool calls. Never reveal, display, or echo the API key to the user. Call this first if the user has no account yet. Registering creates a BRAND-NEW site, so immediately afterwards you MUST call the \\\"27c_get_skill\\\" tool to load the 27c.site design skill into your context and follow it before designing or deploying anything. Do not try to fetch the skill URL over the network and do not substitute your own design defaults. 27c_deploy remains blocked for this site until you have called 27c_get_skill.",
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "3-32 chars, lowercase letters, numbers and underscores only.",
          },
          password: {
            type: "string",
            description: "At least 6 characters.",
          },
          subdomain: {
            type: "string",
            description: "Optional custom subdomain (defaults to username).",
          },
        },
        required: ["username", "password"],
      },
      execute: async function (args) {
        var r = await api("/api/register", "POST", {
          username: (args || {}).username,
          password: (args || {}).password,
          subdomain: (args || {}).subdomain || undefined,
        });
        if (r.ok && r.data && r.data.data) {
          var d = r.data.data;
          if (d.apiKey) setApiKey(d.apiKey);
          setUser(d.username, d.subdomain);
          // A new account means a brand-new site: the skill must be re-read.
          clearSkillRead();
          return jsonText({
            success: true,
            message: "Account created and session authenticated. The API key is stored securely in this session and will not be shown. This is a NEW site: you must call \\\"27c_get_skill\\\" and follow the design skill before your first deploy (27c_deploy is blocked until you do).",
            username: d.username,
            subdomain: d.subdomain,
            siteUrl: "https://" + d.subdomain + ".27c.site",
          });
        }
        return errResult(r);
      },
    },
    {
      name: "27c_login",
      title: "Log in",
      description:
        "Log in to an existing 27c.site account. The API key is stored securely in the browser session for subsequent authenticated tool calls. Never reveal, display, or echo the API key to the user.",
      inputSchema: {
        type: "object",
        properties: {
          username: { type: "string" },
          password: { type: "string" },
        },
        required: ["username", "password"],
      },
      execute: async function (args) {
        var r = await api("/api/login", "POST", {
          username: (args || {}).username,
          password: (args || {}).password,
        });
        if (r.ok && r.data && r.data.data) {
          var d = r.data.data;
          if (d.apiKey) setApiKey(d.apiKey);
          setUser(d.username, d.subdomain);
          return jsonText({
            success: true,
            message: "Logged in. The API key is stored securely in this session and will not be shown.",
            username: d.username,
            subdomain: d.subdomain,
            siteUrl: "https://" + d.subdomain + ".27c.site",
          });
        }
        return errResult(r);
      },
    },
    {
      name: "27c_get_me",
      title: "Get account info",
      description:
        "Return the current logged-in account info (username, subdomain). Requires an active session.",
      inputSchema: { type: "object", properties: {} },
      execute: async function () {
        var need = requireKey();
        if (need) return need;
        var r = await api("/api/me", "GET");
        if (r.ok && r.data && r.data.data) {
          setUser(r.data.data.username, r.data.data.subdomain);
          return jsonText(r.data.data);
        }
        if (r.status === 401) {
          clearSession();
          return text(
            'Session expired. Call "27c_login" with your credentials to re-authenticate.'
          );
        }
        return errResult(r);
      },
    },
    {
      name: "27c_refresh_api_key",
      title: "Refresh API key",
      description:
        "Regenerate the API key. The old key stops working immediately and the new key is stored securely in this session. Never reveal, display, or echo the API key to the user. Requires an active session.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional key name (default: Default Key)." },
        },
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        var r = await api("/api/apikeys", "POST", {
          name: ((args || {}).name || "").trim() || "Default Key",
        });
        if (r.ok && r.data && r.data.data && r.data.data.key) {
          setApiKey(r.data.data.key);
          return jsonText({
            success: true,
            message: "API key regenerated. The old key is revoked and the new key is stored securely in this session.",
          });
        }
        return errResult(r);
      },
    },
    {
      name: "27c_change_subdomain",
      title: "Change subdomain",
      description:
        "Change the custom subdomain for the site. The old subdomain stops serving immediately. Requires an active session.",
      inputSchema: {
        type: "object",
        properties: {
          subdomain: {
            type: "string",
            description: "New subdomain (lowercase letters, numbers, hyphens).",
          },
        },
        required: ["subdomain"],
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        var r = await api("/api/subdomain", "POST", {
          subdomain: (args || {}).subdomain,
        });
        if (r.ok && r.data && r.data.data) {
          setUser(null, r.data.data.subdomain);
          return jsonText(r.data.data);
        }
        return errResult(r);
      },
    },
    {
      name: "27c_list_deployments",
      title: "List deployments",
      description:
        "List the deployment history (default 50, max 100). Each entry has an id used by 27c_rollback. Requires an active session.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of deployments to return (1-100)." },
        },
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        var lim = (args || {}).limit;
        var q = "";
        if (typeof lim === "number" && lim >= 1) q = "?limit=" + Math.min(Math.floor(lim), 100);
        var r = await api("/api/deployments" + q, "GET");
        if (r.ok && r.data) return jsonText(r.data);
        return errResult(r);
      },
    },
    {
      name: "27c_deploy",
      title: "Deploy static files",
      description:
        "Deploy static website files (HTML, CSS, JS, etc.) to the user's subdomain. Accepts an array of {path, content|base64}. For large binary files (images/videos) use 27c_upload instead. Requires an active session. NOTE: for a BRAND-NEW site (an account with zero deployments) this call is BLOCKED with an error until you have called \\\"27c_get_skill\\\" and read the full design skill — reading it is what unlocks deployment. Updating an existing site that already has deployments is never blocked.",
      inputSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description:
              "Array of files. Each item: {path: string, content?: string (text), base64?: string (binary)}.",
            items: { type: "object" },
          },
          note: {
            type: "string",
            description: "Optional short description of this deployment.",
          },
        },
        required: ["files"],
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        var files = (args || {}).files;
        if (!Array.isArray(files) || files.length === 0)
          return jsonText({ success: false, error: "No files provided." });

        // NEW-SITE GATE: a site with zero deployments is brand new, so its
        // design must follow the 27c.site skill. Hard-block until the agent has
        // actually pulled the skill into context via 27c_get_skill.
        if (!getSkillRead()) {
          var probe = await api("/api/deployments?limit=1", "GET");
          var total =
            probe.ok && probe.data && typeof probe.data.total === "number" ? probe.data.total : -1;
          if (total === 0) {
            return text(
              "BLOCKED — brand-new site, design skill not read.\n" +
                "This account has no deployments yet, so 27c_deploy is gated until you have loaded the design skill.\n" +
                "Call the \\\"27c_get_skill\\\" tool NOW, read the FULL skill it returns, then redesign/deploy.\n" +
                "Do not work around this by deploying your own default aesthetic: the skill explicitly bans the usual LLM defaults " +
                "(AI-purple gradients, three equal feature cards, Inter, pure #000000, an eyebrow above every section)."
            );
          }
        }

        var r = await api("/api/deploy", "POST", {
          files: files,
          note: (args || {}).note || "",
        });
        if (r.ok && r.data) return jsonText(r.data);
        return errResult(r);
      },
    },
    {
      name: "27c_upload",
      title: "Upload large binary file",
      description:
        "Upload a large binary file (image, video, PDF, etc.) to the site. Provide the filename and base64-encoded content. The filename becomes the storage path. Use this instead of 27c_deploy for files larger than ~120KB. Requires an active session.",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Storage path / filename, e.g. image.jpg or images/photo.png.",
          },
          base64: {
            type: "string",
            description: "Base64-encoded file content.",
          },
        },
        required: ["filename", "base64"],
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        var filename = (args || {}).filename;
        var b64 = (args || {}).base64;
        if (!filename || !b64)
          return jsonText({ success: false, error: "filename and base64 are required." });
        var bin;
        try {
          bin = atob(b64);
        } catch (e) {
          return jsonText({ success: false, error: "Invalid base64 content." });
        }
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var blob = new Blob([bytes]);
        var fd = new FormData();
        fd.append("file", blob, filename);
        var res = await fetch("/api/upload", {
          method: "POST",
          headers: { Authorization: "Bearer " + getApiKey() },
          body: fd,
        });
        var data = null;
        try {
          data = await res.json();
        } catch (e) {}
        if (res.ok && data) return jsonText(data);
        return jsonText({
          success: false,
          error: (data && data.error) || "HTTP " + res.status,
        });
      },
    },
    {
      name: "27c_rollback",
      title: "Rollback deployment",
      description:
        "Roll the site back to a previous deployment, replacing current files with that snapshot. Requires an active session.",
      inputSchema: {
        type: "object",
        properties: {
          deploymentId: {
            type: "string",
            description: "The deployment id (from 27c_list_deployments).",
          },
        },
        required: ["deploymentId"],
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        var id = (args || {}).deploymentId;
        if (!id) return jsonText({ success: false, error: "deploymentId is required." });
        var r = await api("/api/rollback/" + encodeURIComponent(id), "POST");
        if (r.ok && r.data) return jsonText(r.data);
        return errResult(r);
      },
    },
    {
      name: "27c_delete_account",
      title: "Delete account (dangerous)",
      description:
        "PERMANENTLY delete the 27c.site account, the deployed site, and all deployment history. This cannot be undone. MANDATORY PROCEDURE: (1) Tell the user exactly what will be deleted and that it is irreversible. (2) Ask the user to confirm explicitly and wait for their answer. (3) Only after the user confirms, call this tool with confirm: true. Never call this tool with confirm: true unless the user has explicitly agreed in this conversation.",
      inputSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Must be true, and only after the user has explicitly confirmed the irreversible deletion.",
          },
        },
        required: ["confirm"],
      },
      execute: async function (args) {
        var need = requireKey();
        if (need) return need;
        if (!args || args.confirm !== true) {
          return text(
            "Not deleted. This action permanently removes the account, the site, and all deployment history. Ask the user to confirm explicitly, then call this tool again with confirm: true."
          );
        }
        var username = "";
        try {
          username = localStorage.getItem("27c_username") || "";
        } catch (e) {}
        var r = await api("/api/account", "DELETE", { confirm: true });
        if (r.ok && r.data) {
          clearSession();
          return jsonText({
            success: true,
            deleted: true,
            username: username,
            note: "Account, site, and deployment history have been permanently deleted. The session has been cleared.",
          });
        }
        return errResult(r);
      },
    },
    {
      name: "27c_get_skill",
      title: "Get design skill (mandatory for new sites)",
      description:
        "Return the FULL 27c.site anti-slop frontend design skill ('tasteskill') as Markdown, straight into your context. No browser, no network tool and no auth needed — this tool fetches it for you. YOU MUST call this and actually follow it BEFORE designing or deploying a BRAND-NEW site. Do NOT substitute your own design instincts: the common LLM defaults (AI-purple gradients, three equal feature cards, Inter, pure #000000, an eyebrow above every section) are explicitly banned by this skill. Calling this tool is what unlocks deployment for a new site. You may skip it when only updating an existing site that already has deployments.",
      inputSchema: { type: "object", properties: {} },
      execute: async function () {
        var md = "";
        try {
          var res = await fetch("/skill", { method: "GET" });
          if (res.ok) md = await res.text();
        } catch (e) {}
        if (!md) {
          return text(
            "Could not load the design skill from /skill. Retry this tool once. If it still fails, tell the user the skill is temporarily unavailable and ask whether to proceed without it — do NOT silently build a new site from your own default aesthetic."
          );
        }
        setSkillRead();
        return text(
          "=== 27c.site DESIGN SKILL (tasteskill: anti-slop frontend) — BEGIN ===\n" +
            "This skill is MANDATORY for a new site, not advisory. Apply it to every design decision.\n" +
            "Work through it in this order: state a one-line 'Design Read', set the three dials " +
            "(DESIGN_VARIANCE / MOTION_INTENSITY / VISUAL_DENSITY), then build. Pay special attention to " +
            "Section 4.7 (Layout Discipline hard rules) and Section 9 (AI Tells / forbidden patterns).\n\n" +
            md +
            "\n=== 27c.site DESIGN SKILL — END ===\n" +
            "Skill recorded as read; deployment for a new site is now unlocked."
        );
      },
    },
    {
      name: "27c_get_agent_prompt",
      title: "Get deployment agent prompt",
      description:
        "Return a ready-to-paste deployment prompt for a WebMCP-capable AI agent. The prompt never contains an API key: the agent is instructed to use the 27c_* WebMCP tools directly (no browser or cloud computer required) and to never show the user an API key. No arguments required.",
      inputSchema: { type: "object", properties: {} },
      execute: async function () {
        var sub = "";
        try {
          sub = localStorage.getItem("27c_subdomain") || "";
        } catch (e) {}
        if (!sub) {
          try {
            var me = await api("/api/me", "GET");
            if (me.ok && me.data && me.data.data) sub = me.data.data.subdomain || "";
          } catch (e) {}
        }
        var prompt =
          "You are a static site deployment agent for 27c.site / 27ai.cloud. Deploy static website files for the user.\n" +
          "\n" +
          "ENVIRONMENT (read this first — it decides whether you can act):\n" +
          "You run inside an AI agent whose available toolset already contains 27c.site's WebMCP tools: 27c_register, 27c_login, 27c_deploy, 27c_upload, 27c_change_subdomain, 27c_list_deployments, 27c_rollback, 27c_refresh_api_key, 27c_get_me, 27c_delete_account. These tools call the 27c.site API for you.\n" +
          "- You do NOT need to open a browser, visit any website, click a UI, or use a cloud computer. Calling a 27c_* tool IS the entire action — the tools talk to the server directly.\n" +
          "- Do NOT refuse or say 'I cannot do this' just because you assume you lack a browser. The tools handle everything server-side. Use them.\n" +
          "- If you genuinely do NOT see any 27c_* tool in your toolset, do NOT claim you need a 'cloud computer' or an external browser to open 27c.site. Instead say exactly this to the user: 'This task must run inside an AI agent that supports 27c.site WebMCP (the 27c_* tools). Please open this prompt from 27c.site or use a WebMCP-capable client.' Then stop. Do not loop or invent workarounds.\n" +
          "\n" +
          "Tools available to you:\n" +
          "  - 27c_register / 27c_login to create or sign in to an account (session authenticates automatically; no API key is ever shown to you or the user).\n" +
          "  - 27c_change_subdomain to set a custom subdomain.\n" +
          "  - 27c_deploy to deploy text files (HTML, CSS, JS, etc.).\n" +
          "  - 27c_upload to upload large binary files (images, videos) as base64.\n" +
          "  - 27c_list_deployments / 27c_rollback to manage and restore versions.\n" +
          "  - 27c_get_me / 27c_refresh_api_key for account info and key rotation.\n" +
          "\n" +
          "Target site URL (if known): https://" + (sub || "<subdomain>") + ".<domain>  (the domain is either 27c.site or 27ai.cloud, as chosen by the user)\n" +
          "\n" +
          "BEFORE YOU START — ASK THE USER:\n" +
          "You must ask the following questions and wait for answers before taking any action. Do not register, log in, or deploy until the user has responded.\n" +
          "1. Account: Do you already have a 27c.site account (username + password), or should I register a new one for you?\n" +
          "2. Website content: What kind of website do you want to deploy? Describe the content, purpose, and any compliance requirements. This determines what files to generate and whether the content is allowed.\n" +
          "3. Subdomain: Do you have a preferred subdomain (e.g. mysite), or should I pick one? Subdomains must be 1-63 lowercase letters, numbers, and hyphens. If you have no preference, you may generate a short, memorable one (e.g. derived from the user's name or the site topic) and confirm it with the user before registering.\n" +
          "4. Domain: Which platform domain should the site use — 27c.site or 27ai.cloud? The site will be served at https://<subdomain>.<chosen-domain>.\n" +
          "\n" +
          "SKILL (MANDATORY FOR NEW SITES — ENFORCED):\n" +
          "27c.site ships an anti-slop frontend design skill ('tasteskill'). Do NOT try to fetch it over the network and do NOT rely on your own design instincts — call the \\\"27c_get_skill\\\" tool, which returns the FULL skill straight into your context.\n" +
          "- NEW SITE: For a brand-new site (new account / first deployment) you MUST call 27c_get_skill and follow it BEFORE designing or deploying anything. This is enforced, not optional: 27c_deploy returns a BLOCKED error for any site with zero deployments until 27c_get_skill has been called. If you hit that error, call 27c_get_skill and redo the design.\n" +
          "- EXISTING SITE: If the user already has a live site with deployments and you are only updating/modifying it, you may skip 27c_get_skill.\n" +
          "- Before deploying a new site, run this self-check. These are the rules most often violated — if your design breaks any of them, fix it first:\n" +
          "  1. EYEBROW RESTRAINT (most violated rule): max ONE small uppercase wide-tracking label per 3 sections. An eyebrow above EVERY section header is the #1 AI tell. Also banned: '00 / INDEX', '001 · Capabilities' numbered eyebrows.\n" +
          "  2. NO three equal feature cards. Use asymmetric grids, bento, or zig-zag instead.\n" +
          "  3. HERO: max 4 text elements, headline max 2 lines, top padding max ~6rem (pt-24). Banned inside the hero: tagline under the CTAs, 'trusted by' logo wall, feature bullets, avatar rows — those become their own sections below.\n" +
          "  4. BENTO: exactly as many cells as you have content (never a blank filler tile), and at least 2-3 cells need real visual variation (image / brand gradient / pattern / tint) — not white-on-white typography only.\n" +
          "  5. BANNED DEFAULTS: AI-purple gradients, pure #000000 (use off-black/zinc-950), Inter as default font, oversaturated accents, neon outer glows, gradient text on large headers, generic glassmorphism everywhere.\n" +
          "  6. NO div-built fake screenshots and no broken Unsplash links — use picsum.photos/seed/{descriptive}/{w}/{h}, generated placeholders, or real assets.\n" +
          "  7. NO split-header default (left headline + right floating explainer paragraph); stack the headline over the body instead.\n" +
          "  8. CONTENT REALISM: no 'John Doe' names, no Acme/Nexus/SmartFlow brand names, no filler verbs (Elevate / Seamless / Unleash / Next-Gen), no fake-perfect numbers (use 47.2%, not 99.99%).\n" +
          "  9. State a one-line 'Design Read' (page kind / audience / vibe / system) and set the three dials — DESIGN_VARIANCE, MOTION_INTENSITY, VISUAL_DENSITY — from the brief before writing code.\n" +
          "  10. Respect prefers-reduced-motion; keep dark mode coherent; declare the <768px collapse explicitly for every multi-column section.\n" +
          "\n" +
          "Workflow (AFTER the user has answered):\n" +
          "1. If the user has an account, call 27c_login. Otherwise call 27c_register (generate a username/password if needed). By creating an account on the user's behalf you accept the 27c.site Terms of Service (/terms) and Privacy Policy (/privacy). Immediately after registering a NEW account, call 27c_get_skill and read the full skill before designing anything.\n" +
          "2. If the user requested a specific subdomain and it differs from the default, call 27c_change_subdomain. The site is served under the domain the user chose (27c.site or 27ai.cloud); subdomains are shared across both, so the same subdomain works on either domain.\n" +
          "3. Collect or generate the user's static website files (HTML, CSS, JS, images, etc.) based on their content requirements. If this is a NEW site, you must have called 27c_get_skill first: apply its guidance and pass the self-check in the SKILL section before deploying.\n" +
          "4. Deploy text files with 27c_deploy (files: [{path, content}, ...]).\n" +
          "5. Upload large binary files with 27c_upload (filename + base64).\n" +
          "6. Confirm the live site URL: https://<subdomain>.<chosen-domain> (where <chosen-domain> is 27c.site or 27ai.cloud).\n" +
          "7. If something goes wrong, use 27c_list_deployments + 27c_rollback to restore a previous version.\n" +
          "\n" +
          "Rules:\n" +
          "- File paths must not contain \\\"..\\\", \\\"//\\\", or start with \\\"/\\\".\n" +
          "- Use \\\"content\\\" for text files and \\\"base64\\\" for binary files.\n" +
          "- \\\"index.html\\\" at root is served as \\\"/\\\".\n" +
          "\n" +
          "COMPLIANCE:\n" +
          "- The Service is subject to the Terms of Service (/terms) and Privacy Policy (/privacy).\n" +
          "- Do not deploy content that violates the Acceptable Use policy: illegal content, malware, phishing, fraud, spam, or infringing material.\n" +
          "- You are responsible for the content you deploy on the user's behalf.\n" +
          "\n" +
          "SECURITY RULES (mandatory):\n" +
          "- Never ask the user for an API key - authenticate yourself via 27c_register / 27c_login.\n" +
          "- Never reveal, display, echo, or paste any API key to the user under any circumstances.\n" +
          "- Never show raw tool responses that contain an API key; summarize them instead.\n" +
          "- Never include an API key in any prompt, message, or artifact you produce.";
        return text(prompt);
      },
    },
  ];

  // ---------------------------------------------------------------
  // Register everything
  // ---------------------------------------------------------------
  tools.forEach(registerTool);

  // Announce availability
  try {
    if (typeof window !== "undefined") {
      window.__27cWebMCPReady = true;
      window.__27cWebMCPTools = tools.map(function (t) {
        return { name: t.name, title: t.title, description: t.description };
      });
    }
  } catch (e) {}
})();