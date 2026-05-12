/**
 * btw — Pi Extension
 *
 * Ask a quick aside question without polluting the main conversation context.
 * Inspired by Claude Code's /btw command.
 *
 * Usage: /btw what does the retry logic do?
 *
 * The question is answered using the current model with recent conversation
 * context, then shown in a dismissible floating overlay.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ── System prompt for the aside AI call ────────────────────────────────────────
const BTW_SYSTEM_PROMPT = `You are a concise inline assistant answering quick aside questions during a coding session.
The user is working with an AI coding agent and has a quick question they want answered without derailing the main task.
Keep your answer short and direct (1–5 sentences). Only elaborate if the question genuinely requires it.
Use plain text — no markdown headers, no bullet lists unless truly necessary.
You may reference the conversation context provided if it is relevant.`;

// ── Context extraction ──────────────────────────────────────────────────────────
function buildContext(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const MAX_ENTRIES = 12;
	const MAX_TEXT = 400; // chars per message
	const recentMessages: string[] = [];

	for (const entry of branch.slice(-MAX_ENTRIES)) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!("role" in msg)) continue;

		if (msg.role === "user") {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.slice(0, MAX_TEXT);
			if (text.trim()) recentMessages.push(`User: ${text}`);
		} else if (msg.role === "assistant") {
			const text = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.slice(0, MAX_TEXT);
			if (text.trim()) recentMessages.push(`Assistant: ${text}`);
		}
	}

	if (recentMessages.length === 0) return "";
	return `\n\nRecent conversation context (for reference):\n${recentMessages.join("\n\n")}`;
}

// ── Text wrapping helper ────────────────────────────────────────────────────────
function wrapText(text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph.trim() === "") {
			lines.push("");
			continue;
		}
		const words = paragraph.split(" ");
		let current = "";
		for (const word of words) {
			if (current === "") {
				current = word;
			} else if (visibleWidth(current) + 1 + visibleWidth(word) <= maxWidth) {
				current += " " + word;
			} else {
				lines.push(current);
				current = word;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

// ── Combined loading → result overlay component ────────────────────────────────
type BtwState = { phase: "loading" } | { phase: "result"; answer: string } | { phase: "error"; message: string };

class BtwOverlay {
	private state: BtwState = { phase: "loading" };
	private abort = new AbortController();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private question: string,
		private done: () => void,
		runQuery: (signal: AbortSignal) => Promise<string>,
	) {
		runQuery(this.abort.signal).then(
			(answer) => {
				this.state = { phase: "result", answer };
				this.tui.requestRender(); // Trigger re-render to show result
			},
			(err: unknown) => {
				if (this.abort.signal.aborted) return; // user cancelled — don't update state
				this.state = { phase: "error", message: String(err) };
				this.tui.requestRender(); // Trigger re-render to show error
			},
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.abort.abort();
			this.done();
			return;
		}
		// Dismiss result/error with Space or Enter
		if (this.state.phase !== "loading") {
			if (matchesKey(data, "return") || matchesKey(data, "space")) {
				this.done();
			}
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		const row = (content: string) =>
			th.fg("border", "│") + truncateToWidth(content, innerW, "...", true) + th.fg("border", "│");

		// Top border with title
		const title = " /btw ";
		const titleW = visibleWidth(title);
		const leftDash = Math.floor((innerW - titleW) / 2);
		const rightDash = Math.max(0, innerW - titleW - leftDash);
		lines.push(
			th.fg("border", "╭" + "─".repeat(leftDash)) +
				th.fg("accent", title) +
				th.fg("border", "─".repeat(rightDash) + "╮"),
		);

		// Question line
		lines.push(row(""));
		lines.push(row(` ${th.fg("accent", this.question)}`));
		lines.push(row(""));

		if (this.state.phase === "loading") {
			// Simple animated dots via static text (re-render called on state change)
			lines.push(row(` ${th.fg("muted", "Thinking…")}`));
			lines.push(row(""));
			lines.push(row(` ${th.fg("dim", "Esc to cancel")}`));
		} else if (this.state.phase === "result") {
			const wrapped = wrapText(this.state.answer, innerW - 2);
			for (const line of wrapped) {
				lines.push(row(` ${th.fg("text", line)}`));
			}
			lines.push(row(""));
			lines.push(row(` ${th.fg("dim", "Press Space, Enter, or Escape to dismiss")}`));
		} else {
			lines.push(row(` ${th.fg("error", "Error: " + this.state.message)}`));
			lines.push(row(""));
			lines.push(row(` ${th.fg("dim", "Press Space, Enter, or Escape to dismiss")}`));
		}

		lines.push(th.fg("border", "╰" + "─".repeat(innerW) + "╯"));

		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.abort.abort();
	}
}

// ── Extension entry point ───────────────────────────────────────────────────────
export default function btw(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a quick aside question without affecting the main conversation",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected — cannot run /btw", "error");
				return;
			}

			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <your question>", "warning");
				return;
			}

			// Snapshot context before opening the overlay
			const contextSection = buildContext(ctx);

			// Run the LLM call + show result, all inside one overlay
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const runQuery = async (signal: AbortSignal): Promise<string> => {
						const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
						if (!auth.ok || !auth.apiKey) {
							throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
						}
						const userMessage: UserMessage = {
							role: "user",
							content: [{ type: "text", text: question }],
							timestamp: Date.now(),
						};
						const systemPrompt = BTW_SYSTEM_PROMPT + contextSection;
						const response = await complete(
							ctx.model!,
							{ systemPrompt, messages: [userMessage] },
							{ apiKey: auth.apiKey, headers: auth.headers, signal },
						);
						if (response.stopReason === "aborted") {
							throw new DOMException("Aborted", "AbortError");
						}
						return response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");
					};

					return new BtwOverlay(tui, theme, question, done, runQuery);
				},
				{ overlay: true, overlayOptions: { anchor: "bottom-center", width: 70, margin: { bottom: 2 } } },
			);
		},
	});
}
