export type VoiceChannelKind = "voice" | "stage" | "unsupported";

export interface VoiceAccessFacts {
  readonly channelId: string | null;
  readonly channelKind: VoiceChannelKind | null;
  readonly botMemberAvailable: boolean;
  readonly botInChannel: boolean;
  readonly channelFull: boolean;
  readonly canView: boolean;
  readonly canConnect: boolean;
  readonly canSpeak: boolean;
}

export type VoiceAccessResult =
  | { readonly kind: "ready"; readonly voiceChannelId: string }
  | { readonly kind: "not-in-voice" }
  | { readonly kind: "unsupported-channel" }
  | { readonly kind: "bot-member-unavailable" }
  | {
      readonly kind: "missing-permissions";
      readonly permissions: readonly ("View Channel" | "Connect" | "Speak")[];
    }
  | { readonly kind: "channel-full" }
  | { readonly kind: "voice-changed" };

export type ControlVoiceAccessResult =
  | { readonly kind: "ready"; readonly voiceChannelId: string }
  | { readonly kind: "not-in-voice" }
  | { readonly kind: "unsupported-channel" }
  | { readonly kind: "no-session" }
  | { readonly kind: "wrong-channel" };

export function validateVoiceAccess(
  facts: VoiceAccessFacts,
  intendedVoiceChannelId?: string,
): VoiceAccessResult {
  if (facts.channelId === null || facts.channelKind === null) {
    return intendedVoiceChannelId === undefined
      ? { kind: "not-in-voice" }
      : { kind: "voice-changed" };
  }
  if (intendedVoiceChannelId !== undefined && facts.channelId !== intendedVoiceChannelId) {
    return { kind: "voice-changed" };
  }
  if (facts.channelKind !== "voice") {
    return { kind: "unsupported-channel" };
  }
  if (!facts.botMemberAvailable) {
    return { kind: "bot-member-unavailable" };
  }

  const permissions: Array<"View Channel" | "Connect" | "Speak"> = [];
  if (!facts.canView) {
    permissions.push("View Channel");
  }
  if (!facts.canConnect) {
    permissions.push("Connect");
  }
  if (!facts.canSpeak) {
    permissions.push("Speak");
  }
  if (permissions.length > 0) {
    return { kind: "missing-permissions", permissions };
  }
  if (facts.channelFull && !facts.botInChannel) {
    return { kind: "channel-full" };
  }
  return { kind: "ready", voiceChannelId: facts.channelId };
}

export function validateControlVoiceAccess(
  facts: Pick<VoiceAccessFacts, "channelId" | "channelKind">,
  activeVoiceChannelId: string | null,
  allowMissingSession = false,
): ControlVoiceAccessResult {
  if (facts.channelId === null || facts.channelKind === null) {
    return { kind: "not-in-voice" };
  }
  if (facts.channelKind !== "voice") {
    return { kind: "unsupported-channel" };
  }
  if (activeVoiceChannelId === null) {
    return allowMissingSession
      ? { kind: "ready", voiceChannelId: facts.channelId }
      : { kind: "no-session" };
  }
  if (facts.channelId !== activeVoiceChannelId) {
    return { kind: "wrong-channel" };
  }
  return { kind: "ready", voiceChannelId: facts.channelId };
}
