BEGIN;

CREATE TABLE IF NOT EXISTS speech_to_pipe_daily_usage (
  account_id BIGINT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  transcription_audio_seconds INTEGER NOT NULL DEFAULT 0 CHECK (transcription_audio_seconds >= 0),
  transcription_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (transcription_cost_micros >= 0),
  interpretation_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (interpretation_input_tokens >= 0),
  interpretation_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (interpretation_output_tokens >= 0),
  interpretation_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (interpretation_cost_micros >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, usage_date)
);

CREATE TABLE IF NOT EXISTS speech_to_pipe_assistances (
  id UUID PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started',
  first_instruction TEXT NOT NULL,
  last_instruction TEXT NOT NULL,
  model TEXT,
  reasoning_effort TEXT,
  last_response JSONB,
  outcome TEXT,
  outcome_details JSONB,
  outcome_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS speech_to_pipe_assistances_account_created_idx
  ON speech_to_pipe_assistances (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS speech_to_pipe_turns (
  id BIGSERIAL PRIMARY KEY,
  assistance_id UUID NOT NULL REFERENCES speech_to_pipe_assistances(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL CHECK (turn_index > 0),
  instruction TEXT NOT NULL,
  request_context JSONB NOT NULL DEFAULT '{}'::JSONB,
  response_payload JSONB,
  model TEXT,
  reasoning_effort TEXT,
  upstream_request_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_micros >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  failure_stage TEXT,
  failure_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (assistance_id, turn_index)
);

CREATE INDEX IF NOT EXISTS speech_to_pipe_turns_assistance_idx
  ON speech_to_pipe_turns (assistance_id, turn_index);

COMMIT;
