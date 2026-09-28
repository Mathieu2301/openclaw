import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, transformConfigFile } from "../config/config.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { CronService } from "../cron/service.js";
import { saveCronJobsStoreWithRevisionNative } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { pruneAgentConfig } from "./agents.config.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";

afterEach(() => vi.restoreAllMocks());

function sourceConfig(storePath?: string) {
  return {
    agents: {
      defaults: { systemAgent: { agentId: "research" } },
      entries: { ops: { default: true }, research: {} },
    },
    gateway: { mode: "local" as const },
    plugins: { enabled: false },
    ...(storePath ? { cron: { store: storePath } } : {}),
  };
}

function seedJobs(storePath: string) {
  saveCronJobsStoreWithRevisionNative(storePath, {
    version: 1,
    jobs: [
      makeCronJob({
        id: "historical",
        enabled: false,
        state: { lastRunAtMs: 123, lastRunStatus: "ok" },
      }),
      makeCronJob({ id: "explicit", agentId: "research", enabled: false }),
      makeCronJob({ id: "session", sessionKey: "agent:research:main", enabled: false }),
      makeCronJob({ id: "sql-owner", enabled: false }),
    ],
  });
  const db = openOpenClawStateDatabase().db;
  db.prepare(
    "UPDATE cron_jobs SET agent_id = 'research' WHERE store_key = ? AND job_id = 'sql-owner'",
  ).run(cronStoreKey(storePath));
  db.prepare(
    "UPDATE cron_jobs SET job_json = json_set(job_json, '$.authoredNote', 'keep me') WHERE store_key = ? AND job_id = 'historical'",
  ).run(cronStoreKey(storePath));
}

function rows(storePath: string) {
  return loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
}

async function backups() {
  const databasePath = openOpenClawStateDatabase().path;
  return (await fs.readdir(path.dirname(databasePath)))
    .filter((name) => name.startsWith(`${path.basename(databasePath)}.doctor-cron-`))
    .map((name) => path.join(path.dirname(databasePath), name));
}

async function repair(state: OpenClawTestState) {
  return withDoctorConfigMaintenance(async () => {
    const ctx = await prepareDoctorContext(state.configPath);
    await runInitialConfigWriteHealth(ctx);
    return ctx;
  });
}

function createCron(storePath: string, defaultAgentId = "research") {
  const scheduler = createTestGatewayScheduler();
  const execute = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler,
    storePath,
    cronEnabled: true,
    defaultAgentId,
    legacyDefaultAgentId: "ops",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: () => false,
    requestHeartbeat() {},
    runIsolatedAgentJob: execute,
  });
  return { cron, scheduler, execute };
}

it.each(["retains", "removes"])(
  "refuses an ordinary roster write that %s the historical agent without changing its jobs",
  async (agentChange) => {
    await withOpenClawTestState(
      { label: "cron-owner-config-refusal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config = sourceConfig();
        await state.writeConfig({
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              ...(agentChange === "removes" ? { authInheritance: { agentId: "research" } } : {}),
            },
          },
        });
        const storePath = state.statePath("cron", "jobs.json");
        seedJobs(storePath);
        const beforeRows = rows(storePath);
        const beforeConfig = await fs.readFile(state.configPath, "utf8");
        const write = transformConfigFile({
          transform: (current) => ({
            nextConfig:
              agentChange === "removes" ? pruneAgentConfig(current, "ops").config : current,
          }),
          writeOptions: {
            persistCanonicalAgentRoster: true,
            ...(agentChange === "removes" ? { allowedAgentRosterRemovals: ["ops"] } : {}),
          },
          afterWrite: { mode: "none", reason: "test roster write" },
        });
        await expect(
          write,
          "Ordinary config writes must leave legacy ownership for Doctor",
        ).rejects.toMatchObject({
          code: "CONFIG_WRITE_REJECTED",
          refusal: "cron-owner-safety",
        });
        await expect(write).rejects.toThrow("openclaw doctor --fix");
        expect(rows(storePath)).toEqual(beforeRows);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
        expect(await backups()).toEqual([]);
      },
    );
  },
);

