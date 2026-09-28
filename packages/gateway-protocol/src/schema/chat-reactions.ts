import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import type { SessionParticipantIdentity } from "./session-participant.js";

const id = Type.String({ minLength: 1, maxLength: 256 });
const emoji = Type.String({ minLength: 1, maxLength: 64 });
const target = {
  sessionKey: Type.String({ minLength: 1, maxLength: 1024 }),
  agentId: Type.Optional(id),
  sessionId: id,
};
const reactor = closedObject({
  identity: Type.Union([
    closedObject({ type: Type.Literal("profile"), id }),
    closedObject({ type: Type.Literal("agent"), id }),
  ]),
  label: Type.String(),
  avatarUrl: Type.Optional(Type.String()),
});
const messageIds = Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true });

export const ChatReactionsListParamsSchema = closedObject({ ...target, messageIds });
export const ChatReactionsSetParamsSchema = closedObject({
  ...target,
  messageId: id,
  emoji,
  active: Type.Boolean(),
});
export const ChatReactionsPeopleParamsSchema = closedObject({
  ...target,
  messageId: id,
  emoji,
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export const ChatReactionsListResultSchema = closedObject({
  sessionId: id,
  messages: Type.Array(
    closedObject({
      messageId: id,
      reactions: Type.Array(
        closedObject({
          emoji,
          count: Type.Integer({ minimum: 1 }),
          reactedByMe: Type.Boolean(),
          reactors: Type.Array(reactor, { maxItems: 3 }),
          hasMoreReactors: Type.Boolean(),
        }),
      ),
    }),
    { maxItems: 100 },
  ),
});
export const ChatReactionsSetResultSchema = closedObject({
  ok: Type.Literal(true),
  changed: Type.Boolean(),
});
export const ChatReactionsPeopleResultSchema = closedObject({
  sessionId: id,
  messageId: id,
  emoji,
  reactors: Type.Array(reactor, { maxItems: 50 }),
  nextCursor: Type.Optional(Type.String()),
});
export const ChatReactionsChangedEventSchema = closedObject({
  sessionKey: target.sessionKey,
  agentId: id,
  sessionId: id,
  messageIds,
});

export type ChatReactionIdentity = Extract<
  SessionParticipantIdentity,
  { type: "profile" | "agent" }
>;
export type ChatReactionsListParams = Static<typeof ChatReactionsListParamsSchema>;
export type ChatReactionsSetParams = Static<typeof ChatReactionsSetParamsSchema>;
export type ChatReactionsPeopleParams = Static<typeof ChatReactionsPeopleParamsSchema>;
export type ChatReactionsListResult = Static<typeof ChatReactionsListResultSchema>;
export type ChatReactionSummary = ChatReactionsListResult["messages"][number]["reactions"][number];
export type ChatReactionPerson = ChatReactionSummary["reactors"][number];
export type ChatReactionsSetResult = Static<typeof ChatReactionsSetResultSchema>;
export type ChatReactionsPeopleResult = Static<typeof ChatReactionsPeopleResultSchema>;
export type ChatReactionsChangedEvent = Static<typeof ChatReactionsChangedEventSchema>;
