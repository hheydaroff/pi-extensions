import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn, execSync, ChildProcess } from "child_process";

/**
 * radio-garden — listen to live radio from radio.garden inside pi.
 *
 * Commands:
 *   /radio                     open the interactive menu
 *   /radio on   | random       enable + play a random station
 *   /radio off  | stop         disable / stop playback
 *   /radio search <query>      search stations by name
 *   /radio location <query>    browse stations by city or country
 *   /radio now                 show what's currently playing
 *
 * The currently playing station is shown in the footer.
 * Requires `mpv` or `ffplay` (ffmpeg) on PATH.
 */

const WIDGET_KEY = "radio-garden";
const API = "https://radio.garden/api";
const RG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Referer: "https://radio.garden/",
};

interface Station {
  channelId: string;
  title: string;
  place: string;
  country: string;
}

interface Place {
  id: string;
  title: string;
  country: string;
}

export default function (pi: ExtensionAPI) {
  let player: ChildProcess | null = null;
  let nowPlaying: Station | null = null;
  let placesCache: Place[] | null = null;

  // ---- player discovery ---------------------------------------------------
  // mpv preferred (clean, reconnects), ffplay (ffmpeg) fallback.
  let playerCmd: string | null = null;
  function detectPlayer(): string | null {
    if (playerCmd !== null) return playerCmd || null;
    for (const cmd of ["mpv", "ffplay"]) {
      const r = spawnSyncCheck(cmd);
      if (r) {
        playerCmd = cmd;
        return cmd;
      }
    }
    playerCmd = "";
    return null;
  }

  function spawnSyncCheck(cmd: string): boolean {
    try {
      execSync(`command -v ${cmd}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  function playerArgs(cmd: string, url: string): string[] {
    if (cmd === "mpv") {
      return ["--no-video", "--really-quiet", "--no-terminal", url];
    }
    // ffplay
    return [
      "-nodisp",
      "-loglevel",
      "quiet",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      url,
    ];
  }

  // ---- radio.garden API ---------------------------------------------------
  async function rgJson(path: string): Promise<any> {
    const res = await fetch(`${API}${path}`, { headers: RG_HEADERS });
    if (!res.ok) throw new Error(`radio.garden ${res.status} for ${path}`);
    return res.json();
  }

  function channelIdFromUrl(url: string): string {
    // "/listen/jazzconclass/GgWBBGCW" -> "GgWBBGCW"
    return url.split("/").filter(Boolean).pop() || "";
  }

  async function getPlaces(): Promise<Place[]> {
    if (placesCache) return placesCache;
    const json = await rgJson("/ara/content/places");
    placesCache = (json?.data?.list ?? []).map((p: any) => ({
      id: p.id,
      title: p.title,
      country: p.country,
    }));
    return placesCache!;
  }

  async function getChannels(placeId: string): Promise<Station[]> {
    const json = await rgJson(`/ara/content/page/${placeId}/channels`);
    const out: Station[] = [];
    for (const block of json?.data?.content ?? []) {
      for (const item of block?.items ?? []) {
        const page = item.page;
        if (!page?.url) continue;
        out.push({
          channelId: channelIdFromUrl(page.url),
          title: page.title,
          place: page.place?.title ?? "",
          country: page.country?.title ?? "",
        });
      }
    }
    return out;
  }

  async function searchStations(query: string): Promise<Station[]> {
    const json = await rgJson(`/search?q=${encodeURIComponent(query)}`);
    const out: Station[] = [];
    for (const hit of json?.hits?.hits ?? []) {
      const page = hit?._source?.page;
      if (page?.type !== "channel" || !page?.url) continue;
      out.push({
        channelId: channelIdFromUrl(page.url),
        title: page.title,
        place: page.place?.title ?? "",
        country: page.country?.title ?? "",
      });
    }
    return out;
  }

  async function resolveStream(channelId: string): Promise<string> {
    // The listen endpoint 302-redirects to the real stream URL.
    const res = await fetch(
      `${API}/ara/content/listen/${channelId}/channel.mp3`,
      { headers: RG_HEADERS, redirect: "manual" },
    );
    const loc = res.headers.get("location");
    if (loc) return loc;
    // Some channels stream directly from the endpoint.
    if (res.ok) return `${API}/ara/content/listen/${channelId}/channel.mp3`;
    throw new Error(`Could not resolve stream (${res.status})`);
  }

  // ---- playback control ---------------------------------------------------
  function stop() {
    if (player) {
      player.removeAllListeners("exit");
      player.kill("SIGTERM");
      player = null;
    }
    nowPlaying = null;
  }

  function label(s: Station): string {
    const loc = [s.place, s.country].filter(Boolean).join(", ");
    return loc ? `${s.title} — ${loc}` : s.title;
  }

  // Sticky left-aligned footer widget, shown only while a station is playing.
  // Uses setWidget (not setStatus) so it stays visible even when another
  // extension owns the footer via setFooter (e.g. tool-counter).
  function showWidget(ctx: ExtensionContext, text: string) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => {
        const line = new Text(
          theme.fg("accent", "♪ ") + theme.fg("success", text),
          0,
          0,
        );
        return {
          render: (width: number) => line.render(width),
          invalidate: () => line.invalidate(),
        };
      },
      { placement: "belowEditor" },
    );
  }

  function clearWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  async function play(station: Station, ctx: ExtensionContext): Promise<boolean> {
    const cmd = detectPlayer();
    if (!cmd) {
      ctx.ui.notify(
        "No audio player found. Install mpv (brew install mpv) or ffmpeg (brew install ffmpeg).",
        "error",
      );
      return false;
    }
    let url: string;
    try {
      url = await resolveStream(station.channelId);
    } catch (e: any) {
      ctx.ui.notify(`Couldn't resolve "${station.title}": ${e.message}`, "error");
      return false;
    }

    stop();
    nowPlaying = station;
    player = spawn(cmd, playerArgs(cmd, url), { stdio: "ignore", detached: false });
    player.on("error", () => {
      ctx.ui.notify(`Playback error with ${cmd}.`, "error");
      stop();
      clearWidget(ctx);
    });
    player.on("exit", () => {
      // Stream ended or dropped.
      player = null;
    });

    showWidget(ctx, label(station));
    ctx.ui.notify(`Now playing: ${label(station)}`, "info");
    return true;
  }

  async function playRandom(ctx: ExtensionContext): Promise<void> {
    showWidget(ctx, "tuning…");
    try {
      const places = await getPlaces();
      // Try a few random places until we find one with channels.
      for (let attempt = 0; attempt < 6; attempt++) {
        const place = places[Math.floor(Math.random() * places.length)];
        const channels = await getChannels(place.id);
        if (channels.length) {
          const station = channels[Math.floor(Math.random() * channels.length)];
          if (await play(station, ctx)) return;
        }
      }
      ctx.ui.notify("Couldn't find a random station, try again.", "warning");
      clearWidget(ctx);
    } catch (e: any) {
      ctx.ui.notify(`Random tune failed: ${e.message}`, "error");
      clearWidget(ctx);
    }
  }

  // ---- interactive pickers ------------------------------------------------
  async function pickFromStations(
    stations: Station[],
    ctx: ExtensionContext,
    title: string,
  ): Promise<void> {
    if (!stations.length) {
      ctx.ui.notify("No stations found.", "warning");
      return;
    }
    const labels = stations.map((s) => label(s));
    const choice = await ctx.ui.select(title, labels);
    if (!choice) return;
    const station = stations[labels.indexOf(choice)];
    if (station) await play(station, ctx);
  }

  async function browseByLocation(ctx: ExtensionContext): Promise<void> {
    const query = await ctx.ui.input(
      "Location (city or country)",
      "e.g. Tokyo, Iceland, Berlin",
    );
    if (!query) return;
    let places: Place[];
    try {
      places = await getPlaces();
    } catch (e: any) {
      ctx.ui.notify(`Failed to load places: ${e.message}`, "error");
      return;
    }
    const q = query.toLowerCase();
    const matches = places
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (p.country ?? "").toLowerCase().includes(q),
      )
      .slice(0, 50);
    if (!matches.length) {
      ctx.ui.notify(`No location matching "${query}".`, "warning");
      return;
    }
    const labels = matches.map((p) => `${p.title}, ${p.country}`);
    const pick = await ctx.ui.select("Pick a location", labels);
    if (!pick) return;
    const place = matches[labels.indexOf(pick)];
    let channels: Station[];
    try {
      channels = await getChannels(place.id);
    } catch (e: any) {
      ctx.ui.notify(`Failed to load stations: ${e.message}`, "error");
      return;
    }
    await pickFromStations(channels, ctx, `Stations in ${place.title}`);
  }

  async function searchFlow(ctx: ExtensionContext, query?: string): Promise<void> {
    const q = query || (await ctx.ui.input("Search stations", "e.g. jazz, BBC, reggae"));
    if (!q) return;
    let stations: Station[];
    try {
      stations = await searchStations(q);
    } catch (e: any) {
      ctx.ui.notify(`Search failed: ${e.message}`, "error");
      return;
    }
    await pickFromStations(stations, ctx, `Results for "${q}"`);
  }

  async function mainMenu(ctx: ExtensionContext): Promise<void> {
    const PLAY_RANDOM = "🎲 Play a random station";
    const BROWSE = "🌍 Browse by location (city / country)";
    const SEARCH = "🔎 Search stations by name";
    const NOW = "ℹ️  Now playing";
    const STOP = "⏹  Stop / disable";
    const opts = [PLAY_RANDOM, BROWSE, SEARCH, NOW, STOP];
    const choice = await ctx.ui.select("Radio Garden", opts);
    switch (choice) {
      case PLAY_RANDOM:
        await playRandom(ctx);
        break;
      case BROWSE:
        await browseByLocation(ctx);
        break;
      case SEARCH:
        await searchFlow(ctx);
        break;
      case NOW:
        ctx.ui.notify(
          nowPlaying ? `Now playing: ${label(nowPlaying)}` : "Nothing playing.",
          "info",
        );
        break;
      case STOP:
        stop();
        clearWidget(ctx);
        ctx.ui.notify("Radio stopped.", "info");
        break;
    }
  }

  // ---- command ------------------------------------------------------------
  pi.registerCommand("radio", {
    description:
      "Listen to live radio from radio.garden. Subcommands: on|random, off|stop, search <q>, location <q>, now",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Radio needs an interactive UI.", "warning");
        return;
      }
      const raw = (args || "").trim();
      const [sub, ...rest] = raw.split(/\s+/);
      const arg = rest.join(" ").trim();

      switch (sub.toLowerCase()) {
        case "":
          await mainMenu(ctx);
          break;
        case "on":
        case "random":
        case "enable":
          await playRandom(ctx);
          break;
        case "off":
        case "stop":
        case "disable":
          stop();
          clearWidget(ctx);
          ctx.ui.notify("Radio stopped.", "info");
          break;
        case "search":
          await searchFlow(ctx, arg || undefined);
          break;
        case "location":
        case "loc":
          if (arg) {
            // Pre-filtered browse using the inline query.
            try {
              const places = await getPlaces();
              const qq = arg.toLowerCase();
              const matches = places
                .filter(
                  (p) =>
                    p.title.toLowerCase().includes(qq) ||
                    (p.country ?? "").toLowerCase().includes(qq),
                )
                .slice(0, 50);
              if (!matches.length) {
                ctx.ui.notify(`No location matching "${arg}".`, "warning");
                break;
              }
              const labels = matches.map((p) => `${p.title}, ${p.country}`);
              const pick = await ctx.ui.select("Pick a location", labels);
              if (!pick) break;
              const place = matches[labels.indexOf(pick)];
              const channels = await getChannels(place.id);
              await pickFromStations(channels, ctx, `Stations in ${place.title}`);
            } catch (e: any) {
              ctx.ui.notify(`Location browse failed: ${e.message}`, "error");
            }
          } else {
            await browseByLocation(ctx);
          }
          break;
        case "now":
          ctx.ui.notify(
            nowPlaying ? `Now playing: ${label(nowPlaying)}` : "Nothing playing.",
            "info",
          );
          break;
        default:
          ctx.ui.notify(
            "Usage: /radio [on|off|search <q>|location <q>|now]",
            "info",
          );
          await mainMenu(ctx);
      }
    },
  });

  // ---- cleanup ------------------------------------------------------------
  pi.on("session_shutdown", async (_event, ctx) => {
    stop();
    clearWidget(ctx);
  });
}
