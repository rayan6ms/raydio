import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
} from "discord.js";

export const COMMAND_NAMES = [
  "play",
  "nowplaying",
  "queue",
  "pause",
  "resume",
  "previous",
  "skip",
  "stop",
  "move",
  "jump",
  "shuffle",
  "remove",
  "clear",
  "volume",
  "loop",
  "leave",
  "help",
  "ping",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

function command(name: CommandName, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild);
}

export const APPLICATION_COMMANDS = [
  command("play", "Play a YouTube song or add it to the queue").addStringOption((option) =>
    option
      .setName("request")
      .setDescription("Search terms or a YouTube video or playlist URL")
      .setRequired(true),
  ),
  command("nowplaying", "Show the current song and player controls"),
  command("queue", "Show the current song and upcoming queue"),
  command("pause", "Pause the current song"),
  command("resume", "Resume the current song"),
  command("previous", "Return to the previous song in this session"),
  command("skip", "Skip to the next song"),
  command("stop", "Stop playback and clear the queue"),
  command("move", "Move an upcoming song to another queue position")
    .addIntegerOption((option) =>
      option
        .setName("from")
        .setDescription("Current queue position")
        .setMinValue(1)
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("New queue position").setMinValue(1).setRequired(true),
    ),
  command("jump", "Immediately play a selected upcoming song").addIntegerOption((option) =>
    option
      .setName("position")
      .setDescription("Upcoming queue position")
      .setMinValue(1)
      .setRequired(true),
  ),
  command("shuffle", "Shuffle the upcoming queue"),
  command("remove", "Remove an upcoming song from the queue").addIntegerOption((option) =>
    option
      .setName("position")
      .setDescription("Upcoming queue position")
      .setMinValue(1)
      .setRequired(true),
  ),
  command("clear", "Clear every upcoming song"),
  command("volume", "Show or set the player volume").addIntegerOption((option) =>
    option.setName("level").setDescription("Volume from 0 to 100").setMinValue(0).setMaxValue(100),
  ),
  command("loop", "Choose how playback should repeat").addStringOption((option) =>
    option
      .setName("mode")
      .setDescription("Loop mode")
      .setRequired(true)
      .addChoices(
        { name: "Off", value: "off" },
        { name: "Current song", value: "track" },
        { name: "Entire queue", value: "queue" },
      ),
  ),
  command("leave", "Leave voice and clear the playback session"),
  command("help", "Show Raydio's commands and usage"),
  command("ping", "Check Discord latency and music service readiness"),
] as const;

export type ControlCommandName = Exclude<CommandName, "help" | "ping" | "play">;

export type ControlCommandInvocation =
  | { readonly name: "queue" }
  | { readonly name: "nowplaying" }
  | {
      readonly name:
        | "pause"
        | "resume"
        | "previous"
        | "skip"
        | "stop"
        | "shuffle"
        | "clear"
        | "leave";
    }
  | { readonly name: "volume"; readonly volume: number | null }
  | { readonly name: "loop"; readonly mode: "off" | "track" | "queue" }
  | { readonly name: "remove" | "jump"; readonly displayedIndex: number }
  | { readonly name: "move"; readonly fromIndex: number; readonly toIndex: number };

export type ExecutableControlCommandInvocation = Exclude<
  ControlCommandInvocation,
  { readonly name: "nowplaying" | "queue" }
>;

export const HELP_MESSAGE = [
  "**Raydio commands**",
  "**Start and view**",
  "`/play request:` — search, play a YouTube video, or queue a playlist",
  "`/nowplaying` — show the modern player and controls",
  "`/queue` — show the current and upcoming songs",
  "**Playback**",
  "`/pause` | `/resume` — pause or resume",
  "`/previous` | `/skip` — move through playback history and queue",
  "`/stop` — stop and clear the queue",
  "**Queue and settings**",
  "`/move from: to:` | `/jump position:` — reorder or jump within the queue",
  "`/shuffle` | `/remove position:` | `/clear` — edit upcoming songs",
  "`/volume [level:]` | `/loop mode:` — player settings",
  "**Session and utility**",
  "`/leave` — disconnect and clear the session",
  "`/ping` — show Discord and Lavalink readiness",
  "`/help` — show this menu",
].join("\n");

export interface ParsedCommand {
  readonly argument: string;
  readonly name: string;
}

