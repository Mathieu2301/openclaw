import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import type { SqliteTransactionOptions } from "./sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import {
  canCleanupLegacyManagedHandoff,
  readManagedHandoffRepairFacts,
  inspectManagedHandoffRepairFacts,
} from "./update-managed-service-handoff-cleanup.js";
import {
  createManagedHandoffLeaseDatabase,
  deleteManagedHandoffLeaseRow as deleteRow,
  managedHandoffLeaseBinding as binding,
  parseManagedHandoffLeaseRow as handle,
  readManagedHandoffRepairMetadata,
  readManagedHandoffChildLeases,
  readManagedHandoffLeaseRow as row,
  updateManagedHandoffLeaseRow as updateRow,
  insertManagedHandoffLeaseRow as insertRow,
  type LeaseRow,
  type ManagedHandoffLease,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import {
  readBorrowedLegacyHandoffParent,
  isBorrowedLegacyHandoffParentCurrent,
  type BorrowedLegacyHandoffParent,
} from "./update-managed-service-handoff-legacy-parent.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { assertNoRetainedSourceBorrower } from "./update-managed-service-handoff-retained-custody.js";
import {
  parseManagedHandoffLeasePayload,
  triageFailureSchema,
  type HandoffProcessIdentity,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";
import { createManagedHandoffScopeReader } from "./update-managed-service-handoff-scope.js";

const text = z.string().min(1).max(4096);
export type { ManagedHandoffLease } from "./update-managed-service-handoff-database.js";
export type ManagedHandoffRepair = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createManagedHandoffLeaseStore>["prepareRepair"]>>
>;
export type ManagedHandoffParent = ManagedHandoffLease | BorrowedLegacyHandoffParent;
export type { BorrowedLegacyHandoffParent } from "./update-managed-service-handoff-legacy-parent.js";

export function resolveManagedUpdateLeaseDatabasePath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite");
}

type LeaseRead =
  | { kind: "absent" | "unreadable" }
  | { kind: "current"; lease: ManagedHandoffLease };
type LeaseAcquisition =
  | { kind: "busy"; owner: string }
  | { kind: "acquired"; lease: ManagedHandoffLease };

/** One lease implementation, preloaded normally and sealed before package replacement. */
export function createManagedHandoffLeaseStore(
  options: {
    databasePath: string;
    serviceManagerEnv: NodeJS.ProcessEnv;
    existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
    onProcessIdentityWarning?: (pid: number, message: string) => void;
  } = {
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: resolveServiceManagerEnv(),
  },
  logger?: SqliteTransactionOptions["logger"],
) {
  const { databasePath, serviceManagerEnv } = options;
  const bootIdentity = createManagedHandoffBootIdentityReader(serviceManagerEnv);
  const {
    isPidAlive,
    readProcessStartIdentity,
    processIdentity,
    processState,
    inspectProcessIdentity,
    isProcessIdentityCurrent,
    validateDarwinAncestorProcesses,
    acceptSelfIdentity,
  } = createManagedHandoffProcessIdentityReader({
    env: serviceManagerEnv,
    onWarning:
      options.onProcessIdentityWarning ?? ((pid, message) => logger?.warn(message, { pid })),
  });

  const nativeScopes = createManagedHandoffScopeReader(serviceManagerEnv);
  const withDatabase = createManagedHandoffLeaseDatabase(databasePath, options.existingIdentity);
  function admissionLease(root: string, value: LeaseRow | undefined) {
    // Only admission may retire a positively dead legacy row. Keep its complete
    // observation for the transaction CAS; read/handles require a supported strict schema.
    const legacyDead =
      value &&
      text.safeParse(value.owner).success &&
      Number.isSafeInteger(value.updated_at) &&
      value.updated_at >= 0 &&
      canCleanupLegacyManagedHandoff(value.payload_json, processState);
    return value && !legacyDead ? handle(root, value) : null;
  }
  function read(root: string): LeaseRead {
    try {
      const value = withDatabase.readRow(root);
      return value ? { kind: "current", lease: handle(root, value) } : { kind: "absent" };
    } catch {
      return { kind: "unreadable" };
    }
  }
  function readLegacyParent(
    root: string,
    executor?: HandoffProcessIdentity,
  ): BorrowedLegacyHandoffParent | null {
    return withDatabase(false, (db) =>
      readBorrowedLegacyHandoffParent(root, row(db, root), executor),
    );
  }
  function currentLegacyParent(parent: BorrowedLegacyHandoffParent, db: HandoffDatabase) {
    return isBorrowedLegacyHandoffParentCurrent(parent, () => row(db, parent.key), {
      isProcessIdentityCurrent,
      validateDarwinAncestorProcesses,
    });
  }
  const sameRow = (a: LeaseRow | undefined, b: LeaseRow | undefined) =>
    a?.owner === b?.owner && a?.payload_json === b?.payload_json && a?.updated_at === b?.updated_at;
  function transact<T>(db: HandoffDatabase, operation: () => T): T {
    return withDatabase.transact(db, operation, { logger });
  }
  function hasUnsettledChildren(
    lease: ManagedHandoffParent,
    connection?: HandoffDatabase,
  ): boolean {
    if (lease.version === 3) {
      return true;
    }
    const inspect = (db: HandoffDatabase) =>
      readManagedHandoffChildLeases(db, lease.key).some(
        (child) =>
          child.version === 3 ||
          processState(child.helper) !== "dead" ||
          processState(child.executor) !== "dead" ||
          (process.platform !== "win32" && isChildProcessTreeAlive(child.executor)),
      );
    return connection ? inspect(connection) : withDatabase(false, inspect);
  }
  function reclaimable(lease: ManagedHandoffLease, db?: HandoffDatabase) {
    // No process/boot liveness observation is a join receipt.
    if (lease.version === 3) {
      return false;
    }
    const action = lease.action;
    if (action.kind === "triage" && action.lifetime.kind === "foreground") {
      const boot = bootIdentity();
      if (
        boot.platform === action.lifetime.boot.platform &&
        boot.identity !== action.lifetime.boot.identity
      ) {
        return true;
      }
      if (!["reserved", "closed"].includes(action.phase)) {
        return false;
      }
    }
    if (processState(lease.helper) !== "dead" || processState(lease.executor) !== "dead") {
      return false;
    }
    return (
      !hasUnsettledChildren(lease, db) &&
      (action.kind !== "triage" ||
        action.lifetime.kind !== "native" ||
        nativeScopes.nativeClosed(action.lifetime))
    );
  }
  function admit(
    root: string,
    owner: string,
    payload: string,
    source?: ManagedHandoffLease,
    legacyParent?: BorrowedLegacyHandoffParent,
  ): LeaseAcquisition {
    return withDatabase(true, (db) => {
      // Probe liveness before taking the write lock; commit only if both observations still match.
      const observed = row(db, root);
      const destination = admissionLease(root, observed);
      const canReplace =
        !destination || (destination.owner !== owner && reclaimable(destination, db));
      return transact(db, () => {
        if (
          source &&
          !sameRow(
            { owner: source.owner, payload_json: source.payload, updated_at: source.updatedAt },
            row(db, source.key),
          )
        ) {
          throw new Error("managed triage source changed during admission");
        }
        if (source && hasUnsettledChildren(source, db)) {
          return { kind: "busy", owner: source.owner };
        }
        const childMarker = root.indexOf("/.openclaw-update-child-");
        if (childMarker >= 0) {
          const parentKey = root.slice(0, childMarker);
          const parent = row(db, parentKey);
          if (legacyParent) {
            if (legacyParent.key !== parentKey || !currentLegacyParent(legacyParent, db)) {
              throw new Error("Borrowed legacy update parent changed during child admission");
            }
            if (
              root.lastIndexOf("/.openclaw-update-child-") === childMarker &&
              hasUnsettledChildren(legacyParent, db)
            ) {
              return { kind: "busy", owner: legacyParent.owner };
            }
          } else if (!parent || handle(parentKey, parent).version === 3) {
            return { kind: "busy", owner: parent?.owner ?? owner };
          }
        } else if (legacyParent) {
          throw new Error("Borrowed legacy update authority admits only child rows");
        }
        const latest = row(db, root);
        if (!sameRow(observed, latest)) {
          if (latest) {
            return { kind: "busy", owner: handle(root, latest).owner };
          }
          throw new Error("managed handoff lease changed during admission");
        }
        const previous = destination ?? readBorrowedLegacyHandoffParent(root, observed);
        if (!canReplace || (previous && hasUnsettledChildren(previous, db))) {
          return { kind: "busy", owner: previous?.owner ?? owner };
        }
        if (observed) {
          deleteRow(db, {
            key: root,
            owner: observed.owner,
            payload: observed.payload_json,
            updatedAt: observed.updated_at,
          });
        }
        const updatedAt = Math.max(Date.now(), (source?.updatedAt ?? 0) + 1);
        if (source) {
          if (
            !updateRow(db, source, {
              install_root: root,
              payload_json: payload,
              updated_at: updatedAt,
            })
          ) {
            throw new Error("managed triage source changed during transfer");
          }
        } else {
          insertRow(db, {
            install_root: root,
            owner,
            payload_json: payload,
            updated_at: updatedAt,
          });
        }
        return {
          kind: "acquired",
          lease: handle(root, { owner, payload_json: payload, updated_at: updatedAt }),
        };
      });
    });
  }
  function acquire(
    root: string,
    owner: string,
    action: ManagedHandoffLeaseAction,
    transition = false,
    legacyParent?: BorrowedLegacyHandoffParent,
  ): LeaseAcquisition {
    const helper = processIdentity();
    const payload = JSON.stringify({ version: 2, executor: helper, helper, action });
    if (
      !text.safeParse(root).success ||
      !text.safeParse(owner).success ||
      !parseManagedHandoffLeasePayload(payload)
    ) {
      throw new Error("managed handoff admission is invalid");
    }
    if (transition) {
      if (legacyParent) {
        throw new Error("Borrowed legacy authority cannot transition a lease");
      }
      const result = read(root);
      if (
        result.kind !== "current" ||
        result.lease.owner !== owner ||
        result.lease.payload !== payload ||
        action.kind !== "triage" ||
        action.phase !== "reserved" ||
        action.lifetime.kind !== "native" ||
        action.lifetime.placement.kind !== "pending"
      ) {
        throw new Error("managed triage transition lost its current lease");
      }
      return { kind: "acquired", lease: result.lease };
    }
    return admit(root, owner, payload, undefined, legacyParent);
  }
  function current(lease: ManagedHandoffParent) {
    if (lease.version === 1) {
      return withDatabase(false, (db) => currentLegacyParent(lease, db));
    }
    const result = read(lease.key);
    return result.kind === "current" && isDeepStrictEqual(result.lease, lease);
  }
  function owns(lease: ManagedHandoffLease, role: "helper" | "executor" = "helper") {
    return (
      current(lease) &&
      !(
        lease.action.kind === "triage" &&
        ["closing", "closed", "uncertain"].includes(lease.action.phase)
      ) &&
      lease[role].pid === process.pid &&
      isProcessIdentityCurrent(lease.helper) &&
      acceptSelfIdentity(lease[role])
    );
  }
  function acceptParentBoundExecutor(lease: ManagedHandoffLease) {
    return (
      current(lease) &&
      lease.version === 2 &&
      lease.action.kind === "update" &&
      lease.helper.pid === process.ppid &&
      lease.executor.pid === process.pid &&
      isProcessIdentityCurrent(lease.helper) &&
      acceptSelfIdentity(lease.executor, true)
    );
  }
  function cas(
    lease: ManagedHandoffLease,
    action: ManagedHandoffLeaseAction,
    executor?: HandoffProcessIdentity,
    recovery?: (next: ManagedHandoffLease) => string,
  ) {
    // Ordinary bind/retarget/triage transitions cannot erase native custody.
    if (lease.version === 3) {
      return null;
    }
    const payload = JSON.stringify({
      ...parseManagedHandoffLeasePayload(lease.payload),
      action,
      ...(executor ? { executor, helper: lease.helper } : {}),
    });
    const decoded = parseManagedHandoffLeasePayload(payload);
    if (!decoded) {
      return null;
    }
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (hasUnsettledChildren(lease, db)) {
          return null;
        }
        const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
        const next = { ...lease, ...decoded, payload, updatedAt };
        return updateRow(db, lease, {
          payload_json: payload,
          updated_at: updatedAt,
          ...(recovery ? { recovery_json: recovery(next) } : {}),
        })
          ? next
          : null;
      }),
    );
  }
  function bind(
    lease: ManagedHandoffLease,
    pid: number,
    action = lease.action,
    argv?: readonly string[],
  ) {
    if (!owns(lease)) {
      return null;
    }
    const previous = lease.action;
    if (previous.kind === "triage") {
      if (
        previous.phase !== "reserved" ||
        action.kind !== "triage" ||
        action.phase !== "reserved" ||
        lease.executor.pid !== lease.helper.pid
      ) {
        return null;
      }
      const lifetime =
        previous.lifetime.kind === "native" &&
        action.lifetime.kind === "native" &&
        previous.lifetime.placement.kind === "pending"
          ? { ...previous.lifetime, placement: action.lifetime.placement }
          : previous.lifetime;
      if (JSON.stringify(lifetime) !== JSON.stringify(action.lifetime)) {
        return null;
      }
    } else if (action.kind !== "update") {
      return null;
    }
    return cas(lease, action, processIdentity(pid, argv));
  }
  function retarget(
    lease: ManagedHandoffLease,
    root: string,
    action: ManagedHandoffLeaseAction,
  ): LeaseAcquisition | null {
    if (
      lease.version !== 2 ||
      hasUnsettledChildren(lease) ||
      !owns(lease, "executor") ||
      lease.helper.pid !== process.pid ||
      lease.action.kind !== "update" ||
      action.kind !== "triage" ||
      action.phase !== "reserved" ||
      action.lifetime.kind !== "native" ||
      action.lifetime.placement.kind !== "pending"
    ) {
      return null;
    }
    const payload = JSON.stringify({
      version: 2,
      executor: lease.helper,
      helper: lease.helper,
      action,
    });
    if (
      !text.safeParse(root).success ||
      !parseManagedHandoffLeasePayload(payload) ||
      fs.realpathSync(root) !== root
    ) {
      throw new Error("managed triage destination is not canonical");
    }
    if (root === lease.key) {
      const next = cas(lease, action, lease.helper);
      return next ? { kind: "acquired", lease: next } : null;
    }
    return admit(root, lease.owner, payload, lease);
  }
  function activate(lease: ManagedHandoffLease) {
    if (
      !owns(lease) ||
      processState(lease.executor) !== "live" ||
      lease.executor.pid === lease.helper.pid ||
      lease.action.kind !== "triage" ||
      lease.action.phase !== "reserved"
    ) {
      return null;
    }
    return cas(lease, { ...lease.action, phase: "running" });
  }
  function readGeneration(lease: ManagedHandoffLease) {
    const result = read(lease.key);
    if (result.kind !== "current") {
      return null;
    }
    const active = result.lease;
    return lease.version === 2 &&
      active.version === 2 &&
      lease.action.kind === "triage" &&
      active.action.kind === "triage" &&
      lease.owner === active.owner &&
      JSON.stringify(lease.helper) === JSON.stringify(active.helper) &&
      JSON.stringify(lease.executor) === JSON.stringify(active.executor) &&
      JSON.stringify(lease.action.lifetime) === JSON.stringify(active.action.lifetime)
      ? { ...active, action: active.action }
      : null;
  }
  function settle(lease: ManagedHandoffLease, phase: "closing" | "closed" | "uncertain") {
    const active = readGeneration(lease);
    if (!active) {
      return null;
    }
    const actor =
      active.helper.pid === process.pid && phase !== "closed" ? active.helper : active.executor;
    if (actor.pid !== process.pid || processState(actor) !== "live") {
      return null;
    }
    if (phase === "closed") {
      if (!["running", "closing"].includes(active.action.phase)) {
        return null;
      }
    } else if (
      active.action.phase === "uncertain" ||
      (phase === "closing" && ["closing", "closed"].includes(active.action.phase))
    ) {
      return active;
    }
    return cas(active, { ...active.action, phase });
  }
  function release(lease: ManagedHandoffLease) {
    if (
      !current(lease) ||
      hasUnsettledChildren(lease) ||
      (lease.key.includes("/.openclaw-update-child-") &&
        lease.executor.pid !== lease.helper.pid &&
        process.platform !== "win32" &&
        isChildProcessTreeAlive(lease.executor))
    ) {
      return false;
    }
    const localHelper = lease.helper.pid === process.pid && processState(lease.helper) === "live";
    const action = lease.action;
    const executorClosed =
      lease.executor.pid === process.pid || processState(lease.executor) === "dead";
    const closed = localHelper
      ? action.kind === "update"
        ? executorClosed
        : action.lifetime.kind === "foreground"
          ? ["reserved", "closed"].includes(action.phase) && executorClosed
          : nativeScopes.nativeClosed(action.lifetime)
      : reclaimable(lease);
    if (!closed) {
      return false;
    }
    return withDatabase(true, (db) =>
      transact(db, () => !hasUnsettledChildren(lease, db) && deleteRow(db, lease)),
    );
  }

  /** Only explicit repair may replace an uncertain generation after a complete host census. */
  async function prepareRepair(root: string, env: NodeJS.ProcessEnv, timeoutMs?: number) {
    const found = read(root);
    if (found.kind === "unreadable") {
      throw new Error(
        "Handoff state is unreadable; retain managed-update-handoffs.sqlite and run openclaw doctor --fix.",
      );
    }
    if (found.kind !== "current") {
      return null;
    }
    const previous = found.lease;
    if (
      previous.version !== 2 ||
      previous.action.kind !== "triage" ||
      previous.action.lifetime.kind !== "foreground" ||
      !["running", "uncertain"].includes(previous.action.phase)
    ) {
      return null;
    }
    const assertDead = () => {
      const pids = [previous.helper, previous.executor]
        .filter((owner) => processState(owner) !== "dead")
        .map((owner) => owner.pid);
      if (pids.length) {
        throw new Error(
          `Handoff owners are live or unverified: PID ${[...new Set(pids)].join(", ")}. Wait for their updater or stop it through its owning terminal, then run openclaw update repair.`,
        );
      }
    };
    assertDead();
    const metadata = withDatabase(true, (db) =>
      readManagedHandoffRepairMetadata(db, previous, (operation) => transact(db, operation)),
    );
    if (previous.action.phase !== "uncertain" && !metadata) {
      return null;
    }
    const source = metadata?.source ?? {
      owner: previous.owner,
      payload_json: previous.payload,
      updated_at: previous.updatedAt,
    };
    const { recordUpdateRunStep } = await import("./update-run-ledger.js");
    const discovered = await readManagedHandoffRepairFacts(
      handle(root, source),
      env,
      metadata?.facts.runIds[0],
    );
    const facts = await inspectManagedHandoffRepairFacts(previous, discovered, metadata?.facts);
    facts.timeoutMs = Math.max(facts.timeoutMs ?? 0, timeoutMs ?? 0) || null;
    const helper = processIdentity();
    const action: ManagedHandoffLeaseAction = {
      kind: "triage",
      phase: "running",
      lifetime: { kind: "foreground", boot: bootIdentity() },
    };
    let next = handle(root, {
      owner: randomUUID(),
      payload_json: JSON.stringify({ version: 2, executor: helper, helper, action }),
      updated_at: Math.max(Date.now(), previous.updatedAt + 1),
    });
    const recovery = (lease: ManagedHandoffLease) =>
      JSON.stringify({ version: 3, binding: binding(lease), source, facts });
    withDatabase(true, (db) =>
      transact(db, () => {
        assertDead();
        if (
          hasUnsettledChildren(previous, db) ||
          !updateRow(db, previous, {
            owner: next.owner,
            payload_json: next.payload,
            updated_at: next.updatedAt,
            recovery_json: recovery(next),
          })
        ) {
          throw new Error("Handoff ownership changed; retry openclaw update repair.");
        }
      }),
    );
    const assertCurrent = () => {
      if (!owns(next) || hasUnsettledChildren(next)) {
        throw new Error("Handoff repair lost ownership; retry openclaw update repair.");
      }
    };
    return {
      assertCurrent,
      bindRun(runId: string) {
        assertCurrent();
        facts.runIds.push(runId);
        const bound = cas(next, action, undefined, recovery);
        if (!bound) {
          throw new Error("Handoff repair lost ownership; retry openclaw update repair.");
        }
        next = bound;
      },
      complete(runId: string) {
        assertCurrent();
        if (!facts.runIds.includes(runId)) {
          throw new Error("Handoff settlement requires its bound repair run.");
        }
        const endedAtMs = Date.now();
        const detail = `legacy handoff lease reclaimed: owners proven dead, lease last recorded at ${new Date(previous.updatedAt).toISOString()}, no descendants. Current-installation repair completed.`;
        const result = recordUpdateRunStep(
          runId,
          { step: "finalize:handoff-settlement", status: "completed", endedAtMs, detail },
          { env },
        );
        const receipt = result.steps.find((step) => step.step === "finalize:handoff-settlement");
        if (receipt?.status !== "completed" || receipt.endedAtMs !== endedAtMs) {
          throw new Error("Handoff settlement was not recorded; retry openclaw update repair.");
        }
        const closed = settle(next, "closed");
        if (!closed || !release(closed)) {
          throw new Error(
            "Handoff repair completed but its lease remains; retry openclaw update repair.",
          );
        }
      },
      [Symbol.dispose]() {
        if (current(next)) {
          cas(next, { ...action, phase: "uncertain" }, undefined, recovery);
        }
      },
    };
  }

  function assertSourceUnborrowed(resource: string) {
    const retained = withDatabase
      .readRetainedRows()
      .map((entry) => handle(entry.install_root, entry));
    assertNoRetainedSourceBorrower(resource, retained);
  }
  function stopNative(lease: ManagedHandoffLease, ownPlacement = false) {
    const life = lease.action.kind === "triage" && lease.action.lifetime;
    return (
      life &&
      life.kind === "native" &&
      nativeScopes.stopNative(life, ownPlacement, (scope) =>
        ownPlacement
          ? [lease.helper.pid, lease.executor.pid].includes(process.pid) &&
            processState(lease.helper.pid === process.pid ? lease.helper : lease.executor) ===
              "live" &&
            nativeScopes.isInNativeScope(life, scope)
          : current(lease),
      )
    );
  }
  return {
    prepareRepair,
    retainReadConnection: withDatabase.retainReadConnection,
    transact,
    read,
    readLegacyParent,
    acquire,
    bind,
    retarget,
    activate,
    owns,
    hasUnsettledChildren,
    acceptParentBoundExecutor,
    current,
    readGeneration,
    settle,
    release,
    assertSourceUnborrowed,
    stopNative,
    isInNativeScope: nativeScopes.isInNativeScope,
    processIdentity,
    inspectProcessIdentity,
    isProcessIdentityCurrent,
    readProcessStartIdentity,
    isPidAlive,
    bootIdentity,
    properties: nativeScopes.properties,
    validFailure: (value: unknown) => triageFailureSchema.safeParse(value).success,
  };
}
