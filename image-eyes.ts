/**
 * image-eyes — give text-only models eyes.
 *
 * When the active model cannot see images (model.input lacks "image"),
 * attached images would normally be dropped or rejected. This extension
 * converts images to precise text before the model sees them.
 *
 * Two triggers, because clipboards usually paste a PATH, not an attachment:
 *   1. Image PATHS in the input text (e.g. /var/folders/.../clipboard-*.png).
 *      Detected by extension, read from disk, described, and replaced inline.
 *   2. Attached images (event.images), when the terminal does attach them.
 *
 * For each image:
 *   - PRIMARY: a vision-capable LLM describes it (layout, position, colors,
 *     relative sizes, element states) using a strict prompt. Model pinned to
 *     Claude Haiku 4.5 (EU Bedrock), override with IMAGE_EYES_MODEL="provider/id".
 *   - COMPLEMENT: local OCR (Apple Vision framework) appends the exact text,
 *     so code/IDs/numbers are never hallucinated. Uses `mac-ocr` if installed,
 *     else a bundled Swift script.
 *
 * Invisible when the active model supports images.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const pExecFile = promisify(execFile);

const MAX_IMAGES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const VISION_TIMEOUT_MS = 120_000;

const MIME_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/bmp": ".bmp",
};

// ext (lowercase) -> mime
const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

const DESCRIBE_PROMPT = [
	"You are the eyes of an AI coding assistant whose current model cannot see images.",
	"Describe this image so precisely that a text-only model can work with it as if it had seen it.",
	"",
	"Cover, in this order:",
	"1. Type: what kind of image (screenshot, UI mockup, photo, chart, diagram, document, error dialog, etc.).",
	"2. Layout & position: what is located where (top/bottom/left/right/center) and how elements are arranged relative to each other.",
	"3. Elements: every significant element with its text content, color, approximate relative size (e.g. 'header bar, ~10% of height, dark blue') and state (selected, disabled, highlighted).",
	"4. If a chart or diagram: chart type, axis labels, each series with its color and values or trend, arrows and connections between nodes.",
	"5. If a photo: subject, setting, dominant colors, lighting.",
	"",
	"Report only what is actually visible. No speculation, no advice, no questions.",
	"Output plain prose, no markdown headers.",
].join("\n");

const SWIFT_OCR = `import Foundation
import Vision
import ImageIO

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: ocr <image-path>\\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1]) as CFURL
guard let source = CGImageSourceCreateWithURL(url, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  FileHandle.standardError.write("error: cannot load image\\n".data(using: .utf8)!)
  exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if #available(macOS 12.0, *) {
  request.automaticallyDetectsLanguage = true
}
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do { try handler.perform([request]) } catch {
  FileHandle.standardError.write("error: \\(error)\\n".data(using: .utf8)!)
  exit(1)
}
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\\n"))
`;

type Model = NonNullable<ExtensionContext["model"]>;
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ImageItem = { data: string; mimeType: string; ocrPath?: string; path?: string };

/** Pinned default describer: Claude Haiku 4.5 (EU Bedrock). Override with IMAGE_EYES_MODEL="provider/model-id". */
const DEFAULT_VISION = { provider: "amazon-bedrock", id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" };

/** Recently seen images, keyed by short id, so the `look` tool can re-examine them. */
const imageStore = new Map<string, { data: string; mimeType: string }>();
let imageCounter = 0;
function storeImage(item: ImageItem): string {
	const id = `img${++imageCounter}`;
	imageStore.set(id, { data: item.data, mimeType: item.mimeType });
	if (imageStore.size > 20) {
		const oldest = imageStore.keys().next().value;
		if (oldest !== undefined) imageStore.delete(oldest);
	}
	return id;
}
function lastImage(): { data: string; mimeType: string } | undefined {
	return imageCounter > 0 ? imageStore.get(`img${imageCounter}`) : undefined;
}

let ocrTool: "mac-ocr" | "swift" | undefined;
let ocrScriptPath: string | undefined;
let ocrDisabled = false;

async function detectOcr(): Promise<void> {
	try {
		await pExecFile("which", ["mac-ocr"]);
		ocrTool = "mac-ocr";
		return;
	} catch {
		// fall through to swift
	}
	try {
		await pExecFile("which", ["swift"]);
		const dir = join(homedir(), ".pi", "agent", "cache");
		await mkdir(dir, { recursive: true });
		ocrScriptPath = join(dir, "image-eyes-ocr.swift");
		await writeFile(ocrScriptPath, SWIFT_OCR, "utf8");
		ocrTool = "swift";
	} catch {
		ocrDisabled = true;
	}
}

/** Best-effort local OCR on a file path. Returns undefined when unavailable or empty. */
async function ocrImage(filePath: string): Promise<string | undefined> {
	if (ocrDisabled || !ocrTool) return undefined;
	try {
		const { stdout } =
			ocrTool === "mac-ocr"
				? await pExecFile("mac-ocr", [filePath], { timeout: 30_000 })
				: await pExecFile("swift", [ocrScriptPath!, filePath], { timeout: 30_000 });
		const text = stdout.trim();
		return text.length > 0 ? text : undefined;
	} catch {
		ocrDisabled = true; // don't keep retrying a broken OCR path
		return undefined;
	}
}

function pickVisionModel(ctx: ExtensionContext): Model | undefined {
	const override = process.env.IMAGE_EYES_MODEL;
	if (override) {
		const slash = override.indexOf("/");
		if (slash > 0) {
			const m = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
			if (m?.input.includes("image")) return m;
		}
	}
	const pinned = ctx.modelRegistry.find(DEFAULT_VISION.provider, DEFAULT_VISION.id);
	if (pinned?.input.includes("image") && ctx.modelRegistry.hasConfiguredAuth(pinned)) return pinned;
	const vision = ctx.modelRegistry
		.getAvailable()
		.filter((m) => m.input.includes("image") && ctx.modelRegistry.hasConfiguredAuth(m));
	if (vision.length === 0) return undefined;
	// Prefer cheap fast models when several are available
	return vision.find((m) => /flash|haiku|vl|mini|lite|nano/i.test(m.id)) ?? vision[0];
}

function buildDescribePrompt(focus?: string): string {
	if (!focus) return DESCRIBE_PROMPT;
	return [
		"You are the eyes of an AI coding assistant whose current model cannot see images.",
		`The user is specifically asking: "${focus}"`,
		"Describe the image to answer that goal precisely — give the layout, position, colors, sizes, and text of the relevant parts.",
		"Also include a brief summary of the overall layout and any other significant elements so nothing important is lost.",
		"Report only what is actually visible. No speculation, no advice. Plain prose, no markdown headers.",
	].join("\n");
}

async function describeWithVision(
	img: { data: string; mimeType: string },
	visionModel: Model,
	ctx: ExtensionContext,
	focus?: string,
): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
	try {
		const message = await ctx.modelRegistry.complete(
			visionModel,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: img.data, mimeType: img.mimeType },
							{ type: "text", text: buildDescribePrompt(focus) },
						],
					},
				],
			} as any,
			{ signal: controller.signal } as any,
		);
		const text = message.content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n")
			.trim();
		if (!text) throw new Error("vision model returned empty description");
		return text;
	} finally {
		clearTimeout(timer);
	}
}

