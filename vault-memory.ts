import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Vault Memory — persistent memory for the agent.
 * All memories stored in ~/.pi/agent/pi-memory/*.md
 */

function getMemoryPath(): string {
  const defaultPath = `${process.env.HOME}/.pi/agent/pi-memory`;
  try {
    const fs = require("fs");
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    if (fs.existsSync(settingsPath)) {
      const p = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))?.vaultMemory?.memoryPath;
      if (p) return p.startsWith("~/") ? `${process.env.HOME}${p.slice(1)}` : p;
    }
  } catch {}
  return defaultPath;
}

const MEMORY_PATH = getMemoryPath();

// ─── Helpers ────────────────────────────────────────────────────────────────

function readFileSync(path: string): string | null {
  try {
    return require("fs").readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writeFileSync(path: string, content: string) {
  const fs = require("fs");
  const dir = require("path").dirname(path);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path, content, "utf-8");
}

function listMemoryFiles(): { name: string; description: string; path: string }[] {
  const fs = require("fs");
  const path = require("path");
  if (!fs.existsSync(MEMORY_PATH)) return [];

  const files = fs.readdirSync(MEMORY_PATH).filter((f: string) => f.endsWith(".md")).sort();
  return files.map((f: string) => {
    const fullPath = path.join(MEMORY_PATH, f);
    const content = readFileSync(fullPath) || "";
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let description = "";
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*(.+)/);
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    if (!description) {
      const lines = content.replace(/^---[\s\S]*?---\n?/, "").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          description = trimmed.slice(0, 120);
          break;
        }
      }
    }
    return { name: f.replace(/\.md$/, ""), description, path: fullPath };
  });
}

