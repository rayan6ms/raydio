import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyPlayInput } from "../src/music/urls.js";

describe("classifyPlayInput", () => {
  it("classifies a YouTube watch URL", () => {
    assert.deepEqual(classifyPlayInput("https://www.youtube.com/watch?v=video-id"), {
      kind: "youtube-url",
      mediaType: "video",
      url: "https://www.youtube.com/watch?v=video-id",
    });
  });

  it("classifies a youtu.be URL", () => {
    assert.deepEqual(classifyPlayInput("https://youtu.be/video-id?t=30"), {
      kind: "youtube-url",
      mediaType: "video",
      url: "https://youtu.be/video-id?t=30",
    });
  });

  it("classifies a YouTube Music URL", () => {
    assert.deepEqual(classifyPlayInput("https://music.youtube.com/watch?v=video-id"), {
      kind: "youtube-url",
      mediaType: "video",
      url: "https://music.youtube.com/watch?v=video-id",
    });
  });

  it("classifies a playlist URL", () => {
    assert.deepEqual(classifyPlayInput("https://youtube.com/playlist?list=playlist-id"), {
      kind: "youtube-url",
      mediaType: "playlist",
      url: "https://www.youtube.com/playlist?list=playlist-id",
    });
  });

  it("treats a selected video carrying a list as the full canonical playlist", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=NrI-UBIB8Jk&list=PLEijU2q67K_twQnJ06-3DnrvsAdEii_MQ",
      "https://youtu.be/NrI-UBIB8Jk?list=PLEijU2q67K_twQnJ06-3DnrvsAdEii_MQ&t=30",
      "https://music.youtube.com/watch?v=NrI-UBIB8Jk&list=PLEijU2q67K_twQnJ06-3DnrvsAdEii_MQ",
      "https://youtube.com/shorts/NrI-UBIB8Jk?list=PLEijU2q67K_twQnJ06-3DnrvsAdEii_MQ",
    ]) {
      assert.deepEqual(classifyPlayInput(url), {
        kind: "youtube-url",
        mediaType: "playlist",
        url: "https://www.youtube.com/playlist?list=PLEijU2q67K_twQnJ06-3DnrvsAdEii_MQ",
      });
    }
  });

  it("accepts common direct video path forms", () => {
    for (const path of ["shorts/video-id", "live/video-id", "embed/video-id"]) {
      assert.equal(classifyPlayInput(`https://m.youtube.com/${path}`).kind, "youtube-url");
    }
  });

  it("rejects unrelated and non-HTTP URLs", () => {
    assert.equal(classifyPlayInput("https://example.com/watch?v=video-id").kind, "unsupported-url");
    assert.equal(classifyPlayInput("ftp://youtube.com/watch?v=video-id").kind, "unsupported-url");
  });

  it("rejects credentials and non-default ports in otherwise allowed URLs", () => {
    assert.equal(
      classifyPlayInput("https://user:secret@youtube.com/watch?v=video-id").kind,
      "unsupported-url",
    );
    assert.equal(
      classifyPlayInput("https://youtube.com:8443/watch?v=video-id").kind,
      "unsupported-url",
    );
  });

  it("rejects non-media pages even on an allowed host", () => {
    assert.equal(classifyPlayInput("https://youtube.com/@artist").kind, "unsupported-url");
    assert.equal(classifyPlayInput("https://youtu.be/").kind, "unsupported-url");
    assert.equal(classifyPlayInput("https://youtube.com/watch").kind, "unsupported-url");
  });

  it("rejects missing, blank, malformed, and non-identifier media IDs", () => {
    for (const url of [
      "https://youtube.com/watch?v=%20",
      "https://youtube.com/watch?v=video%2Fid",
      "https://youtube.com/watch?v=%",
      "https://youtube.com/playlist?list=%09",
      "https://youtu.be/%20",
      "https://youtu.be/video%2Fid",
      "https://youtube.com/shorts/%E2%80%A8",
    ]) {
      assert.equal(classifyPlayInput(url).kind, "unsupported-url");
    }
  });

  it("treats ordinary text and URL-like text without a scheme as searches", () => {
    assert.deepEqual(classifyPlayInput("  Daft Punk - Instant Crush  "), {
      kind: "search",
      query: "Daft Punk - Instant Crush",
    });
    assert.deepEqual(classifyPlayInput("youtube.com/watch?v=video-id"), {
      kind: "search",
      query: "youtube.com/watch?v=video-id",
    });
  });
});