async function imageToText(
	item: ImageItem,
	index: number,
	total: number,
	visionModel: Model | undefined,
	ctx: ExtensionContext,
	focus?: string,
): Promise<string> {
	const header = `[Image ${index}/${total} — the active model (${ctx.model?.provider}/${ctx.model?.id}) cannot see images, so it was converted to text]`;

	// OCR needs a file on disk. Path inputs already have one; attachments get a temp file.
	let ocrText: string | undefined;
	try {
		const tmp = item.ocrPath ?? join(tmpdir(), `image-eyes-${Date.now()}-${index}${MIME_EXT[item.mimeType] ?? ".img"}`);
		if (!item.ocrPath) await writeFile(tmp, Buffer.from(item.data, "base64"));
		ocrText = await ocrImage(tmp);
	} catch {
		// OCR is best-effort
	}

	let description: string | undefined;
	let visionError: string | undefined;
	if (visionModel) {
		try {
			description = await describeWithVision(item, visionModel, ctx, focus);
		} catch (err) {
			visionError = err instanceof Error ? err.message : String(err);
		}
	}

	const parts = [header];
	if (description) {
		parts.push(`\n[Visual description via ${visionModel!.provider}/${visionModel!.id}]\n${description}`);
	} else if (visionError) {
		parts.push(`\n[Visual description unavailable: ${visionError}]`);
	} else {
		parts.push("\n[No vision-capable model available — OCR only]");
	}
	if (ocrText) {
		parts.push(`\n[Exact text extracted via local OCR — trust these strings verbatim over the description]\n${ocrText}`);
	}
	const id = storeImage(item);
	parts.push(`[/Image ${index}/${total}]`);
	parts.push(`\n[To re-examine a detail this description may have missed (a color, position, button, or text), call the \`look\` tool with image_id "${id}" and your question.]`);
	return parts.join("\n");
}

/** Find image file paths (absolute / ~ / ./ / ../) inside the input text. */
function extractImagePaths(text: string): { path: string; mimeType: string }[] {
	const out: { path: string; mimeType: string }[] = [];
	const seen = new Set<string>();
	const re = /((?:~\/|\/|\.\.?\/)[^\s"'`()<>;&|]+\.(png|jpe?g|webp|gif|bmp))/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		let p = m[1];
		if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
		p = p.replace(/[),.;:]+$/, ""); // strip trailing punctuation added by a sentence
		const mimeType = MIME_BY_EXT[m[2].toLowerCase()];
		if (!mimeType || seen.has(p)) continue;
		seen.add(p);
		out.push({ path: p, mimeType });
	}
	return out;
}

