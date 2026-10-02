import test from "node:test";
import assert from "node:assert/strict";
import { createSpeechToPipeHandler } from "../api/app/speech-to-pipe.js";

const origin = "https://app.pipepilotapp.com";
const identity = { ok: true, subject: "user-1", email: "pipe@example.com" };

function request(body) {
  return new Request("https://pipepilot-api.vercel.app/api/app/speech-to-pipe", {
    method: "POST",
    headers: { origin, authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function interpretBody(overrides = {}) {
  return {
    version: 1, mode: "interpret",
    instruction: "90 to 90, 36 inches center to center, north",
    history: [], drawingContext: { runCount: 0 }, selection: null,
    assistanceId: null, correctionOf: null, ...overrides,
  };
}

function readyPlan() {
  const empty = {
    direction: null, lengthSixteenths: null, fittingType: null,
    startFitting: null, endFitting: null, measurementBasis: null,
    outletSize: null, referenceFittingType: null, referencePosition: null,
    horizontalDirection: null, verticalDirection: null, runSixteenths: null,
    riseSixteenths: null, travelSixteenths: null, angleDegrees: null,
    firstHorizontal: null, secondHorizontal: null, offsetSixteenths: null,
    gasketTreatment: null, gasketThickness: null, endTeeTopology: null,
  };
  return {
    status: "ready", message: "Ready to preview.", question: null,
    source: { mode: "default", fittingType: null, position: null },
    requirements: { fittingRoles: [
      { operationIndex: 0, role: "start", fittingType: "ELBOW_90" },
      { operationIndex: 0, role: "end", fittingType: "ELBOW_90" },
    ] },
    operations: [{ ...empty, kind: "double_ninety", direction: "north", lengthSixteenths: 576 }],
  };
}

function fakeStore(overrides = {}) {
  return {
    startSubmission: async () => ({ allowed: true, accountId: 1, assistanceId: "4b38f80d-8680-45cd-a5ae-2cbdd2453d8c", turnId: 2, usageDate: "2026-10-01", remaining: 9 }),
    completeSubmission: async () => {}, failSubmission: async () => {},
    recordOutcome: async () => true, ...overrides,
  };
}

test("paid submission returns strict operations and records cost telemetry", async () => {
  let completion;
  let upstreamBody;
  const store = fakeStore({ completeSubmission: async (value) => { completion = value; } });
  const handler = createSpeechToPipeHandler({
    environment: { OPENAI_API_KEY: "key", SPEECH_TO_PIPE_MODEL: "gpt-6-luna" },
    verifier: async () => identity, store,
    fetcher: async (_url, options) => {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ output_text: JSON.stringify(readyPlan()), usage: { input_tokens: 100, output_tokens: 40 } }), {
        status: 200, headers: { "content-type": "application/json", "x-request-id": "req-1" },
      });
    },
  });

  const response = await handler(request(interpretBody()));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.remainingRequests, 9);
  assert.equal(body.operations[0].kind, "double_ninety");
  assert.equal(upstreamBody.model, "gpt-6-luna");
  assert.equal(upstreamBody.reasoning.effort, "none");
  assert.equal(upstreamBody.store, false);
  assert.equal(upstreamBody.text.format.strict, true);
  assert.equal(completion.inputTokens, 100);
  assert.equal(completion.outputTokens, 40);
  assert.equal(completion.reasoningEffort, "none");
  assert.equal(completion.estimatedCostMicros, 30);
});

test("free accounts are rejected before an OpenAI call", async () => {
  let fetched = false;
  const handler = createSpeechToPipeHandler({
    environment: { OPENAI_API_KEY: "key" }, verifier: async () => identity,
    store: fakeStore({ startSubmission: async () => ({ allowed: false, reason: "paid" }) }),
    fetcher: async () => { fetched = true; return new Response(); },
  });
  const response = await handler(request(interpretBody()));
  assert.equal(response.status, 403);
  assert.equal(fetched, false);
});

test("daily allowance is rejected before an OpenAI call", async () => {
  const handler = createSpeechToPipeHandler({
    environment: { OPENAI_API_KEY: "key", SPEECH_TO_PIPE_DAILY_LIMIT: "10" },
    verifier: async () => identity,
    store: fakeStore({ startSubmission: async () => ({ allowed: false, reason: "quota" }) }),
  });
  const response = await handler(request(interpretBody()));
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /10 submissions/);
});

test("missing facts return one clarification and no operations", async () => {
  const clarification = {
    status: "clarification", message: "Direction required.",
    question: "Which direction does the spool run?",
    source: { mode: "default", fittingType: null, position: null },
    requirements: { fittingRoles: [
      { operationIndex: 0, role: "start", fittingType: "ELBOW_90" },
      { operationIndex: 0, role: "end", fittingType: "ELBOW_90" },
    ] },
    operations: [],
  };
  const handler = createSpeechToPipeHandler({
    environment: { OPENAI_API_KEY: "key" }, verifier: async () => identity,
    store: fakeStore(),
    fetcher: async () => new Response(JSON.stringify({ output_text: JSON.stringify(clarification) }), { status: 200 }),
  });
  const response = await handler(request(interpretBody({ instruction: "90 to 90 at 36 inch centers" })));
  const body = await response.json();
  assert.equal(body.status, "clarification");
  assert.equal(body.question, "Which direction does the spool run?");
  assert.deepEqual(body.operations, []);
});