function buildMemoryIndex(): string {
  const files = listMemoryFiles();
  if (files.length === 0) return "(no memories stored yet)";
  return files.map(f => `- **${f.name}**: ${f.description || "(no description)"}`).join("\n");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── Inject memory index into system prompt ──────────────────────────────

  pi.on("before_agent_start", async (event) => {
    const memoryIndex = buildMemoryIndex();

    const injection = `
## Vault Memory

### Agent Memories (pi-memory/)
The following memory files are available. Use the vault_memory tool with action "read" to load relevant ones when needed.
${memoryIndex}

### Memory Guidelines
- When you learn something worth remembering (user preferences, project patterns, environment details, solutions to problems), use the vault_memory tool with action "write" to store it.
- Keep memories atomic — one topic per file.
- If a relevant memory file already exists, use action "update" to append to it rather than creating duplicates.
- Memory files are markdown in the user's Obsidian vault. Keep them clean and human-readable.
`;

    return { systemPrompt: event.systemPrompt + injection };
  });

  // ── Memory tool ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "vault_memory",
    label: "Vault Memory",
    description: "Read, write, update, or list persistent memories. Use this to remember facts, preferences, patterns, and learnings across sessions.",
    promptSnippet: "Read, write, update, or list persistent memories",
    promptGuidelines: [
      "When you discover user preferences, project patterns, environment details, or solutions worth remembering, store them with vault_memory write.",
      "Before starting a task, check if relevant memories exist with vault_memory list or vault_memory read.",
      "Keep memories atomic — one topic per file. Use descriptive filenames like 'homelab-setup' or 'coding-preferences'.",
      "When the user says 'remember this' or similar, use vault_memory write immediately.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("read"),
        Type.Literal("write"),
        Type.Literal("update"),
      ], { description: "list: show all memory files. read: load a specific memory. write: create new memory. update: append to existing memory." }),
      name: Type.Optional(Type.String({ description: "Memory file name (without .md). Required for read/write/update. Use descriptive kebab-case names like 'homelab-setup'." })),
      content: Type.Optional(Type.String({ description: "Content to write or append. Required for write/update. Use markdown format." })),
      description: Type.Optional(Type.String({ description: "Short description for frontmatter (required for write, used in memory index)." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { action, name, content, description } = params;

      switch (action) {
        case "list": {
          const files = listMemoryFiles();
          if (files.length === 0) {
            return { content: [{ type: "text", text: "No memories stored yet. Use action 'write' to create one." }], details: { count: 0 } };
          }
          const listing = files.map(f => `- **${f.name}**: ${f.description || "(no description)"}`).join("\n");
          return {
            content: [{ type: "text", text: `## Memory Files (${files.length})\n\n${listing}` }],
            details: { count: files.length, files: files.map(f => f.name) },
          };
        }

        case "read": {
          if (!name) return { content: [{ type: "text", text: "Error: 'name' is required for read." }], details: {}, isError: true };
          const slug = slugify(name);
          if (!slug) return { content: [{ type: "text", text: "Error: name produced an empty slug. Use alphanumeric characters." }], details: {}, isError: true };
          const filePath = `${MEMORY_PATH}/${slug}.md`;
          const fileContent = readFileSync(filePath);
          if (!fileContent) {
            return { content: [{ type: "text", text: `Memory '${slug}' not found. Use action 'list' to see available memories.` }], details: {} };
          }
          return { content: [{ type: "text", text: fileContent }], details: { name: slug, path: filePath } };
        }

        case "write": {
          if (!name || !content) return { content: [{ type: "text", text: "Error: 'name' and 'content' are required for write." }], details: {}, isError: true };
          const slug = slugify(name);
          if (!slug) return { content: [{ type: "text", text: "Error: name produced an empty slug. Use alphanumeric characters." }], details: {}, isError: true };
          const filePath = `${MEMORY_PATH}/${slug}.md`;
          const fs = require("fs");
          if (fs.existsSync(filePath)) {
            return { content: [{ type: "text", text: `Memory '${slug}' already exists. Use action 'update' to append, or choose a different name.` }], details: {}, isError: true };
          }
          const now = new Date().toISOString().split("T")[0];
          const frontmatter = [
            "---",
            `description: "${(description || "").replace(/"/g, '\\"')}"`,
            `created: ${now}`,
            `updated: ${now}`,
            "tags:",
            "  - pi-memory",
            "---",
          ].join("\n");
          writeFileSync(filePath, `${frontmatter}\n\n${content}\n`);
          return { content: [{ type: "text", text: `✅ Memory '${slug}' created.` }], details: { name: slug, path: filePath, action: "created" } };
        }

        case "update": {
          if (!name || !content) return { content: [{ type: "text", text: "Error: 'name' and 'content' are required for update." }], details: {}, isError: true };
          const slug = slugify(name);
          if (!slug) return { content: [{ type: "text", text: "Error: name produced an empty slug. Use alphanumeric characters." }], details: {}, isError: true };
          const filePath = `${MEMORY_PATH}/${slug}.md`;
          const existing = readFileSync(filePath);
          if (!existing) {
            return { content: [{ type: "text", text: `Memory '${slug}' not found. Use action 'write' to create it first.` }], details: {}, isError: true };
          }
          const now = new Date().toISOString().split("T")[0];
          let updated = existing.replace(/updated:\s*\S+/, `updated: ${now}`);
          updated = updated.trimEnd() + `\n\n${content}\n`;
          writeFileSync(filePath, updated);
          return { content: [{ type: "text", text: `✅ Memory '${slug}' updated.` }], details: { name: slug, path: filePath, action: "updated" } };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {}, isError: true };
      }
    },
  });

  // ── Command ─────────────────────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "List or manage vault memories",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().toLowerCase();
      if (sub === "list" || !sub) {
        const files = listMemoryFiles();
        if (files.length === 0) {
          ctx.ui.notify("No memories stored yet.", "info");
        } else {
          const listing = files.map(f => `${f.name}: ${f.description || "(no description)"}`).join("\n");
          ctx.ui.notify(`Memory files (${files.length}):\n${listing}`, "info");
        }
      } else if (sub === "index") {
        ctx.ui.notify(buildMemoryIndex(), "info");
      } else {
        ctx.ui.notify("/memory — list all memories\n/memory list — same\n/memory index — show index", "info");
      }
    },
  });
}
