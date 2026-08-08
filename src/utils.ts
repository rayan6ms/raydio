import { escapeMarkdown } from "discord.js";

export const DISCORD_MESSAGE_LIMIT = 2_000;

export function escapeExternalText(text: string): string {
  const escaped = escapeMarkdown(text, {
    bulletedList: true,
    heading: true,
    maskedLink: true,
    numberedList: true,
  });

  return escaped.replaceAll(/^(\s*)(>|-#)/gm, "$1\\$2");
}

export function truncateMessage(content: string, maximumLength = DISCORD_MESSAGE_LIMIT): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    throw new RangeError("maximumLength must be a positive safe integer");
  }

  if (content.length <= maximumLength) {
    return content;
  }

  if (maximumLength === 1) {
    return "…";
  }

  const contentLimit = maximumLength - 1;
  let truncated = "";

  for (const character of content) {
    if (truncated.length + character.length > contentLimit) {
      break;
    }

    truncated += character;
  }

  return `${truncated}…`;
}

export function errorFields(error: unknown): { errorClass: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorClass: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorClass: "UnknownThrownValue",
    errorMessage: "A non-Error value was thrown",
  };
}
