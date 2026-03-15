#!/usr/bin/env node
// omc-mcp-hub v2.0 — MCP Skill Multiplexer + Toolbox Runtime
// Part of oh-my-claudecode: lazy-load MCP tools via skills, single-file script tools
// Inspired by Amp skills + mcp.json (Nicolay Gerold, "Tool Search is Dead")
//
// Architecture:
//   - Skills: JSON configs that bundle MCP server definitions + includeTools filters
//   - Toolbox: executable scripts (bash/python/node) auto-discovered as tools
//   - Hub exposes 5 management tools + proxies loaded skill/toolbox tools
//   - Supports stdio + streamable-http child MCP transports
//   - tools/list_changed notification for dynamic tool injection

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "hub-skills");
const TOOLBOX_DIR = join(__dirname, "hub-toolbox");
const STATS_FILE = join(__dirname, "..", ".omc", "hub-stats.json");

// ── State ──────────────────────────────────────────────
const loaded = new Map();        // skillName -> { clients[], tools: Map }
const registry = new Map();      // toolName -> skillName
const toolboxTools = new Map();  // toolName -> { name, description, inputSchema, scriptPath }
let skillConfigs = {};           // all available skill configs
let stats = {};
let statsDirty = false;

// ── Stats ──────────────────────────────────────────────
async function loadStats() {
  try { stats = JSON.parse(await readFile(STATS_FILE, "utf8")); } catch { stats = {}; }
}

async function flushStats() {
  if (!statsDirty) return;
  try { await writeFile(STATS_FILE, JSON.stringify(stats, null, 2)); statsDirty = false; } catch {}
}

function recordCall(toolName, durationMs, isError) {
  if (!stats[toolName]) stats[toolName] = { calls: 0, errors: 0, totalMs: 0, lastUsed: null };
  stats[toolName].calls++;
  if (isError) stats[toolName].errors++;
  stats[toolName].totalMs += durationMs;
  stats[toolName].lastUsed = new Date().toISOString();
  statsDirty = true;
}

setInterval(flushStats, 30000).unref();

// ── includeTools glob matching ─────────────────────────
function matchesInclude(toolName, patterns) {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => {
    if (p.includes("*")) {
      const regex = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return regex.test(toolName);
    }
    return p === toolName;
  });
}

// ── Config Loader (supports folder skills) ─────────────
async function loadSkillConfigs() {
  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const name = entry.name.replace(".json", "");
        skillConfigs[name] = JSON.parse(await readFile(join(SKILLS_DIR, entry.name), "utf8"));
      } else if (entry.isDirectory()) {
        try {
          const skillJson = join(SKILLS_DIR, entry.name, "skill.json");
          skillConfigs[entry.name] = JSON.parse(await readFile(skillJson, "utf8"));
          skillConfigs[entry.name]._dir = join(SKILLS_DIR, entry.name);
        } catch {}
      }
    }
  } catch {}
}

