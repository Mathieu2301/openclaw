import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as buildAll from "../../scripts/build-all.mts";
import { acquireDistArtifactOwnership } from "../../scripts/lib/dist-artifact-lock.mts";
import * as artifactOwnership from "../../scripts/lib/dist-artifact-ownership.mts";
import { prepareVitestRuntime } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { prepareTestRuntime } from "../../scripts/prepare-vitest-runtime.mts";
import * as sourceRunner from "../../scripts/run-node.mts";
import * as postbuild from "../../scripts/runtime-postbuild.mts";
import * as gatewayBindings from "../../src/daemon/managed-gateway-bindings.js";
import * as serviceOperation from "../../src/daemon/service-operation-lock.js";
import * as gatewayService from "../../src/daemon/service.js";
import { createDeferred } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const commands = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>()),
  runManagedCommand: commands.prepare,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = tempDirs.make("test-runtime-preparation-");
  env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state"), OPENCLAW_RUNNER_LOG: "0" };
  // Keep artifact ownership inside the fixture even when TMPDIR is in another checkout.
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "entry.js"), "original\n");
  vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([]);
  vi.spyOn(gatewayService, "readGatewayServiceState").mockRejectedValue(
    Object.assign(new Error("EACCES: permission denied, open protected-service.env"), {
      code: "EACCES",
    }),
  );
  // Old automatic CLI preparation must reach the modeled EACCES, not a host service lock.
  vi.spyOn(serviceOperation, "withGatewayServiceOperationLock").mockImplementation(
    async (_env, callback) => callback(() => {}),
  );
  commands.prepare.mockReset().mockImplementation(async ({ args, env: commandEnv }) => {
    if (args[0] === "scripts/run-node.mjs") {
      return sourceRunner.runNodeMain({ cwd: root, args: args.slice(1), env: commandEnv });
    }
    if (args[0] !== "scripts/prepare-vitest-runtime.mjs") {
      throw new Error(`Unexpected prerequisite command: ${args.join(" ")}`);
    }
    return prepareTestRuntime(root, commandEnv);
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["unavailable service", "live overlapping service"])(
  "prepares selected private-QA tests with %s",
  async (service) => {
    if (service === "live overlapping service") {
      vi.mocked(gatewayService.readGatewayServiceState).mockResolvedValue({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command: {
          programArguments: [process.execPath, path.join(root, "dist", "entry.js"), "gateway"],
        },
        runtime: { status: "running" },
      });
    }
    const runBuild = buildAll.runBuildAllSteps;
    const compiler = vi.fn(async () => {
      await fs.writeFile(path.join(root, "dist", "entry.js"), "rebuilt\n");
      return { status: 0 };
    });
    const build = vi.spyOn(buildAll, "runBuildAllSteps").mockImplementation((profile, params) =>
      runBuild(profile, {
        ...params,
        logger: { error() {}, warn() {} },
        steps: [{ label: "fixture-compiler", args: [] }],
        resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
        runStep: compiler,
      }),
    );
    const status = await prepareVitestRuntime(
      [{ includePatterns: ["extensions/qa-lab/src/suite-process-lifecycle.test.ts"] }],
      env,
    );
    expect(status).toBe(service === "live overlapping service" ? 1 : 0);
    expect(build).toHaveBeenCalledWith(
      "qaRuntime",
      expect.objectContaining({
        cwd: root,
        env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "1" }),
      }),
    );
    expect(compiler).toHaveBeenCalledTimes(service === "live overlapping service" ? 0 : 1);
    expect(await fs.readFile(path.join(root, "dist", "entry.js"), "utf8")).toBe(
      service === "live overlapping service" ? "original\n" : "rebuilt\n",
    );
  },
);

it("reuses current artifacts without writable checkout or service access", async () => {
  vi.spyOn(artifactOwnership, "withDistArtifactOwnership").mockRejectedValue(
    Object.assign(new Error("read-only checkout"), { code: "EROFS" }),
  );
  vi.spyOn(sourceRunner, "resolveRunNodePreparation").mockReturnValue({
    build: false,
    runtime: false,
    immutable: false,
  });
  const build = vi.spyOn(buildAll, "runBuildAllSteps");
  expect(await prepareTestRuntime(root, env)).toBe(0);
  expect(build).not.toHaveBeenCalled();
  expect(gatewayService.readGatewayServiceState).not.toHaveBeenCalled();
});

it("refuses to rebuild an immutable deployment", async () => {
  await fs.writeFile(
    path.join(root, "deployment.json"),
    JSON.stringify({ kind: "git", sourceHead: "a".repeat(40) }),
  );
  const build = vi.spyOn(buildAll, "runBuildAllSteps");
  await expect(prepareTestRuntime(root, env)).rejects.toThrow("immutable deployment");
  expect(build).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, "dist", "entry.js"), "utf8")).toBe("original\n");
});

it.each([false, true])(
  "does not compile when only postbuild is stale (fails=%s)",
  async (fails) => {
    vi.spyOn(sourceRunner, "resolveRunNodePreparation").mockReturnValue({
      build: false,
      runtime: true,
      immutable: false,
    });
    const build = vi.spyOn(buildAll, "runBuildAllSteps");
    const sync = vi.spyOn(postbuild, "runRuntimePostBuild").mockImplementation(() => {
      if (fails) {
        throw new Error("postbuild failed");
      }
    });
    if (fails) {
      await expect(prepareTestRuntime(root, env)).rejects.toThrow("postbuild failed");
      await expect(
        fs.access(path.join(root, "dist", ".runtime-postbuildstamp")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await prepareTestRuntime(root, env)).toBe(0);
    }
    expect(sync).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
  },
);

it("joins a canceled compiler before releasing checkout ownership", async () => {
  const controller = new AbortController();
  const started = createDeferred();
  const finish = createDeferred();
  const runBuild = buildAll.runBuildAllSteps;
  const finalize = vi.fn(() => true);
  vi.spyOn(buildAll, "runBuildAllSteps").mockImplementation((profile, params) =>
    runBuild(profile, {
      ...params,
      logger: { error() {}, warn() {} },
      steps: [{ label: "fixture-compiler", args: [] }],
      resolveCacheState: () => ({ cacheable: false, fresh: false, reason: "no-cache" }),
      finalizeCache: finalize,
      runStep: async () => {
        started.resolve();
        await finish.promise;
        return { status: 0 };
      },
    }),
  );
  const attempt = prepareTestRuntime(root, env, controller.signal);
  try {
    await Promise.race([started.promise, attempt]);
    controller.abort();
    expect(
      await fs.readFile(path.join(root, ".artifacts", "dist-artifacts.lock", "owner.json"), "utf8"),
    ).toContain(String(process.pid));
  } finally {
    finish.resolve();
    await expect(attempt).rejects.toMatchObject({ name: "AbortError" });
  }
  expect(finalize).not.toHaveBeenCalled();
  const next = await acquireDistArtifactOwnership(root);
  await next.release();
});
