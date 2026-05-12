import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SignalConfig {
  account: string;           // Your Signal phone number (E.164, e.g. "+15551234567")
  allowedContacts: string[]; // Phone numbers allowed to talk to pi
}

interface BridgeState {
  connected: boolean;
  config: SignalConfig | null;
}

interface PendingMessage {
  sender: string;
  text: string;
  images?: { data: string; mimeType: string }[];
  voiceTranscript?: string;
}

// ─── Security Helpers ───────────────────────────────────────────────────────

function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

function validateConfig(data: unknown): SignalConfig | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.account !== "string" || !isValidE164(obj.account)) return null;
  if (!Array.isArray(obj.allowedContacts)) return null;
  if (!obj.allowedContacts.every((c: unknown) => typeof c === "string" && isValidE164(c))) return null;
  if (obj.allowedContacts.length === 0) return null;
  return { account: obj.account, allowedContacts: [...obj.allowedContacts] };
}

function sanitizeIncomingMessage(text: string): string {
  const cleaned = text.replace(/`{3,}/g, "'''");
  const maxIncoming = 4000;
  return cleaned.length > maxIncoming
    ? cleaned.slice(0, maxIncoming) + " [truncated]"
    : cleaned;
}

// ─── Markdown Stripping ─────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  let s = text;
  // Remove headers: ## Header → Header
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Bold/italic: **text** / __text__ / *text* / _text_
  s = s.replace(/\*{2,3}(.+?)\*{2,3}/g, "$1");
  s = s.replace(/_{2,3}(.+?)_{2,3}/g, "$1");
  s = s.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1");
  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, "$1");
  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, "$1");
  // Code blocks: ```...```
  s = s.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/```\w*\n?/g, "").replace(/```/g, "").trim();
  });
  // Links: [text](url) → text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Images: ![alt](url) → (image: url)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "(image: $2)");
  // Bullet lists: - item / * item → • item
  s = s.replace(/^[\s]*[-*]\s+/gm, "• ");
  // Numbered lists: keep as-is, they're fine
  // Horizontal rules
  s = s.replace(/^[-*_]{3,}\s*$/gm, "");
  // Tables: | col | col | → just the content
  s = s.replace(/^\|(.+)\|\s*$/gm, (_match, inner) => {
    return inner.split("|").map((c: string) => c.trim()).filter(Boolean).join("  —  ");
  });
  // Remove table separator lines: |---|---|
  s = s.replace(/^\|[-:\s|]+\|\s*$/gm, "");
  // Blockquotes: > text → text
  s = s.replace(/^>\s+/gm, "");
  // Collapse 3+ blank lines to 2
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ─── Message Splitting ──────────────────────────────────────────────────────

function splitIntoChunks(text: string, maxChunk: number = 1500): string[] {
  if (text.length <= maxChunk) return [text];

  const chunks: string[] = [];
  // Split on double newlines (paragraphs) first
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > maxChunk) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If any chunk is still too long, split on single newlines
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChunk) {
      result.push(chunk);
    } else {
      const lines = chunk.split("\n");
      let cur = "";
      for (const line of lines) {
        if (cur && (cur.length + line.length + 1) > maxChunk) {
          result.push(cur.trim());
          cur = line;
        } else {
          cur = cur ? cur + "\n" + line : line;
        }
      }
      if (cur.trim()) result.push(cur.trim());
    }
  }
  return result;
}

// ─── Tool Label Mapping ─────────────────────────────────────────────────────

function toolStatusMessage(toolName: string, input: any): string {
  // Extract useful context from tool input
  if (toolName === "bash" && input?.command) {
    // Show first meaningful part of command, truncated
    const cmd = input.command.split("\n")[0].trim().substring(0, 60);
    return `⚙️ ${cmd}${input.command.length > 60 ? "…" : ""}`;
  }
  if (toolName === "read" && input?.path) {
    const file = input.path.split("/").pop();
    return `📄 reading ${file}`;
  }
  if (toolName === "edit" && input?.path) {
    const file = input.path.split("/").pop();
    return `✏️ editing ${file}`;
  }
  if (toolName === "write" && input?.path) {
    const file = input.path.split("/").pop();
    return `📝 writing ${file}`;
  }
  if (toolName === "vault_memory") {
    const action = input?.action || "";
    const name = input?.name || "";
    return `🧠 memory ${action}${name ? " " + name : ""}`;
  }
  if (toolName === "cron_schedule") {
    return `⏰ ${input?.action || "scheduling"}`;
  }
  if (toolName === "security_manage") return "🔒 security check";
  if (toolName.includes("search")) return "🔍 searching";
  if (toolName.includes("browse") || toolName.includes("fetch")) return "🌐 fetching page";
  return `🔧 ${toolName}`;
}

// ─── Audio Transcription ────────────────────────────────────────────────────

let whisperInstance: any = null;
let whisperLoading = false;

async function getWhisper(): Promise<any> {
  if (whisperInstance) return whisperInstance;
  if (whisperLoading) {
    // Wait for ongoing load
    while (whisperLoading) await new Promise((r) => setTimeout(r, 200));
    return whisperInstance;
  }
  whisperLoading = true;
  try {
    // @xenova/transformers is ESM-only, so we must use dynamic import()
    const path = require("path");
    const extensionDir = path.join(process.env.HOME!, ".pi/agent/extensions/signal-bridge");
    const transformersPath = path.join(extensionDir, "node_modules/@xenova/transformers/src/transformers.js");
    const transformers = await import(transformersPath);
    const modelsDir = path.join(extensionDir, "node_modules/whisper-onnx-speech-to-text/models");
    transformers.env.localModelPath = modelsDir;
    transformers.env.allowRemoteModels = false;
    transformers.env.local_files_only = true;
    if (transformers.env.backends?.onnx?.wasm) {
      transformers.env.backends.onnx.wasm.numThreads = 1;
    }
    // Suppress ONNX runtime warnings about unused initializers
    if (transformers.env.backends?.onnx) {
      transformers.env.backends.onnx.logSeverityLevel = 3; // ERROR only
    }
    try {
      const ort = require(path.join(extensionDir, "node_modules/onnxruntime-node"));
      ort.env.logSeverityLevel = 3;
    } catch {}

    const pipe = await transformers.pipeline("automatic-speech-recognition", "whisper-tiny.en", { quantized: false });
    // Wrap in an object matching the Whisper class interface
    whisperInstance = {
      async transcribe(filePath: string) {
        const util = require("util");
        const fs = require("fs");
        const wavefile = require(path.join(extensionDir, "node_modules/wavefile"));
        const readFile = util.promisify(fs.readFile);
        const wav = new wavefile.WaveFile(await readFile(path.normalize(filePath)));
        wav.toBitDepth("32f");
        wav.toSampleRate(16000);
        let audioData = wav.getSamples();
        if (Array.isArray(audioData)) {
          if (audioData.length > 1) {
            const SCALING_FACTOR = Math.sqrt(2);
            for (let i = 0; i < audioData[0].length; ++i) {
              audioData[0][i] = SCALING_FACTOR * (audioData[0][i] + audioData[1][i]) / 2;
            }
          }
          audioData = audioData[0];
        }
        return pipe(audioData, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
      }
    };
    return whisperInstance;
  } catch (err: any) {
    console.error("[signal-bridge] Failed to load Whisper:", err.message);
    return null;
  } finally {
    whisperLoading = false;
  }
}

async function transcribeAudio(audioPath: string): Promise<string | null> {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { execSync } = require("child_process");

  const tmpWav = path.join(os.tmpdir(), `signal-voice-${Date.now()}.wav`);

  try {
    // Debug: check input file
    const stat = fs.statSync(audioPath);
    console.error(`[signal-bridge] Audio input: ${audioPath} (${stat.size} bytes)`);

    if (stat.size < 100) {
      console.error("[signal-bridge] Audio file too small, likely empty");
      return null;
    }

    // Convert to 16kHz mono WAV (required by Whisper)
    let converted = false;
    try {
      execSync(`ffmpeg -y -i "${audioPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${tmpWav}"`, { timeout: 30000, stdio: "pipe" });
      converted = true;
      console.error(`[signal-bridge] ffmpeg conversion OK: ${fs.statSync(tmpWav).size} bytes`);
    } catch (ffErr: any) {
      console.error("[signal-bridge] ffmpeg failed:", ffErr.stderr?.toString() || ffErr.message);
      // Fallback to macOS afconvert
      try {
        execSync(`afconvert -f WAVE -d LEI16@16000 -c 1 "${audioPath}" "${tmpWav}"`, { timeout: 30000, stdio: "pipe" });
        converted = true;
        console.error(`[signal-bridge] afconvert conversion OK: ${fs.statSync(tmpWav).size} bytes`);
      } catch (afErr: any) {
        console.error("[signal-bridge] afconvert also failed:", afErr.stderr?.toString() || afErr.message);
      }
    }

    if (!converted || !fs.existsSync(tmpWav)) {
      console.error("[signal-bridge] Audio conversion failed completely");
      return null;
    }

    console.error("[signal-bridge] Loading Whisper...");
    const whisper = await getWhisper();
    if (!whisper) {
      console.error("[signal-bridge] Whisper instance is null");
      return null;
    }

    console.error("[signal-bridge] Transcribing...");
    const result = await whisper.transcribe(tmpWav);
    console.error("[signal-bridge] Transcription result:", JSON.stringify(result)?.slice(0, 300));

    // Handle both array format and direct object format
    if (Array.isArray(result) && result.length > 0 && result[0].text) {
      return result[0].text.trim();
    }
    if (result && typeof result === "object" && result.text) {
      return result.text.trim();
    }
    console.error("[signal-bridge] No text in transcription result");
    return null;
  } catch (err: any) {
    console.error("[signal-bridge] Transcription error:", err.message, err.stack?.slice(0, 500));
    return null;
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let signalCli: any = null;
  let state: BridgeState = { connected: false, config: null };
  let pendingMessages: PendingMessage[] = [];
  let waitingForResponse = false;
  let lastCtx: ExtensionContext | null = null; // stored for Signal abort

  // Throttle: track last status message time to avoid spamming
  let lastStatusSentAt = 0;
  const STATUS_THROTTLE_MS = 3000;

  const CONFIG_FILE = `${process.env.HOME}/.pi/agent/extensions/signal-bridge/signal-bridge.json`;

  // ── Helpers ─────────────────────────────────────────────────────────────

  function loadConfig(): SignalConfig | null {
    try {
      const fs = require("fs");
      if (fs.existsSync(CONFIG_FILE)) {
        return validateConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")));
      }
    } catch {}
    return null;
  }

  function saveConfig(config: SignalConfig) {
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  /** Find the Signal sender from the last user message in the branch */
  function findSignalSender(ctx: ExtensionContext): string | null {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "user") {
        const content = typeof entry.message.content === "string"
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? (entry.message.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
            : "";
        const match = content.match(/^\[Signal (?:voice )?message from (\+\d{7,15})\]:/);
        if (match && isValidE164(match[1])) return match[1];
        break; // last user message wasn't from Signal
      }
    }
    return null;
  }

  function extractAssistantReply(ctx: ExtensionContext): string | null {
    const branch = ctx.sessionManager.getBranch();
    let signalMsgIndex = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "user") {
        const content = typeof entry.message.content === "string"
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? (entry.message.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
            : "";
        if (content.match(/^\[Signal (?:voice )?message from \+\d{7,15}\]:/)) {
          signalMsgIndex = i;
          break;
        }
      }
    }
    if (signalMsgIndex === -1) return null;
    for (let i = branch.length - 1; i > signalMsgIndex; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "assistant") {
        const msg = entry.message;
        if (msg.content && typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          const textParts = (msg.content as any[])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text);
          if (textParts.length > 0) return textParts.join("\n");
        }
      }
    }
    return null;
  }

  /** Send a typing indicator to the recipient */
  async function sendTyping(recipient: string, stop: boolean = false) {
    if (!signalCli || !state.connected) return;
    try {
      await signalCli.sendTyping(recipient, stop);
    } catch {}
  }

  /** Send a short status update (throttled) */
  async function sendStatus(text: string, recipient: string) {
    const now = Date.now();
    if (now - lastStatusSentAt < STATUS_THROTTLE_MS) return;
    lastStatusSentAt = now;
    await sendSignalMessage(text, recipient);
  }

  /** Core send — validates recipient, splits long messages into chunks */
  async function sendSignalMessage(text: string, recipient: string) {
    if (!signalCli || !state.connected) return;
    if (!isValidE164(recipient)) return;
    if (!state.config?.allowedContacts.includes(recipient)) return;

    try {
      // Stop typing indicator before sending
      await sendTyping(recipient, true);
      await signalCli.sendMessage(recipient, text);
    } catch (err: any) {
      console.error("[signal-bridge] Failed to send:", err.message);
    }
  }

  /** Send the final reply — strip markdown, split into chat-sized chunks */
  async function sendSignalReply(text: string, recipient: string) {
    if (!signalCli || !state.connected) return;
    if (!isValidE164(recipient)) return;
    if (!state.config?.allowedContacts.includes(recipient)) return;

    const cleaned = stripMarkdown(text);
    const chunks = splitIntoChunks(cleaned);

    try {
      await sendTyping(recipient, true);
      for (let i = 0; i < chunks.length; i++) {
        await signalCli.sendMessage(recipient, chunks[i]);
        // Small delay between chunks so they appear sequentially
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } catch (err: any) {
      console.error("[signal-bridge] Failed to send reply:", err.message);
    }
  }

  function processNextMessage() {
    if (waitingForResponse || pendingMessages.length === 0) return;
    const msg = pendingMessages.shift()!;
    waitingForResponse = true;
    lastStatusSentAt = 0; // reset throttle for new message
    lastStatusMsg = ""; // reset dedup for new message

    const sanitized = sanitizeIncomingMessage(msg.text);
    const deliverAs = "followUp" as const;

    // Voice message — inject transcript
    if (msg.voiceTranscript) {
      const prefix = `[Signal voice message from ${msg.sender}]`;
      const body = msg.text
        ? `${sanitized}\n\n🎙️ Voice transcript: ${msg.voiceTranscript}`
        : msg.voiceTranscript;
      pi.sendUserMessage(`${prefix}: ${body}`, { deliverAs });
    } else if (msg.images && msg.images.length > 0) {
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: `[Signal message from ${msg.sender}]: ${sanitized || "(image)"}` },
        ...msg.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })),
      ];
      pi.sendUserMessage(content, { deliverAs });
    } else {
      pi.sendUserMessage(`[Signal message from ${msg.sender}]: ${sanitized}`, { deliverAs });
    }
  }

  // ── Connection ──────────────────────────────────────────────────────────

  async function connectSignal(ctx: ExtensionContext, silent: boolean = false) {
    if (state.connected) {
      if (!silent) ctx.ui.notify("Signal bridge already connected", "warning");
      return;
    }
    const config = loadConfig();
    if (!config) {
      if (!silent) ctx.ui.notify("No valid Signal config. Run /signal setup <phone> <contact>", "error");
      return;
    }
    state.config = config;

    try {
      const javaBin = "/opt/homebrew/opt/openjdk/bin";
      if (!process.env.PATH?.includes(javaBin)) {
        process.env.PATH = `${javaBin}:${process.env.PATH}`;
      }
      if (!process.env.JAVA_HOME) {
        process.env.JAVA_HOME = "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home";
      }

      const { SignalCli } = require("signal-sdk");
      signalCli = new SignalCli(config.account, { logLevel: "silent" });
      ctx.ui.setStatus("signal", "⏳ connecting…");

      await signalCli.connect({
        ignoreAttachments: false,
        ignoreAvatars: true,
        ignoreStickers: true,
        ignoreStories: true,
      });

      signalCli.on("message", async (message: any) => {
        try {
          const envelope = message?.envelope;
          if (!envelope) return;

          let sender = envelope.source || envelope.sourceNumber;
          let text = envelope?.dataMessage?.message;
          let attachments = envelope?.dataMessage?.attachments;

          if (!text && !attachments && envelope?.syncMessage?.sentMessage) {
            const sent = envelope.syncMessage.sentMessage;
            text = sent.message;
            attachments = sent.attachments;
            sender = sender || envelope.sourceNumber || state.config?.account;
          }

          if (!sender || (!text && !attachments)) return;
          if (typeof sender !== "string") return;
          if (!isValidE164(sender)) return;
          if (!config.allowedContacts.includes(sender)) return;

          // ── Signal commands (intercepted before queueing) ──
          if (text) {
            const cmd = text.trim().toLowerCase();

            // Abort current turn
            if (cmd === "abort") {
              if (waitingForResponse && lastCtx) {
                lastCtx.abort();
                waitingForResponse = false;
                await sendSignalMessage("✋ aborted", sender);
                processNextMessage();
              } else {
                await sendSignalMessage("nothing running to abort", sender);
              }
              return;
            }

            // Compact session
            if (cmd === "compact") {
              if (lastCtx) {
                await sendSignalMessage("🗜️ compacting session…", sender);
                try {
                  await lastCtx.compact();
                  await sendSignalMessage("✅ session compacted", sender);
                } catch (err: any) {
                  await sendSignalMessage("⚠️ compact failed: " + err.message, sender);
                }
              } else {
                await sendSignalMessage("no active session to compact", sender);
              }
              return;
            }

            // New session
            if (cmd === "new session") {
              if (lastCtx) {
                await sendSignalMessage("🆕 starting new session…", sender);
                try {
                  waitingForResponse = false;
                  pendingMessages = [];
                  await (lastCtx as any).newSession?.();
                  await sendSignalMessage("✅ new session started", sender);
                } catch (err: any) {
                  await sendSignalMessage("⚠️ new session failed: " + err.message, sender);
                }
              } else {
                await sendSignalMessage("no active context for new session", sender);
              }
              return;
            }

            // Status check
            if (cmd === "status") {
              const queueLen = pendingMessages.length;
              const busy = waitingForResponse ? "busy" : "idle";
              const connected = state.connected ? "connected" : "disconnected";
              await sendSignalMessage(
                `📊 Signal: ${connected}\nAgent: ${busy}\nQueued messages: ${queueLen}`,
                sender
              );
              return;
            }

            // Reload extensions, skills, prompts, themes
            if (cmd === "reload") {
              if (lastCtx) {
                await sendSignalMessage("🔄 reloading…", sender);
                try {
                  waitingForResponse = false;
                  pendingMessages = [];
                  pi.sendUserMessage("/reload-signal", { deliverAs: "followUp" });
                } catch (err: any) {
                  await sendSignalMessage("⚠️ reload failed: " + err.message, sender);
                }
              } else {
                await sendSignalMessage("no active context for reload", sender);
              }
              return;
            }
          }

          // Process attachments (images + audio)
          const images: { data: string; mimeType: string }[] = [];
          let voiceTranscript: string | undefined;
          if (Array.isArray(attachments)) {
            for (const att of attachments) {
              const ct = att.contentType || "";

              // ── Audio / voice messages ──
              if ((ct.startsWith("audio/") || ct === "application/ogg") && att.id) {
                try {
                  const attData = await signalCli.getAttachment({ id: att.id, recipient: sender });
                  if (attData) {
                    const fs = require("fs");
                    const os = require("os");
                    const path = require("path");
                    let audioPath: string;

                    if (typeof attData === "string" && fs.existsSync(attData)) {
                      audioPath = attData;
                    } else if (typeof attData === "string") {
                      // base64 data — write to temp file
                      const ext = ct.includes("ogg") ? "ogg" : ct.includes("mp4") || ct.includes("m4a") ? "m4a" : "audio";
                      audioPath = path.join(os.tmpdir(), `signal-audio-${Date.now()}.${ext}`);
                      fs.writeFileSync(audioPath, Buffer.from(attData, "base64"));
                    } else { continue; }

                    // Notify sender that we're transcribing
                    sendStatus("🎙️ transcribing voice message…", sender);

                    const transcript = await transcribeAudio(audioPath);
                    if (transcript) {
                      voiceTranscript = transcript;
                    } else {
                      sendSignalMessage("⚠️ couldn't transcribe that voice message", sender);
                    }

                    // Clean up temp file if we created one
                    if (audioPath.includes(os.tmpdir())) {
                      try { fs.unlinkSync(audioPath); } catch {}
                    }
                  }
                } catch (err: any) {
                  console.error("[signal-bridge] Audio attachment error:", err.message);
                }
                continue;
              }

              // ── Image attachments ──
              if (ct.startsWith("image/") && att.id) {
                try {
                  const attData = await signalCli.getAttachment({ id: att.id, recipient: sender });
                  if (attData) {
                    const fs = require("fs");
                    let base64: string;
                    if (typeof attData === "string" && fs.existsSync(attData)) {
                      base64 = fs.readFileSync(attData).toString("base64");
                    } else if (typeof attData === "string") {
                      base64 = attData;
                    } else { continue; }
                    images.push({ data: base64, mimeType: ct });
                  }
                } catch (err: any) {
                  console.error("[signal-bridge] Attachment error:", err.message);
                }
              }
            }
          }

          if (!text && images.length === 0 && !voiceTranscript) return;

          pendingMessages.push({
            sender,
            text: text || "",
            images: images.length > 0 ? images : undefined,
            voiceTranscript,
          });

          // If pi is busy, acknowledge the queued message
          if (waitingForResponse) {
            sendStatus("⏳ got it, finishing up something first", sender);
          }

          processNextMessage();
        } catch (err: any) {
          console.error("[signal-bridge] Message error:", err.message);
        }
      });

      state.connected = true;
      ctx.ui.setStatus("signal", "📱 Signal connected");
      ctx.ui.notify(`Signal bridge connected as ${config.account}`, "info");
    } catch (err: any) {
      ctx.ui.setStatus("signal", "❌ disconnected");
      ctx.ui.notify(`Signal connection failed: ${err.message}`, "error");
    }
  }

  async function disconnectSignal(ctx: ExtensionContext) {
    if (!state.connected || !signalCli) {
      ctx.ui.notify("Signal bridge not connected", "warning");
      return;
    }
    try { await signalCli.gracefulShutdown(); } catch {}
    signalCli = null;
    state.connected = false;
    waitingForResponse = false;
    pendingMessages = [];
    ctx.ui.setStatus("signal", undefined);
    ctx.ui.notify("Signal bridge disconnected", "info");
  }

  // ── Events ──────────────────────────────────────────────────────────────

  let lastStatusMsg = "";

  // Capture ctx early so Signal commands work before any tool calls
  // Auto-connect if config exists (reconnects after /reload too)
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    if (!state.connected) {
      const config = loadConfig();
      if (config) {
        try {
          await connectSignal(ctx, true);
        } catch (err: any) {
          console.error("[signal-bridge] Auto-connect failed:", err.message);
        }
      }
    }
  });
  pi.on("session_switch", async (_event, ctx) => { lastCtx = ctx; });

  // Tool call started — send typing indicator + status message
  pi.on("tool_call", async (event, ctx) => {
    if (!state.connected) return;
    lastCtx = ctx;
    const sender = findSignalSender(ctx);
    if (!sender) return;

    // Send typing indicator
    await sendTyping(sender);

    // Build descriptive status, skip if identical to last
    const status = toolStatusMessage(event.toolName, event.input);
    if (status === lastStatusMsg) return;
    lastStatusMsg = status;
    await sendStatus(status, sender);
  });

  // Tool result error — send error to Signal (handles security blocks with ctx.abort())
  pi.on("tool_result", async (event, ctx) => {
    if (!state.connected || !event.isError) return;
    const sender = findSignalSender(ctx);
    if (!sender) return;

    const errorText = Array.isArray(event.content)
      ? (event.content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
      : typeof event.content === "string" ? event.content : "";

    if (errorText) {
      // Strip the verbose guidance text, just send the key info
      const firstLine = errorText.split("\n")[0] || errorText;
      await sendSignalMessage("🚫 " + stripMarkdown(firstLine), sender);
      waitingForResponse = false;
      processNextMessage();
    }
  });

  // Turn ended — send final reply and always unstick the queue
  pi.on("turn_end", async (_event, ctx) => {
    if (!state.connected) return;
    lastCtx = ctx;
    const sender = findSignalSender(ctx);
    if (!sender) {
      // No Signal sender found — turn was local or aborted before reply.
      // Reset queue so next Signal message can go through.
      if (waitingForResponse) {
        waitingForResponse = false;
        processNextMessage();
      }
      return;
    }

    const reply = extractAssistantReply(ctx);
    if (reply) {
      await sendSignalReply(reply, sender);
    }
    // Always reset — even if no reply (abort, security block, error)
    waitingForResponse = false;
    processNextMessage();
  });

  // Cleanup
  pi.on("session_shutdown", async () => {
    if (signalCli && state.connected) {
      try { await signalCli.gracefulShutdown(); } catch {}
      signalCli = null;
      state.connected = false;
    }
  });

  // ── Commands ────────────────────────────────────────────────────────────

  // Reload command triggered by Signal "reload" message
  pi.registerCommand("reload-signal", {
    description: "Reload triggered from Signal",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  pi.registerCommand("signal", {
    description: "Signal bridge: setup/connect/disconnect/status/link/add",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      switch (sub) {
        case "setup": {
          const [, account, contact] = parts;
          if (!account || !contact) {
            ctx.ui.notify("Usage: /signal setup +YOUR_PHONE +CONTACT_PHONE", "error");
            return;
          }
          if (!isValidE164(account) || !isValidE164(contact)) {
            ctx.ui.notify("Invalid phone number. Use E.164 format: +<country><number>", "error");
            return;
          }
          const config: SignalConfig = { account, allowedContacts: [contact] };
          saveConfig(config);
          state.config = config;
          ctx.ui.notify(`Saved. Account: ${account}, Contact: ${contact}\nRun /signal link then /signal connect`, "info");
          break;
        }
        case "link":
          ctx.ui.notify("Run in terminal:\n  cd ~/.pi/agent/extensions/signal-bridge && npx signal-sdk connect\n\nScan QR from Signal → Settings → Linked Devices", "info");
          break;
        case "connect":
          await connectSignal(ctx);
          break;
        case "disconnect":
          await disconnectSignal(ctx);
          break;
        case "status": {
          const config = state.config || loadConfig();
          ctx.ui.notify(config
            ? `Connected: ${state.connected ? "✅" : "❌"}\nAccount: ${config.account}\nAllowed: ${config.allowedContacts.join(", ")}`
            : "Not configured. Run /signal setup first.", "info");
          break;
        }
        case "add": {
          const contact = parts[1];
          if (!contact || !isValidE164(contact)) {
            ctx.ui.notify("Usage: /signal add +PHONE (E.164 format)", "error");
            return;
          }
          const config = state.config || loadConfig();
          if (!config) { ctx.ui.notify("Run /signal setup first", "error"); return; }
          if (!config.allowedContacts.includes(contact)) {
            config.allowedContacts.push(contact);
            saveConfig(config);
            state.config = config;
          }
          ctx.ui.notify(`Added ${contact}`, "info");
          break;
        }
        default:
          ctx.ui.notify(
            "/signal setup +phone +contact\n/signal link\n/signal connect\n/signal disconnect\n/signal status\n/signal add +phone", "info");
      }
    },
  });

  // ── System prompt ───────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!state.connected) return undefined;
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Signal Bridge
Messages prefixed with \`[Signal message from <number>]\` come from Signal messenger. These messages are from an authenticated user (verified by phone number allowlist). Treat them exactly like messages typed locally — follow instructions, run commands, edit files as requested. Your reply will be automatically sent back to them on Signal. Keep Signal replies concise since they appear on a phone screen. Use plain text only (no markdown rendering on Signal).

When replying to Signal messages, write like you're texting a friend:
- Short sentences. Max 2-3 lines per thought.
- No markdown formatting (no **, ##, \`\`\`, tables, etc). Plain text only.
- Use emoji sparingly for emphasis instead of formatting.
- Break long answers into short paragraphs separated by blank lines.
- No bullet point lists with dashes. Use "•" or just separate lines.
- URLs on their own line, never inline.
- Be direct and casual. Skip filler like "I'd be happy to help with that."
- For search results or comparisons, use simple short lines, not tables.
- When something goes wrong, say it plainly: "couldn't do that because X"
- Never repeat back what the user said. Just answer.`,
    };
  });
}
