export const PREFIX = "\\" as const;

const CANONICAL_COMMANDS = [
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

export type CommandName = (typeof CANONICAL_COMMANDS)[number];

const COMMAND_ALIASES = new Map<string, CommandName>([
  ["p", "play"],
  ["s", "skip"],
  ["q", "queue"],
  ["np", "nowplaying"],
  ["vol", "volume"],
  ["disconnect", "leave"],
  ["dc", "leave"],
]);

const MUSIC_COMMANDS = new Set<CommandName>(
  CANONICAL_COMMANDS.filter((name) => name !== "help" && name !== "ping"),
);

const HELP_MESSAGE = [
  "Raydio commands available now:",
  "`\\help` — show this command list",
  "`\\ping` — show Discord latency and Lavalink readiness",
  "Music commands are recognized; playback implementation is the next milestone.",
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
  return CANONICAL_COMMANDS.some((commandName) => commandName === name);
}

export function resolveCommandName(name: string): CommandName | null {
  const normalizedName = name.toLowerCase();

  if (isCommandName(normalizedName)) {
    return normalizedName;
  }

  return COMMAND_ALIASES.get(normalizedName) ?? null;
}

function formatDiscordLatency(ready: boolean, latencyMs: number): string {
  if (!ready || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return "unavailable";
  }

  return `${Math.round(latencyMs)} ms`;
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

  if (MUSIC_COMMANDS.has(commandName)) {
    await context.send(
      context.lavalinkReady
        ? "Music playback is not implemented yet."
        : "Music service is temporarily unavailable.",
    );
    return "unavailable";
  }

  return "unknown";
}