it.each(["update", "remove"])(
  "refuses an operator %s before changing an unresolved historical job",
  async (operation) => {
    await withOpenClawTestState(
      { label: "cron-owner-mutation-refusal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig(sourceConfig());
        const storePath = state.statePath("cron", "jobs.json");
        seedJobs(storePath);
        const { cron } = createCron(storePath);
        try {
          expect(
            (await cron.list({ includeDisabled: true })).some((job) => job.id === "historical"),
          ).toBe(true);
          const beforeRows = rows(storePath);
          const operationResult =
            operation === "update"
              ? cron.update("historical", { name: "changed" })
              : cron.remove("historical");
          await expect(operationResult).rejects.toThrow("openclaw doctor --fix");
          expect(rows(storePath)).toEqual(beforeRows);
          expect(await backups()).toEqual([]);
        } finally {
          cron.stop();
        }
      },
    );
  },
);

it("preserves historical rows and rolls back explicit jobs when agent deletion needs Doctor", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-agent-deletion", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      saveCronJobsStoreWithRevisionNative(storePath, {
        version: 1,
        jobs: [
          makeCronJob({ id: "historical", enabled: false }),
          makeCronJob({ id: "research", agentId: "research", enabled: false }),
        ],
      });
      const { cron } = createCron(storePath);
      try {
        await cron.list({ includeDisabled: true });
        const beforeRows = rows(storePath);
        const beforeConfig = await fs.readFile(state.configPath, "utf8");
        await expect(
          cron.removeAgentJobsTransactional("research", () =>
            transformConfigFile({
              transform: (current) => ({
                nextConfig: pruneAgentConfig(current, "research").config,
              }),
              writeOptions: { allowedAgentRosterRemovals: ["research"] },
              afterWrite: { mode: "none", reason: "test agent deletion" },
            }),
          ),
        ).rejects.toMatchObject({ code: "CONFIG_WRITE_REJECTED", refusal: "cron-owner-safety" });
        expect(rows(storePath)).toEqual(beforeRows);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
        expect(await backups()).toEqual([]);
      } finally {
        cron.stop();
      }
    },
  );
});

it("preserves malformed cron bytes and the historical marker when Doctor cannot verify ownership", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-corrupt", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      seedJobs(storePath);
      openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE cron_jobs SET job_json = '{malformed' WHERE store_key = ? AND job_id = 'historical'",
        )
        .run(cronStoreKey(storePath));
      const before = rows(storePath);
      const beforeConfig = await fs.readFile(state.configPath, "utf8");
      await expect(repair(state)).rejects.toThrow("Cannot verify ownership of malformed cron job");
      expect(rows(storePath)).toEqual(before);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
      expect(await backups()).toEqual([]);
    },
  );
});

it("leaves SQLite and legacy JSON owners unchanged on ordinary cron startup", async () => {
  await withOpenClawTestState({ label: "cron-owner-startup" }, async (state) => {
    await state.writeConfig(sourceConfig());
    const storePath = state.statePath("cron", "jobs.json");
    seedJobs(storePath);
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', 123) WHERE store_key = ? AND job_id = 'sql-owner'",
      )
      .run(cronStoreKey(storePath));
    const legacy = `${JSON.stringify({ version: 1, jobs: [makeCronJob({ id: "legacy-json", enabled: false })] })}\n`;
    await state.writeText("cron/jobs.json", legacy);
    const beforeDefinitions = rows(storePath).map(({ job_id, job_json, agent_id }) => ({
      job_id,
      job_json,
      agent_id,
    }));
    const { cron, scheduler, execute } = createCron(storePath);
    try {
      await cron.start();
      expect(
        rows(storePath).map(({ job_id, job_json, agent_id }) => ({ job_id, job_json, agent_id })),
        "Gateway startup must not repair stored cron ownership",
      ).toEqual(beforeDefinitions);
      expect(
        JSON.parse(
          expectDefined(
            rows(storePath).find((row) => row.job_id === "sql-owner"),
            "SQL-owned job after runtime maintenance",
          ).state_json,
        ).nextRunAtMs,
      ).toBeUndefined();
      expect(await fs.readFile(storePath, "utf8")).toBe(legacy);
      expect(execute).not.toHaveBeenCalled();
      expect(await backups()).toEqual([]);
    } finally {
      cron.stop();
      await scheduler.stop();
    }
  });
});

it.each(["ops", "research"])(
  "pins newly created jobs to the selected %s owner while legacy repair is pending",
  async (agentId) => {
    await withOpenClawTestState({ label: "cron-owner-new-job" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const { cron, scheduler, execute } = createCron(storePath, agentId);
      try {
        const created = await cron.add({
          name: "New job",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "newly authored job" },
        });
        expect(created.agentId, "New cron jobs must preserve their freshly selected owner").toBe(
          agentId,
        );
        expect(rows(storePath).find((row) => row.job_id === created.id)?.agent_id).toBe(agentId);
        await cron.run(created.id, "force");
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        cron.stop();
        await scheduler.stop();
      }
    });
  },
);

