import type { ChatReactionsSetParams } from "../../../packages/gateway-protocol/src/chat-reactions.js";
import { enforceMessageActionAllowlist } from "../../infra/outbound/outbound-policy.js";
import { captureSessionToolInvocationAuthority } from "../session-tool-invocation-authority.js";
import { prepareChatReactionAuthority } from "./chat-reactions-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function prepareChatReactionWriteAuthority(
  options: GatewayRequestHandlerOptions,
  input: ChatReactionsSetParams,
) {
  if (options.client?.internal?.agentToolCaller || options.client?.internal?.agentRuntimeIdentity) {
    return prepareAgentChatReactionAuthority(options, input);
  }
  const authority = await prepareChatReactionAuthority(options, input, true);
  const profileId = authority.viewerProfileId;
  if (!profileId) {
    authority.release();
    throw new Error("A signed-in human profile is required");
  }
  return {
    scope: authority.scope,
    reactor: { type: "profile" as const, id: profileId },
    profileAliases: [
      profileId,
      ...Object.entries(authority.profileAliases)
        .filter(([, canonical]) => canonical === profileId)
        .map(([alias]) => alias),
    ],
    assertCurrent: authority.assertCurrent,
    release: authority.release,
  };
}

/** Agent writes borrow the admitted run and the existing current-session participation owner. */
async function prepareAgentChatReactionAuthority(
  options: GatewayRequestHandlerOptions,
  input: ChatReactionsSetParams,
) {
  const client = options.client;
  const tool = client?.internal?.agentToolCaller;
  const runtime = client?.internal?.agentRuntimeIdentity;
  const caller = tool ?? runtime;
  if (
    !client ||
    !caller ||
    caller.sessionKey !== input.sessionKey ||
    (input.agentId && caller.agentId !== input.agentId)
  ) {
    throw new Error("An agent can only react in its current conversation");
  }
  const runSessionId = runtime?.messageActionContext?.sessionId;
  if (runSessionId && runSessionId !== input.sessionId) {
    throw new Error("The agent run belongs to a different session window");
  }
  const assertRun = captureSessionToolInvocationAuthority({
    client,
    context: options.context,
    sessionKey: input.sessionKey,
    agentId: caller.agentId,
    requiredTool: "message",
    deny: (message) => {
      throw new Error(message ?? "Agent reaction authority is no longer active");
    },
  });
  const assertAgentCurrent = () => {
    assertRun();
    if (
      client?.internal?.agentToolCaller !== tool ||
      client?.internal?.agentRuntimeIdentity !== runtime
    ) {
      throw new Error("The agent reaction caller is no longer active");
    }
    enforceMessageActionAllowlist({
      cfg: options.context.getRuntimeConfig(),
      agentId: caller.agentId,
      action: "react",
    });
  };
  const authority = await prepareChatReactionAuthority(
    options,
    { ...input, agentId: caller.agentId },
    true,
    assertAgentCurrent,
  );
  return {
    scope: authority.scope,
    reactor: { type: "agent" as const, id: caller.agentId },
    profileAliases: [],
    assertCurrent: authority.assertCurrent,
    release: authority.release,
  };
}
