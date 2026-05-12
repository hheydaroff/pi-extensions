import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Cron Scheduler — Schedule recurring and one-shot tasks.
 *
 * Jobs persist in ~/.pi/agent/cron-jobs.json across restarts.
 * When a job triggers, it sends a prompt to pi as a Signal message
 * so the response goes back to your phone.
 *
 * Cron format: "minute hour day month weekday" (standard 5-field)
 *   - Use * for any, star/N for every N, comma-separated values
 *   - Examples: "0 9 * * *" = every day at 9am
 *                "star/30 * * * *" = every 30 minutes
 *                "0 9 * * 1-5" = weekdays at 9am
 *   - Special: "once" = run once then auto-remove
 */

const JOBS_FILE = `${process.env.HOME}/.pi/agent/cron-jobs.json`;

interface CronJob {
  id: string;
  name: string;
  schedule: string;           // cron expression or "once"
  prompt: string;             // what to send to the agent
  signalRecipient?: string;   // phone number to route response to
  enabled: boolean;
  lastRun?: string;           // ISO date
  createdAt: string;
  runOnceAt?: string;         // ISO date for "once" jobs
}

// ─── Cron Parsing ───────────────────────────────────────────────────────────

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (part === "*") {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (stepMatch) {
      const step = parseInt(stepMatch[2]);
      let start = min;
      let end = max;
      if (stepMatch[1] !== "*") {
        const rm = stepMatch[1].match(/^(\d+)(?:-(\d+))?$/);
        if (rm) { start = parseInt(rm[1]); if (rm[2]) end = parseInt(rm[2]); }
      }
      for (let i = start; i <= end; i += step) values.push(i);
    } else if (rangeMatch) {
      const s = parseInt(rangeMatch[1]), e = parseInt(rangeMatch[2]);
      for (let i = s; i <= e; i++) values.push(i);
    } else {
      const n = parseInt(part);
      if (!isNaN(n)) values.push(n);
    }
  }
  return values;
}

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, dayF, monthF, wdayF] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const wday = date.getDay(); // 0=Sun

  return (
    parseCronField(minF, 0, 59).includes(minute) &&
    parseCronField(hourF, 0, 23).includes(hour) &&
    parseCronField(dayF, 1, 31).includes(day) &&
    parseCronField(monthF, 1, 12).includes(month) &&
    parseCronField(wdayF, 0, 6).includes(wday)
  );
}

// ─── Persistence ────────────────────────────────────────────────────────────

