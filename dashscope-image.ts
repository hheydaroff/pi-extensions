/**
 * dashscope-image — text/image generation via DashScope (Model Studio).
 *
 * Registers the `generate_image` tool (LLM-callable) and `/image` command for
 * three DashScope image models:
 *
 *   - qwen-image-3.0 / -pro  (text-to-image, async submit + poll)
 *   - wan2.6-image           (image editing / subject-consistency, async, needs ≥1 ref image)
 *
 * Facts verified against the live API (workspace `eu-central-1`, key from macOS
 * keychain `dashscope-api-key`):
 *   - qwen-image-3.0(-pro): POST /services/aigc/image-generation/generation
 *     (async) then GET /tasks/{id}. Result: output.choices[].message.content[].image.
 *   - wan2.6-image: same async endpoint with enable_interleave=false.
 *     Editing mode requires 1–4 reference images.
 *   - The SYNC multimodal endpoint is flaky on this workspace (hangs with 0 bytes)
 *     and qwen's image-to-image hangs on the async endpoint, so edits always
 *     route to wan2.6-image and text-to-image always uses qwen.
 *
 * Auth/base-url are auto-derived from the existing `dashscope` provider in
 * ~/.pi/agent/models.json (a `sk-ws-…` workspace key and `.maas.aliyuncs.com`
 * compatible-mode baseUrl), then overridable in settings.json under
 * `dashscope-image`. Generated files are saved into the CWD.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, Image } from "@earendil-works/pi-tui";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_KEY = "dashscope-image";

const QWEN_MODELS = ["qwen-image-3.0", "qwen-image-3.0-pro"] as const;
const WAN_MODELS = ["wan2.6-image"] as const;
const ALL_MODELS = [...QWEN_MODELS, ...WAN_MODELS];

interface Config {
  model?: string;   // default model
  size?: string;    // output size override ("1024*1024", "1K", …)
  apiKey?: string;  // literal | $ENV | !command
  baseUrl?: string; // full base incl. /api/v1 (host fallback = auto-derived)
}

function loadConfig(): Config {
  const p = join(getAgentDir(), "settings.json");
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  const c = raw[SETTINGS_KEY];
  if (c && typeof c === "object") return c as Config;
  return {};
}

function readModelsJsonProviders(): Record<string, any> | undefined {
  const p = join(getAgentDir(), "models.json");
  if (!existsSync(p)) return undefined;
  const raw = JSON.parse(readFileSync(p, "utf-8")) as any;
  return raw?.providers;
}

/** Resolve pi-style config values: `!command`, `$ENV`, `${ENV}`, `$$`, `$!`. */
export function resolveValue(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v.startsWith("!") && !v.startsWith("$!")) {
    // command execution (trim trailing newline)
    try {
      return execFileSync("bash", ["-lc", v.slice(1)], { encoding: "utf-8", timeout: 8000 }).trim();
    } catch {
      return undefined;
    }
  }
  let s = v.replace(/\$\$/g, "\u0000").replace(/\$!/g, "\u0001");
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? "");
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n: string) => process.env[n] ?? "");
  return s.replace(/\u0000/g, "$").replace(/\u0001/g, "!");
}

/** Derive the native (non-compatible-mode) API base from the dashscope provider baseUrl. */
export function deriveBaseUrl(compatBaseUrl: string | undefined): string {
  if (compatBaseUrl) {
    const host = compatBaseUrl.replace(/\/compatible-mode\/v1\/?$/, "").replace(/\/v1\/?$/, "");
    if (host) return `${host}/api/v1`;
  }
  return "https://dashscope-intl.aliyuncs.com/api/v1";
}

/** Reuse pi's already-resolved dashscope credential (no keychain re-prompt, no hang). */
async function piResolvedDashscopeKey(ctx?: ExtensionContext): Promise<string | undefined> {
  if (!ctx) return undefined;
  try {
    const models: any[] = ctx.modelRegistry.getAvailable?.() ?? [];
    const m = models.find((x) => x.provider === "dashscope");
    if (!m) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
    if (auth?.ok && auth?.apiKey) return auth.apiKey as string;
  } catch {}
  return undefined;
}