// ── Child MCP Connect (stdio + HTTP) ───────────────────
async function connectChild(mcpConfig) {
  let transport;
  if (mcpConfig.type === "streamable-http" || mcpConfig.type === "sse") {
    transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
      requestInit: { headers: mcpConfig.headers || {} },
    });
  } else {
    transport = new StdioClientTransport({
      command: mcpConfig.command,
      args: mcpConfig.args || [],
      env: { ...process.env, ...(mcpConfig.env || {}) },
    });
  }
  const client = new Client(
    { name: "omc-hub", version: "2.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return { client, transport };
}

// ── Skill Lifecycle ────────────────────────────────────
async function loadSkill(skillName) {
  if (loaded.has(skillName)) {
    const s = loaded.get(skillName);
    return { already: true, tools: [...s.tools.keys()] };
  }
  const config = skillConfigs[skillName];
  if (!config) {
    throw new Error(`Unknown skill: ${skillName}. Available: ${Object.keys(skillConfigs).join(", ")}`);
  }

  const skillTools = new Map();
  const clients = [];

  for (const [serverName, mcpConfig] of Object.entries(config.mcpServers || {})) {
    const { client, transport } = await connectChild(mcpConfig);
    clients.push({ client, transport, serverName });

    const { tools } = await client.listTools();
    const include = mcpConfig.includeTools;

    for (const tool of tools) {
      if (!matchesInclude(tool.name, include)) continue;
      const nsName = `skill__${skillName}__${tool.name}`;
      skillTools.set(nsName, {
        originalName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        client,
        serverName,
      });
      registry.set(nsName, skillName);
    }
  }

  // Load skill-embedded toolbox scripts
  const skillDir = config._dir;
  if (skillDir) {
    try {
      const tbDir = join(skillDir, "toolbox");
      const tbFiles = await readdir(tbDir);
      for (const f of tbFiles) {
        const scriptPath = join(tbDir, f);
        const { stdout, code } = await runScript(scriptPath, { TOOLBOX_ACTION: "describe" });
        if (code !== 0 || !stdout) continue;
        const desc = parseDescribe(stdout);
        if (!desc) continue;
        const nsName = `skill__${skillName}__${desc.name}`;
        skillTools.set(nsName, {
          originalName: desc.name,
          description: desc.description,
          inputSchema: desc.inputSchema,
          scriptPath,
        });
        registry.set(nsName, skillName);
      }
    } catch {}
  }

  loaded.set(skillName, { tools: skillTools, clients, config });
  return { loaded: true, toolCount: skillTools.size, tools: [...skillTools.keys()] };
}

async function unloadSkill(skillName) {
  const skill = loaded.get(skillName);
  if (!skill) return { error: `${skillName} not loaded` };

  for (const { client } of skill.clients) {
    try { await client.close(); } catch {}
  }
  for (const toolName of skill.tools.keys()) {
    registry.delete(toolName);
  }
  loaded.delete(skillName);
  return { unloaded: true };
}

// ── Toolbox: single-file script tools ─────────────────
function runScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const ext = scriptPath.split(".").pop();
    let cmd, args;
    if (ext === "py") { cmd = "python"; args = [scriptPath]; }
    else if (ext === "mjs" || ext === "js") { cmd = "node"; args = [scriptPath]; }
    else { cmd = "bash"; args = [scriptPath]; }

    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
    child.on("error", reject);
    child.stdin.end();
  });
}

function parseDescribe(stdout) {
  try {
    const j = JSON.parse(stdout);
    if (j.name) return j;
  } catch {}

  const lines = stdout.split("\n").filter(Boolean);
  const kv = {};
  const params = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === "name" || key === "description") { kv[key] = val; }
    else {
      const pm = val.match(/^(\w+)\s+(.+)$/);
      if (pm) params[key] = { type: pm[1], description: pm[2] };
      else params[key] = { type: "string", description: val };
    }
  }
  if (!kv.name) return null;

  const properties = {};
  for (const [k, v] of Object.entries(params)) {
    properties[k] = { type: v.type, description: v.description };
  }
  return {
    name: kv.name,
    description: kv.description || kv.name,
    inputSchema: { type: "object", properties },
  };
}

async function scanToolbox() {
  try {
    const files = await readdir(TOOLBOX_DIR);
    const results = await Promise.allSettled(
      files.map(async (f) => {
        const scriptPath = join(TOOLBOX_DIR, f);
        const { stdout, code } = await runScript(scriptPath, { TOOLBOX_ACTION: "describe" });
        if (code !== 0 || !stdout) return null;
        const desc = parseDescribe(stdout);
        if (!desc) return null;
        const nsName = `toolbox__${desc.name}`;
        toolboxTools.set(nsName, { ...desc, scriptPath });
        return nsName;
      })
    );
    const registered = results.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
    if (registered.length > 0) {
      process.stderr.write(`[omc-hub] toolbox: ${registered.length} tools registered\n`);
    }
  } catch {}
}

async function executeToolbox(scriptPath, args) {
  const { stdout, stderr, code } = await runScript(scriptPath, {
    TOOLBOX_ACTION: "execute",
    TOOLBOX_ARGS: JSON.stringify(args || {}),
  });
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return { content: [{ type: "text", text: output || "(no output)" }], isError: code !== 0 };
}

