const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export type PlayInput =
  | {
      readonly kind: "search";
      readonly query: string;
    }
  | {
      readonly kind: "youtube-url";
      readonly mediaType: "playlist" | "video";
      readonly url: string;
    }
  | {
      readonly kind: "unsupported-url";
      readonly url: string;
    };

function isYoutubeIdentifier(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  try {
    return /^[A-Za-z0-9_-]{1,128}$/u.test(decodeURIComponent(value));
  } catch {
    return false;
  }
}

function hasPathIdentifier(url: URL, prefix: string): boolean {
  const identifier = url.pathname.slice(prefix.length).split("/", 1)[0] ?? null;
  return isYoutubeIdentifier(identifier);
}

function youtubeMediaType(url: URL): "playlist" | "video" | null {
  // Shared YouTube links often identify both a selected video and its playlist.
  // The playlist is the broader explicit request and must not be reduced to one video.
  if (isYoutubeIdentifier(url.searchParams.get("list"))) {
    return "playlist";
  }

  if (url.hostname === "youtu.be") {
    return hasPathIdentifier(url, "/") ? "video" : null;
  }

  if (url.pathname === "/watch" && isYoutubeIdentifier(url.searchParams.get("v"))) {
    return "video";
  }

  if (url.pathname === "/playlist" && isYoutubeIdentifier(url.searchParams.get("list"))) {
    return "playlist";
  }

  for (const prefix of ["/shorts/", "/live/", "/embed/"]) {
    if (url.pathname.startsWith(prefix) && hasPathIdentifier(url, prefix)) {
      return "video";
    }
  }

  return null;
}

export function classifyPlayInput(input: string): PlayInput {
  const trimmedInput = input.trim();
  let url: URL;

  try {
    url = new URL(trimmedInput);
  } catch {
    return { kind: "search", query: trimmedInput };
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !YOUTUBE_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return { kind: "unsupported-url", url: url.href };
  }

  const mediaType = youtubeMediaType(url);
  if (mediaType === null) {
    return { kind: "unsupported-url", url: url.href };
  }

  if (mediaType === "playlist") {
    const playlistId = url.searchParams.get("list");
    if (playlistId === null) {
      return { kind: "unsupported-url", url: url.href };
    }
    const canonicalUrl = new URL("https://www.youtube.com/playlist");
    canonicalUrl.searchParams.set("list", playlistId);
    return { kind: "youtube-url", mediaType, url: canonicalUrl.href };
  }

  return {
    kind: "youtube-url",
    mediaType,
    url: url.href,
  };
}
