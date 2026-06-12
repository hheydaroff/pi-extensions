import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Auto-Skill — Detects complex tasks and PROPOSES (never auto-creates) a skill.
 *
 * After a complex multi-step task (5+ tool calls, 2+ file writes), sends a
 * steer message prompting the LLM to propose a reusable pi skill: a one-paragraph
 * explanation of how it would help, plus an offer to create it. The skill is only
 * written to ~/.pi/agent/skills/<name>/SKILL.md after the user explicitly accepts.
 *
 * Skills are auto-discovered by pi on /reload and shown in the system prompt.
 */

export default function (pi: ExtensionAPI) {
  let toolCalls: { name: string; wasWrite: boolean }[] = [];

  pi.on("agent_start", async () => {
    toolCalls = [];
  });

  pi.on("tool_result", async (event) => {
    const isWrite = ["write", "edit"].includes(event.toolName);
    toolCalls.push({ name: event.toolName, wasWrite: isWrite });
  });

  pi.on("agent_end", async () => {
    // Skip if auto-skill nudge already fired this turn (avoid re-nudge)
    if (toolCalls.some(t => t.name === "cron_schedule")) return;

    // Detect complex work: 5+ tool calls with at least 2 file writes/edits
    const writeCount = toolCalls.filter(t => t.wasWrite).length;
    if (toolCalls.length < 5 || writeCount < 2) return;

    pi.sendMessage({
      customType: "auto-skill-nudge",
      content: [
        "You just completed a complex multi-step task. Consider whether it is worth saving as a reusable pi skill.",
        "",
        "DO NOT create any skill files yet. Only propose. Specifically:",
        "- If, and only if, this work is genuinely reusable and non-trivial, write ONE short paragraph (2-4 sentences) to the user explaining what the skill would capture and how it would help them in future sessions.",
        "- Then ask: 'Want me to save this as a skill?' and wait for their confirmation.",
        "- If the task was trivial or one-off, say nothing about skills and do not propose anything.",
        "",
        "ONLY after the user explicitly accepts, create the skill:",
        "1. Choose a kebab-case name (e.g. 'setup-signal-bridge').",
        "2. Create ~/.pi/agent/skills/<name>/SKILL.md with this format:",
        "",
        "---",
        "name: <kebab-case-name>",
        "description: <what this skill does and when to use it, max 1024 chars>",
        "---",
        "",
        "# <Skill Title>",
        "",
        "## When to Use",
        "<describe the scenario>",
        "",
        "## Steps",
        "<the approach, commands, gotchas, lessons learned>",
        "",
        "3. Include any helper scripts in the skill directory if needed.",
        "4. After creating the skill, run /reload so pi discovers it immediately.",
        "",
        "Never write skill files on your own initiative — proposing requires user confirmation before any file is created.",
      ].join("\n"),
      display: false,
    }, { deliverAs: "steer" });
  });
}
