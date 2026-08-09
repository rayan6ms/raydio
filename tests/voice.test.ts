import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type VoiceAccessFacts, validateVoiceAccess } from "../src/music/voice.js";

const readyFacts: VoiceAccessFacts = {
  channelId: "voice-1",
  channelKind: "voice",
  botMemberAvailable: true,
  botInChannel: false,
  channelFull: false,
  canView: true,
  canConnect: true,
  canSpeak: true,
};

describe("validateVoiceAccess", () => {
  it("accepts a normal voice channel with the three required permissions", () => {
    assert.deepEqual(validateVoiceAccess(readyFacts), {
      kind: "ready",
      voiceChannelId: "voice-1",
    });
  });

  it("rejects missing voice, Stage channels, and changed commit-time voice", () => {
    assert.deepEqual(validateVoiceAccess({ ...readyFacts, channelId: null, channelKind: null }), {
      kind: "not-in-voice",
    });
    assert.deepEqual(validateVoiceAccess({ ...readyFacts, channelKind: "stage" }), {
      kind: "unsupported-channel",
    });
    assert.deepEqual(validateVoiceAccess(readyFacts, "voice-2"), { kind: "voice-changed" });
    assert.deepEqual(
      validateVoiceAccess({ ...readyFacts, channelId: null, channelKind: null }, "voice-1"),
      { kind: "voice-changed" },
    );
  });

  it("reports every missing bot permission in stable order", () => {
    assert.deepEqual(
      validateVoiceAccess({
        ...readyFacts,
        canView: false,
        canConnect: false,
        canSpeak: false,
      }),
      {
        kind: "missing-permissions",
        permissions: ["View Channel", "Connect", "Speak"],
      },
    );
    assert.deepEqual(validateVoiceAccess({ ...readyFacts, botMemberAvailable: false }), {
      kind: "bot-member-unavailable",
    });
  });

  it("rejects a full channel unless the bot is already connected there", () => {
    assert.deepEqual(validateVoiceAccess({ ...readyFacts, channelFull: true }), {
      kind: "channel-full",
    });
    assert.deepEqual(
      validateVoiceAccess({ ...readyFacts, channelFull: true, botInChannel: true }),
      { kind: "ready", voiceChannelId: "voice-1" },
    );
  });
});
