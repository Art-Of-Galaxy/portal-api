// Usage / credits tracking. Centralises the math that converts raw
// model events (Claude tokens, fal.ai images) into a single "credits"
// abstraction the Header can show without the operator having to do
// per-model conversions client-side.
//
// The conversion is deliberately simple to start: 1 credit per 1k LLM
// input tokens + 4 credits per 1k LLM output tokens + 25 credits per
// generated image. Tweak in CREDIT_RATES when pricing changes.

const { poll } = require('../config/dbconfig');

const CREDIT_RATES = {
  llm_input_per_1k:  1,
  llm_output_per_1k: 4,
  image_per_unit:    25,
  // Videos are an order of magnitude more expensive than logos. Adjust
  // when we have real Higgsfield pricing locked in.
  video_per_unit:    400,
};

function llmCredits(inputTokens, outputTokens) {
  const inCredits  = ((Number(inputTokens) || 0) / 1000) * CREDIT_RATES.llm_input_per_1k;
  const outCredits = ((Number(outputTokens) || 0) / 1000) * CREDIT_RATES.llm_output_per_1k;
  return Math.round((inCredits + outCredits) * 100) / 100;
}

function imageCredits(units) {
  return (Number(units) || 0) * CREDIT_RATES.image_per_unit;
}

function videoCredits(units) {
  return (Number(units) || 0) * CREDIT_RATES.video_per_unit;
}

async function recordUsage({
  userEmail,
  kind,                // 'llm' | 'image'
  model,
  service,
  inputTokens = 0,
  outputTokens = 0,
  units = 0,
  meta = null,
}) {
  try {
    let credits = 0;
    if (kind === 'llm') credits = llmCredits(inputTokens, outputTokens);
    else if (kind === 'image') credits = imageCredits(units);
    else if (kind === 'video') credits = videoCredits(units);

    await poll.query(
      `INSERT INTO tbl_usage
         (user_email, kind, model, service, input_tokens, output_tokens, units, credits, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        userEmail || null,
        kind,
        model || null,
        service || null,
        Math.max(0, Math.floor(inputTokens) || 0),
        Math.max(0, Math.floor(outputTokens) || 0),
        Math.max(0, Math.floor(units) || 0),
        credits,
        meta ? JSON.stringify(meta) : null,
      ]
    );
    return { ok: true, credits };
  } catch (err) {
    console.error('[usage] recordUsage failed:', err.message || err);
    return { ok: false, error: err.message || String(err) };
  }
}

// Aggregates for the Header badge. Returns total credits + a breakdown
// for the operator to drill into later.
async function getSummary({ userEmail, sinceDays = 30 }) {
  const params = [];
  const where = [`created_at >= NOW() - ($1 || ' days')::interval`];
  params.push(String(sinceDays));
  if (userEmail) {
    params.push(userEmail);
    where.push(`user_email = $${params.length}`);
  }

  const totalRow = await poll.query(
    `SELECT
       COALESCE(SUM(credits), 0)::float8  AS total_credits,
       COALESCE(SUM(input_tokens), 0)::int  AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
       COALESCE(SUM(units), 0)::int         AS total_units,
       COUNT(*)::int                        AS total_events
     FROM tbl_usage
     WHERE ${where.join(' AND ')}`,
    params
  );

  const byKind = await poll.query(
    `SELECT kind,
            COALESCE(SUM(credits), 0)::float8 AS credits,
            COUNT(*)::int AS events
       FROM tbl_usage
       WHERE ${where.join(' AND ')}
       GROUP BY kind
       ORDER BY credits DESC`,
    params
  );

  const total = totalRow?.[0] || {
    total_credits: 0, total_input_tokens: 0, total_output_tokens: 0, total_units: 0, total_events: 0,
  };

  return {
    since_days: sinceDays,
    total_credits: total.total_credits,
    total_tokens: total.total_input_tokens + total.total_output_tokens,
    total_input_tokens: total.total_input_tokens,
    total_output_tokens: total.total_output_tokens,
    total_units: total.total_units,
    total_events: total.total_events,
    by_kind: byKind || [],
    rates: CREDIT_RATES,
  };
}

module.exports = {
  recordUsage,
  getSummary,
  CREDIT_RATES,
};
