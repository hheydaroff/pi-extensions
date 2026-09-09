import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Cron Scheduler — Schedule recurring and one-shot tasks.
 *
 * Jobs persist in ~/.pi/agent/cron-jobs.json across restarts.
 * When a job triggers, it sends a prompt to pi as a Signal message
 * so the response goes back to your phone.
 *
 * Every open pi session runs a ticker against that one shared file, so two
 * things keep a job from misfiring:
 *   1. cron-home  — the one session jobs are supposed to run in (/cron home).
 *                   Other sessions stay out of it unless cron-home is closed,
 *                   in which case one of them runs the job as a fallback so it
 *                   is never silently skipped.
 *   2. claim file — O_EXCL in ~/.pi/agent/cron-claims/ so that even if several
 *                   sessions are eligible, only one actually fires.
 *
 * Cron format: "minute hour day month weekday" (standard 5-field)
 *   - Use * for any, star/N for every N, comma-separated values
 *   - Examples: "0 9 * * *" = every day at 9am
 *                "star/30 * * * *" = every 30 minutes
 *                "0 9 * * 1-5" = weekdays at 9am
 *   - Special: "once" = run once then auto-remove
 */

const JOBS_FILE = `${process.env.HOME}/.pi/agent/cron-jobs.json`;
// Every open pi session runs its own ticker against the same jobs file. This dir
// is the cross-process mutex: the first session to create a claim file (O_EXCL)
// fires the job, the rest skip. So a job runs exactly once no matter how many
// sessions are open — and still runs when only one is.
const CLAIM_DIR = `${process.env.HOME}/.pi/agent/cron-claims`;
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
// Which session jobs should run in, by cwd. Separate file so old sessions that
// are still running keep parsing cron-jobs.json as a plain array.
const HOME_FILE = `${process.env.HOME}/.pi/agent/cron-home.json`;
// How long a non-home session waits before running an unclaimed job itself.
// Must exceed the 30s tick interval plus slack for a stalled event loop.
const FALLBACK_DELAY_MS = 120_000;

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

/**
 * Claim the right to fire a job. Atomic across processes via O_EXCL create.
 * @param key minute bucket for cron jobs, "once" for one-shot jobs (fire once ever).
 */
function claimFire(jobId: string, key: string): boolean {
  const fs = require("fs");
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    fs.writeFileSync(`${CLAIM_DIR}/${jobId}-${key}`, String(process.pid), { flag: "wx" });
  } catch {
    return false; // another session won this one
  }
  // Prune expired claims. Only runs on a successful claim, so it's rare.
  try {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const name of fs.readdirSync(CLAIM_DIR)) {
      const p = `${CLAIM_DIR}/${name}`;
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
  return true;
}

function isClaimed(jobId: string, key: string): boolean {
  const fs = require("fs");
  return fs.existsSync(`${CLAIM_DIR}/${jobId}-${key}`);
}

// ─── Cron home (which session jobs run in) ──────────────────────────────────

function normalizePath(p: string): string {
  const fs = require("fs");
  try { return fs.realpathSync(p); } catch { return p; }
}

/** Pinned cwd, or null when unpinned (then any session may run jobs). */
function loadHome(): string | null {
  try {
    const fs = require("fs");
    if (!fs.existsSync(HOME_FILE)) return null;
    const cwd = JSON.parse(fs.readFileSync(HOME_FILE, "utf-8")).cwd;
    return typeof cwd === "string" && cwd ? normalizePath(cwd) : null;
  } catch {
    return null;
  }
}

function saveHome(cwd: string | null) {
  const fs = require("fs");
  if (cwd === null) {
    try { fs.unlinkSync(HOME_FILE); } catch {}
    return;
  }
  fs.writeFileSync(HOME_FILE, JSON.stringify({ cwd }, null, 2), "utf-8");
}

