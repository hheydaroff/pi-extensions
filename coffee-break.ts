import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, ChildProcess } from "child_process";
import { platform } from "os";

export default function (pi: ExtensionAPI) {
  let caffeinateProcess: ChildProcess | null = null;
  const os = platform(); // "darwin" | "linux" | "win32"

  function startCaffeinate() {
    if (caffeinateProcess) return;

    switch (os) {
      case "darwin":
        // macOS: caffeinate prevents sleep
        caffeinateProcess = spawn("caffeinate", ["-dims"], {
          stdio: "ignore",
          detached: false,
        });
        break;

      case "linux":
        // Linux: systemd-inhibit blocks sleep while the child (sleep infinity) runs
        // When we kill it, the inhibit lock is released
        caffeinateProcess = spawn(
          "systemd-inhibit",
          [
            "--what=idle:sleep:handle-lid-switch",
            "--who=pi-coffee-break",
            "--why=Pi agent is working",
            "sleep", "infinity",
          ],
          { stdio: "ignore", detached: false }
        );

        // Fallback: if systemd-inhibit isn't available, try gnome-session-inhibit
        caffeinateProcess.on("error", () => {
          caffeinateProcess = spawn(
            "gnome-session-inhibit",
            ["--inhibit", "idle:suspend", "--reason", "Pi agent is working", "sleep", "infinity"],
            { stdio: "ignore", detached: false }
          );
          caffeinateProcess.on("error", () => {
            caffeinateProcess = null;
          });
          caffeinateProcess.on("exit", () => {
            caffeinateProcess = null;
          });
        });
        break;

      case "win32":
        // Windows: PowerShell call to SetThreadExecutionState
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED = 0x80000003
        // Runs in a loop to keep refreshing the state until killed
        caffeinateProcess = spawn(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SleepUtil {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@;
[SleepUtil]::SetThreadExecutionState(0x80000003);
while ($true) { Start-Sleep -Seconds 30; [SleepUtil]::SetThreadExecutionState(0x80000003); }
            `.trim(),
          ],
          { stdio: "ignore", detached: false, windowsHide: true }
        );
        break;

      default:
        return; // unsupported OS, silently do nothing
    }

    caffeinateProcess?.on("exit", () => {
      caffeinateProcess = null;
    });
  }

  function stopCaffeinate() {
    if (!caffeinateProcess) return;

    if (os === "win32") {
      // On Windows, kill the PowerShell process tree
      spawn("taskkill", ["/PID", String(caffeinateProcess.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      caffeinateProcess.kill("SIGTERM");
    }

    caffeinateProcess = null;
  }

  // Start when agent begins working
  pi.on("agent_start", async () => {
    startCaffeinate();
  });

  // Stop when agent turn ends — your Mac/PC/Linux box can sleep again
  pi.on("turn_end", async () => {
    stopCaffeinate();
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", async () => {
    stopCaffeinate();
  });

  // Also stop if session switches
  pi.on("session_switch", async () => {
    stopCaffeinate();
  });
}
