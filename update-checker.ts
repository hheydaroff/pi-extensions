import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHANGELOG_URL =
  "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md";

/**
 * Detect which package manager installed pi, and return the install command.
 */
function getInstallCommand(): string {
  const resolved = `${__dirname}\0${process.execPath || ""}`.toLowerCase();
  if (resolved.includes("/pnpm/") || resolved.includes("/.pnpm/"))
    return `pnpm install -g ${PACKAGE_NAME}`;
  if (resolved.includes("/yarn/") || resolved.includes("/.yarn/"))
    return `yarn global add ${PACKAGE_NAME}`;
  // default to npm
  return `npm install -g ${PACKAGE_NAME}`;
}

/**
 * Fetch the latest version from the npm registry.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(NPM_REGISTRY_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return data.version && data.version !== VERSION ? data.version : undefined;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return;
    if (!ctx.hasUI) return;

    const newVersion = await fetchLatestVersion();
    if (!newVersion) return;

    const choice = await ctx.ui.select(
      `Update available: ${VERSION} → ${newVersion}  (${CHANGELOG_URL})`,
      [
        "🚀 Update and restart now",
        "⏳ Update later",
      ]
    );

    if (choice === "🚀 Update and restart now") {
      const cmd = getInstallCommand();
      ctx.ui.notify(`Running: ${cmd}`, "info");

      const result = await pi.exec(cmd.split(" ")[0], cmd.split(" ").slice(1), {
        timeout: 120_000,
      });

      if (result.code === 0) {
        ctx.ui.notify(
          `Updated to v${newVersion}! Restarting pi...`,
          "success"
        );
        // Short delay so the user sees the message
        await new Promise((resolve) => setTimeout(resolve, 1500));
        ctx.shutdown();
      } else {
        ctx.ui.notify(
          `Update failed (exit ${result.code}): ${result.stderr || result.stdout}`,
          "error"
        );
      }
    }
    // "Update later" — do nothing, user continues normally
  });
}
