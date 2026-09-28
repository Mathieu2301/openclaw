import { isRuntimeToolAllowed, isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

/** Capture the admitted tool/run owner independently of a resource’s storage lifetime. */
export function captureSessionToolInvocationAuthority(params: {
  client: GatewayClient;
  context: GatewayRequestContext;
  sessionKey: string;
  agentId: string;
  requiredTool?: string;
  deny: (message?: string) => never;
}): () => void {
  const { client, sessionKey } = params;
  const tool = client?.internal?.agentToolCaller;
  const runtime = client?.internal?.agentRuntimeIdentity;
  const ambient = client?.internal?.syntheticClient ? getGatewayToolCallerIdentity() : undefined;
  const assertAmbient = ambient ? captureGatewayToolCallerAssertion() : undefined;
  const owner = tool ?? runtime ?? (assertAmbient ? ambient : undefined);
  const inherited = runtime?.sessionSpawnContext?.inheritedToolPolicy;
  const inheritedPolicy = inherited
    ? { allow: [...inherited.allow], deny: [...inherited.deny] }
    : undefined;
  if ((client.internal?.syntheticClient && !owner) || (tool && !tool.assertCurrent)) {
    params.deny("Session resources require an authenticated operator or an admitted agent run.");
  }
  if (owner && (owner.sessionKey !== sessionKey || owner.agentId !== params.agentId)) {
    params.deny("An agent can only access resources in its own conversation.");
  }
  const assertRun = () => {
    tool?.assertCurrent?.();
    if (ambient) {
      if (
        !assertAmbient ||
        ambient.agentId !== params.agentId ||
        ambient.sessionKey !== sessionKey ||
        (ambient.gatewayContextResolver && ambient.gatewayContextResolver() !== params.context)
      ) {
        params.deny();
      }
      assertAmbient();
    }
    if (runtime && params.context.validateAgentRuntimeApprovalAuthority?.(runtime) !== true) {
      params.deny();
    }
    const requiredTool = params.requiredTool;
    if (requiredTool && owner) {
      if (ambient) {
        if (
          !ambient.assertToolAllowed ||
          !ambient.operationalRunInstance ||
          (runtime &&
            (runtime.operationalRunInstance.instanceId !==
              ambient.operationalRunInstance.instanceId ||
              runtime.operationalRunInstance.runId !== ambient.operationalRunInstance.runId))
        ) {
          params.deny();
        }
        ambient.assertToolAllowed(requiredTool);
      } else if (!inheritedPolicy) {
        params.deny();
      }
      if (
        inheritedPolicy &&
        (!isRuntimeToolAllowed(requiredTool, inheritedPolicy.allow) ||
          !isToolAllowedByPolicyName(requiredTool, { deny: inheritedPolicy.deny }))
      ) {
        params.deny();
      }
    }
  };
  return assertRun;
}
