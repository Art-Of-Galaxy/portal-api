// Autopilot for the WordPress blog engine. Mirrors blog-engine/autopilot
// in structure: every cron tick, top up each active autopilot's draft
// queue to its queue_depth, scheduling each new draft at the cadence
// interval. The publish cron in scheduler.js handles the actual REST
// API push when scheduled_for is hit.

const { poll } = require('../config/dbconfig');
const blogService = require('../blog-engine/service');

const CADENCE_TO_HOURS = {
  daily:    24,
  '3x':     56,
  '2x':     84,
  weekly:   168,
  biweekly: 84,
  monthly:  720,
};

function cadenceIntervalMs(cadence) {
  const h = CADENCE_TO_HOURS[String(cadence || '').toLowerCase()] || 168;
  return h * 60 * 60 * 1000;
}

function nextSlotAfter(date, hhmm) {
  const [hh, mm] = String(hhmm || '08:00').split(':').map((s) => Number(s) || 0);
  const next = new Date(date);
  next.setUTCHours(hh, mm, 0, 0);
  if (next <= date) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function loadActiveAutopilots() {
  const rows = await poll.query(
    `SELECT id, user_email, wp_connection_id, category_id, category_name,
            keywords_json, cadence, publish_time, voice_json, intent,
            length, queue_depth, next_publish_at, last_drafted_at, published_count
       FROM tbl_wp_autopilots WHERE status = 'active'`
  );
  return rows || [];
}

async function loadUsedKeywords(autopilotId) {
  const rows = await poll.query(
    `SELECT keyword FROM tbl_wp_articles WHERE autopilot_id = $1`,
    [autopilotId]
  );
  return new Set((rows || []).map((r) => String(r.keyword || '').toLowerCase()).filter(Boolean));
}

async function countQueued(autopilotId) {
  const rows = await poll.query(
    `SELECT COUNT(*)::int AS c FROM tbl_wp_articles
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
    `INSERT INTO tbl_wp_articles
        (user_email, wp_connection_id, autopilot_id, mode, keyword,
         brief_json, spec_json, assets_json, title, handle, meta_title,
         meta_description, tags, seo_score, word_count, status, scheduled_for)
      VALUES ($1, $2, $3, 'autopilot', $4,
              $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, 'scheduled', $15)
      RETURNING id`,
    [
      autopilot.user_email,
      autopilot.wp_connection_id,
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
    `UPDATE tbl_wp_autopilots
        SET next_publish_at = $2,
            last_drafted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [autopilotId, nextSlot]
  );
}

function pickNextKeyword(bank, used) {
  const list = Array.isArray(bank) ? bank.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!list.length) return null;
  for (const kw of list) {
    if (!used.has(kw.toLowerCase())) return kw;
  }
  return list[0];
}

async function tickAutopilot(autopilot) {
  const queued = await countQueued(autopilot.id);
  const depth = Math.max(1, Number(autopilot.queue_depth) || 5);
  if (queued >= depth) return { autopilot_id: autopilot.id, drafted: 0 };

  const used = await loadUsedKeywords(autopilot.id);
  const bank = Array.isArray(autopilot.keywords_json) ? autopilot.keywords_json : [];
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
      // eslint-disable-next-line no-await-in-loop
      const generated = await blogService.generateArticle({
        brief: {
          brand: autopilot.voice_json?.brand || autopilot.category_name || '',
          keyword,
          intent: autopilot.intent || 'informational',
          length: autopilot.length || 'standard',
          voice: autopilot.voice_json || {},
          notes: 'autopilot drafted (wordpress)',
        },
      });
      // eslint-disable-next-line no-await-in-loop
      await insertArticle({ autopilot, keyword, generated, scheduledFor: nextSlot });
      drafted += 1;
      nextSlot = new Date(nextSlot.getTime() + interval);
    } catch (err) {
      console.error(`[wp-blog-engine:autopilot] draft for "${keyword}" failed:`, err.message || err);
      continue;
    }
  }

  if (drafted > 0) await bumpAutopilot(autopilot.id, nextSlot);
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
      console.error(`[wp-blog-engine:autopilot] tick ${a.id} threw:`, err.message || err);
    }
  }
  return results;
}

module.exports = { tickAll, tickAutopilot, CADENCE_TO_HOURS };
