export const PREFIX = "\\" as const;

export const COMMAND_NAMES = [
  "play",
  "pause",
  "resume",
  "previous",
  "skip",
  "stop",
  "queue",
  "nowplaying",
  "volume",
  "loop",
  "shuffle",
  "remove",
  "clear",
  "leave",
  "help",
  "ping",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export const COMMAND_ALIASES = [
  ["p", "play"],
  ["prev", "previous"],
  ["s", "skip"],
  ["q", "queue"],
  ["np", "nowplaying"],
  ["vol", "volume"],
  ["disconnect", "leave"],
  ["dc", "leave"],
] as const satisfies ReadonlyArray<readonly [string, CommandName]>;

const commandAliases = new Map<string, CommandName>(COMMAND_ALIASES);

export type ControlCommandName = Exclude<CommandName, "help" | "ping" | "play">;

export type ControlCommandInvocation =
  | { readonly name: "queue" }
  | { readonly name: "pause" | "resume" | "previous" | "skip" | "stop" | "nowplaying" }
  | { readonly name: "shuffle" | "clear" | "leave" }
  | { readonly name: "volume"; readonly volume: number | null }
  | { readonly name: "loop"; readonly mode: "off" | "track" | "queue" }
  | { readonly name: "remove"; readonly displayedIndex: number };

export type ExecutableControlCommandInvocation = Exclude<
  ControlCommandInvocation,
  { readonly name: "nowplaying" | "queue" }
>;

const HELP_MESSAGE = [
  "**Raydio commands**",
  "**Start and view**",
  "`\\play <song or YouTube URL>` | `\\p` — choose, play, or queue music",
  "`\\nowplaying` | `\\np` — show the player and controls",
  "`\\queue` | `\\q` — show the current and upcoming tracks",
  "**Playback**",
  "`\\pause` | `\\resume` — pause or resume",
  "`\\previous` | `\\prev` — return to the previous track",
  "`\\skip` | `\\s` — play the next track",
  "`\\stop` — stop and clear the queue",
  "**Queue and settings**",
  "`\\shuffle` | `\\remove <index>` | `\\clear` — edit upcoming tracks",
  "`\\volume [0-100]` | `\\vol` — show or set volume",
  "`\\loop <off|track|queue>` — set looping",
  "**Session and utility**",
  "`\\leave` | `\\disconnect` | `\\dc` — disconnect and clear",
  "`\\ping` — show Discord and Lavalink readiness",
  "`\\help` | `\\` — show this menu",
].join("\n");

export interface CommandMessageInput {
  readonly authorIsBot: boolean;
  readonly content: string;
  readonly guildId: string | null;
}

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

export function parseCommand(input: CommandMessageInput): ParsedCommand | null {
  if (input.authorIsBot || input.guildId === null || !input.content.startsWith(PREFIX)) {
    return null;
  }

  const body = input.content.slice(PREFIX.length).trim();
  if (!body) {
    return { name: "help", argument: "" };
  }

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match?.[1]) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    argument: match[2] ?? "",
  };
}

function isCommandName(name: string): name is CommandName {
  return COMMAND_NAMES.some((commandName) => commandName === name);
}

export function resolveCommandName(name: string): CommandName | null {
  const normalizedName = name.toLowerCase();

  if (isCommandName(normalizedName)) {
    return normalizedName;
  }

  return commandAliases.get(normalizedName) ?? null;
}

function formatDiscordLatency(ready: boolean, latencyMs: number): string {
  if (!ready || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return "unavailable";
  }

  return `${Math.round(latencyMs)} ms`;
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
    return argument === "" ? { name: commandName } : `Usage: \`\\${commandName}\`.`;
  }

  if (commandName === "volume") {
    if (argument === "") {
      return { name: "volume", volume: null };
    }
    if (!/^\d+$/.test(argument)) {
      return "Usage: `\\volume [0-100]`.";
    }
    const volume = Number(argument);
    return Number.isSafeInteger(volume) && volume <= 100
      ? { name: "volume", volume }
      : "Usage: `\\volume [0-100]`.";
  }

  if (commandName === "loop") {
    const mode = argument.toLowerCase();
    return mode === "off" || mode === "track" || mode === "queue"
      ? { name: "loop", mode }
      : "Usage: `\\loop <off|track|queue>`.";
  }

  if (!/^[1-9]\d*$/.test(argument)) {
    return "Usage: `\\remove <upcoming index>`.";
  }
  const displayedIndex = Number(argument);
  return Number.isSafeInteger(displayedIndex)
    ? { name: "remove", displayedIndex }
    : "Usage: `\\remove <upcoming index>`.";
}

function requiresReadyPlayer(invocation: ControlCommandInvocation): boolean {
  return (
    invocation.name === "pause" ||
    invocation.name === "resume" ||
    invocation.name === "previous" ||
    invocation.name === "skip" ||
    (invocation.name === "volume" && invocation.volume !== null)
  );
}

export async function dispatchCommand(
  parsed: ParsedCommand,
  context: CommandContext,
): Promise<DispatchResult> {
  const commandName = resolveCommandName(parsed.name);

  if (commandName === null) {
    await context.send("Unknown command. Use `\\help` to see the command list.");
    return "unknown";
  }

  if (commandName === "help") {
    await context.send(HELP_MESSAGE);
    return "handled";
  }

  if (commandName === "ping") {
    const latency = formatDiscordLatency(context.discordReady, context.discordLatencyMs);
    const lavalinkStatus = context.lavalinkReady ? "ready" : "unavailable";
    await context.send(`Pong! Discord: ${latency}. Lavalink: ${lavalinkStatus}.`);
    return "handled";
  }

  if (commandName === "play") {
    if (!parsed.argument) {
      await context.send("Usage: `\\play <song or YouTube URL>`.");
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

  const invocation = parseControlInvocation(commandName, parsed.argument);
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
