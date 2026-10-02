import test from "node:test";
import assert from "node:assert/strict";

import { createSpeechToPipeStore } from "../api/_lib/speech-to-pipe-store.js";

const identity = { subject: "owner-1", email: "owner@example.com" };

function fakeSql(entitlement, { requestCount = 1 } = {}) {
  const queries = [];
  const sql = async (strings, ...values) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push({ text, values });
    if (text.startsWith("INSERT INTO app_accounts")) {
      return [{ id: 7, suspended_at: null }];
    }
    if (text.startsWith("SELECT tier, status, paid_through")) {
      return [entitlement];
    }
    if (text.startsWith("INSERT INTO speech_to_pipe_daily_usage")) {
      return [{ request_count: requestCount }];
    }
    if (text.startsWith("INSERT INTO speech_to_pipe_assistances")) {
      return [];
    }
    if (text.startsWith("INSERT INTO speech_to_pipe_turns")) {
      return [{ id: 11, turn_index: 1 }];
    }
    if (text.startsWith("UPDATE speech_to_pipe_assistances")) {
      return [];
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  return { sql, queries };
}

test("administrator submissions are counted for telemetry without a daily cap", async () => {
  const database = fakeSql({
    tier: "annual_full",
    status: "complimentary_lifetime",
    paid_through: null,
  }, { requestCount: 27 });
  const store = createSpeechToPipeStore(database.sql, {
    now: () => new Date("2026-10-02T12:00:00.000Z"),
    idFactory: () => "4b38f80d-8680-45cd-a5ae-2cbdd2453d8c",
  });

  const started = await store.startSubmission({
    identity,
    dailyLimit: 10,
    assistanceId: null,
    instruction: "flange to flange eight feet north",
    requestContext: {},
  });

  assert.equal(started.allowed, true);
  assert.equal(started.unlimited, true);
  assert.equal(started.remaining, null);
  const usageQuery = database.queries.find(({ text }) =>
    text.startsWith("INSERT INTO speech_to_pipe_daily_usage"));
  assert.ok(usageQuery);
  assert.doesNotMatch(usageQuery.text, /WHERE speech_to_pipe_daily_usage\.request_count/);
});

test("paid non-administrator submissions retain the configured daily cap", async () => {
  const database = fakeSql({
    tier: "annual_full",
    status: "active",
    paid_through: "2099-01-01T00:00:00.000Z",
  }, { requestCount: 4 });
  const store = createSpeechToPipeStore(database.sql, {
    now: () => new Date("2026-10-02T12:00:00.000Z"),
    idFactory: () => "4b38f80d-8680-45cd-a5ae-2cbdd2453d8c",
  });

  const started = await store.startSubmission({
    identity,
    dailyLimit: 10,
    assistanceId: null,
    instruction: "90 to 90 three feet north",
    requestContext: {},
  });

  assert.equal(started.allowed, true);
  assert.equal(started.unlimited, false);
  assert.equal(started.remaining, 6);
  const usageQuery = database.queries.find(({ text }) =>
    text.startsWith("INSERT INTO speech_to_pipe_daily_usage"));
  assert.ok(usageQuery);
  assert.match(usageQuery.text, /WHERE speech_to_pipe_daily_usage\.request_count/);
});
