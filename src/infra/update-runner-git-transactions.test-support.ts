import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { expectRuntime, runFixtureGit } from "./update-runner-git-candidate.test-support.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";

export function registerGitActivationDoctorOutcomeTests(
  getFixture: () => {
    root: string;
    beforeSha: string;
    events: string[];
    isStopped: () => boolean;
    runCommand: CommandRunner;
    setRunCommand: (runner: CommandRunner) => void;
    advanceRemote: () => Promise<string>;
    git: (root: string, ...args: string[]) => Promise<string>;
    update: (
      opts: Pick<UpdateRunnerOptions, "runGitDoctor" | "onTransaction">,
    ) => Promise<UpdateRunResult>;
    expectNoRuntimeStagingPaths: () => Promise<void>;
  },
) {
  registerGitRetainedTransactionTests(getFixture);
  it.each(["restore", "complete", "cleanup-failed", "source-changed", "runtime-changed"] as const)(
    "retains the activated Git transaction through finalization: %s",
    async (outcome) => {
      const { root, beforeSha, advanceRemote, git, update, expectNoRuntimeStagingPaths } =
        getFixture();
      const targetSha = await advanceRemote();
      let retained: PackageUpdateTransaction | undefined;
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
      });
      expect(result.status).toBe("ok");
      assert(retained, "Finalization must receive the retained Git runtime transaction");
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
      expect(result.gitRuntime).toEqual({
        commit: targetSha,
        distDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      if (outcome === "cleanup-failed") {
        const remove = fs.rm.bind(fs);
        const backupRoot = retained.backupRoot;
        const removal = vi.spyOn(fs, "rm").mockImplementation(async (entry, options) => {
          if (entry === backupRoot) {
            throw Object.assign(new Error("backup cleanup denied"), { code: "EACCES" });
          }
          return remove(entry, options);
        });
        try {
          const warning = await retained.complete({ activationVerified: true }, () => {});
          expect(warning).toMatchObject({
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining(backupRoot),
            },
          });
          expect(await retained.complete({ activationVerified: true }, () => {})).toBe(warning);
          await expectRuntime(root, targetSha);
          await expect(fs.stat(backupRoot)).resolves.toBeDefined();
        } finally {
          removal.mockRestore();
        }
        return;
      }
      if (outcome === "complete") {
        await retained.complete({ activationVerified: true }, () => {});
        await expectRuntime(root, targetSha);
        await expectNoRuntimeStagingPaths();
        return;
      }
      if (outcome === "source-changed") {
        await fs.writeFile(path.join(root, "operator-edit.txt"), "preserve this edit\n");
        await expect(retained.rollback(() => {})).rejects.toThrow("changed after activation");
        await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow(
          "changed after activation",
        );
        expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
        expect(await fs.readFile(path.join(root, "operator-edit.txt"), "utf8")).toBe(
          "preserve this edit\n",
        );
        await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
        return;
      } else if (outcome === "runtime-changed") {
        await fs.writeFile(path.join(root, "dist", "operator-chunk.mjs"), "export {};\n");
      }
      const restored = await retained.rollback(() => {});
      expect(restored.exitCode).toBe(0);
      await retained.complete({ activationVerified: false }, () => {});
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      await expectRuntime(root, beforeSha);
      await expectNoRuntimeStagingPaths();
    },
  );
  it.each([
    ["success", undefined],
    ["config-refused", "repair-requires-config-change"],
    ["requester-revoked", "requester-revoked"],
    ["doctor-error", "doctor-failed"],
    ["doctor-zero-exit-timeout", "doctor-failed"],
    ["doctor-zero-exit-output-limit", "doctor-failed"],
    ["doctor-throw", "unexpected-error"],
    ["cleanup-uncertain", undefined],
    ["missing", "doctor-entry-missing"],
  ] as const)(
    "uses the CLI activation Doctor and preserves its outcome: %s",
    async (outcome, reason) => {
      const {
        root,
        beforeSha,
        events,
        isStopped,
        advanceRemote,
        git,
        update,
        expectNoRuntimeStagingPaths,
      } = getFixture();
      const targetSha = await advanceRemote();
      const configChanges: UpdateDoctorConfigChange[] = [{ kind: "key", key: "agents" }];
      const cleanupError = new Error("Doctor child cleanup remains unresolved", {
        cause: new CommandProcessCleanupError(),
      });
      const runGitDoctor = vi.fn(async (doctorRoot: string) => {
        expect(isStopped()).toBe(true);
        await expectRuntime(doctorRoot, targetSha);
        events.push("owned-doctor");
        if (outcome === "requester-revoked") {
          throw new UpdateRequesterRevokedError();
        }
        if (outcome === "doctor-throw") {
          throw new Error("Doctor failed after starting migration");
        }
        if (outcome === "cleanup-uncertain") {
          throw cleanupError;
        }
        if (outcome === "missing") {
          return null;
        }
        return {
          name: "openclaw doctor",
          command: "candidate doctor",
          cwd: doctorRoot,
          durationMs: 1,
          exitCode: outcome === "success" || outcome.startsWith("doctor-zero-exit-") ? 0 : 1,
          ...(outcome === "doctor-zero-exit-timeout" ? { termination: "timeout" as const } : {}),
          ...(outcome === "doctor-zero-exit-output-limit" ? { outputLimitExceeded: true } : {}),
          configChanges,
          ...(outcome === "config-refused"
            ? {
                configWriteRefusal: {
                  reason: "include-ownership",
                  message: "An included file owns the pending config change.",
                  keys: ["agents"],
                },
              }
            : {}),
        };
      });

      const running = update({ runGitDoctor });
      if (outcome === "cleanup-uncertain") {
        await expect(running).rejects.toBe(cleanupError);
        expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
        expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
        expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
        await expectRuntime(root, targetSha);
        const backups = (await fs.readdir(root)).filter(
          (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
        );
        expect(backups).toHaveLength(1);
        const backup = backups[0];
        assert(backup);
        expect(
          JSON.parse(
            await fs.readFile(path.join(root, backup, "previous", "build-info.json"), "utf8"),
          ),
        ).toMatchObject({ commit: beforeSha, buildId: beforeSha });
        return;
      }
      const result = await running;

      expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
      expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
      expect(result.status).toBe(outcome === "success" ? "ok" : "error");
      expect(result.reason).toBe(reason);
      const expectedSha = outcome === "missing" ? beforeSha : targetSha;
      expect(await git(root, "rev-parse", "HEAD")).toBe(expectedSha);
      await expectRuntime(root, expectedSha);
      await expectNoRuntimeStagingPaths();
      if (outcome !== "success") {
        expect(result.recovery).toMatchObject(
          outcome === "missing"
            ? { serviceRestartSafe: true, buildId: beforeSha }
            : { serviceRestartSafe: false, reason: "state-migration-started" },
        );
      }
      if (outcome !== "requester-revoked" && outcome !== "doctor-throw" && outcome !== "missing") {
        expect(result.steps.find((step) => step.name === "openclaw doctor")?.configChanges).toEqual(
          configChanges,
        );
      }
    },
  );
}

