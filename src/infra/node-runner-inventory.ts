import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { parseWorkerCapacity } from "../../packages/gateway-protocol/src/worker-capacity.js";

export const NODE_RUNNER_INVENTORY_UPDATE_METHOD = "node.runnerInventory.update";
export const NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE = "node-worker-supervisor-v6";
const RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES = [
  "node-worker-supervisor-v1",
  "node-worker-supervisor-v2",
  "node-worker-supervisor-v3",
  "node-worker-supervisor-v4",
  "node-worker-supervisor-v5",
] as const;
export const NODE_WORKER_BUNDLE_RETENTION_VERSION = 1;
export const NODE_WORKER_BUNDLE_STATUS_VERSION = 1;
export const NODE_WORKER_PORTAL_STREAM_VERSION = 1;
export const NODE_WORKER_ENVIRONMENT_SESSION_VERSION = 1;
export const NODE_WORKER_PREPARED_WORKSPACE_VERSION = 1;
export const NODE_WORKER_HOST_DISABLED_REASON_MAX_LENGTH = 1_024;

const NODE_WORKER_VERSIONED_CAPABILITIES = [
  ["bundlePrewarm", WORKER_BUNDLE_PREWARM_VERSION],
  ["bundleRetention", NODE_WORKER_BUNDLE_RETENTION_VERSION],
  ["bundleStatus", NODE_WORKER_BUNDLE_STATUS_VERSION],
  ["portalStream", NODE_WORKER_PORTAL_STREAM_VERSION],
  ["environmentSession", NODE_WORKER_ENVIRONMENT_SESSION_VERSION],
  ["preparedWorkspace", NODE_WORKER_PREPARED_WORKSPACE_VERSION],
] as const;

type NodeWorkerVersionedCapabilities = {
  [
    Capability in (typeof NODE_WORKER_VERSIONED_CAPABILITIES)[number] as Capability[0]
  ]?: Capability[1];
};

export const NODE_RUNNER_UPDATE_REQUIRED_ISSUE = {
  code: "update-required",
  action: "update-and-reconnect",
  updateCommand: "openclaw update",
  headlessReconnectCommand: "openclaw node restart",
} as const;

export type NodeRunnerInventoryIssue =
  | typeof NODE_RUNNER_UPDATE_REQUIRED_ISSUE
  | { code: "worker-host-unavailable"; message: string };
export type NodeWorkerCapacitySnapshot = Readonly<{
  total: number;
  available: number;
}>;

export type NodeWorkerHostDeclaration =
  | { enabled: false; reason?: string }
  | (NodeWorkerVersionedCapabilities & {
      enabled: true;
      capacity: NodeWorkerCapacitySnapshot;
      capturedExecPolicy?: true;
    });

export type NodeRunnerInventoryDeclaration =
  | { protocolFeatures: readonly [] }
  | {
      protocolFeatures: readonly [
        (typeof RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES)[number],
      ];
    }
  | {
      protocolFeatures: readonly [typeof NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE];
      workerHost: NodeWorkerHostDeclaration;
    };

function parseWorkerHostDeclaration(value: unknown): NodeWorkerHostDeclaration | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    return null;
  }
  const keys = Object.keys(value);
  if (!value.enabled) {
    if (
      keys.some((key) => key !== "enabled" && key !== "reason") ||
      (value.reason !== undefined &&
        (typeof value.reason !== "string" ||
          !value.reason.trim() ||
          value.reason.length > NODE_WORKER_HOST_DISABLED_REASON_MAX_LENGTH))
    ) {
      return null;
    }
    return {
      enabled: false,
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  const capacity = parseWorkerCapacity(value.capacity);
  if (
    !capacity ||
    !keys.includes("enabled") ||
    !keys.includes("capacity") ||
    keys.some(
      (key) =>
        key !== "enabled" &&
        key !== "capacity" &&
        key !== "capturedExecPolicy" &&
        !NODE_WORKER_VERSIONED_CAPABILITIES.some(([name]) => name === key),
    ) ||
    (value.capturedExecPolicy !== undefined && value.capturedExecPolicy !== true) ||
    (value.bundleStatus !== undefined && value.bundleRetention === undefined)
  ) {
    return null;
  }
  const capabilities: NodeWorkerVersionedCapabilities = {};
  for (const [key, version] of NODE_WORKER_VERSIONED_CAPABILITIES) {
    if (value[key] !== undefined) {
      if (value[key] !== version) {
        return null;
      }
      capabilities[key] = version;
    }
  }
  return {
    enabled: true,
    capacity,
    ...capabilities,
    ...(value.capturedExecPolicy === true ? { capturedExecPolicy: true } : {}),
  };
}

/** Parses the closed reconnect-scoped node-host runner declaration. */
export function parseNodeRunnerInventoryDeclaration(
  value: unknown,
): NodeRunnerInventoryDeclaration | null {
  if (!isRecord(value) || !Array.isArray(value.protocolFeatures)) {
    return null;
  }
  const keys = Object.keys(value);
  if (value.protocolFeatures.length === 0) {
    return keys.length === 1 && keys.includes("protocolFeatures") ? { protocolFeatures: [] } : null;
  }
  if (value.protocolFeatures.length !== 1) {
    return null;
  }
  const feature = value.protocolFeatures[0];
  const retiredFeature = RETIRED_NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURES.find(
    (candidate) => candidate === feature,
  );
  if (retiredFeature) {
    // Retired payloads never become consent or launch authority; only their marker drives recovery.
    return keys.length <= 2 &&
      keys.every(
        (key) => key === "protocolFeatures" || key === "workerRuns" || key === "workerHost",
      )
      ? { protocolFeatures: [retiredFeature] }
      : null;
  }
  if (feature !== NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE || keys.length !== 2) {
    return null;
  }
  const workerHost = parseWorkerHostDeclaration(value.workerHost);
  return workerHost
    ? { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost }
    : null;
}

export function formatNodeRunnerInventoryIssue(
  nodeId: string,
  issue: NodeRunnerInventoryIssue,
): string {
  return issue.code === "worker-host-unavailable"
    ? `device worker node ${nodeId} cannot host sessions: ${issue.message}`
    : `device worker node ${nodeId} requires an update before it can host sessions; run ${issue.updateCommand}, then reconnect it (for a headless node, run ${issue.headlessReconnectCommand})`;
}

/** Worker execution requires the node to preserve the Gateway's captured exec policy. */
export function resolveNodeWorkerExecutionIssue(
  workerHost: NodeWorkerHostDeclaration,
): NodeRunnerInventoryIssue | undefined {
  return workerHost.enabled && workerHost.capturedExecPolicy !== true
    ? NODE_RUNNER_UPDATE_REQUIRED_ISSUE
    : undefined;
}
