// Autopilot keeps the article queue full for each active autopilot.
//
// Strategy: every hour, for each active autopilot:
//   1. Count how many articles already exist for this autopilot in
//      ('draft', 'scheduled') status.
//   2. If that count is less than queue_depth, draft enough new
//      articles to refill it — one per next unused keyword.
//   3. Stamp each new draft with scheduled_for = next_publish_at and
//      bump next_publish_at by the cadence interval.
//
// The publish cron (scheduler.js) handles actual posting when
// scheduled_for is hit. Autopilot is just the keyword-bank rotator.

const { poll } = require('../config/dbconfig');
const service = require('./service');

const CADENCE_TO_HOURS = {
  daily:    24,
  '3x':     56,   // ~3 per week
  '2x':     84,   // ~2 per week
  weekly:   168,
  biweekly: 84,   // 2 per month
  monthly:  720,
};

function cadenceIntervalMs(cadence) {
  const h = CADENCE_TO_HOURS[String(cadence || '').toLowerCase()] || 168;
  return h * 60 * 60 * 1000;
}

// Pick the next "first publish slot" at or after now, at the
// autopilot's preferred publish_time (HH:MM, UTC for v1).
function nextSlotAfter(date, hhmm) {
  const [hh, mm] = String(hhmm || '08:00').split(':').map((s) => Number(s) || 0);
  const next = new Date(date);
  next.setUTCHours(hh, mm, 0, 0);
  if (next <= date) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function loadActiveAutopilots() {
  const rows = await poll.query(
    `SELECT id, user_email, shop_connection_id, blog_id, blog_title,
            keywords_json, cadence, publish_time, voice_json, intent,
            length, queue_depth, next_publish_at, last_drafted_at, published_count
       FROM tbl_blog_autopilots WHERE status = 'active'`
  );
  return rows || [];
}

async function loadUsedKeywords(autopilotId) {
  const rows = await poll.query(
    `SELECT keyword FROM tbl_blog_articles WHERE autopilot_id = $1`,
    [autopilotId]
  );
  return new Set((rows || []).map((r) => String(r.keyword || '').toLowerCase()).filter(Boolean));
}

async function countQueued(autopilotId) {
  const rows = await poll.query(
    `SELECT COUNT(*)::int AS c FROM tbl_blog_articles
       WHERE autopilot_id = $1 AND status IN ('draft', 'scheduled')`,
    [autopilotId]
  );
  return (rows?.[0]?.c) || 0;
}

async function insertArticle({ autopilot, keyword, generated, scheduledFor }) {
  const spec = generated.spec || {};
  const featured = generated.featured || null;
  const bodyHtml = generated.body_html || '';
  const result = await poll.query(
    `INSERT INTO tbl_blog_articles
        (user_email, shop_connection_id, autopilot_id, mode, keyword,
         brief_json, spec_json, assets_json, title, handle, meta_title,
         meta_description, tags, seo_score, word_count, status, scheduled_for)
      VALUES ($1, $2, $3, 'autopilot', $4,
              $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, 'scheduled', $15)
      RETURNING id`,
    [
      autopilot.user_email,
      autopilot.shop_connection_id,
      autopilot.id,
      keyword,
      JSON.stringify({ keyword, autopilot_id: autopilot.id }),
      JSON.stringify(spec),
      JSON.stringify({ featured, body_html: bodyHtml }),
      spec.title || keyword,
      spec.handle || null,
      spec.meta_title || null,
      spec.meta_description || null,
      Array.isArray(spec.tags) ? spec.tags.join(',') : (spec.tags || null),
      Number.isInteger(spec.seo_score) ? spec.seo_score : null,
      Number.isInteger(spec.word_count) ? spec.word_count : null,
      scheduledFor,
    ]
  );
  return result.rows?.[0]?.id || null;
}

async function bumpAutopilot(autopilotId, nextSlot) {
  await poll.query(
    `UPDATE tbl_blog_autopilots
        SET next_publish_at = $2,
            last_drafted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [autopilotId, nextSlot]
  );
}

// Returns the next available keyword that hasn't been drafted yet for
// this autopilot. Keywords cycle from the top of the bank — once we've
// used them all, we start over (the autopilot keeps publishing fresh
// articles on the same topics over time).
function pickNextKeyword(bank, used) {
  const list = Array.isArray(bank) ? bank.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) return null;
  for (const kw of list) {
    if (!used.has(kw.toLowerCase())) return kw;
  }
  // All used. Pick the least-recent one (just rotate by reset).
  return list[0];
}

async function tickAutopilot(autopilot) {
  const queued = await countQueued(autopilot.id);
  const depth = Math.max(1, Number(autopilot.queue_depth) || 5);
  if (queued >= depth) return { autopilot_id: autopilot.id, drafted: 0 };

  const used = await loadUsedKeywords(autopilot.id);
  const bank = Array.isArray(autopilot.keywords_json) ? autopilot.keywords_json : [];

  // First publish slot defaults to next preferred time-of-day.
  let nextSlot = autopilot.next_publish_at
    ? new Date(autopilot.next_publish_at)
    : nextSlotAfter(new Date(), autopilot.publish_time);

  const interval = cadenceIntervalMs(autopilot.cadence);
  const toDraft = depth - queued;
  let drafted = 0;

  for (let i = 0; i < toDraft; i += 1) {
    const keyword = pickNextKeyword(bank, used);
    if (!keyword) break;
    used.add(keyword.toLowerCase());

    try {
      const generated = await service.generateArticle({
        brief: {
          brand: autopilot.voice_json?.brand || autopilot.blog_title || '',
          keyword,
          intent: autopilot.intent || 'informational',
          length: autopilot.length || 'standard',
          voice: autopilot.voice_json || {},
          notes: 'autopilot drafted',
        },
      });
      // First slot uses the calculated nextSlot; subsequent drafts
      // step forward by the cadence interval.
      await insertArticle({
        autopilot, keyword, generated, scheduledFor: nextSlot,
      });
      drafted += 1;
      nextSlot = new Date(nextSlot.getTime() + interval);
    } catch (err) {
      console.error(`[blog-engine:autopilot] draft for "${keyword}" failed:`, err.message || err);
      // Skip this keyword and try the next one.
      continue;
    }
  }

  if (drafted > 0) {
    await bumpAutopilot(autopilot.id, nextSlot);
  }
  return { autopilot_id: autopilot.id, drafted };
}

async function tickAll() {
  const autos = await loadActiveAutopilots();
  const results = [];
  for (const a of autos) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await tickAutopilot(a);
      results.push(r);
    } catch (err) {
      console.error(`[blog-engine:autopilot] tick ${a.id} threw:`, err.message || err);
    }
  }
  return results;
}

module.exports = { tickAll, tickAutopilot, CADENCE_TO_HOURS };
