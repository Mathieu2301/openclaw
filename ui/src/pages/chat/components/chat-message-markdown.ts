import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { renderCopyAsMarkdownButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import { readHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
} from "../../../lib/chat/message-normalizer.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import {
  resolveCappedMessageId,
  resolveSourceMessageId,
  type AssistantMessageExpansionState,
} from "../chat-message-recovery.ts";
import type { ChatReactionsController } from "../chat-reactions.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { renderRewindButton } from "./chat-message-confirmation.ts";
import { extractMessageMediaText } from "./chat-message-media.ts";

registerChatMessageMetadataEnglish();

export type MessageReplyTarget = ChatReplyTarget;

export type MessageActionDetails = {
  /** Canonical saved user/assistant target for the shared reaction/action row. */
  reactionMessageId?: string;
  /** Source for context copy, independent of footer visibility and reply truncation. */
  copyMarkdown?: string;
  markdown?: string;
  fullMessage?: { messageId: string; state: AssistantMessageExpansionState | undefined };
  replyTarget?: MessageReplyTarget;
};

// Loading and completion each advance the revision: three automatic attempts.
export const FULL_MESSAGE_RETRY_REVISION_LIMIT = 6;

// Options and action handlers outlive a render; keep this preparation separate from them.
export function prepareChatMessageRender(message: unknown) {
  const normalizedMessage = normalizeMessage(message);
  const displayMarkdown = resolveMessageDisplayMarkdown(message, normalizedMessage);
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  let humanMentions: ReturnType<typeof readHumanMentions>;
  if (record?.role === "user" && metadata?.humanMentions) {
    const source =
      typeof record.content === "string"
        ? record.content
        : Array.isArray(record.content)
          ? record.content
              .flatMap((block: unknown) => {
                const item = asNullableRecord(block);
                return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
              })
              .join("\n")
          : null;
    // Selections belong to submitted bytes, not a stripped envelope or display cap.
    if (source === displayMarkdown) {
      humanMentions = readHumanMentions(displayMarkdown, metadata.humanMentions);
    }
  }
  return { message, normalizedMessage, displayMarkdown, humanMentions };
}

export type ChatMessageRenderPreparation = ReturnType<typeof prepareChatMessageRender>;

// An explicit Markdown value is the displayed expansion, even when it is empty.
export function resolveMessageReplyText(
  message: unknown,
  normalizedMessage = normalizeMessage(message),
  markdown = resolveMessageDisplayMarkdown(message, normalizedMessage),
): string {
  return markdown || extractMessageMediaText(message, normalizedMessage.content);
}

export function resolveMessageActionDetails(
  { message, normalizedMessage, displayMarkdown: previewMarkdown }: ChatMessageRenderPreparation,
  params: {
    messageId: string;
    canFetchFullMessage?: boolean;
    getAssistantMessageExpansion?: (
      messageId: string,
    ) => AssistantMessageExpansionState | undefined;
    onReply?: (target: MessageReplyTarget) => void;
    senderLabel: string;
  },
): MessageActionDetails | null {
  const { messageId: renderMessageId, canFetchFullMessage, onReply, senderLabel } = params;
  const role = normalizeRoleForGrouping(normalizedMessage.role);
  const pendingInput =
    resolveSourceMessageId(message)?.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX) === true;
  const cappedMessageId = canFetchFullMessage ? resolveCappedMessageId(message, role) : undefined;
  const fullMessage = cappedMessageId
    ? { messageId: cappedMessageId, state: params.getAssistantMessageExpansion?.(cappedMessageId) }
    : undefined;
  const expansion = fullMessage?.state;
  const expandedMarkdown = expansion?.status === "loaded" ? expansion.markdown : previewMarkdown;
  const visibleMarkdown =
    role === "assistant" ? stripThinkingTags(expandedMarkdown) : expandedMarkdown;
  const markdown =
    role === "assistant" || role === "user" || pendingInput ? visibleMarkdown : undefined;
  const copyMarkdown = resolveMessageReplyText(message, normalizedMessage, visibleMarkdown);
  const replyText = onReply && !pendingInput ? truncateUtf16Safe(copyMarkdown, 500) : "";
  const sourceMessageId = persistedMessageEntryId(message);
  const reactionMessageId =
    (role === "user" || role === "assistant") && sourceMessageId ? sourceMessageId : undefined;
  if (!copyMarkdown && !markdown && !replyText && !fullMessage && !reactionMessageId) {
    return null;
  }
  return {
    ...(reactionMessageId ? { reactionMessageId } : {}),
    copyMarkdown,
    ...(markdown === undefined ? {} : { markdown }),
    fullMessage,
    ...(replyText
      ? {
          replyTarget: {
            messageId: renderMessageId,
            text: replyText,
            senderLabel,
            ...(sourceMessageId ? { sourceMessageId } : {}),
          },
        }
      : {}),
  };
}

export function renderMessageActionButtons(
  details: MessageActionDetails,
  opts: {
    onReply?: (target: MessageReplyTarget) => void;
  },
) {
  return html`
    ${details.markdown ? renderCopyAsMarkdownButton(details.markdown) : nothing}
    ${
      details.replyTarget && opts.onReply
        ? renderReplyButton(details.replyTarget, opts.onReply)
        : nothing
    }
  `;
}

export function renderReplyButton(
  target: MessageReplyTarget,
  onReply: (target: MessageReplyTarget) => void,
) {
  return html`
    <openclaw-tooltip .content=${t("chat.messages.reply")}>
      <button
        class="chat-reply-btn"
        type="button"
        aria-label=${t("chat.messages.replyToMessage")}
        @click=${() => onReply(target)}
      >
        ${icons.messageSquare}
      </button>
    </openclaw-tooltip>
  `;
}

export type MessageReactionActionOptions = {
  isStreaming: boolean;
  reactions?: ChatReactionsController;
  messageActions?: MessageActionDetails | null;
  onReply?: (target: MessageReplyTarget) => void;
  onRewind?: () => void;
  rewindDisabled?: boolean;
};

export function renderMessageReactionActions(
  messageKey: string,
  role: string,
  opts: MessageReactionActionOptions,
) {
  const reactionMessageId = !opts.isStreaming ? opts.messageActions?.reactionMessageId : undefined;
  return html`
    ${
      reactionMessageId && (role === "user" || role === "assistant") && opts.reactions
        ? html`<div class="chat-message-action-line" data-message-actions-for=${messageKey}>
            <openclaw-chat-message-reactions
              data-message-id=${reactionMessageId}
              .messageId=${reactionMessageId}
              .controller=${opts.reactions}
              .actions=${html`<div class="chat-message-actions-row">
                ${role === "user" && opts.onRewind && !opts.rewindDisabled ? renderRewindButton(opts.onRewind) : nothing}
                ${opts.messageActions ? renderMessageActionButtons(opts.messageActions, opts) : nothing}
              </div>`}
            ></openclaw-chat-message-reactions>
          </div>`
        : nothing
    }
  `;
}