// ── Notify tools changed ──────────────────────────────
async function notifyChanged() {
  try {
    await server.notification({ method: "notifications/tools/list_changed" });
  } catch {}
}

function skillSummary() {
  return Object.entries(skillConfigs)
    .map(([name, c]) => `${name}: ${c.description || "no description"}`)
    .join("; ");
}

// ── Hub Server ─────────────────────────────────────────
const server = new Server(
  { name: "omc-mcp-hub", version: "2.0.0" },
  { capabilities: { tools: { listChanged: true } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "hub_load_skill",
      description: `Load a skill's MCP tools on-demand. Skills: ${skillSummary()}`,
      inputSchema: {
        type: "object",
        properties: { skill: { type: "string", description: "Skill name to load" } },
        required: ["skill"],
      },
    },
    {
      name: "hub_unload_skill",
      description: "Unload a skill's MCP tools to free resources",
      inputSchema: {
        type: "object",
        properties: { skill: { type: "string", description: "Skill name to unload" } },
        required: ["skill"],
      },
    },
    {
      name: "hub_list_skills",
      description: "List all available skills and their load status",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "hub_reload_toolbox",
      description: "Rescan toolbox directory for new/changed scripts",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "hub_stats",
      description: "Show tool call statistics (calls, errors, avg latency)",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  for (const [, skill] of loaded) {
    for (const [nsName, info] of skill.tools) {
      tools.push({ name: nsName, description: info.description, inputSchema: info.inputSchema });
    }
  }

  for (const [nsName, info] of toolboxTools) {
    tools.push({ name: nsName, description: `[toolbox] ${info.description}`, inputSchema: info.inputSchema });
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const t0 = Date.now();

  // ── Management tools ──
  if (name === "hub_load_skill") {
    try {
      const result = await loadSkill(args.skill);
      await notifyChanged();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  }

  if (name === "hub_unload_skill") {
    const result = await unloadSkill(args.skill);
    await notifyChanged();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "hub_list_skills") {
    const result = {
      available: Object.entries(skillConfigs).map(([n, c]) => ({
        name: n,
        description: c.description,
        loaded: loaded.has(n),
        servers: Object.keys(c.mcpServers || {}),
        hasToolbox: !!c._dir,
      })),
      totalLoaded: loaded.size,
      totalProxiedTools: registry.size,
      totalToolboxTools: toolboxTools.size,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (name === "hub_reload_toolbox") {
    toolboxTools.clear();
    await scanToolbox();
    await notifyChanged();
    return { content: [{ type: "text", text: JSON.stringify({ reloaded: true, tools: [...toolboxTools.keys()] }) }] };
  }

  if (name === "hub_stats") {
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) || "{}" }] };
  }

  // ── Toolbox dispatch ──
  if (toolboxTools.has(name)) {
    const tool = toolboxTools.get(name);
    const result = await executeToolbox(tool.scriptPath, args);
    recordCall(name, Date.now() - t0, result.isError);
    return result;
  }

  // ── Proxy to child MCP / skill-embedded toolbox ──
  const skillName = registry.get(name);
  if (!skillName) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  const skill = loaded.get(skillName);
  const toolInfo = skill.tools.get(name);

  try {
    let result;
    if (toolInfo.scriptPath) {
      result = await executeToolbox(toolInfo.scriptPath, args);
    } else {
      result = await toolInfo.client.callTool({
        name: toolInfo.originalName,
        arguments: args || {},
      });
    }
    recordCall(name, Date.now() - t0, false);
    return result;
  } catch (e) {
    recordCall(name, Date.now() - t0, true);
    return {
      content: [{ type: "text", text: `Skill ${skillName} error: ${e.message}` }],
      isError: true,
    };
  }
});

// ── Graceful shutdown ──────────────────────────────────
async function shutdown() {
  await flushStats();
  for (const [name] of loaded) await unloadSkill(name);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Start ──────────────────────────────────────────────
await loadStats();
await loadSkillConfigs();
await scanToolbox();
const transport = new StdioServerTransport();
await server.connect(transport);
