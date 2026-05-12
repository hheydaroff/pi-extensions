import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Auto-Skill — Detects complex tasks and nudges the LLM to save reusable pi skills.
 *
 * After a complex multi-step task (5+ tool calls, 2+ file writes), sends a
 * steer message prompting the LLM to consider saving a proper pi skill
 * in ~/.pi/agent/skills/<name>/SKILL.md.
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
        "You just completed a complex multi-step task. Consider if this is worth saving as a reusable pi skill.",
        "",
        "If yes, create a proper pi skill directory:",
        "1. Choose a kebab-case name (e.g. 'setup-signal-bridge')",
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
        "Also consider saving key facts to vault_memory if anything is worth remembering.",
        "",
        "Only save if genuinely reusable. Skip if trivial or one-off.",
      ].join("\n"),
      display: false,
    }, { deliverAs: "steer" });
  });
}
