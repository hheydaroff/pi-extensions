import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

/**
 * /dream — manual memory consolidation. Engine: dream/dream.py (model only returns text; the
 * script validates and applies, one git commit per apply).
 *   /dream status            index size, archived count, model
 *   /dream plan              ~10 min in background; changes nothing; writes a report
 *   /dream apply             apply the latest plan (skips anything edited since)
 *   /dream model [id]        show or set the model (~/.pi/agent/dream/config.json)
 */
const HOME = os.homedir();
const SCRIPT = `${HOME}/development/pi-extensions/dream/dream.py`;
const STATE = `${HOME}/.pi/agent/dream`;

function run(args: string[]): Promise<string> {
	return new Promise((resolve) => {
		const p = spawn("uv", ["run", "python", SCRIPT, ...args]);
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("error", (e) => resolve(`failed to start: ${e.message}`));
		p.on("close", (code) => resolve(code === 0 ? out.trim() : `exit ${code}\n${out.trim().slice(-800)}`));
	});
}

export default function (pi: ExtensionAPI) {
	let planning = false;
	pi.registerCommand("dream", {
		description: "Consolidate pi-memory: /dream status | plan | apply | model [id]",
		handler: async (args, ctx) => {
			const [cmd = "status", ...rest] = args.trim().split(/\s+/);
			const say = (m: string, k: "info" | "error" = "info") => ctx.ui.notify(m, k);

			if (cmd === "status") return say(await run(["status"]));

			if (cmd === "model") {
				const id = rest[0];
				if (!id) return say((await run(["status"])).split("\n")[0]);
				fs.mkdirSync(STATE, { recursive: true });
				fs.writeFileSync(`${STATE}/config.json`, JSON.stringify({ model: id }) + "\n");
				return say(`dream model → ${id}`);
			}

			if (cmd === "plan") {
				if (planning) return say("a plan is already running", "error");
				planning = true;
				say("dream: planning in background (~10 min). Nothing will be changed.");
				run(["plan", "--force"]).then((out) => {
					planning = false;
					const rep = out.match(/^report: (.+)$/m)?.[1];
					const idx = out.split("\n").find((l) => l.startsWith("index")) ?? "";
					say(rep ? `${idx}\nReview: ${rep}\nThen: /dream apply` : out, rep ? "info" : "error");
				});
				return;
			}

			if (cmd === "apply") {
				if (planning) return say("plan still running", "error");
				const ok = await ctx.ui.confirm("Apply dream plan?", "Archives/merges notes per the latest plan and makes one git commit in the vault. Have you read the report?");
				if (!ok) return say("cancelled");
				return say(await run(["apply"]));
			}

			say("usage: /dream status | plan | apply | model [id]", "error");
		},
	});
}