it.each(["health write", "preflight custom store"])(
  "pins the original owner before the %s and preserves recovery",
  async (entry) => {
    await withOpenClawTestState(
      { label: "cron-owner-doctor", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const customStore = entry === "preflight custom store";
        const storePath = state.statePath(customStore ? "custom-cron" : "cron", "jobs.json");
        await state.writeConfig(sourceConfig(customStore ? storePath : undefined));
        seedJobs(storePath);
        const original = rows(storePath);
        const originalGrant = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT grant_definition_generation FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'",
          )
          .get(cronStoreKey(storePath));
        if (customStore) {
          await state.writeJson("custom-cron/jobs.json", {
            version: 1,
            jobs: [makeCronJob({ id: "json-import", enabled: false })],
          });
        }
        const ctx = await repair(state);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const saved = await readConfigFileSnapshot();
        expect(saved.config.agents?.ownership).toBe("explicit");
        expect(saved.config.agents?.defaults?.systemAgent?.agentId).toBe("research");
        expect(saved.sourceConfig.agents?.entries?.ops).not.toHaveProperty("default");
        const repaired = rows(storePath);
        const historical = repaired.find((row) => row.job_id === "historical");
        const originalHistorical = original.find((row) => row.job_id === "historical");
        expect(historical).toMatchObject({
          agent_id: "ops",
          state_json: originalHistorical?.state_json,
          sort_order: originalHistorical?.sort_order,
        });
        expect(JSON.parse(historical?.job_json ?? "null")).toMatchObject({
          agentId: "ops",
          authoredNote: "keep me",
        });
        const repairedGrant = openOpenClawStateDatabase()
          .db.prepare(
            "SELECT grant_definition_generation, grant_definition_revision, grant_definition_updated_at FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'",
          )
          .get(cronStoreKey(storePath));
        expect(repairedGrant?.grant_definition_generation).toBeGreaterThan(
          Number(originalGrant?.grant_definition_generation),
        );
        expect(repairedGrant?.grant_definition_revision).toBeNull();
        expect(repairedGrant?.grant_definition_updated_at).toBeNull();
        for (const id of ["explicit", "session", "sql-owner"]) {
          const row = repaired.find((candidate) => candidate.job_id === id);
          const before = original.find((candidate) => candidate.job_id === id);
          if (!customStore && id !== "sql-owner") {
            expect(row).toEqual(before);
          } else {
            expect(row?.state_json).toBe(before?.state_json);
            expect(row?.agent_id).toBe(before?.agent_id);
          }
        }
        expect(
          JSON.parse(repaired.find((row) => row.job_id === "sql-owner")?.job_json ?? "null"),
        ).toMatchObject({ agentId: "research" });
        if (customStore) {
          expect(repaired.find((row) => row.job_id === "json-import")?.agent_id).toBe("ops");
        }
        const savedBackups = await backups();
        expect(savedBackups).toHaveLength(1);
        const backup = new DatabaseSync(savedBackups[0]!, { readOnly: true });
        try {
          expect(
            backup.prepare("SELECT agent_id FROM cron_jobs WHERE job_id = 'historical'").get()
              ?.agent_id,
          ).toBeNull();
        } finally {
          backup.close();
        }
        const repairedDefinitions = rows(storePath);
        await repair(state);
        expect(rows(storePath)).toEqual(repairedDefinitions);
        expect(await backups()).toEqual(savedBackups);
      },
    );
  },
);

it("retains the marker and a verified backup when SQL ownership changes after inspection", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-currentness", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      seedJobs(storePath);
      const originalConfig = await fs.readFile(state.configPath, "utf8");
      const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const snapshot = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockImplementationOnce(async (params) => {
          const result = await createSnapshot(params);
          openOpenClawStateDatabase()
            .db.prepare(
              "UPDATE cron_jobs SET agent_id = 'research' WHERE store_key = ? AND job_id = 'historical'",
            )
            .run(cronStoreKey(storePath));
          return result;
        });
      await expect(repair(state)).rejects.toThrow("Cron ownership changed during Doctor repair");
      snapshot.mockRestore();
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      const historical = rows(storePath).find((row) => row.job_id === "historical");
      expect(historical?.agent_id).toBe("research");
      expect(JSON.parse(historical?.job_json ?? "null")).not.toHaveProperty("agentId");
      expect(await backups()).toHaveLength(1);
    },
  );
});
