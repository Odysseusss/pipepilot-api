import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryRateLimiter,
  createPeteyHandler,
} from '../api/petey.mjs';
import { PETEY_SYSTEM_PROMPT } from '../api/_lib/petey-prompt.mjs';

const requestBody = {
  version: 1,
  mode: 'petey_chat',
  message: 'What is the travel for a 10 inch 45 offset?',
  history: [],
  drawingSummary: { runCount: 1 },
  selection: null,
};

function environment(overrides = {}) {
  return {
    OPENAI_API_KEY: 'test-key',
    PETEY_MODEL: 'test-model',
    AI_BASE_URL: 'https://example.test/v1',
    PETEY_ALLOWED_ORIGINS: 'https://pipepilot.example',
    ...overrides,
  };
}

function request({ body = requestBody, method = 'POST', headers = {} } = {}) {
  return {
    method,
    body,
    headers: {
      'content-type': 'application/json',
      'x-pipe-pilot-client': 'install-12345678',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function alwaysAllowed() {
  return { allow: () => true };
}

test('proxies a chat request without exposing the API key to the client', async () => {
  let upstreamRequest;
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: alwaysAllowed(),
    fetcher: async (url, init) => {
      upstreamRequest = { url, init, body: JSON.parse(init.body) };
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    answer: '14.14 inches.',
                    intent: 'answer',
                    yaketyCommand: null,
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'x-request-id': 'req_test' } },
      );
    },
  });
  const result = response();

  await handler(request(), result);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    answer: '14.14 inches.',
    intent: 'answer',
    yaketyCommand: null,
    requestId: 'req_test',
  });
  assert.equal(upstreamRequest.url, 'https://example.test/v1/responses');
  assert.equal(upstreamRequest.init.headers.authorization, 'Bearer test-key');
  assert.equal(upstreamRequest.body.model, 'test-model');
  assert.equal(upstreamRequest.body.tools, undefined);
  assert.equal(upstreamRequest.body.store, false);
  assert.equal(upstreamRequest.body.text.format.type, 'json_schema');
  assert.equal(upstreamRequest.body.text.format.strict, true);
});

test('uses the low-cost model default when PETEY_MODEL is unset', async () => {
  let model;
  const handler = createPeteyHandler({
    environment: environment({ PETEY_MODEL: '' }),
    rateLimiter: alwaysAllowed(),
    fetcher: async (_url, init) => {
      model = JSON.parse(init.body).model;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            answer: 'Use the fitting table for an exact takeoff.',
            intent: 'answer',
            yaketyCommand: null,
          }),
        }),
        { status: 200 },
      );
    },
  });

  await handler(request(), response());

  assert.equal(model, 'gpt-5-mini');
});

test('returns a structured Yakety command for the app to validate', async () => {
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: alwaysAllowed(),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            answer: 'Sending two 90s to the route preview.',
            intent: 'drawing_command',
            yaketyCommand: '90 to 90 36 inches center to center running north',
          }),
        }),
        { status: 200 },
      ),
  });
  const result = response();

  await handler(
    request({
      body: {
        ...requestBody,
        message: 'Add two 90s 36 inches center to center running north',
      },
    }),
    result,
  );

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, {
    answer: 'Sending two 90s to the route preview.',
    intent: 'drawing_command',
    yaketyCommand: '90 to 90 36 inches center to center running north',
    requestId: null,
  });
});

test('rejects a command unless intent is drawing_command', async () => {
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: alwaysAllowed(),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            answer: 'This is only an answer.',
            intent: 'answer',
            yaketyCommand: '90 to 90 36 inches running north',
          }),
        }),
        { status: 200 },
      ),
  });
  const result = response();

  await handler(request(), result);

  assert.equal(result.statusCode, 502);
});

test('rate limits repeated callers', async () => {
  let currentTime = 1000;
  const limiter = createMemoryRateLimiter({
    limit: 1,
    periodMs: 60_000,
    now: () => currentTime,
  });
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: limiter,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            answer: 'First answer.',
            intent: 'answer',
            yaketyCommand: null,
          }),
        }),
        { status: 200 },
      ),
  });
  const first = response();
  const second = response();

  await handler(request(), first);
  await handler(request(), second);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 429);
  currentTime += 60_000;
  const reset = response();
  await handler(request(), reset);
  assert.equal(reset.statusCode, 200);
});

test('rejects malformed requests before calling upstream', async () => {
  let called = false;
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: alwaysAllowed(),
    fetcher: async () => {
      called = true;
      throw new Error('should not run');
    },
  });
  const result = response();

  await handler(request({ body: { ...requestBody, message: '' } }), result);

  assert.equal(result.statusCode, 400);
  assert.equal(called, false);
});

test('accepts local iPhone origins without configuration', async () => {
  const handler = createPeteyHandler({
    environment: environment({ PETEY_ALLOWED_ORIGINS: '' }),
    rateLimiter: alwaysAllowed(),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            answer: 'Ready.',
            intent: 'answer',
            yaketyCommand: null,
          }),
        }),
        { status: 200 },
      ),
  });
  const result = response();

  await handler(
    request({ headers: { origin: 'http://192.168.4.76' } }),
    result,
  );

  assert.equal(result.statusCode, 200);
  assert.equal(
    result.headers['access-control-allow-origin'],
    'http://192.168.4.76',
  );
});

test('accepts the production app origin without extra configuration', async () => {
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: alwaysAllowed(),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            answer: 'Ready.',
            intent: 'answer',
            yaketyCommand: null,
          }),
        }),
        { status: 200 },
      ),
  });
  const result = response();

  await handler(
    request({ headers: { origin: 'https://app.pipepilotapp.com' } }),
    result,
  );

  assert.equal(result.statusCode, 200);
  assert.equal(
    result.headers['access-control-allow-origin'],
    'https://app.pipepilotapp.com',
  );
});

test('rejects unlisted production origins', async () => {
  const handler = createPeteyHandler({
    environment: environment(),
    rateLimiter: alwaysAllowed(),
  });
  const result = response();

  await handler(
    request({ headers: { origin: 'https://not-pipe-pilot.example' } }),
    result,
  );

  assert.equal(result.statusCode, 403);
});

test('trade prompt keeps fixed 45 and custom-miter rules explicit', () => {
  assert.match(PETEY_SYSTEM_PROMPT, /fixed 45s cannot satisfy/i);
  assert.match(PETEY_SYSTEM_PROMPT, /26\.565 degrees/);
  assert.match(PETEY_SYSTEM_PROMPT, /no tools/i);
  assert.match(
    PETEY_SYSTEM_PROMPT,
    /Do not tell\s+the user\s+to copy or paste/i,
  );
  assert.match(PETEY_SYSTEM_PROMPT, /only drawing capability/i);
  assert.match(PETEY_SYSTEM_PROMPT, /bypass normal validation/i);
});