async function readImageFile(path: string, mimeType: string): Promise<ImageItem> {
	const s = await stat(path);
	if (!s.isFile()) throw new Error(`${path} is not a file`);
	if (s.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
	const buf = await readFile(path);
	return { data: buf.toString("base64"), mimeType, ocrPath: path, path };
}

export default function (pi: ExtensionAPI) {
	void detectOcr();

	pi.registerCommand("look", {
		description: "Describe an image file (OCR + vision model) so a text-only model can see it.",
		handler: async (args, ctx) => {
			let path = (args ?? "").trim().replace(/^["']|["']$/g, "");
			const ext = path.toLowerCase().match(/\.(png|jpe?g|webp|gif|bmp)$/)?.[1];
			if (!path || !ext) {
				ctx.ui.notify("Usage: /look <image-path> (png/jpg/webp/gif/bmp)", "error");
				return;
			}
			if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
			ctx.ui.notify("\ud83d\udc41 Looking at image…", "info");
			ctx.ui.setStatus("image-eyes", "looking at image…");
			try {
				const visionModel = pickVisionModel(ctx);
				const item = await readImageFile(path, MIME_BY_EXT[ext]);
				const desc = await imageToText(item, 1, 1, visionModel, ctx, undefined);
				ctx.ui.setStatus("image-eyes", undefined);
				await pi.sendUserMessage(desc);
			} catch (err) {
				ctx.ui.setStatus("image-eyes", undefined);
				ctx.ui.notify(`/look failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "look",
		label: "Look",
		description: "Re-examine an image that was converted to text earlier in this session, answering a specific question about it (a color, position, label, button, or text the initial description may have omitted). Use image_id from that image's description block, or omit it to look at the most recent image.",
		parameters: Type.Object({
			question: Type.String({ description: "The specific question to answer about the image" }),
			image_id: Type.Optional(Type.String({ description: "Image id from the description block (e.g. img1); omit for the most recent image" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const item = params.image_id ? imageStore.get(params.image_id) : lastImage();
			if (!item) throw new Error("No image with that id is available (it may have been evicted). Re-paste the image.");
			const visionModel = pickVisionModel(ctx);
			const answer = await describeWithVision(item, visionModel, ctx, params.question);
			return { content: [{ type: "text", text: answer }] };
		},
	});

	pi.on("input", async (event, ctx) => {
		const textOnly = !ctx.model?.input.includes("image");
		if (!textOnly) return { action: "continue" as const };

		const attached = (event.images as ImageBlock[] | undefined) ?? [];
		const paths = extractImagePaths(event.text);

		if (attached.length === 0 && paths.length === 0) return { action: "continue" as const };

		const visionModel = pickVisionModel(ctx);
		if (!visionModel && ocrDisabled) {
			ctx.ui.notify("image-eyes: no vision model and OCR unavailable — images will be dropped", "warning");
		}

		// Assemble combined item list: attachments first, then detected paths (read from disk).
		const items: ImageItem[] = attached.map((img) => ({ data: img.data, mimeType: img.mimeType }));
		const failedPaths: { path: string; reason: string }[] = [];
		for (const p of paths) {
			try {
				items.push(await readImageFile(p.path, p.mimeType));
			} catch (err) {
				failedPaths.push({ path: p.path, reason: err instanceof Error ? err.message : String(err) });
			}
		}

		let focus = event.text;
		for (const p of paths) focus = focus.split(p.path).join(" ");
		const trimmedFocus = focus.trim();
		const focusQuery = trimmedFocus.length > 0 ? trimmedFocus : undefined;

		const toProcess = items.slice(0, MAX_IMAGES);
		if (toProcess.length > 0) ctx.ui.notify(`\ud83d\udc41 Looking at ${toProcess.length} image${toProcess.length > 1 ? "s" : ""}…`, "info");
		const descriptions: string[] = [];
		let i = 0;
		for (const item of toProcess) {
			i++;
			ctx.ui.setStatus("image-eyes", `looking at image ${i}/${toProcess.length}…`);
			descriptions.push(await imageToText(item, i, items.length, visionModel, ctx, focusQuery));
		}
		ctx.ui.setStatus("image-eyes", undefined);
		if (items.length > MAX_IMAGES) {
			descriptions.push(`[Note: ${items.length - MAX_IMAGES} further image(s) were skipped (limit ${MAX_IMAGES})]`);
		}

		// Replace path tokens inline; append attachment descriptions at the end.
		let text = event.text;
		for (let k = 0; k < toProcess.length; k++) {
			const it = toProcess[k];
			if (it.path && text.includes(it.path)) {
				text = text.split(it.path).join(descriptions[k]);
			} else {
				text = (text.trim() ? text + "\n\n" : "") + descriptions[k];
			}
		}
		for (const f of failedPaths) {
			if (text.includes(f.path)) {
				text = text.split(f.path).join(`[Image at ${f.path} could not be read: ${f.reason}]`);
			}
		}

		return { action: "transform" as const, text, images: [] };
	});
}