test("clarification cannot erase an explicitly requested fitting pair", async () => {
  let upstreamBody;
  const bareRun = {
    ...readyPlan(),
    message: "Ready to preview an 8 ft north run from a WNRF flange end.",
    requirements: { fittingRoles: [
      { operationIndex: 0, role: "start", fittingType: "WNRF" },
    ] },
    operations: [{
      ...readyPlan().operations[0],
      kind: "run",
      direction: "north",
      lengthSixteenths: 8 * 12 * 16,
    }],
  };
  const handler = createSpeechToPipeHandler({
    environment: { OPENAI_API_KEY: "key" }, verifier: async () => identity,
    store: fakeStore({
      startSubmission: async () => ({
        allowed: true, accountId: 1,
        assistanceId: "4b38f80d-8680-45cd-a5ae-2cbdd2453d8c",
        turnId: 2, usageDate: "2026-10-01", remaining: 8,
        originalInstruction: "Flange of flange 8 foot and end running north",
        priorRequirements: { fittingRoles: [
          { operationIndex: 0, role: "start", fittingType: null },
          { operationIndex: 0, role: "end", fittingType: null },
        ] },
      }),
    }),
    fetcher: async (_url, options) => {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output_text: JSON.stringify(bareRun),
      }), { status: 200 });
    },
  });
  const response = await handler(request(interpretBody({
    instruction: "wnrf",
    history: [
      { role: "user", content: "Flange of flange 8 foot and end running north" },
      { role: "assistant", content: "Which flange type should start the run?" },
    ],
  })));
  const body = await response.json();

  assert.equal(body.status, "clarification");
  assert.match(body.question, /end/i);
  assert.deepEqual(body.requirements.fittingRoles, [
    { operationIndex: 0, role: "start", fittingType: "WNRF" },
    { operationIndex: 0, role: "end", fittingType: null },
  ]);
  const currentTurn = JSON.parse(upstreamBody.input.at(-1).content);
  assert.equal(
    currentTurn.originalInstruction,
    "Flange of flange 8 foot and end running north",
  );
  assert.equal(currentTurn.priorFittingRequirements.fittingRoles.length, 2);
  assert.deepEqual(body.operations, []);
});

test("clarification preserves a resolved flange-to-flange assembly", async () => {
  const assembly = {
    ...readyPlan(),
    message: "Ready to preview the WNRF spool.",
    requirements: { fittingRoles: [
      { operationIndex: 0, role: "start", fittingType: "WNRF" },
      { operationIndex: 0, role: "end", fittingType: "WNRF" },
    ] },
    operations: [{
      ...readyPlan().operations[0],
      kind: "assembly",
      direction: "north",
      lengthSixteenths: 8 * 12 * 16,
      startFitting: "WNRF",
      endFitting: "WNRF",
      measurementBasis: "end_to_end",
    }],
  };
  const handler = createSpeechToPipeHandler({
    environment: { OPENAI_API_KEY: "key" }, verifier: async () => identity,
    store: fakeStore(),
    fetcher: async () => new Response(JSON.stringify({
      output_text: JSON.stringify(assembly),
    }), { status: 200 }),
  });
  const response = await handler(request(interpretBody({
    instruction: "wnrf for both",
    history: [
      { role: "user", content: "flange to flange 8 feet end to end north" },
      { role: "assistant", content: "Which flange type is used at both ends?" },
    ],
  })));
  const body = await response.json();

  assert.equal(body.status, "ready");
  assert.equal(body.operations[0].kind, "assembly");
  assert.equal(body.operations[0].startFitting, "WNRF");
  assert.equal(body.operations[0].endFitting, "WNRF");
});

test("continuity ledger protects every fitting role without type-specific rules", async () => {
  const droppedReducer = {
    ...readyPlan(),
    requirements: { fittingRoles: [] },
    operations: [{
      ...readyPlan().operations[0], kind: "run", direction: "east",
      lengthSixteenths: 48 * 16,
    }],
  };
  const protectedTypes = ["TEE", "CONCENTRIC_REDUCER", "VALVE", "STRAINER"];
  for (const fittingType of protectedTypes) {
    const handler = createSpeechToPipeHandler({
      environment: { OPENAI_API_KEY: "key" }, verifier: async () => identity,
      rateLimiter: { allow: () => true },
      store: fakeStore({
        startSubmission: async () => ({
          allowed: true, accountId: 1,
          assistanceId: "4b38f80d-8680-45cd-a5ae-2cbdd2453d8c",
          turnId: 2, usageDate: "2026-10-01", remaining: 8,
          originalInstruction: `90 to ${fittingType} four feet east`,
          priorRequirements: { fittingRoles: [
            { operationIndex: 0, role: "start", fittingType: "ELBOW_90" },
            { operationIndex: 0, role: "end", fittingType },
          ] },
        }),
      }),
      fetcher: async () => new Response(JSON.stringify({
        output_text: JSON.stringify(droppedReducer),
      }), { status: 200 }),
    });
    const response = await handler(request(interpretBody({ instruction: "yes" })));
    const body = await response.json();
    assert.equal(body.status, "clarification", fittingType);
    assert.deepEqual(body.requirements.fittingRoles, [
      { operationIndex: 0, role: "start", fittingType: "ELBOW_90" },
      { operationIndex: 0, role: "end", fittingType },
    ], fittingType);
  }
});

test("drawing outcomes are attached to the assistance report", async () => {
  let recorded;
  const handler = createSpeechToPipeHandler({
    verifier: async () => identity,
    store: fakeStore({ recordOutcome: async (value) => { recorded = value; return true; } }),
  });
  const response = await handler(request({
    version: 1, mode: "outcome",
    assistanceId: "4b38f80d-8680-45cd-a5ae-2cbdd2453d8c",
    outcome: "applied", stage: "execution", message: null,
    steps: ["two 90s, 36 inches north"],
  }));
  assert.equal(response.status, 200);
  assert.equal(recorded.outcome, "applied");
  assert.equal(recorded.identity.subject, "user-1");
});
