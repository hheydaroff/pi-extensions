import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { agentLoop, type AgentContext, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { spawn, ChildProcess } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync, readFileSync } from "node:fs";

// --- Config ---

interface PocketTTSConfig {
  model: { provider: string; id: string };
  voice?: string;
  language?: string;
  maxChars?: number;
}

const SETTINGS_KEY = "pocket-tts";

const DEFAULTS: PocketTTSConfig = {
  model: { provider: "amazon-bedrock", id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" },
  voice: "alba",
  language: "english",
  maxChars: 200,
};

function loadConfig(): PocketTTSConfig {
  const settingsPath = join(getAgentDir(), "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const nested = raw[SETTINGS_KEY] as Partial<PocketTTSConfig> | undefined;
      if (nested && typeof nested === "object") {
        return { ...DEFAULTS, ...nested };
      }
    }
  } catch {}
  return { ...DEFAULTS };
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let alwaysOn = false;
  let voiceEnabled = false;
  let currentPlayback: ChildProcess | null = null;
  let pendingGeneration: ChildProcess | null = null;
  let config = loadConfig();

  const TTS_OUTPUT = join(tmpdir(), `pi-tts-output-${process.pid}.wav`);

  // Restore state from session entries
  pi.on("session_start", async (_event, ctx) => {
    alwaysOn = false;
    voiceEnabled = false;
    config = loadConfig();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "pocket-tts-state") {
        alwaysOn = entry.data?.alwaysOn ?? false;
        voiceEnabled = entry.data?.voiceEnabled ?? false;
      }
    }
    updateStatus(ctx);
  });

  function saveState() {
    pi.appendEntry("pocket-tts-state", { alwaysOn, voiceEnabled });
  }

  function updateStatus(ctx: ExtensionContext) {
    if (voiceEnabled) {
      ctx.ui.setStatus("pocket-tts", alwaysOn ? "🔊 always" : "🔊 once");
    } else {
      ctx.ui.setStatus("pocket-tts", "");
    }
  }

  function stopPlayback() {
    if (currentPlayback) {
      currentPlayback.kill("SIGTERM");
      currentPlayback = null;
    }
    if (pendingGeneration) {
      pendingGeneration.kill("SIGTERM");
      pendingGeneration = null;
    }
  }

  // --- Summarize using LLM ---

  async function summarize(text: string, ctx: ExtensionContext): Promise<string> {
    const model = ctx.modelRegistry.find(config.model.provider, config.model.id);
    if (!model) {
      // Fallback: just truncate
      return text.slice(0, config.maxChars || 200);
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return text.slice(0, config.maxChars || 200);
    }

    const maxChars = config.maxChars || 200;

    const prompts: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Summarize the following assistant response into a brief, natural spoken summary (max ${maxChars} characters). 
Write it as if you're telling someone what was done — conversational, no markdown, no bullet points, no code. 
Just a plain spoken sentence or two.

Response to summarize:
${text}`,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    const context: AgentContext = {
      systemPrompt: "You are a concise summarizer. Output only the spoken summary, nothing else.",
      messages: [],
      tools: [],
    };

    const loopConfig: AgentLoopConfig = {
      model: model as any,
      apiKey: auth.apiKey as string,
      headers: (auth as any).headers,
      maxTokens: 256,
      convertToLlm: (msgs) => msgs as Message[],
      toolExecution: "sequential",
    };

    try {
      const stream = agentLoop(prompts, context, loopConfig);
      let summary = "";
      for await (const event of stream) {
        if (event.type === "message_end" && (event as any).message?.role === "assistant") {
          const content = (event as any).message.content;
          if (Array.isArray(content)) {
            summary = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
          } else if (typeof content === "string") {
            summary = content;
          }
        }
      }
      return summary.trim() || text.slice(0, maxChars);
    } catch {
      return text.slice(0, config.maxChars || 200);
    }
  }

  // --- TTS ---

  function speak(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!text.trim()) {
        resolve();
        return;
      }

      const args = [
        "pocket-tts", "generate",
        "--text", text,
        "--output-path", TTS_OUTPUT,
        "--quiet",
      ];

      if (config.voice) {
        args.push("--voice", config.voice);
      }
      if (config.language) {
        args.push("--language", config.language);
      }

      const gen = spawn("uvx", args, {
        stdio: "ignore",
        env: { ...process.env },
      });

      pendingGeneration = gen;

      gen.on("error", (err) => {
        pendingGeneration = null;
        reject(err);
      });

      gen.on("exit", (code) => {
        pendingGeneration = null;
        if (code !== 0) {
          reject(new Error(`pocket-tts exited with code ${code}`));
          return;
        }

        if (!existsSync(TTS_OUTPUT)) {
          reject(new Error("TTS output file not found"));
          return;
        }

        // macOS: afplay, Linux: paplay/aplay, fallback: ffplay
        const playCmd = platform() === "darwin" ? "afplay"
          : existsSync("/usr/bin/paplay") ? "paplay"
          : existsSync("/usr/bin/aplay") ? "aplay"
          : "ffplay";
        const playArgs = playCmd === "ffplay"
          ? ["-nodisp", "-autoexit", TTS_OUTPUT]
          : [TTS_OUTPUT];

        const play = spawn(playCmd, playArgs, { stdio: "ignore" });
        currentPlayback = play;

        play.on("exit", () => {
          currentPlayback = null;
          try { unlinkSync(TTS_OUTPUT); } catch {}
          resolve();
        });

        play.on("error", (err) => {
          currentPlayback = null;
          reject(err);
        });
      });
    });
  }

  // --- Command ---

  pi.registerCommand("voice", {
    description: "TTS voice output. /voice, /voice always, /voice off, /voice stop",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();

      if (arg === "stop") {
        stopPlayback();
        ctx.ui.notify("🔇 Stopped", "info");
        return;
      }

      if (arg === "off") {
        alwaysOn = false;
        voiceEnabled = false;
        stopPlayback();
        saveState();
        updateStatus(ctx);
        ctx.ui.notify("🔇 Voice off", "info");
        return;
      }

      if (arg === "always") {
        alwaysOn = true;
        voiceEnabled = true;
        saveState();
        updateStatus(ctx);
        ctx.ui.notify("🔊 Voice always on", "success");
        return;
      }

      // Toggle
      if (!voiceEnabled) {
        voiceEnabled = true;
        saveState();
        updateStatus(ctx);
        ctx.ui.notify("🔊 Voice on (next response)", "success");
      } else {
        voiceEnabled = false;
        alwaysOn = false;
        saveState();
        updateStatus(ctx);
        ctx.ui.notify("🔇 Voice off", "info");
      }
    },
  });

  // --- Hook: speak after agent response ---

  pi.on("agent_end", async (event, ctx) => {
    if (!voiceEnabled) return;

    // Find the last assistant message
    const messages = event.messages || [];
    const lastAssistant = [...messages].reverse().find(
      (m: any) => m.role === "assistant"
    );

    if (!lastAssistant) return;

    // Extract text content
    const content = (lastAssistant as any).content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
    }

    if (!text.trim()) return;

    // If not always-on, disable after this response
    if (!alwaysOn) {
      voiceEnabled = false;
      saveState();
      updateStatus(ctx);
    }

    // Summarize then speak (in background)
    (async () => {
      try {
        const summary = await summarize(text, ctx);
        await speak(summary);
      } catch {
        // Silent fail
      }
    })();
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    stopPlayback();
  });
}
