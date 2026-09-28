import type {
  ChatReactionIdentity,
  ChatReactionsListResult,
  ChatReactionsSetResult,
  ChatReactionsPeopleResult,
  ChatReactionsChangedEvent,
} from "../../../packages/gateway-protocol/src/chat-reactions.js";
import {
  ErrorCodes,
  errorShape,
  validateChatReactionsListParams,
  validateChatReactionsSetParams,
  validateChatReactionsPeopleParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  listSessionReactions,
  peopleSessionReactions,
  setSessionReaction,
} from "../../config/sessions/session-reactions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertChatReactionEmoji } from "../../shared/chat-reaction-emoji.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { projectSessionParticipant } from "../session-identity-projection.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { prepareChatReactionWriteAuthority } from "./chat-reactions-agent-authority.js";
import { prepareChatReactionAuthority } from "./chat-reactions-authority.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

function reactor(
  identity: ChatReactionIdentity,
  cfg: OpenClawConfig,
): ChatReactionsPeopleResult["reactors"][number] {
  if (identity.type === "agent") {
    const display = projectSessionParticipant(identity, new Map(), cfg);
    return { identity, label: display.label ?? identity.id, avatarUrl: display.avatarUrl };
  }
  const display = resolveCurrentUserProfileDisplay(identity.id);
  return display.kind === "resolved"
    ? {
        identity: { type: "profile", id: display.profileId },
        label: display.label ?? "Unknown person",
        avatarUrl: display.avatarUrl,
      }
    : { identity, label: "Unknown person" };
}

function fail(options: GatewayRequestHandlerOptions, error: unknown) {
  options.respond(
    false,
    undefined,
    error instanceof SessionMutationAuthorizationChangedError
      ? error.error
      : errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "Reaction request failed",
        ),
  );
}

export const chatReactionHandlers: GatewayRequestHandlers = {
  "chat.reactions.list": defineValidatedGatewayHandler(
    "chat.reactions.list",
    validateChatReactionsListParams,
    async (options) => {
      let authority: Awaited<ReturnType<typeof prepareChatReactionAuthority>> | undefined;
      try {
        const input = options.params;
        authority = await prepareChatReactionAuthority(options, input, false);
        const messages = await listSessionReactions(authority.scope, {
          sessionId: input.sessionId,
          messageIds: input.messageIds,
          profileAliases: authority.profileAliases,
          viewerProfileId: authority.viewerProfileId,
        });
        authority.assertCurrent();
        const cfg = options.context.getRuntimeConfig();
        options.respond(true, {
          sessionId: input.sessionId,
          messages: messages.map((message) => ({
            messageId: message.messageId,
            reactions: message.reactions.map(({ reactors, ...reaction }) => ({
              ...reaction,
              reactors: reactors.map((identity) => reactor(identity, cfg)),
            })),
          })),
        } satisfies ChatReactionsListResult);
      } catch (error) {
        fail(options, error);
      } finally {
        authority?.release();
      }
    },
  ),
  "chat.reactions.people": defineValidatedGatewayHandler(
    "chat.reactions.people",
    validateChatReactionsPeopleParams,
    async (options) => {
      let authority: Awaited<ReturnType<typeof prepareChatReactionAuthority>> | undefined;
      try {
        const input = options.params;
        assertChatReactionEmoji(input.emoji);
        authority = await prepareChatReactionAuthority(options, input, false);
        const people = await peopleSessionReactions(authority.scope, {
          sessionId: input.sessionId,
          messageId: input.messageId,
          emoji: input.emoji,
          profileAliases: authority.profileAliases,
          cursor: input.cursor,
        });
        authority.assertCurrent();
        const cfg = options.context.getRuntimeConfig();
        options.respond(true, {
          sessionId: input.sessionId,
          messageId: input.messageId,
          emoji: input.emoji,
          reactors: people.reactors.map((identity) => reactor(identity, cfg)),
          ...(people.nextCursor ? { nextCursor: people.nextCursor } : {}),
        } satisfies ChatReactionsPeopleResult);
      } catch (error) {
        fail(options, error);
      } finally {
        authority?.release();
      }
    },
  ),
  "chat.reactions.set": defineValidatedGatewayHandler(
    "chat.reactions.set",
    validateChatReactionsSetParams,
    async (options) => {
      let authority: Awaited<ReturnType<typeof prepareChatReactionWriteAuthority>> | undefined;
      try {
        const input = options.params;
        assertChatReactionEmoji(input.emoji);
        authority = await prepareChatReactionWriteAuthority(options, input);
        const changed = await setSessionReaction(
          authority.scope,
          {
            sessionId: input.sessionId,
            messageId: input.messageId,
            emoji: input.emoji,
            active: input.active,
            reactor: authority.reactor,
            profileAliases: authority.profileAliases,
          },
          authority.assertCurrent,
        );
        if (changed) {
          // Counts and identities are fetched under each reader's current authority, never broadcast.
          options.context.broadcast(
            "chat.reactions.changed",
            {
              sessionKey: authority.scope.sessionKey,
              agentId: authority.scope.agentId,
              sessionId: input.sessionId,
              messageIds: [input.messageId],
            } satisfies ChatReactionsChangedEvent,
            {
              dropIfSlow: true,
              sessionKeys: [authority.scope.sessionKey],
              agentId: authority.scope.agentId,
            },
          );
        }
        options.respond(true, { ok: true, changed } satisfies ChatReactionsSetResult);
      } catch (error) {
        fail(options, error);
      } finally {
        authority?.release();
      }
    },
  ),
};
