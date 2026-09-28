import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChatReactionsSetResult } from "../../../packages/gateway-protocol/src/chat-reactions.js";
import { resolveReactionMessageId } from "../../channels/plugins/actions/reaction-message-id.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { assertChatReactionEmoji } from "../../shared/chat-reaction-emoji.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import type { MessageActionInput, MessageActionResult } from "./message-action-contracts.js";
import { resolveOutboundMessageGatewayOptions } from "./message-gateway-options.js";

/** Use the registered reaction owner with the tool's bound Gateway and admitted identity. */
export async function executeInternalSourceReaction(
  input: MessageActionInput,
  params: Record<string, unknown>,
): Promise<MessageActionResult> {
  const { gateway, agentId, sessionId, sessionKey } = input;
  if (
    input.actionOrigin !== "message-tool" ||
    !gateway ||
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !input.assertDirectAdapterHandoff
  ) {
    throw new Error("Control UI reactions require an active agent turn in this conversation");
  }
  if (params.gatewayUrl !== undefined || params.gatewayToken !== undefined) {
    throw new Error(
      "Control UI reactions use the current Gateway; omit gatewayUrl and gatewayToken",
    );
  }
  if (params.trackToolCalls === true || params.track_tool_calls === true) {
    throw new Error("Control UI reactions do not support status tracking; omit trackToolCalls");
  }
  const messageId = normalizeOptionalString(
    resolveReactionMessageId({
      args: params,
      toolContext: input.messageActionAuthorization?.toolContext ?? input.toolContext,
    }),
  );
  if (!messageId) {
    throw new Error("Choose a saved chat message with messageId");
  }
  const emoji = normalizeOptionalString(params.emoji);
  if (!emoji) {
    throw new Error(
      "Control UI reactions require an emoji; use remove:true with that emoji to remove it",
    );
  }
  assertChatReactionEmoji(emoji);
  const active = readBooleanParam(params, "remove") !== true;
  const dryRun = input.dryRun === true || readBooleanParam(params, "dryRun") === true;
  throwIfAborted(input.abortSignal);
  input.assertDirectAdapterHandoff();
  let changed = false;
  if (!dryRun) {
    const request = {
      method: "chat.reactions.set",
      params: { sessionKey, agentId, sessionId, messageId, emoji, active },
      signal: input.abortSignal,
    };
    let result: ChatReactionsSetResult;
    if (gateway.request) {
      result = await gateway.request<ChatReactionsSetResult>(request);
    } else {
      const agentRuntimeIdentityToken = await gateway.resolveAgentRuntimeIdentityToken?.();
      if (!agentRuntimeIdentityToken) {
        throw new Error("Control UI reactions require an authenticated agent runtime");
      }
      const { callGatewayLeastPrivilege } = await import("./message.gateway.runtime.js");
      throwIfAborted(input.abortSignal);
      input.assertDirectAdapterHandoff();
      result = await callGatewayLeastPrivilege<ChatReactionsSetResult>({
        ...resolveOutboundMessageGatewayOptions(gateway),
        ...request,
        agentRuntimeIdentityToken,
      });
    }
    changed = result.changed;
  }
  const payload = { ok: true as const, changed, emoji, messageId, active, dryRun };
  const result = {
    kind: "action" as const,
    action: "react" as const,
    channel: INTERNAL_MESSAGE_CHANNEL,
    toolResult: {
      content: [
        {
          type: "text" as const,
          text: dryRun
            ? "Dry run: reaction not applied."
            : changed
              ? `${active ? "Added" : "Removed"} ${emoji} ${active ? "on" : "from"} the saved chat message.`
              : "Your reaction already matches the requested state.",
        },
      ],
      details: payload,
    },
  };
  return dryRun
    ? { ...result, handledBy: "dry-run", payload, dryRun: true }
    : { ...result, handledBy: "core", payload: { ...payload, dryRun: false }, dryRun: false };
}
