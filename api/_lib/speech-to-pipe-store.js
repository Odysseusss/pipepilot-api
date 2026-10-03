import { randomUUID } from "node:crypto";
import { currentAppEntitlement, upsertAppAccount } from "./app-account-store.js";
import { APP_TIERS, resolveCapabilities } from "./app-capabilities.js";

export function createSpeechToPipeStore(sql, {
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  return {
    async startSubmission({ identity, dailyLimit, assistanceId, instruction, requestContext }) {
      const account = await upsertAppAccount(sql, identity);
      const entitlement = await currentAppEntitlement(sql, account.id);
      const access = resolveCapabilities(entitlement, {
        suspended: account.suspended_at !== null,
      });
      if (access.tier !== APP_TIERS.ANNUAL_FULL) {
        return { allowed: false, reason: "paid" };
      }
      const unlimited = access.capabilities.administrator === true;

      let resolvedAssistanceId = assistanceId;
      let originalInstruction = instruction;
      let priorRequirements = null;
      if (resolvedAssistanceId) {
        const existing = await sql`
          SELECT id, first_instruction, last_response
          FROM speech_to_pipe_assistances
          WHERE id = ${resolvedAssistanceId}::uuid AND account_id = ${account.id}
          LIMIT 1
        `;
        if (!existing[0]) return { allowed: false, reason: "assistance" };
        originalInstruction = existing[0].first_instruction ?? instruction;
        priorRequirements = existing[0].last_response?.requirements ?? null;
      }

      const usageDate = now().toISOString().slice(0, 10);
      const usageRows = unlimited
        ? await sql`
            INSERT INTO speech_to_pipe_daily_usage (
              account_id, usage_date, request_count
            ) VALUES (${account.id}, ${usageDate}::date, 1)
            ON CONFLICT (account_id, usage_date) DO UPDATE
            SET request_count = speech_to_pipe_daily_usage.request_count + 1,
                updated_at = NOW()
            RETURNING request_count
          `
        : await sql`
            INSERT INTO speech_to_pipe_daily_usage (
              account_id, usage_date, request_count
            ) VALUES (${account.id}, ${usageDate}::date, 1)
            ON CONFLICT (account_id, usage_date) DO UPDATE
            SET request_count = speech_to_pipe_daily_usage.request_count + 1,
                updated_at = NOW()
            WHERE speech_to_pipe_daily_usage.request_count < ${dailyLimit}
            RETURNING request_count
          `;
      if (!usageRows[0]) return { allowed: false, reason: "quota" };

      if (!resolvedAssistanceId) {
        resolvedAssistanceId = idFactory();
        await sql`
          INSERT INTO speech_to_pipe_assistances (
            id, account_id, status, first_instruction, last_instruction
          ) VALUES (
            ${resolvedAssistanceId}::uuid, ${account.id}, 'started',
            ${instruction}, ${instruction}
          )
        `;
      }

      const contextJson = JSON.stringify(requestContext ?? {});
      const turnRows = await sql`
        INSERT INTO speech_to_pipe_turns (
          assistance_id, turn_index, instruction, request_context
        )
        SELECT ${resolvedAssistanceId}::uuid,
               COALESCE(MAX(turn_index), 0) + 1,
               ${instruction}, ${contextJson}::jsonb
        FROM speech_to_pipe_turns
        WHERE assistance_id = ${resolvedAssistanceId}::uuid
        RETURNING id, turn_index
      `;
      await sql`
        UPDATE speech_to_pipe_assistances
        SET last_instruction = ${instruction}, status = 'submitted',
            updated_at = NOW()
        WHERE id = ${resolvedAssistanceId}::uuid AND account_id = ${account.id}
      `;
      return {
        allowed: true,
        accountId: account.id,
        assistanceId: resolvedAssistanceId,
        turnId: turnRows[0].id,
        usageDate,
        remaining: unlimited
          ? null
          : Math.max(0, dailyLimit - Number(usageRows[0].request_count)),
        unlimited,
        originalInstruction,
        priorRequirements,
      };
    },

    async completeSubmission({
      started, model, reasoningEffort, upstreamRequestId, reply, inputTokens, outputTokens,
      estimatedCostMicros, latencyMs, continuityDemoted = false,
    }) {
      const replyJson = JSON.stringify(reply);
      await sql`
        UPDATE speech_to_pipe_turns
        SET response_payload = ${replyJson}::jsonb, model = ${model},
            reasoning_effort = ${reasoningEffort},
            upstream_request_id = ${upstreamRequestId},
            input_tokens = ${inputTokens}, output_tokens = ${outputTokens},
            estimated_cost_micros = ${estimatedCostMicros},
            latency_ms = ${latencyMs}, continuity_demoted = ${continuityDemoted},
            completed_at = NOW()
        WHERE id = ${started.turnId}
      `;
      await sql`
        UPDATE speech_to_pipe_daily_usage
        SET interpretation_input_tokens = interpretation_input_tokens + ${inputTokens},
            interpretation_output_tokens = interpretation_output_tokens + ${outputTokens},
            interpretation_cost_micros = interpretation_cost_micros + ${estimatedCostMicros},
            updated_at = NOW()
        WHERE account_id = ${started.accountId}
          AND usage_date = ${started.usageDate}::date
      `;
      await sql`
        UPDATE speech_to_pipe_assistances
        SET status = ${reply.status}, model = ${model}, reasoning_effort = ${reasoningEffort},
            last_response = ${replyJson}::jsonb, updated_at = NOW()
        WHERE id = ${started.assistanceId}::uuid
          AND account_id = ${started.accountId}
      `;
    },

    async failSubmission({ started, model, reasoningEffort, stage, message, latencyMs }) {
      await sql`
        UPDATE speech_to_pipe_turns
        SET model = ${model}, reasoning_effort = ${reasoningEffort},
            failure_stage = ${stage}, failure_message = ${message},
            latency_ms = ${latencyMs}, completed_at = NOW()
        WHERE id = ${started.turnId}
      `;
      await sql`
        UPDATE speech_to_pipe_assistances
        SET status = 'failed', updated_at = NOW()
        WHERE id = ${started.assistanceId}::uuid
          AND account_id = ${started.accountId}
      `;
    },

    async recordOutcome({ identity, assistanceId, outcome, stage, message, steps }) {
      const account = await upsertAppAccount(sql, identity);
      const details = JSON.stringify({ stage, message, steps });
      const rows = await sql`
        UPDATE speech_to_pipe_assistances
        SET outcome = ${outcome}, outcome_details = ${details}::jsonb,
            outcome_at = NOW(), updated_at = NOW()
        WHERE id = ${assistanceId}::uuid AND account_id = ${account.id}
        RETURNING id
      `;
      return Boolean(rows[0]);
    },
  };
}
