import test from "node:test";
import assert from "node:assert/strict";
import { administratorAccountCount } from "../api/_lib/app-account-count.js";

test("ordinary accounts never query or receive account totals", async () => {
  for (const capabilities of [{}, { administrator: false }, { administrator: "true" }]) {
    assert.deepEqual(await administratorAccountCount(() => { throw new Error("must not query"); }, capabilities), {});
  }
});
test("administrator receives total across all account tiers", async () => {
  assert.deepEqual(await administratorAccountCount(async (query) => {
    assert.equal(query[0], "SELECT COUNT(*) AS total FROM app_accounts");
    return [{ total: "42" }];
  }, { administrator: true }), { registeredAccountCount: 42 });
});
test("missing or failed statistics never report a false zero or block access", async () => {
  for (const total of [undefined, "bad", -1, 1.5]) {
    assert.deepEqual(await administratorAccountCount(async () => [{ total }], { administrator: true }), {});
  }
  assert.deepEqual(await administratorAccountCount(async () => { throw new Error("offline"); }, { administrator: true }), {});
  assert.deepEqual(await administratorAccountCount(async () => [{ total: "0" }], { administrator: true }), { registeredAccountCount: 0 });
});