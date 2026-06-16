/**
 * UV Extension - Redirects Python tooling to uv equivalents
 *
 * This extension wraps the bash tool to prepend intercepted-commands to PATH,
 * which contains shim scripts that intercept common Python tooling commands
 * and redirect agents to use uv instead.
 *
 * Intercepted commands:
 * - pip/pip3: Blocked with suggestions to use `uv add` or `uv run --with`
 * - poetry: Blocked with uv equivalents (uv init, uv add, uv sync, uv run)
 * - python/python3: Redirected through `uv run` to a real interpreter path,
 *   with special handling to block `python -m pip`, `python -m venv`, and
 *   `python -m py_compile`
 *
 * The shim scripts are located in the intercepted-commands directory and
 * provide helpful error messages with the equivalent uv commands.
 *
 * Note: PATH shims are bypassable via explicit interpreter paths
 * (for example `.venv/bin/python`). To close that gap, this extension also
 * blocks disallowed invocations at bash spawn time.
 */

import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "..", "intercepted-commands");

function getBlockedCommandMessage(command: string): string | null {
  // Match commands at the start of a shell segment (start/newline/; /&& /|| /|)
  const pipCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m;
  const pip3CommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m;
  const poetryCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m;

  // Match python invocations including explicit paths like .venv/bin/python
  // and .venv/bin/python3.12.
  const pythonPipPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m;
  const pythonVenvPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m;
  const pythonPyCompilePattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m;

  if (pipCommandPattern.test(command)) {
    return [
      "Error: pip is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pip3CommandPattern.test(command)) {
    return [
      "Error: pip3 is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (poetryCommandPattern.test(command)) {
    return [
      "Error: poetry is disabled. Use uv instead:",
      "",
      "  To initialize a project: uv init",
      "  To add a dependency: uv add PACKAGE",
      "  To sync dependencies: uv sync",
      "  To run commands: uv run COMMAND",
      "",
    ].join("\n");
  }

  if (pythonPipPattern.test(command)) {
    return [
      "Error: 'python -m pip' is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pythonVenvPattern.test(command)) {
    return [
      "Error: 'python -m venv' is disabled. Use uv instead:",
      "",
      "  To create a virtual environment: uv venv",
      "",
    ].join("\n");
  }

  if (pythonPyCompilePattern.test(command)) {
    return [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
      "",
    ].join("\n");
  }

  // Block python invoked via an explicit path (absolute or relative) or a
  // version-suffixed name. Both skip the PATH shim and run a bare interpreter
  // outside uv. (Bare `python`/`python3` are allowed — they resolve to the shim.)
  const explicitPathPython =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)python(?:3(?:\.\d+)?)?\b/m;
  const versionedPython = /(?:^|\n|[;|&]{1,2})\s*python3\.\d+\b/m;
  if (explicitPathPython.test(command) || versionedPython.test(command)) {
    return [
      "Error: running Python via an explicit path or a version-suffixed name bypasses uv.",
      "",
      "  Use plain `python3 ...` (uv-managed via PATH), or be explicit through uv:",
      "    uv run python script.py",
      "    uv run --python 3.12 python script.py   # to pin a specific version",
      "",
    ].join("\n");
  }

  // Block direct execution of a .py file as the command (its shebang would run
  // a bare interpreter). Only matches when the .py file is the command itself,
  // not an argument (so `cat foo.py` and `python3 foo.py` stay allowed).
  const directPyScript = /(?:^|\n|[;|&]{1,2})\s*(?:\.?\/)?[^\s;|&]*\.py\b/m;
  if (directPyScript.test(command)) {
    return [
      "Error: executing a .py file directly bypasses uv (it runs via the script's shebang).",
      "",
      "  Run it through uv instead: uv run python path/to/script.py",
      "",
    ].join("\n");
  }

  return null;
}

/**
 * Detect missing-module failures in command output and return a nudge that
 * tells the agent to re-run through uv with the package made available.
 *
 * The PATH shim lets bare `python3` route through `uv run`, but uv only manages
 * the *interpreter* — it does not install third-party packages. So
 * `python3 -m markitdown` (or `import markitdown`) runs in a clean base env and
 * fails with a raw ModuleNotFoundError instead of a helpful "use uv" message.
 * The extension can't pre-block this (it can't distinguish stdlib `-m` modules
 * like json.tool/http.server from third-party ones), so we catch it after the
 * fact and append actionable guidance.
 */
function getMissingModuleHint(text: string): string | null {
  // `import foo` -> ModuleNotFoundError: No module named 'foo'
  // `python -m foo` -> <interpreter>: No module named foo
  const quoted = /ModuleNotFoundError: No module named ['"]([^'".]+)/;
  const bare = /: No module named ([A-Za-z0-9_]+)/;
  const match = text.match(quoted) ?? text.match(bare);
  if (!match) return null;
  const pkg = match[1];
  if (!pkg) return null;

  return [
    "",
    `\u26A0\uFE0F uv hint: module '${pkg}' is not available in the uv-managed base interpreter.`,
    "Bare `python3` routes through uv but does NOT install third-party packages. Re-run with the package made available:",
    "",
    `  uv run --with ${pkg} python ...      # one-off, ephemeral env`,
    `  uv add ${pkg}                        # add as a project dependency, then: uv run python ...`,
    "",
    "(The import/module name may differ from the PyPI package name; adjust if needed.)",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const bashTool = createBashTool(cwd, {
    commandPrefix: `export PATH="${interceptedCommandsPath}:$PATH"`,
    spawnHook: (ctx) => {
      const blockedMessage = getBlockedCommandMessage(ctx.command);
      if (blockedMessage) {
        throw new Error(blockedMessage);
      }
      return ctx;
    },
  });

  pi.registerTool(bashTool);

  // Append a uv nudge when a command fails due to a missing Python module.
  pi.on("tool_result", async (event: ToolResultEvent) => {
    try {
      if (event.toolName !== bashTool.name) return;
      const blocks = event.content as { type: string; text?: string }[];
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      if (!text) return;

      const hint = getMissingModuleHint(text);
      if (!hint) return;
      // Avoid double-appending if the hint is already present.
      if (text.includes("uv hint: module")) return;

      const kept = blocks.filter((b) => b.type !== "text");
      return {
        content: [...(kept as any), { type: "text", text: `${text}\n${hint}` }],
      };
    } catch {
      // Fail-open: never lose output because of the hint.
      return;
    }
  });
}
