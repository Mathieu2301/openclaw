import type {
  ChatReactionPerson,
  ChatReactionsListResult,
} from "../../../packages/gateway-protocol/src/chat-reactions.js";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";

export const reactionSessionKey = "agent:main:reaction-demo";
export const reactionSessionId = "reaction-demo-window";
export const humanReactionMessageId = "reaction-human-message";
export const agentReactionMessageId = "reaction-agent-message";
export const maya = {
  identity: { type: "profile", id: "reaction-person-maya" },
  label: "Maya",
} satisfies ChatReactionPerson;
export const aria = {
  identity: { type: "profile", id: "reaction-person-aria" },
  label: "Aria",
} satisfies ChatReactionPerson;
export const noah = {
  identity: { type: "profile", id: "reaction-person-noah" },
  label: "Noah",
} satisfies ChatReactionPerson;
export const currentPerson = {
  identity: { type: "profile", id: "reaction-person-owner" },
  label: "Owner",
} satisfies ChatReactionPerson;

export const atlas = {
  identity: { type: "agent", id: "reaction-agent-atlas" },
  label: "Atlas",
} satisfies ChatReactionPerson;

export function reactionList(own = false, other = false): ChatReactionsListResult {
  const people = [maya, atlas, aria, ...(own ? [currentPerson] : []), ...(other ? [noah] : [])];
  return {
    sessionId: reactionSessionId,
    messages: [
      {
        messageId: humanReactionMessageId,
        reactions: [
          { emoji: "👀", count: 1, reactedByMe: false, reactors: [noah], hasMoreReactors: false },
        ],
      },
      {
        messageId: agentReactionMessageId,
        reactions: [
          {
            emoji: "👍",
            count: people.length,
            reactedByMe: own,
            reactors: people.slice(0, 3),
            hasMoreReactors: people.length > 3,
          },
          { emoji: "🎉", count: 1, reactedByMe: false, reactors: [aria], hasMoreReactors: false },
        ],
      },
    ],
  };
}

export function reactionScenario(): ControlUiMockGatewayScenario {
  return {
    assistantName: "Assistant",
    agentModel: "openai/gpt-4.1",
    models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
    sessionKey: reactionSessionKey,
    presenceUsers: [
      {
        self: true,
        id: currentPerson.identity.id,
        identity: currentPerson.identity,
        name: currentPerson.label,
      },
    ],
    sessions: [
      {
        key: reactionSessionKey,
        sessionId: reactionSessionId,
        label: "Project planning",
        displayName: "Project planning",
        kind: "direct",
        status: "done",
        hasActiveRun: false,
        visibility: "shared",
        updatedAt: Date.now(),
        model: "gpt-4.1",
        modelProvider: "openai",
      },
    ],
    historyMessages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Can we ship the new onboarding flow on Thursday? The mobile review is the last item on my list.",
          },
        ],
        timestamp: Date.now() - 120_000,
        __openclaw: { id: humanReactionMessageId, seq: 1 },
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Thursday looks good. Here’s the remaining checklist:

- Finish the mobile review
- Confirm the welcome email copy
- Run the final accessibility checks

I’ve grouped the review notes so everyone can add feedback in one place.`,
          },
        ],
        timestamp: Date.now() - 60_000,
        __openclaw: { id: agentReactionMessageId, seq: 2 },
      },
    ],
    methodResponses: {
      "chat.reactions.list": reactionList(),
      "chat.reactions.set": { ok: true },
      "chat.reactions.people": {
        sessionId: reactionSessionId,
        messageId: agentReactionMessageId,
        emoji: "👍",
        reactors: [maya, atlas, aria],
      },
    },
  };
}
