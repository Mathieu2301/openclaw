import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { listAgentIds } from "../agent-scope.js";
import {
  callInProcessGatewayToolWithCreation,
  hasInProcessGatewayToolContext,
  type AgentToolGatewayRequestCaller as GatewayCaller,
} from "./in-process-gateway.js";

export function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: "main",
    mainKey: params.mainKey,
  });
}

export function isConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  mainKey: string;
}): boolean {
  if (isUnscopedSessionKeySentinel(params.sessionKey)) {
    return false;
  }
  if (params.sessionKey === params.mainKey) {
    return true;
  }
  const agentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  return agentId
    ? params.sessionKey ===
        resolveConfiguredAgentMainSessionKey({
          cfg: params.cfg,
          agentId,
          mainKey: params.mainKey,
        })
    : false;
}

export async function createConfiguredAgentMainSession(params: {
  callGateway: GatewayCaller;
  agentId: string;
  sessionKey: string;
  requesterSessionKey?: string;
  useTrustedInProcessCreation: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const createParams = {
      key: params.sessionKey,
      agentId: params.agentId,
    };
    if (
      params.useTrustedInProcessCreation &&
      params.requesterSessionKey &&
      hasInProcessGatewayToolContext()
    ) {
      // sessions.create serializes keyed creation and adopts an existing row,
      // so concurrent first sends can safely race after the missing resolution.
      await callInProcessGatewayToolWithCreation("sessions.create", createParams, {
        via: "internal",
        actor: { type: "agent", id: params.requesterSessionKey },
      });
    } else {
      await params.callGateway({
        method: "sessions.create",
        params: createParams,
        timeoutMs: 10_000,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}