function isHomeSession(): boolean {
  const home = loadHome();
  return home === null || home === normalizePath(process.cwd());
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let jobs: CronJob[] = loadJobs();
  let tickTimer: any = null;
  let lastTickMinute = -1;
  let fallbackTimers: any[] = [];

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

      // Re-read every tick: jobs are shared across all open pi sessions, and a
      // stale in-memory copy both re-fires removed jobs and clobbers jobs added
      // in another session when we save.
      jobs = loadJobs();

      const minuteKey = String(Math.floor(now.getTime() / 60_000));
      const eligible = isHomeSession();

      for (const job of jobs) {
        if (!job.enabled) continue;

        const isOnce = job.schedule === "once";
        const due = isOnce
          ? !!job.runOnceAt && now >= new Date(job.runOnceAt)
          : cronMatches(job.schedule, now);
        if (!due) continue;

        const key = isOnce ? "once" : minuteKey;
        if (eligible) runJob(job.id, key, false);
        else armFallback(job.id, key);
      }
    }, 30_000);

    if (tickTimer.unref) tickTimer.unref();
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    for (const t of fallbackTimers) clearTimeout(t);
    fallbackTimers = [];
  }

  /**
   * Claim, fire, and persist one job. Re-reads from disk first so a job that was
   * removed or paused between arming and firing does not run, and so saving here
   * never clobbers a job another session just added.
   */
  function runJob(jobId: string, key: string, fallback: boolean): boolean {
    const job = loadJobs().find(j => j.id === jobId);
    if (!job || !job.enabled) return false;
    if (!claimFire(job.id, key)) return false; // another session got there first

    fireJob(job, fallback);

    const fresh = loadJobs();
    if (job.schedule === "once") {
      saveJobs(fresh.filter(j => j.id !== job.id));
    } else {
      const target = fresh.find(j => j.id === job.id);
      if (target) {
        target.lastRun = new Date().toISOString();
        saveJobs(fresh);
      }
    }
    jobs = fresh;
    return true;
  }

  /**
   * We are not the cron home, so stay out of it — unless nobody claims the job,
   * which means the home session is closed. Then run it anyway rather than let
   * the job silently not happen.
   */
  function armFallback(jobId: string, key: string) {
    const timer = setTimeout(() => {
      fallbackTimers = fallbackTimers.filter(t => t !== timer);
      if (!isClaimed(jobId, key)) runJob(jobId, key, true);
    }, FALLBACK_DELAY_MS);
    if (timer.unref) timer.unref();
    fallbackTimers.push(timer);
  }

  function fireJob(job: CronJob, fallback = false) {
    const recipient = job.signalRecipient || getSignalRecipient();
    // Say so when the pinned session was not the one that ran it.
    const tag = fallback ? ` [fallback: cron home not open, ran in ${process.cwd()}]` : "";
    if (recipient) {
      // Route through Signal so response goes to phone
      pi.sendUserMessage(
        `[Signal message from ${recipient}]: [Scheduled: ${job.name}]${tag} ${job.prompt}`,
        { deliverAs: "followUp" }
      );
    } else {
      // No Signal — just run as a regular prompt
      pi.sendUserMessage(
        `[Scheduled: ${job.name}]${tag} ${job.prompt}`,
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

      // Another session may have added/removed jobs since our last tick; without
      // this, saveJobs() below would write a stale list and delete them.
      jobs = loadJobs();

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
          const home = loadHome();
          const homeLine = home
            ? `\n\n🏠 cron home: \`${home}\`${isHomeSession() ? " (this session)" : " (not this session)"}`
            : "\n\n🏠 cron home: not set — jobs fire in any open session";
          return {
            content: [{ type: "text", text: `## Scheduled Jobs (${jobs.length})${homeLine}\n\n${lines.join("\n\n")}` }],
            details: { count: jobs.length, home, jobs: jobs.map(j => ({ id: j.id, name: j.name, enabled: j.enabled })) },
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
    description: "List jobs, or pin them to this session with /cron home",
    handler: async (args, ctx) => {
      const sub = (args || "").trim();
      if (sub === "home" || sub.startsWith("home ")) {
        const arg = sub.slice(4).trim();
        if (arg === "off") {
          saveHome(null);
          ctx.ui.notify("cron home cleared — jobs fire in whichever session claims them first.", "info");
        } else {
          const target = arg ? normalizePath(arg) : normalizePath(process.cwd());
          saveHome(target);
          ctx.ui.notify(
            `🏠 cron home: ${target}\nJobs fire only in the pi session with this cwd.\n` +
            `If that session is closed, another one runs the job as a fallback after 2 min.`,
            "info",
          );
        }
        return;
      }
      if (!sub || sub === "list") {
        jobs = loadJobs();
        const home = loadHome();
        const homeLine = home
          ? `🏠 cron home: ${home}${isHomeSession() ? "  ← this session" : "  (not this session)"}`
          : "🏠 cron home: not set — jobs fire in any open session";
        if (jobs.length === 0) {
          ctx.ui.notify(`No scheduled jobs.\n${homeLine}`, "info");
        } else {
          const lines = jobs.map(j => {
            const s = j.enabled ? "✅" : "⏸️";
            return `${s} ${j.name} [${j.id}] — ${j.schedule}\n  → ${j.prompt}`;
          });
          ctx.ui.notify(`${homeLine}\n\n${lines.join("\n")}`, "info");
        }
      } else {
        ctx.ui.notify(
          "/cron — list jobs\n/cron home — pin jobs to this session's cwd\n" +
          "/cron home <path> — pin to a path\n/cron home off — unpin\n\n" +
          "Use the cron_schedule tool to add/remove/toggle jobs.",
          "info",
        );
      }
    },
  });
}