function loadJobs(): CronJob[] {
  try {
    const fs = require("fs");
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveJobs(jobs: CronJob[]) {
  const fs = require("fs");
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let jobs: CronJob[] = loadJobs();
  let tickTimer: any = null;
  let lastTickMinute = -1;

  // Find Signal recipient from config
  function getSignalRecipient(): string | null {
    try {
      const fs = require("fs");
      const configPath = `${process.env.HOME}/.pi/.secrets/signal-bridge.json`;
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (config.allowedContacts && config.allowedContacts.length > 0) {
          return config.allowedContacts[0];
        }
      }
    } catch {}
    return null;
  }

  // ── Tick — runs every 30s, fires matching jobs ──────────────────────────

  function startTicker() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      const now = new Date();
      const currentMinute = now.getHours() * 60 + now.getMinutes();
      if (currentMinute === lastTickMinute) return; // only fire once per minute
      lastTickMinute = currentMinute;

      const toRemove: string[] = [];

      for (const job of jobs) {
        if (!job.enabled) continue;

        // "once" jobs — check if it's time
        if (job.schedule === "once" && job.runOnceAt) {
          const target = new Date(job.runOnceAt);
          if (now >= target) {
            fireJob(job);
            toRemove.push(job.id);
          }
          continue;
        }

        // Cron jobs
        if (cronMatches(job.schedule, now)) {
          fireJob(job);
          job.lastRun = now.toISOString();
        }
      }

      // Remove one-shot jobs that fired
      if (toRemove.length > 0) {
        jobs = jobs.filter(j => !toRemove.includes(j.id));
        saveJobs(jobs);
      }
    }, 30_000);

    if (tickTimer.unref) tickTimer.unref();
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function fireJob(job: CronJob) {
    const recipient = job.signalRecipient || getSignalRecipient();
    if (recipient) {
      // Route through Signal so response goes to phone
      pi.sendUserMessage(
        `[Signal message from ${recipient}]: [Scheduled: ${job.name}] ${job.prompt}`,
        { deliverAs: "followUp" }
      );
    } else {
      // No Signal — just run as a regular prompt
      pi.sendUserMessage(
        `[Scheduled: ${job.name}] ${job.prompt}`,
        { deliverAs: "followUp" }
      );
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  pi.on("session_start", async () => {
    jobs = loadJobs();
    startTicker();
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
  });

  // ── Tool ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "cron_schedule",
    label: "Cron Schedule",
    description: "Manage scheduled tasks. Jobs run on a cron schedule and send results via Signal.",
    promptSnippet: "Schedule recurring or one-shot tasks with cron expressions",
    promptGuidelines: [
      "When the user asks to be reminded or wants recurring tasks, use cron_schedule to set them up.",
      "Common schedules: '0 9 * * *' (daily 9am), '*/30 * * * *' (every 30min), '0 9 * * 1-5' (weekdays 9am).",
      "For one-time reminders, use schedule 'once' with runOnceAt in ISO format.",
      "Always confirm the schedule with the user before creating.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("add"),
        Type.Literal("list"),
        Type.Literal("remove"),
        Type.Literal("toggle"),
      ], { description: "add: create job. list: show all. remove: delete by id. toggle: enable/disable by id." }),
      name: Type.Optional(Type.String({ description: "Job name (required for add)" })),
      schedule: Type.Optional(Type.String({ description: "Cron expression '* * * * *' or 'once' (required for add)" })),
      prompt: Type.Optional(Type.String({ description: "What to ask the agent when job fires (required for add)" })),
      id: Type.Optional(Type.String({ description: "Job ID (required for remove/toggle)" })),
      runOnceAt: Type.Optional(Type.String({ description: "ISO datetime for 'once' schedule, e.g. '2026-04-22T09:00:00'" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { action } = params;

      switch (action) {
        case "list": {
          if (jobs.length === 0) {
            return { content: [{ type: "text", text: "No scheduled jobs." }], details: { count: 0 } };
          }
          const lines = jobs.map(j => {
            const status = j.enabled ? "✅" : "⏸️";
            const last = j.lastRun ? ` (last: ${j.lastRun.split("T")[0]})` : "";
            return `${status} **${j.name}** [${j.id}] — \`${j.schedule}\`${last}\n   → ${j.prompt}`;
          });
          return {
            content: [{ type: "text", text: `## Scheduled Jobs (${jobs.length})\n\n${lines.join("\n\n")}` }],
            details: { count: jobs.length, jobs: jobs.map(j => ({ id: j.id, name: j.name, enabled: j.enabled })) },
          };
        }

        case "add": {
          if (!params.name || !params.schedule || !params.prompt) {
            return { content: [{ type: "text", text: "Error: name, schedule, and prompt are required." }], details: {}, isError: true };
          }
          // Validate cron expression
          if (params.schedule !== "once") {
            const parts = params.schedule.trim().split(/\s+/);
            if (parts.length !== 5) {
              return { content: [{ type: "text", text: "Error: cron must be 5 fields (minute hour day month weekday)" }], details: {}, isError: true };
            }
          }
          if (params.schedule === "once" && !params.runOnceAt) {
            return { content: [{ type: "text", text: "Error: runOnceAt is required for 'once' schedule." }], details: {}, isError: true };
          }
          const job: CronJob = {
            id: generateId(),
            name: params.name,
            schedule: params.schedule,
            prompt: params.prompt,
            signalRecipient: getSignalRecipient() || undefined,
            enabled: true,
            createdAt: new Date().toISOString(),
            runOnceAt: params.runOnceAt,
          };
          jobs.push(job);
          saveJobs(jobs);
          const when = params.schedule === "once"
            ? `once at ${params.runOnceAt}`
            : `cron: ${params.schedule}`;
          return {
            content: [{ type: "text", text: `✅ Job '${job.name}' created [${job.id}]\nSchedule: ${when}\nPrompt: ${job.prompt}` }],
            details: { id: job.id, name: job.name },
          };
        }

        case "remove": {
          if (!params.id) return { content: [{ type: "text", text: "Error: id is required." }], details: {}, isError: true };
          const idx = jobs.findIndex(j => j.id === params.id);
          if (idx === -1) return { content: [{ type: "text", text: `Job '${params.id}' not found.` }], details: {} };
          const removed = jobs.splice(idx, 1)[0];
          saveJobs(jobs);
          return {
            content: [{ type: "text", text: `🗑️ Removed job '${removed.name}' [${removed.id}]` }],
            details: { id: removed.id, name: removed.name },
          };
        }

        case "toggle": {
          if (!params.id) return { content: [{ type: "text", text: "Error: id is required." }], details: {}, isError: true };
          const job = jobs.find(j => j.id === params.id);
          if (!job) return { content: [{ type: "text", text: `Job '${params.id}' not found.` }], details: {} };
          job.enabled = !job.enabled;
          saveJobs(jobs);
          const status = job.enabled ? "enabled ✅" : "paused ⏸️";
          return {
            content: [{ type: "text", text: `Job '${job.name}' is now ${status}` }],
            details: { id: job.id, enabled: job.enabled },
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: {}, isError: true };
      }
    },
  });

  // ── Command ─────────────────────────────────────────────────────────────

  pi.registerCommand("cron", {
    description: "List, add, or remove scheduled jobs",
    handler: async (args, ctx) => {
      const sub = (args || "").trim();
      if (!sub || sub === "list") {
        if (jobs.length === 0) {
          ctx.ui.notify("No scheduled jobs.", "info");
        } else {
          const lines = jobs.map(j => {
            const s = j.enabled ? "✅" : "⏸️";
            return `${s} ${j.name} [${j.id}] — ${j.schedule}\n  → ${j.prompt}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
        }
      } else {
        ctx.ui.notify("/cron — list jobs\nUse the cron_schedule tool to add/remove/toggle jobs.", "info");
      }
    },
  });
}
