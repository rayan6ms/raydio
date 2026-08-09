export const PREFIX = "\\" as const;

export const COMMAND_NAMES = [
  "play",
  "pause",
  "resume",
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
  | { readonly name: "pause" | "resume" | "skip" | "stop" | "queue" | "nowplaying" }
  | { readonly name: "shuffle" | "clear" | "leave" }
  | { readonly name: "volume"; readonly volume: number | null }
  | { readonly name: "loop"; readonly mode: "off" | "track" | "queue" }
  | { readonly name: "remove"; readonly displayedIndex: number };

const HELP_MESSAGE = [
  "Raydio commands:",
  "`\\play <song or YouTube URL>` (`\\p`) — play or queue music",
  "`\\pause` / `\\resume` — pause or resume",
  "`\\skip` (`\\s`) / `\\stop` — skip or stop and clear",
  "`\\queue` (`\\q`) / `\\nowplaying` (`\\np`) — playback details",
  "`\\volume [0-100]` (`\\vol`) — show or set volume",
  "`\\loop <off|track|queue>` — set looping",
  "`\\shuffle` / `\\remove <index>` / `\\clear` — edit upcoming tracks",
  "`\\leave` (`\\disconnect`, `\\dc`) — disconnect",
  "`\\help` — show this command list",
  "`\\ping` — show Discord latency and Lavalink readiness",
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
  play(input: string): Promise<string>;
  control(invocation: ControlCommandInvocation): Promise<string>;
  send(content: string): Promise<void>;
}

export type DispatchResult = "handled" | "unavailable" | "unknown";

export function parseCommand(input: CommandMessageInput): ParsedCommand | null {
  if (input.authorIsBot || input.guildId === null || !input.content.startsWith(PREFIX)) {
    return null;
  }

  const body = input.content.slice(PREFIX.length).trim();
  if (!body) {
    return null;
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
    await context.send(await context.play(parsed.argument));
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
  await context.send(await context.control(invocation));
  return "handled";
}
