/**
 * add-agent-md — Pi Extension
 *
 * Installs an AGENTS.md template into the current project.
 *
 * Usage:
 *   /add-agent-md            — list available templates
 *   /add-agent-md code       — copy agent-md-templates/code.md → ./AGENTS.md
 *
 * Templates live in ~/.pi/agent/agent-md/. Add more by dropping <name>.md there.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const TEMPLATES_DIR = join(homedir(), ".pi", "agent", "agent-md");

function listTemplates(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .sort();
}

function reply(ctx: any, text: string, kind: "info" | "error" = "info") {
  if (ctx.mode !== "tui") return void console.log(text);
  ctx.ui.notify(text, kind);
}

async function handleAddAgentMd(args: string, ctx: any) {
  const templates = listTemplates();

  if (templates.length === 0) {
    return reply(ctx, "No templates found in agent-md-templates/", "error");
  }

  let name = (args || "").trim().toLowerCase();

  // No arg → interactive picker (TUI) or usage hint (headless)
  if (!name) {
    if (ctx.mode !== "tui") {
      return reply(ctx, "Usage: /add-agent-md <name> — available: " + templates.join(", "));
    }
    name = await ctx.ui.select("Pick an AGENTS.md template:", templates);
    if (!name) return;
  }

  const src = join(TEMPLATES_DIR, `${name}.md`);
  if (!existsSync(src)) {
    return reply(ctx, `No template "${name}". Available: ${templates.join(", ")}`, "error");
  }

  const dest = join(ctx.cwd, "AGENTS.md");
  if (existsSync(dest)) {
    if (ctx.mode === "tui") {
      const ok = await ctx.ui.confirm("AGENTS.md already exists", `Overwrite ${dest}?`, { timeout: 30000 });
      if (!ok) return;
    } else {
      return reply(ctx, `AGENTS.md already exists — ${dest}`, "error");
    }
  }

  writeFileSync(dest, readFileSync(src));
  reply(ctx, `Wrote ${dest} (template "${name}")`);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("add-agent-md", {
    description: "Install an AGENTS.md template into the current project (arg: template name | none to pick)",
    getArgumentCompletions: (prefix: string) => {
      const items = listTemplates()
        .filter((t) => t.startsWith(prefix))
        .map((t) => ({ value: t, label: t }));
      return items.length > 0 ? items : null;
    },
    handler: handleAddAgentMd,
  });
}