async function resolveAuth(cfg: Config, ctx?: ExtensionContext): Promise<{ baseUrl: string; apiKey?: string }> {
  const providers = readModelsJsonProviders();
  const ds = providers?.["dashscope"] as any;
  const baseUrl = cfg.baseUrl?.replace(/\/+$/, "") || deriveBaseUrl(ds?.baseUrl);
  // Order: settings override → env → pi's resolved dashscope key → models.json !command.
  const apiKey =
    resolveValue(cfg.apiKey) ??
    process.env.DASHSCOPE_API_KEY ??
    (await piResolvedDashscopeKey(ctx)) ??
    resolveValue(ds?.apiKey);
  return { baseUrl, apiKey };
}

const MIME_EXT: Record<string, { ext: string; mime: string }> = {
  "image/png": { ext: ".png", mime: "image/png" },
  "image/jpeg": { ext: ".jpg", mime: "image/jpeg" },
  "image/webp": { ext: ".webp", mime: "image/webp" },
  "image/bmp": { ext: ".bmp", mime: "image/bmp" },
};

const LOCAL_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", bmp: "image/bmp",
};

/** Find image file paths (absolute / ~ / ./ / ../) inside a text string. */
function extractImagePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /((?:~\/|\/|\.\.?\/)[^\s"'`()<>;&|]+\.(png|jpe?g|webp|gif|bmp))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].replace(/[),.;:]+$/, "");
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Turn reference_images into content parts: local files → base64, URLs pass through. */
async function toImageParts(refs: string[] | undefined): Promise<{ image: string }[]> {
  const out: { image: string }[] = [];
  for (const ref of refs ?? []) {
    const r = ref.trim();
    if (!r) continue;
    if (/^https?:\/\//i.test(r)) {
      out.push({ image: r });
      continue;
    }
    // local path (support ~/)
    let p = r;
    if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
    const ext = p.match(LOCAL_EXT)?.[1]?.toLowerCase();
    if (!ext || !existsSync(p)) throw new Error(`reference image not found: ${r}`);
    const data = (await readFile(p)).toString("base64");
    out.push({ image: `data:${MIME_BY_EXT[ext]};base64,${data}` });
  }
  return out;
}

function buildBody(model: string, prompt: string, imgs: { image: string }[], params: { size?: string; n: number; negativePrompt?: string; seed?: number; enableInterleave?: boolean }) {
  return {
    model,
    input: { messages: [{ role: "user", content: [{ text: prompt }, ...imgs] }] },
    parameters: {
      n: params.n,
      prompt_extend: true,
      watermark: false,
      ...(params.size ? { size: params.size } : {}),
      ...(params.negativePrompt ? { negative_prompt: params.negativePrompt } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.enableInterleave !== undefined ? { enable_interleave: params.enableInterleave } : {}),
    },
  };
}

/** Extract image URLs from either response shape (choices[] or legacy results[]). */
export function extractImages(output: any): string[] {
  const urls: string[] = [];
  for (const c of output?.choices ?? []) {
    for (const part of c?.message?.content ?? []) {
      if (typeof part?.image === "string") urls.push(part.image);
    }
  }
  if (urls.length === 0) {
    for (const r of output?.results ?? []) {
      if (typeof r?.url === "string") urls.push(r.url);
    }
  }
  return urls;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch with a hard deadline so nothing blocks the turn forever. */
function fetchTO(url: string, init: RequestInit, ms: number): Promise<Response> {
  const signals: AbortSignal[] = [AbortSignal.timeout(ms)];
  if (init.signal) signals.push(init.signal);
  return fetch(url, { ...init, signal: AbortSignal.any(signals) });
}

async function pollTask(
  baseUrl: string,
  apiKey: string,
  taskId: string,
  signal: AbortSignal | undefined,
  onUpdate: ((u: any) => void) | undefined,
): Promise<any> {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    const res = await fetchTO(`${baseUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 30_000);
    if (!res.ok) throw new Error(`task query failed: HTTP ${res.status}`);
    const j = (await res.json()) as any;
    const status = j?.output?.task_status;
    if (status === "SUCCEEDED") return j.output;
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(`image task ${status}: ${j?.output?.message || j?.output?.code || "unknown error"}`);
    }
    onUpdate?.({ content: [{ type: "text", text: `Generating… (${status.toLowerCase()})` }] });
    if (Date.now() > deadline) throw new Error("image task timed out after 5 minutes");
    await sleep(8000);
  }
}

interface ImgResult {
  path: string;
  base64: string;
  mime: string;
}

async function saveAndEncode(url: string, dir: string, model: string, i: number): Promise<ImgResult> {
  const res = await fetchTO(url, {}, 60_000);
  if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const rawMime = res.headers.get("content-type") ?? "image/png";
  const mime = rawMime.split(";")[0].trim();
  const map = MIME_EXT[mime] ?? { ext: ".png", mime: "image/png" };
  const safe = model.replace(/[^a-zA-Z0-9-]/g, "-");
  const file = join(dir, `dashscope-${safe}-${Date.now()}-${i + 1}${map.ext}`);
  await writeFile(file, buf);
  return { path: file, base64: buf.toString("base64"), mime: map.mime };
}

export async function generate(
  args: { prompt: string; model?: string; size?: string; n?: number; negative_prompt?: string; seed?: number; reference_images?: string[] },
  ctx?: ExtensionContext,
  onUpdate?: (u: any) => void,
  signal?: AbortSignal,
): Promise<{ summary: string; images: { data: string; mimeType: string }[]; paths: string[] }> {
  const cfg = loadConfig();
  const { baseUrl, apiKey } = await resolveAuth(cfg, ctx);
  if (!apiKey) {
    throw new Error("No DashScope API key found. Set DASHSCOPE_API_KEY, or add a `dashscope` provider to ~/.pi/agent/models.json, or set `dashscope-image.apiKey` in settings.json.");
  }

  const n = Math.min(Math.max(args.n ?? 1, 1), 4);

  // Natural-language support: pull inline image paths out of the prompt
  // (e.g. "make a whale in this image. photo.jpg") and use them as references.
  const inlinePaths = extractImagePaths(args.prompt ?? "");
  const prompt = inlinePaths.reduce((t, p) => t.split(p).join(" "), args.prompt ?? "").replace(/\s+/g, " ").trim();
  const refs = (args.reference_images && args.reference_images.length > 0) ? args.reference_images : inlinePaths;
  const imgs = await toImageParts(refs.length > 0 ? refs : undefined);

  // Routing: edits (a reference image present) always use wan2.6-image — it's
  // the reliable edit path; qwen's image-to-image hangs on this workspace.
  // Text-to-image uses the requested model (qwen-image-3.0 by default).
  const model: string = imgs.length > 0
    ? "wan2.6-image"
    : ((args.model ?? cfg.model ?? "qwen-image-3.0"));
  if (imgs.length === 0 && !ALL_MODELS.includes(model as any)) {
    throw new Error(`Unknown model "${model}". Choose one of: ${ALL_MODELS.join(", ")}`);
  }
  const isWan = WAN_MODELS.includes(model as any);

  const size = args.size ?? cfg.size ?? (isWan ? "1K" : "1024*1024");

  // All models use the async submit + poll flow. The sync multimodal endpoint
  // proved flaky on this workspace (it intermittently hangs with 0 bytes).
  const res = await fetchTO(`${baseUrl}/services/aigc/image-generation/generation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(buildBody(model, prompt, imgs, {
      size, n, negativePrompt: args.negative_prompt, seed: args.seed,
      ...(isWan ? { enableInterleave: false } : {}),
    })),
    signal,
  }, 30_000);
  if (!res.ok) throw new Error(`submit failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const submit = (await res.json()) as any;
  if (submit?.code) throw new Error(`submit failed: ${submit.code} ${submit.message ?? ""}`);
  const taskId = submit?.output?.task_id;
  if (!taskId) throw new Error(`submit returned no task_id: ${JSON.stringify(submit).slice(0, 300)}`);
  onUpdate?.({ content: [{ type: "text", text: "Submitted — generating… (can take up to a minute)" }] });
  const output = await pollTask(baseUrl, apiKey, taskId, signal, onUpdate);

  const urls = extractImages(output);
  if (urls.length === 0) throw new Error("no images returned from DashScope");

  const dir = process.cwd();
  const images: { data: string; mimeType: string }[] = [];
  const paths: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const saved = await saveAndEncode(urls[i], dir, model, i);
    paths.push(saved.path);
    images.push({ data: saved.base64, mimeType: saved.mime });
  }

  const summary = paths.map((p) => `Saved: ${p}`).join("\n");

  return { summary, images, paths };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate images (text-to-image) or edit them. Text-to-image uses qwen-image-3.0 (default) or qwen-image-3.0-pro; any edit that passes a reference image path (in the prompt or reference_images) auto-uses wan2.6-image. Saves PNGs to the working directory and returns their paths.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Positive prompt describing the image to generate or the edit to apply." }),
      model: Type.Optional(Type.String({ description: "For text-to-image only: qwen-image-3.0 (default) or qwen-image-3.0-pro. Edits (with a reference image) always use wan2.6-image." })),
      size: Type.Optional(Type.String({ description: "Output size, e.g. \"1024*1024\". Omit for model default." })),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Number of images (1-4)." })),
      negative_prompt: Type.Optional(Type.String({ description: "Content to avoid in the image." })),
      seed: Type.Optional(Type.Integer({ description: "Random seed for reproducibility." })),
      reference_images: Type.Optional(Type.Array(Type.String({ description: "Reference image URLs or local file paths (1-4). Required for wan2.6-image; optional for qwen models (image-to-image)." }))),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }] });
      const r = await generate(params as any, ctx, onUpdate, signal);
      ctx.ui.notify(r.paths.length === 1 ? `Image saved: ${r.paths[0]}` : `${r.paths.length} images saved`, "success");
      const content: any[] = [{ type: "text", text: r.summary }];
      // Only inline the images when the active model can actually see them;
      // text-only models just get the paths — the image itself is rendered
      // in the tool result via renderResult().
      if (ctx.model?.input?.includes("image")) {
        content.push(...r.images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType })));
      }
      return { content, details: { paths: r.paths, images: r.images } };
    },

    // Show the generated image(s) + saved path directly in the transcript,
    // regardless of whether the active model can see images.
    renderResult(result: any, _opts: any, theme: any) {
      const d = result?.details ?? {};
      const images: { data: string; mimeType: string }[] = d.images ?? [];
      const paths: string[] = d.paths ?? [];
      const box = new Box(0, 0);
      for (const img of images) {
        box.addChild(new Image(img.data, img.mimeType, { fallbackColor: (s: string) => (theme?.fg ? theme.fg("dim", s) : s) }, { maxWidthCells: 64, maxHeightCells: 24 }));
      }
      const label = paths.length
        ? paths.map((p: string, i: number) => `Saved${images.length > 1 ? ` #${i + 1}` : ""}: ${p}`).join("\n")
        : "Image generated";
      box.addChild(new Text(label, 1, 0));
      return box;
    },
  });

  // Same rendering for the /image command (a TUI-only transcript entry).
  pi.registerEntryRenderer("dashscope-image", (entry: any, _opts: any, theme: any) => {
    const d = entry.data ?? {};
    const images: { data: string; mimeType: string }[] = d.images ?? [];
    const paths: string[] = d.paths ?? [];
    const box = new Box(0, 0);
    for (const img of images) {
      box.addChild(new Image(img.data, img.mimeType, { fallbackColor: (s: string) => (theme?.fg ? theme.fg("dim", s) : s) }, { maxWidthCells: 64, maxHeightCells: 24 }));
    }
    box.addChild(new Text(paths.map((p: string, i: number) => `Saved${images.length > 1 ? ` #${i + 1}` : ""}: ${p}`).join("\n"), 1, 0));
    return box;
  });

  pi.registerCommand("image", {
    description: "Generate an image. /image <prompt> [--model qwen-image-3.0|qwen-image-3.0-pro|wan2.6-image] [--size 1024*1024] [--ref <url-or-path>]…",
    handler: async (args, ctx) => {
      const m = (args ?? "").match(/--model\s+([^\s]+)/);
      const s = (args ?? "").match(/--size\s+([^\s]+)/);
      const refs = [...(args ?? "").matchAll(/--ref\s+([^\s]+)/g)].map((x) => x[1]);
      let prompt = (args ?? "").replace(/--model\s+[^\s]+/g, "").replace(/--size\s+[^\s]+/g, "").replace(/--ref\s+[^\s]+/g, "").trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /image <prompt> [--model qwen-image-3.0-pro] [--size 1024*1024] [--ref <url|path>]", "error");
        return;
      }
      ctx.ui.notify("🖼 Generating image…", "info");
      ctx.ui.setStatus("dashscope-image", "generating…");
      try {
        const r = await generate({ prompt, model: m?.[1], size: s?.[1], reference_images: refs.length ? refs : undefined }, ctx);
        ctx.ui.setStatus("dashscope-image", undefined);
        pi.appendEntry("dashscope-image", { paths: r.paths, images: r.images });
        ctx.ui.notify(r.paths.length === 1 ? `Image saved: ${r.paths[0]}` : `${r.paths.length} images saved`, "success");
      } catch (err) {
        ctx.ui.setStatus("dashscope-image", undefined);
        ctx.ui.notify(`/image failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}