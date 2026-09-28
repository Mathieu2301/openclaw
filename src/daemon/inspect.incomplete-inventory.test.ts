import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";

vi.mock("./systemd-loaded-unit-inventory.js", () => ({ listLoadedSystemdUnits: async () => [] }));

import { listManagedOpenClawGatewayServices } from "./inspect.js";

it.each([
  ["linux", ".config/systemd/user/custom-worker.service", false],
  ["linux", ".config/systemd/user/openclaw-gateway.service", true],
  ["darwin", "Library/LaunchAgents/org.example.custom-worker.plist", true],
] as const)(
  "handles unreadable paths in complete %s inventories: %s",
  async (platform, relative, required) => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    try {
      await withTestDir({ prefix: "openclaw-incomplete-inventory-" }, async (home) => {
        const readdir = fs.readdir;
        const directories = vi
          .spyOn(fs, "readdir")
          .mockImplementation((...args: Parameters<typeof fs.readdir>) => {
            const dir = args[0];
            return typeof dir === "string" && (dir === home || dir.startsWith(`${home}${path.sep}`))
              ? readdir(...args)
              : Promise.resolve([]);
          });
        try {
          const unreadable = path.join(home, relative);
          // A directory in place of a service file fails reads even as root.
          await fs.mkdir(unreadable, { recursive: true });
          await expect(listManagedOpenClawGatewayServices({ HOME: home })).resolves.toEqual({
            services: [],
            errors:
              platform === "linux" && required
                ? [{ source: unreadable, message: "Service path could not be inspected." }]
                : [],
          });
          await expect(
            listManagedOpenClawGatewayServices({ HOME: home }, { requireComplete: true }),
          ).resolves.toEqual({
            services: [],
            errors: required
              ? [{ source: unreadable, message: "Service path could not be inspected." }]
              : [],
          });
        } finally {
          directories.mockRestore();
        }
      });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  },
);
