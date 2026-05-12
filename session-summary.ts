import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Session Summary — Auto-saves a conversation summary when a session ends.
 *
 * On session shutdown or switch, extracts conversation highlights, tools used,
 * and files modified, then saves to the vault memory path as a session summary.
 *
 * Uses the same memoryPath config as vault-memory (from settings.json vaultMemory).
 */

function expandPath(p: string): string {
  if (p.startsWith("~/")) return `${process.env.HOME}${p.slice(1)}`;
  return p;
}

function getMemoryPath(): string {
  const defaultPath = `${process.env.HOME}/.pi/agent/pi-memory`;
  try {
    const fs = require("fs");
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.vaultMemory?.memoryPath) {
        return expandPath(settings.vaultMemory.memoryPath);
      }
    }
  } catch {}
  return defaultPath;
}

export default function (pi: ExtensionAPI) {
  let summarySaved = false;

  pi.on("session_start", async () => {
    summarySaved = false;
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    await saveSummary(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await saveSummary(ctx);
  });

  async function saveSummary(ctx: ExtensionContext) {
    if (summarySaved) return;
    summarySaved = true;

    try {
      const branch = ctx.sessionManager.getBranch();
      if (!branch || branch.length < 4) return;

      const highlights: string[] = [];
      const toolsUsed = new Set<string>();
      const filesModified = new Set<string>();
      let messageCount = 0;

      for (const entry of branch) {
        if (entry.type !== "message") continue;
        const msg = entry.message;

        if (msg.role === "user") {
          messageCount++;
          const text = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
              : "";
          const cleaned = text.replace(/^\[Signal (?:voice )?message from \+\d+\]:\s*/g, "").trim();
          if (cleaned && cleaned.length > 5 && cleaned.length < 200) {
            highlights.push(`- User: ${cleaned}`);
          } else if (cleaned && cleaned.length >= 200) {
            highlights.push(`- User: ${cleaned.slice(0, 150)}...`);
          }
        }

        if (msg.role === "toolResult") {
          const tn = (msg as any).toolName;
          if (tn) toolsUsed.add(tn);
          const det = (msg as any).details;
          if (det?.path) filesModified.add(det.path);
        }
      }

      if (messageCount < 3) return;

      const memoryPath = getMemoryPath();
      const now = new Date();
      const dateStr = now.toISOString().split("T")[0];
      const timeStr = now.toTimeString().split(" ")[0].slice(0, 5);
      const sessionFile = ctx.sessionManager.getSessionFile() || "unknown";
      const sessionId = require("path").basename(sessionFile).replace(/\.jsonl$/, "");

      const summary = [
        `---`,
        `description: "Session summary ${dateStr} ${timeStr}"`,
        `created: ${dateStr}`,
        `updated: ${dateStr}`,
        `session: ${sessionId}`,
        `tags:`,
        `  - pi-memory`,
        `  - session-summary`,
        `---`,
        ``,
        `# Session Summary — ${dateStr} ${timeStr}`,
        ``,
        `## Conversation Highlights`,
        highlights.slice(0, 30).join("\n"),
        ``,
        toolsUsed.size > 0 ? `## Tools Used\n${[...toolsUsed].join(", ")}` : "",
        filesModified.size > 0 ? `\n## Files Modified\n${[...filesModified].slice(0, 20).map(f => `- ${f}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");

      const slug = `session-${dateStr}-${timeStr.replace(":", "")}`;
      const filePath = `${memoryPath}/${slug}.md`;

      const fs = require("fs");
      const path = require("path");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, summary + "\n", "utf-8");
      }
    } catch (err: any) {
      console.error("[session-summary] Error:", err.message);
    }
  }
}
