import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatReactionsListParams } from "../../../packages/gateway-protocol/src/chat-reactions.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { readUserProfileAliasRevision } from "../../state/user-profile-events.js";
import {
  readResidentUserProfileId,
  readResidentUserProfileMergeAliases,
} from "../../state/user-profile-list.js";
import { onOperatorRolePolicyChanged } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  authorizeIncognitoSessionTarget,
  hiddenSessionNotFound,
} from "../session-sharing-policy.js";
import { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "../session-sharing-read.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function changed(message: string): never {
  throw new SessionMutationAuthorizationChangedError(errorShape(ErrorCodes.FORBIDDEN, message));
}

/** Retain the physical session, requester and live sharing owner across storage waits. */
export async function prepareChatReactionAuthority(
  options: GatewayRequestHandlerOptions,
  input: Pick<ChatReactionsListParams, "sessionKey" | "agentId" | "sessionId">,
  write: boolean,
  assertAgentWriterCurrent?: () => void,
) {
  const { client, context } = options;
  const attachedProfileId = client?.authenticatedUserProfile?.profileId;
  const assertIngress = () => {
    options.signal?.throwIfAborted();
    options.sessionMutationAuthorization?.assertCurrent();
    if (write) {
      assertAgentWriterCurrent?.();
    }
    if (
      client?.invalidated ||
      client?.connectionSignal?.aborted ||
      client?.authenticatedUserProfile?.profileId !== attachedProfileId
    ) {
      changed("Reaction requester changed; reload the conversation");
    }
    if (
      write &&
      !assertAgentWriterCurrent &&
      (!attachedProfileId || !client || isSyntheticGatewayCaller(client))
    ) {
      changed("Only a signed-in human can change message reactions");
    }
  };
  assertIngress();
  const projection = getSessionRowProjection(context);
  if (!projection) {
    throw new Error("Session access is not ready; reload the conversation");
  }
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, input.sessionKey, input.agentId);
  if (!requested.ok) {
    throw new SessionMutationAuthorizationChangedError(requested.error);
  }
  const profile = attachedProfileId
    ? await prepareUserProfileRoleAuthority(attachedProfileId)
    : undefined;
  assertIngress();
  const facts = await prepareSessionMutationFacts({
    cfg,
    sessionKey: input.sessionKey,
    agentId: requested.agentId,
  });
  const stops: Array<() => void> = [];
  try {
    const aliasRevision = readUserProfileAliasRevision();
    const profileAliases = readResidentUserProfileMergeAliases();
    const viewerProfileId = attachedProfileId
      ? readResidentUserProfileId(attachedProfileId)
      : undefined;
    if (write && !assertAgentWriterCurrent && (!viewerProfileId || !profile?.isCurrent())) {
      changed("The signed-in profile is no longer available");
    }
    const initial = facts.readCurrent(context.getRuntimeConfig()).target;
    let revoked = false;
    const assertCurrent = () => {
      if (revoked) {
        changed("Reaction access changed; reload the conversation");
      }
      assertIngress();
      if (
        getSessionRowProjection(context) !== projection ||
        readUserProfileAliasRevision() !== aliasRevision ||
        (profile && !profile.isCurrent())
      ) {
        changed("Reaction identity changed; reload the conversation");
      }
      const current = facts.readCurrent(context.getRuntimeConfig());
      const target = current.target;
      if (
        target.entry.sessionId !== initial.entry.sessionId ||
        (write && target.entry.sessionId !== input.sessionId) ||
        target.entry.lifecycleRevision !== initial.entry.lifecycleRevision
      ) {
        changed("Reaction session changed; reload the conversation");
      }
      const incognitoError = authorizeIncognitoSessionTarget({
        client,
        sessionKey: target.canonicalKey,
        target,
      });
      if (incognitoError) {
        throw new SessionMutationAuthorizationChangedError(incognitoError);
      }
      const sharing = prepareProjectedSessionSharing({
        cfg: context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig(),
        client,
        isMember: (_target, identity) => current.membership.has(identity),
      });
      if (sharing.entryFilter?.(target.canonicalKey, target.entry) === false) {
        throw new SessionMutationAuthorizationChangedError(
          hiddenSessionNotFound(target.canonicalKey),
        );
      }
      const denied = write ? sharing.authorizeTarget(target) : null;
      if (denied) {
        throw new SessionMutationAuthorizationChangedError(denied);
      }
    };
    assertCurrent();
    // A revoked invitation restored before the worker next asks must not revive this request.
    const inRequestContext = AsyncLocalStorage.snapshot();
    const observe = () =>
      inRequestContext(() => {
        try {
          assertCurrent();
        } catch {
          revoked = true;
        }
      });
    stops.push(sessionChanges.subscribe(observe), onOperatorRolePolicyChanged(observe));
    return {
      scope: {
        agentId: initial.agentId,
        sessionKey: initial.canonicalKey,
        sessionId: input.sessionId,
        storePath: initial.storePath,
      },
      viewerProfileId,
      profileAliases,
      assertCurrent,
      release(this: void) {
        stops.forEach((stop) => stop());
        facts.release();
      },
    };
  } catch (error) {
    stops.forEach((stop) => stop());
    facts.release();
    throw error;
  }
}
