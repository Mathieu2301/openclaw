import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServiceChildRelayAdapter } from "./service-child-relay-host.js";

// A focused kernel contract, not an emulation of a sandbox service or provider.
// The full stock mandatory filter is exercised separately in isolated acceptance.
const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
const libc = koffi.load(null);
const prctl = libc.func(
  "int prctl(int, unsigned long, unsigned long, unsigned long, unsigned long)",
);
const program = koffi.struct({ len: "uint16_t", filter: "void *" });
const install = libc.func("prctl", "int", [
  "int",
  "unsigned long",
  koffi.pointer(program),
  "unsigned long",
  "unsigned long",
]);
const syscall = process.arch === "arm64" ? 129 : 62;
const arch = process.arch === "arm64" ? 0xc00000b7 : 0xc000003e;
const filters = [
  [0x20, 0, 0, 4],
  [0x15, 1, 0, arch],
  [0x06, 0, 0, 0x80000000],
  [0x20, 0, 0, 0],
  [0x15, 0, 4, syscall],
  [0x20, 0, 0, 16],
  [0x15, 1, 0, 0],
  [0x45, 0, 1, 0x80000000],
  [0x06, 0, 0, 0x00050001],
  [0x06, 0, 0, 0x7fff0000],
];
const bytes = Buffer.alloc(filters.length * 8);
for (const [index, instruction] of filters.entries()) {
  bytes.writeUInt16LE(instruction[0]!, index * 8);
  bytes[index * 8 + 2] = instruction[1]!;
  bytes[index * 8 + 3] = instruction[2]!;
  bytes.writeUInt32LE(instruction[3]!, index * 8 + 4);
}
assert.equal(prctl(38, 1, 0, 0, 0), 0);
assert.equal(install(22, 2, { len: filters.length, filter: bytes }, 0, 0), 0);
assert.throws(() => process.kill(0, 0), { code: "EPERM" });
const receipts = [];
for (const label of ["A", "B"]) {
  const { adapter, ready } = await createServiceChildRelayAdapter({
    command: process.execPath,
    args: ["-e", "process.stdout.write(" + JSON.stringify(label + "-final-output") + ")"],
    stdinMode: "pipe-closed",
    oomScoreWrapperSelected: false,
  });
  await ready;
  let stdout = "";
  adapter.onStdout((chunk) => {
    stdout += chunk;
  });
  const result = await adapter.wait();
  await adapter.waitForExtinction();
  receipts.push({
    label,
    ...result,
    stdout,
    extinct: adapter.confirmExtinction(),
    owner: adapter.treeOwnership,
  });
  adapter.dispose();
}
assert.throws(() => process.kill(-2147483647, 0), { code: "EPERM" });
process.stdout.write(JSON.stringify(receipts));
