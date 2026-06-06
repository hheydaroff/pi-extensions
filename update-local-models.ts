import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODELS_PATH = join(homedir(), ".pi", "agent", "models.json");
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type ModelEntry = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
  compat?: Record<string, unknown>;
  [k: string]: unknown;
};

type Provider = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  [k: string]: unknown;
};

type ModelsFile = { providers?: Record<string, Provider>; [k: string]: unknown };

/**
 * Resolve a models.json secret value: "!cmd" runs a shell command,
 * "$VAR"/"${VAR}" interpolates env vars, "$$"/"$!" are literal escapes.
 */
function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$$")) return "$" + value.slice(2);
  if (value.startsWith("$!")) return "!" + value.slice(2);
  if (value.startsWith("!")) {
    try {
      return execSync(value.slice(1), { encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  }
  if (value.includes("$")) {
    return value
      .replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "")
      .replace(/\$(\w+)/g, (_, n) => process.env[n] ?? "");
  }
  return value;
}

/** Query an OpenAI-compatible /models endpoint and return reported model IDs. */
async function fetchModelIds(
  provider: Provider,
  signal?: AbortSignal,
): Promise<string[]> {
  const base = (provider.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return [];
  const url = `${base}/models`;

  const headers: Record<string, string> = { Accept: "application/json" };
  const key = resolveSecret(provider.apiKey);
  if (key) headers["Authorization"] = `Bearer ${key}`;
  for (const [h, v] of Object.entries(provider.headers ?? {})) {
    const resolved = resolveSecret(v);
    if (resolved) headers[h] = resolved;
  }

  const res = await fetch(url, {
    headers,
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };
  const list = body.data ?? body.models ?? [];
  return list
    .map((m) => m.id ?? (m as { name?: string }).name)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Build a new model entry, copying defaults from a sibling model when available. */
function buildEntry(id: string, template?: ModelEntry): ModelEntry {
  if (template) {
    const entry: ModelEntry = {
      id,
      name: id,
      reasoning: template.reasoning ?? false,
      input: template.input ?? ["text"],
      contextWindow: template.contextWindow ?? 131072,
      maxTokens: template.maxTokens ?? 32768,
      cost: { ...ZERO_COST, ...(template.cost ?? {}) },
    };
    if (template.compat) entry.compat = { ...template.compat };
    return entry;
  }
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { ...ZERO_COST },
  };
}

type Plan = {
  provider: string;
  missing: string[];
  removed?: string[];
  error?: string;
  scanned: boolean;
};

async function scan(
  file: ModelsFile,
  signal?: AbortSignal,
): Promise<Plan[]> {
  const plans: Plan[] = [];
  const providers = file.providers ?? {};

  for (const [name, provider] of Object.entries(providers)) {
    // Only manage providers that already maintain a custom model list
    // (skips built-in overrides like a bare amazon-bedrock baseUrl).
    if (!Array.isArray(provider.models)) continue;
    if (!provider.baseUrl) continue;

    const existing = new Set(provider.models.map((m) => m.id));
    try {
      const reported = await fetchModelIds(provider, signal);
      const missing = reported.filter((id) => !existing.has(id));
      const removed = provider.models
        .filter((m) => !reported.includes(m.id))
        .map((m) => m.id);
      plans.push({ provider: name, missing, removed, scanned: true });
    } catch (err) {
      plans.push({
        provider: name,
        missing: [],
        removed: [],
        scanned: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return plans;
}

function applyPlans(file: ModelsFile, plans: Plan[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const providers = file.providers ?? {};
  for (const plan of plans) {
    if (!plan.scanned) continue;

    // Add missing models
    if (plan.missing.length > 0) {
      const provider = providers[plan.provider];
      if (provider?.models) {
        const template = provider.models[0];
        for (const id of plan.missing) {
          provider.models.push(buildEntry(id, template));
          added++;
        }
      }
    }

    // Remove stale models no longer reported by the server
    if (plan.removed?.length > 0) {
      const provider = providers[plan.provider];
      if (provider?.models) {
        const before = provider.models.length;
        provider.models = provider.models.filter((m) => !plan.removed.includes(m.id));
        removed += before - provider.models.length;
      }
    }
  }
  return { added, removed };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("update-local-models", {
    description:
      "Discover models from each local provider's /models endpoint and add missing ones to models.json",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const checkOnly = args.trim().toLowerCase() === "check";

      if (!existsSync(MODELS_PATH)) {
        ctx.ui.notify(`No models.json found at ${MODELS_PATH}`, "error");
        return;
      }

      let file: ModelsFile;
      try {
        file = JSON.parse(readFileSync(MODELS_PATH, "utf8")) as ModelsFile;
      } catch (err) {
        ctx.ui.notify(
          `Failed to parse models.json: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }

      ctx.ui.setStatus("update-models", "Querying providers…");
      const plans = await scan(file, ctx.signal);
      ctx.ui.setStatus("update-models", "");

      const lines: string[] = [];
      for (const p of plans) {
        if (!p.scanned) {
          lines.push(`✗ ${p.provider}: unreachable (${p.error})`);
        } else if (p.missing.length === 0 && !p.removed?.length) {
          lines.push(`✓ ${p.provider}: up to date`);
        } else {
          const parts: string[] = [];
          if (p.missing.length > 0) parts.push(`${p.missing.length} new`);
          if (p.removed?.length > 0) parts.push(`${p.removed.length} removed`);
          lines.push(`+ ${p.provider}: ${parts.join(", ")}`);
          for (const id of p.missing) lines.push(`    • + ${id}`);
          for (const id of p.removed ?? []) lines.push(`    • − ${id}`);
        }
      }

      if (plans.length === 0) {
        ctx.ui.notify(
          "No providers with a custom 'models' list found in models.json.",
          "info",
        );
        return;
      }

      const totalMissing = plans.reduce((n, p) => n + p.missing.length, 0);
      const totalRemoved = plans.reduce((n, p) => n + (p.removed?.length ?? 0), 0);
      const totalChanges = totalMissing + totalRemoved;

      if (totalChanges === 0) {
        ctx.ui.notify(`All local models up to date.\n${lines.join("\n")}`, "info");
        return;
      }

      if (checkOnly) {
        const parts: string[] = [];
        if (totalMissing > 0) parts.push(`${totalMissing} new`);
        if (totalRemoved > 0) parts.push(`${totalRemoved} removed`);
        ctx.ui.notify(
          `${parts.join(" + ")} available (check only):\n${lines.join("\n")}`,
          "info",
        );
        return;
      }

      if (ctx.hasUI) {
        const parts: string[] = [];
        if (totalMissing > 0) parts.push(`${totalMissing} new`);
        if (totalRemoved > 0) parts.push(`${totalRemoved} removed`);
        const ok = await ctx.ui.confirm(
          `Sync ${parts.join(" + ")} models in models.json?`,
          lines.join("\n"),
        );
        if (!ok) {
          ctx.ui.notify("Cancelled. No changes made.", "info");
          return;
        }
      }

      // Backup, then apply.
      try {
        copyFileSync(MODELS_PATH, `${MODELS_PATH}.bak`);
      } catch {
        // non-fatal
      }
      const { added, removed } = applyPlans(file, plans);
      writeFileSync(MODELS_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
      ctx.modelRegistry.refresh();

      const summary: string[] = [];
      if (added > 0) summary.push(`added ${added}`);
      if (removed > 0) summary.push(`removed ${removed}`);
      ctx.ui.notify(
        `Synced models.json (${summary.join(", ") || "no changes"}; backup: models.json.bak).`,
        "success",
      );
    },
    getArgumentCompletions: (prefix: string) => {
      const items = [{ value: "check", label: "check — report only, don't modify" }];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
  });
}
