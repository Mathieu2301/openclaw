import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { TemplateContext } from "../templating.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";

export type ReplySourceMessageContext = {
  sessionCtx: TemplateContext;
  run?: { agentId?: string; sessionId: string; sessionKey?: string };
  userTurnAdmission?: UserTurnTranscriptAdmissionReceipt;
};

/** Tool targets use saved WebChat entries without rewriting ingress/recovery identity. */
export function resolveReplyCurrentMessageId(params: ReplySourceMessageContext) {
  const { sessionCtx, run, userTurnAdmission } = params;
  if (
    sessionCtx.InputProvenance?.kind === "internal_system" &&
    sessionCtx.InputProvenance.sourceTool === "restart-sentinel"
  ) {
    return sessionCtx.ReplyToId;
  }
  const provider = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Provider,
  });
  if (provider !== "webchat") {
    return sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  }
  // A send/run ID or accepted pending input is not a saved message. Only the
  // current recorder's committed receipt can supply the native chat target.
  return userTurnAdmission &&
    run?.agentId === userTurnAdmission.agentId &&
    run.sessionId === userTurnAdmission.sessionId &&
    run.sessionKey === userTurnAdmission.sessionKey
    ? userTurnAdmission.entryId
    : undefined;
}