export interface CommandContext {
  readonly discordLatencyMs: number;
  readonly discordReady: boolean;
  readonly lavalinkReady: boolean;
  play(input: string): Promise<string | null>;
  control(invocation: ExecutableControlCommandInvocation): Promise<string>;
  presentNowPlaying(): Promise<void>;
  presentQueue(): Promise<void>;
  send(content: string): Promise<void>;
}

export type DispatchResult = "handled" | "unavailable" | "unknown";

function isCommandName(name: string): name is CommandName {
  return COMMAND_NAMES.some((commandName) => commandName === name);
}

function formatDiscordLatency(ready: boolean, latencyMs: number): string {
  if (!ready || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return "unavailable";
  }
  return `${Math.round(latencyMs)} ms`;
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseControlInvocation(
  commandName: ControlCommandName,
  argument: string,
): ControlCommandInvocation | string {
  if (
    commandName === "pause" ||
    commandName === "resume" ||
    commandName === "previous" ||
    commandName === "skip" ||
    commandName === "stop" ||
    commandName === "queue" ||
    commandName === "nowplaying" ||
    commandName === "shuffle" ||
    commandName === "clear" ||
    commandName === "leave"
  ) {
    return argument === "" ? { name: commandName } : `Use \`/${commandName}\` without options.`;
  }

  if (commandName === "volume") {
    if (argument === "") {
      return { name: "volume", volume: null };
    }
    const volume = /^\d+$/.test(argument) ? Number(argument) : Number.NaN;
    return Number.isSafeInteger(volume) && volume <= 100
      ? { name: "volume", volume }
      : "Use `/volume level:` with a value from 0 to 100.";
  }

  if (commandName === "loop") {
    const mode = argument.toLowerCase();
    return mode === "off" || mode === "track" || mode === "queue"
      ? { name: "loop", mode }
      : "Choose a mode offered by `/loop`.";
  }

  if (commandName === "move") {
    const [fromValue, toValue, extra] = argument.split(" ");
    const fromIndex = positiveInteger(fromValue ?? "");
    const toIndex = positiveInteger(toValue ?? "");
    return fromIndex !== null && toIndex !== null && extra === undefined
      ? { name: "move", fromIndex, toIndex }
      : "Use `/move from: to:` with valid upcoming queue positions.";
  }

  const displayedIndex = positiveInteger(argument);
  if (displayedIndex === null) {
    return commandName === "jump"
      ? "Use `/jump position:` with a valid upcoming queue position."
      : "Use `/remove position:` with a valid upcoming queue position.";
  }
  return { name: commandName, displayedIndex };
}

function requiresReadyPlayer(invocation: ControlCommandInvocation): boolean {
  return (
    invocation.name === "pause" ||
    invocation.name === "resume" ||
    invocation.name === "previous" ||
    invocation.name === "skip" ||
    invocation.name === "jump" ||
    (invocation.name === "volume" && invocation.volume !== null)
  );
}

export async function dispatchCommand(
  parsed: ParsedCommand,
  context: CommandContext,
): Promise<DispatchResult> {
  if (!isCommandName(parsed.name)) {
    await context.send("That command is no longer registered. Type `/` to see Raydio's commands.");
    return "unknown";
  }

  if (parsed.name === "help") {
    await context.send(HELP_MESSAGE);
    return "handled";
  }

  if (parsed.name === "ping") {
    const latency = formatDiscordLatency(context.discordReady, context.discordLatencyMs);
    const lavalinkStatus = context.lavalinkReady ? "ready" : "unavailable";
    await context.send(`Pong! Discord: ${latency}. Lavalink: ${lavalinkStatus}.`);
    return "handled";
  }

  if (parsed.name === "play") {
    if (!parsed.argument) {
      await context.send("Use `/play request:` and enter search terms or a YouTube URL.");
      return "handled";
    }
    if (!context.lavalinkReady) {
      await context.send("Music service is temporarily unavailable.");
      return "unavailable";
    }
    const response = await context.play(parsed.argument);
    if (response !== null) {
      await context.send(response);
    }
    return "handled";
  }

  const invocation = parseControlInvocation(parsed.name, parsed.argument);
  if (typeof invocation === "string") {
    await context.send(invocation);
    return "handled";
  }
  if (!context.lavalinkReady && requiresReadyPlayer(invocation)) {
    await context.send("Music service is temporarily unavailable.");
    return "unavailable";
  }
  if (invocation.name === "queue") {
    await context.presentQueue();
    return "handled";
  }
  if (invocation.name === "nowplaying") {
    await context.presentNowPlaying();
    return "handled";
  }
  await context.send(await context.control(invocation));
  return "handled";
}
