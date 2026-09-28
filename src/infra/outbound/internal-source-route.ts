import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import { parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";

export function hasExternalSessionDeliveryRoute(sessionKey: string | undefined): boolean {
  const route = parseSessionDeliveryRoute(sessionKey);
  const channel = route && normalizeMessageChannel(route.channel);
  return Boolean(channel && channel !== INTERNAL_MESSAGE_CHANNEL);
}

export function hasExplicitSourceRouteParam(params: Record<string, unknown>): boolean {
  return (
    readTrimmedStringAlias(params, ["channel", "target", "to", "channelId"]) !== undefined ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => normalizeOptionalString(value)))
  );
}

/** Discovery and dispatch share this pure route decision without loading channel runtime. */
export function shouldUseInternalSourceReaction(
  input: { action: string; sessionKey?: string; toolContext?: ChannelThreadingToolContext },
  params: Record<string, unknown>,
): boolean {
  return (
    input.action === "react" &&
    normalizeMessageChannel(input.toolContext?.currentChannelProvider) ===
      INTERNAL_MESSAGE_CHANNEL &&
    Boolean(input.sessionKey?.trim()) &&
    !hasExternalSessionDeliveryRoute(input.sessionKey) &&
    !hasExplicitSourceRouteParam(params)
  );
}
