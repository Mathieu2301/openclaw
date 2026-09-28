/** Browser-safe type-only contract; reaction state never enters transcript messages. */
export type {
  ChatReactionIdentity,
  ChatReactionSummary,
  ChatReactionPerson,
  ChatReactionsListParams,
  ChatReactionsSetParams,
  ChatReactionsPeopleParams,
  ChatReactionsListResult,
  ChatReactionsSetResult,
  ChatReactionsPeopleResult,
  ChatReactionsChangedEvent,
} from "./schema/chat-reactions.js";
