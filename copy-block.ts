/**
 * copy-block — Pi Extension
 *
 * Provides /copy-block command that extracts code blocks from the last
 * assistant message and copies clean text (no TUI padding) to clipboard.
 *
 * Usage:
 *   /copy-block        — pick from all code blocks in last assistant message
 *   /copy-block 2      — copy the 2nd code block directly
 *
 * Load with: pi --extension ./copy-block.ts
 * Or copy to: ~/.pi/agent/extensions/copy-block.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function extractCodeBlocks(text: string): { lang: string; code: string }[] {
  const blocks: { lang: string; code: string }[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      lang: match[1] || "text",
      code: match[2].replace(/\n$/, ""), // trim trailing newline
    });
  }
  return blocks;
}

function getLastAssistantText(ctx: any): string | null {
  const branch = ctx.sessionManager.getBranch();
  // Walk backwards to find last assistant message
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "message" && entry.message.role === "assistant") {
      const textParts = entry.message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }
  return null;
}

async function copyToClipboard(text: string, pi: ExtensionAPI): Promise<boolean> {
  // Write to temp file, then pipe to clipboard command
  // This avoids shell escaping issues with complex code
  const tmpFile = `/tmp/pi-copy-block-${Date.now()}.txt`;
  const escaped = tmpFile.replace(/'/g, "'\\''");

  // Write file using printf to avoid echo interpretation issues
  // We base64-encode to avoid any shell escaping problems
  const b64 = Buffer.from(text).toString("base64");
  const writeResult = await pi.exec("bash", ["-c", `echo '${b64}' | base64 -d > '${escaped}'`], { timeout: 3000 });
  if (writeResult.code !== 0) return false;

  // Try clipboard commands: pbcopy (macOS), xclip (Linux), xsel (Linux)
  for (const cmd of [
    `cat '${escaped}' | pbcopy`,
    `cat '${escaped}' | xclip -selection clipboard`,
    `cat '${escaped}' | xsel --clipboard --input`,
  ]) {
    try {
      const result = await pi.exec("bash", ["-c", cmd], { timeout: 3000 });
      if (result.code === 0) {
        // Clean up
        await pi.exec("rm", ["-f", tmpFile], { timeout: 1000 });
        return true;
      }
    } catch {
      // try next
    }
  }
  // Clean up on failure
  await pi.exec("rm", ["-f", tmpFile], { timeout: 1000 });
  return false;
}

async function handleCopyBlock(args: string, ctx: any, pi: ExtensionAPI) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/cb requires interactive mode", "error");
        return;
      }

      const text = getLastAssistantText(ctx);
      if (!text) {
        ctx.ui.notify("No assistant message found", "warning");
        return;
      }

      const blocks = extractCodeBlocks(text);
      if (blocks.length === 0) {
        ctx.ui.notify("No code blocks found in last assistant message", "warning");
        return;
      }

      let selectedBlock: { lang: string; code: string };

      // If a number argument was given, use it directly
      const argNum = parseInt(args.trim(), 10);
      if (!isNaN(argNum) && argNum >= 1 && argNum <= blocks.length) {
        selectedBlock = blocks[argNum - 1];
      } else if (blocks.length === 1) {
        selectedBlock = blocks[0];
      } else {
        const options = blocks.map((b, i) => {
          const preview = b.code.split("\n")[0].substring(0, 60);
          const lines = b.code.split("\n").length;
          return `${i + 1}. [${b.lang}] ${preview}${b.code.split("\n")[0].length > 60 ? "..." : ""} (${lines} lines)`;
        });

        const choice = await ctx.ui.select("Pick a code block to copy:", options);
        if (!choice) return;

        const choiceIndex = options.indexOf(choice);
        selectedBlock = blocks[choiceIndex];
      }

      const copied = await copyToClipboard(selectedBlock.code, pi);
      if (copied) {
        const lines = selectedBlock.code.split("\n").length;
        ctx.ui.notify(`✓ Copied ${lines}-line ${selectedBlock.lang} block to clipboard`, "info");
      } else {
        ctx.ui.notify("Failed to copy — no clipboard command available (pbcopy/xclip/xsel)", "error");
      }
}

export default function CopyBlockExtension(pi: ExtensionAPI) {
  pi.registerCommand("cb", {
    description: "Copy a code block from the last assistant message to clipboard (clean, no padding)",
    handler: async (args, ctx) => {
      await handleCopyBlock(args, ctx, pi);
    },
  });

  pi.registerShortcut("ctrl+shift+c", {
    description: "Copy code block from last assistant message",
    handler: async (ctx) => {
      await handleCopyBlock("", ctx, pi);
    },
  });
}