function registerGitRetainedTransactionTests(
  getFixture: () => {
    root: string;
    beforeSha: string;
    advanceRemote: () => Promise<string>;
    update: (opts: Partial<UpdateRunnerOptions>) => Promise<UpdateRunResult>;
    runCommand: CommandRunner;
    setRunCommand: (runner: CommandRunner) => void;
    expectNoRuntimeStagingPaths: () => Promise<void>;
  },
) {
  it.each([
    ["source check", "tracked"],
    ["source check", "untracked"],
    ["checkout", "tracked"],
    ["checkout", "untracked"],
    ["source restore", "tracked"],
    ["source restore", "untracked"],
    ["before checkout", "tracked"],
    ["before source restore", "tracked"],
    ["before source restore", "staged"],
    ["before source restore", "staged-unrelated"],
  ] as const)("retained rollback preserves %s await edits (%s)", async (phase, kind) => {
    const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
    const targetSha = await advanceRemote();
    const relative =
      kind === "untracked"
        ? "operator-edit.txt"
        : phase === "source restore" || kind === "staged-unrelated"
          ? "openclaw.mjs"
          : "candidate.txt";
    const file = path.join(root, relative);
    const edit = "preserve this operator edit\n";
    let rollingBack = false;
    let edited = false;
    let retained: PackageUpdateTransaction | undefined;
    setRunCommand(async (argv, options) => {
      const matches =
        rollingBack &&
        !edited &&
        argv[0] === "git" &&
        argv[2] === root &&
        ((phase === "source check" && argv.includes("--abbrev-ref")) ||
          ((phase === "checkout" || phase === "before checkout") && argv.includes("checkout")) ||
          ((phase === "source restore" || phase === "before source restore") &&
            argv.includes("checkout") &&
            argv.includes("-B") &&
            argv.at(-1) === beforeSha));
      if (matches && phase.startsWith("before ")) {
        await fs.writeFile(file, edit);
        if (kind === "staged" || kind === "staged-unrelated") {
          await runFixtureGit(root, "add", relative);
          if (kind === "staged-unrelated") {
            await fs.writeFile(file, `${edit}unstaged content\n`);
          }
        }
        edited = true;
      }
      const result = await runCommand(argv, options);
      if (matches && !phase.startsWith("before ")) {
        expect(result.code).toBe(0);
        // The child has completed, but the rollback owner has not resumed yet.
        await fs.writeFile(file, edit);
        edited = true;
      }
      return result;
    });
    expect(
      (
        await update({
          onTransaction: (transaction) => {
            retained = transaction;
          },
        })
      ).status,
    ).toBe("ok");
    assert(retained);
    rollingBack = true;
    const failure = await retained
      .rollback(() => {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(edited).toBe(true);
    expect(await fs.readFile(file, "utf8").catch(() => undefined)).toBe(
      kind === "staged-unrelated" ? `${edit}unstaged content\n` : edit,
    );
    if (kind === "staged" || kind === "staged-unrelated") {
      expect(await runFixtureGit(root, "show", `:${relative}`)).toBe(edit.trim());
    }
    if (kind === "staged-unrelated") {
      expect(await runFixtureGit(root, "status", "--short")).toContain("MM openclaw.mjs");
    }
    expect(failure).toBeInstanceOf(Error);
    await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
    expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(
      phase === "source restore" || kind === "staged-unrelated" ? beforeSha : targetSha,
    );
    expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await expectRuntime(root, targetSha);
    await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
    const distBackup = (await fs.readdir(root)).find(
      (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
    );
    assert(distBackup);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, distBackup, "previous", "build-info.json"), "utf8"),
      ),
    ).toMatchObject({ commit: beforeSha });
  });

  it.each([
    ["delete", "none"],
    ["rewrite", "none"],
    ["delete", "checkout"],
    ["rewrite", "checkout"],
    ["delete", "bisect"],
    ["delete", "rebase"],
    ["delete", "recreate-failed"],
  ] as const)(
    "retained rollback protects custody at the final ref %s (%s)",
    async (operation, claim) => {
      const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
      const linked = path.join(path.dirname(root), "linked-checkout");
      if (operation === "delete") {
        await runFixtureGit(root, "checkout", "-b", "operator-branch");
        await runFixtureGit(root, "branch", "-D", "main");
      }
      if (claim === "bisect") {
        const remote = await runFixtureGit(root, "remote", "get-url", "origin");
        await runFixtureGit(remote, "commit", "--allow-empty", "-m", "bisect midpoint");
      }
      const targetSha = await advanceRemote();
      let rollingBack = false;
      let attempted = false;
      setRunCommand(async (argv, options) => {
        if (
          rollingBack &&
          !attempted &&
          argv[2] === root &&
          (operation === "rewrite"
            ? argv.includes("checkout") && argv.includes("-B")
            : argv.includes("update-ref") && argv.includes("-d"))
        ) {
          attempted = true;
          if (claim !== "none") {
            const claiming = runFixtureGit(root, "worktree", "add", linked, "main");
            if (operation === "rewrite") {
              await expect(claiming).rejects.toThrow(/already (?:used|checked out)/);
            } else {
              await claiming;
              if (claim === "bisect") {
                await runFixtureGit(linked, "bisect", "start", "main", beforeSha);
              } else if (claim === "rebase") {
                const tree = await runFixtureGit(root, "rev-parse", `${beforeSha}^{tree}`);
                const base = await runFixtureGit(
                  root,
                  "commit-tree",
                  tree,
                  "-p",
                  beforeSha,
                  "-m",
                  "rebase base",
                );
                await expect(
                  runFixtureGit(linked, "rebase", "--exec", "false", base),
                ).rejects.toThrow();
              }
              if (claim === "bisect" || claim === "rebase") {
                await expect(runFixtureGit(linked, "symbolic-ref", "HEAD")).rejects.toThrow();
              }
            }
          }
        }
        if (
          claim === "recreate-failed" &&
          argv.includes("update-ref") &&
          /^0+$/.test(argv.at(-1) ?? "")
        ) {
          // A concurrent ref writer wins after deletion; compensation must not overwrite it.
          await runFixtureGit(root, "update-ref", "refs/heads/main", beforeSha);
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
      });
      expect(result.status).toBe("ok");
      assert(retained);
      rollingBack = true;
      expect((await retained.rollback(() => {})).exitCode).toBe(0);
      expect(attempted).toBe(true);
      if (operation === "delete" && claim === "none") {
        expect(await runFixtureGit(root, "branch", "--list", "main")).toBe("");
      } else {
        expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(
          operation === "rewrite" || claim === "recreate-failed" ? beforeSha : targetSha,
        );
      }
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await runFixtureGit(root, "symbolic-ref", "HEAD")).toBe(
        `refs/heads/${operation === "delete" ? "operator-branch" : "main"}`,
      );
      await expectRuntime(root, beforeSha);
      if (operation === "delete" && claim !== "none") {
        expect(await runFixtureGit(linked, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
        if (claim === "checkout") {
          expect(await runFixtureGit(linked, "rev-parse", "HEAD")).toBe(targetSha);
          expect(await runFixtureGit(linked, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
        }
        expect(
          result.steps.find((step) => step.name === "git-rollback-delete-branch"),
        ).toMatchObject({
          advisory: {
            kind: "recoverable-maintenance",
            message: expect.stringContaining(
              claim === "recreate-failed" ? `git branch main ${targetSha}` : "another Git worktree",
            ),
          },
        });
      }
      await retained.complete({ activationVerified: false }, () => {});
    },
  );

  it("retains the runtime backup when another worktree already holds the original branch", async () => {
    const { root, beforeSha, advanceRemote, update } = getFixture();
    await runFixtureGit(root, "checkout", "-b", "operator-branch");
    const targetSha = await advanceRemote();
    let retained: PackageUpdateTransaction | undefined;
    expect(
      (
        await update({
          onTransaction: (transaction) => {
            retained = transaction;
          },
        })
      ).status,
    ).toBe("ok");
    assert(retained);
    await runFixtureGit(
      root,
      "worktree",
      "add",
      path.join(path.dirname(root), "holder"),
      "operator-branch",
    );
    await expect(retained.rollback(() => {})).rejects.toThrow("git-rollback-checkout");
    expect(await runFixtureGit(root, "rev-parse", "operator-branch")).toBe(beforeSha);
    expect(await runFixtureGit(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    await expectRuntime(root, targetSha);
    await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
  });

  it.each(["untracked", "ignored"] as const)(
    "refuses to overwrite a late %s file during source restoration",
    async (kind) => {
      const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
      const remote = await runFixtureGit(root, "remote", "get-url", "origin");
      await fs.rm(path.join(remote, "openclaw.mjs"));
      await runFixtureGit(remote, "commit", "-am", "remove launcher");
      const targetSha = await advanceRemote();
      let edited = false;
      setRunCommand(async (argv, options) => {
        if (
          argv[2] === root &&
          argv.includes("checkout") &&
          argv.includes("-B") &&
          argv.at(-1) === beforeSha
        ) {
          if (kind === "ignored") {
            await fs.appendFile(path.join(root, ".git", "info", "exclude"), "\nopenclaw.mjs\n");
          }
          await fs.writeFile(path.join(root, "openclaw.mjs"), "operator content\n");
          edited = true;
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      expect(
        (
          await update({
            onTransaction: (transaction) => {
              retained = transaction;
            },
          })
        ).status,
      ).toBe("ok");
      assert(retained);
      await expect(retained.rollback(() => {})).rejects.toThrow("git-rollback-source");
      expect(edited).toBe(true);
      expect(await fs.readFile(path.join(root, "openclaw.mjs"), "utf8")).toBe("operator content\n");
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(targetSha);
      await expectRuntime(root, targetSha);
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
    },
  );

  it.each(["raw-writer", "missing-reflog"] as const)(
    "retains the runtime when the rollback rewrite transition cannot be verified: %s",
    async (failure) => {
      const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
      const targetSha = await advanceRemote();
      const concurrentSha = await runFixtureGit(
        root,
        "commit-tree",
        `${beforeSha}^{tree}`,
        "-p",
        beforeSha,
        "-m",
        "operator ref",
      );
      let rollingBack = false;
      let injected = false;
      setRunCommand(async (argv, options) => {
        if (rollingBack && argv[2] === root && argv.includes("checkout") && argv.includes("-B")) {
          if (failure === "raw-writer") {
            await runFixtureGit(root, "update-ref", "refs/heads/main", concurrentSha, targetSha);
          } else {
            await runFixtureGit(root, "config", "core.logAllRefUpdates", "false");
            await fs.rm(path.join(root, ".git", "logs", "refs", "heads", "main"));
          }
          injected = true;
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
      });
      expect(result.status).toBe("ok");
      assert(retained);
      rollingBack = true;
      await expect(retained.rollback(() => {})).rejects.toThrow("git-rollback-source");
      expect(injected).toBe(true);
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await runFixtureGit(root, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
      const diagnostic = result.steps.find(
        (step) => step.name === "git-rollback-source",
      )?.stderrTail;
      const recoverySha = failure === "raw-writer" ? concurrentSha : targetSha;
      expect(diagnostic).toContain("git checkout --detach --no-overwrite-ignore");
      expect(diagnostic).toMatch(new RegExp(`git branch -f (?:main|'main') ${recoverySha}`));
      if (failure === "missing-reflog") {
        expect(diagnostic).toContain("unavailable reflog");
      }
      await expectRuntime(root, targetSha);
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
      await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
      await runFixtureGit(root, "checkout", "--detach", "--no-overwrite-ignore");
      await runFixtureGit(root, "branch", "-f", "main", recoverySha);
      expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(recoverySha);
    },
  );

  it.each([
    ["operator-branch", false],
    ["HEAD", false],
    ["operator-branch", true],
  ] as const)(
    "retained rollback restores its own %s lineage (new branch edited: %s)",
    async (branch, branchEdited) => {
      const {
        root,
        beforeSha,
        advanceRemote,
        update,
        expectNoRuntimeStagingPaths,
        runCommand,
        setRunCommand,
      } = getFixture();
      await runFixtureGit(
        root,
        "checkout",
        ...(branch === "HEAD" ? ["--detach", beforeSha] : ["-b", branch]),
      );
      await runFixtureGit(root, "branch", "-D", "main");
      const targetSha = await advanceRemote();
      let edited = false;
      setRunCommand(async (argv, options) => {
        if (
          branchEdited &&
          argv[2] === root &&
          ((argv.includes("branch") && argv.includes("-D")) ||
            (argv.includes("update-ref") && argv.includes("-d")))
        ) {
          await runFixtureGit(root, "update-ref", "refs/heads/main", beforeSha, targetSha);
          edited = true;
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      expect(
        (
          await update({
            onTransaction: (transaction) => {
              retained = transaction;
            },
          })
        ).status,
      ).toBe("ok");
      assert(retained);
      if (branchEdited) {
        await expect(retained.rollback(() => {})).rejects.toThrow();
        expect(edited).toBe(true);
        expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(beforeSha);
        expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
        expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
        await expectRuntime(root, targetSha);
        await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
        await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
        return;
      }
      expect((await retained.rollback(() => {})).exitCode).toBe(0);
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      expect(await runFixtureGit(root, "branch", "--list", "main")).toBe("");
      await expectRuntime(root, beforeSha);
      await retained.complete({ activationVerified: false }, () => {});
      await expectNoRuntimeStagingPaths();
    },
  );
}
