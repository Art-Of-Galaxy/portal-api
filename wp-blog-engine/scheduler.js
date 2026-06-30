// Two cron jobs for the WordPress Blog Engine, mirroring blog-engine:
//   1. Publish (every minute): claim tbl_wp_articles rows where
//      status='scheduled' and scheduled_for<=NOW(), flip to publishing,
//      call publisher.publishArticle.
//   2. Autopilot (hourly): refill each active autopilot's draft queue.
//
// On Vercel serverless, the node-cron triggers don't actually fire; cron
// runs come in via HTTP from cron-job.org hitting the GET endpoints
// exposed by controller.js. The start() function here is a no-op when
// WP_BLOG_PUBLISH_SCHEDULER=off (default off in serverless deploys to
// avoid duplicate work — we trust the HTTP cron).

const cron = require('node-cron');
const { poll } = require('../config/dbconfig');
const publisher = require('./publisher');
const autopilot = require('./autopilot');

const PUBLISH_TAG  = '[wp-blog-engine:publish]';
const AUTOPILOT_TAG = '[wp-blog-engine:autopilot]';
let publishTask = null;
let autopilotTask = null;

async function recoverStuckPublishing() {
  try {
    await poll.query(
      `UPDATE tbl_wp_articles
          SET status = 'scheduled', updated_at = NOW()
        WHERE status = 'publishing'
          AND updated_at < NOW() - INTERVAL '5 minutes'`
    );
  } catch (err) {
    console.warn(`${PUBLISH_TAG} recovery sweep failed:`, err.message || err);
  }
}

async function claimDueArticles(limit = 1) {
  try {
    const result = await poll.query(
      `WITH due AS (
         SELECT id FROM tbl_wp_articles
          WHERE status = 'scheduled' AND scheduled_for <= NOW()
          ORDER BY scheduled_for ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE tbl_wp_articles a
          SET status = 'publishing', updated_at = NOW()
         FROM due
        WHERE a.id = due.id
       RETURNING a.id`,
      [limit]
    );
    const rows = Array.isArray(result) ? result : (result?.rows || []);
    return rows.map((r) => r.id);
  } catch (err) {
    console.warn(`${PUBLISH_TAG} claim CTE failed, falling back:`, err.message || err);
    const result = await poll.query(
      `UPDATE tbl_wp_articles
          SET status = 'publishing', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM tbl_wp_articles
           WHERE status = 'scheduled' AND scheduled_for <= NOW()
           ORDER BY scheduled_for ASC LIMIT $1
        )
        RETURNING id`,
      [limit]
    );
    const rows = Array.isArray(result) ? result : (result?.rows || []);
    return rows.map((row) => row.id);
  }
}

async function publishTick() {
  await recoverStuckPublishing();
  let ids = [];
  try { ids = await claimDueArticles(1); }
  catch (err) { console.error(`${PUBLISH_TAG} claim error:`, err.message || err); return; }
  if (!ids.length) return;
  console.log(`${PUBLISH_TAG} publishing ${ids.length} due article(s): ${ids.join(', ')}`);
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await publisher.publishArticle({ articleId: id, publishImmediately: true });
    } catch (err) {
      console.error(`${PUBLISH_TAG} publish ${id} threw:`, err.message || err);
      try {
        // eslint-disable-next-line no-await-in-loop
        await poll.query(
          `UPDATE tbl_wp_articles SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'publishing'`,
          [id]
        );
      } catch { /* ignore */ }
    }
  }
}

async function autopilotTick() {
  try {
    const results = await autopilot.tickAll();
    const total = results.reduce((s, r) => s + (r.drafted || 0), 0);
    if (total > 0) {
      console.log(`${AUTOPILOT_TAG} drafted ${total} new article(s) across ${results.length} autopilot(s)`);
    }
  } catch (err) {
    console.error(`${AUTOPILOT_TAG} tick error:`, err.message || err);
  }
}

function start() {
  if (!publishTask) {
    if ((process.env.WP_BLOG_PUBLISH_SCHEDULER || '').toLowerCase() === 'off') {
      console.log(`${PUBLISH_TAG} disabled via WP_BLOG_PUBLISH_SCHEDULER=off`);
    } else {
      publishTask = cron.schedule('* * * * *', () => {
        publishTick().catch((err) => console.error(`${PUBLISH_TAG} tick failed:`, err.message || err));
      }, { scheduled: true });
      console.log(`${PUBLISH_TAG} started, polling every minute`);
    }
  }
  if (!autopilotTask) {
    if ((process.env.WP_BLOG_AUTOPILOT_SCHEDULER || '').toLowerCase() === 'off') {
      console.log(`${AUTOPILOT_TAG} disabled via WP_BLOG_AUTOPILOT_SCHEDULER=off`);
    } else {
      autopilotTask = cron.schedule('17 * * * *', () => {
        autopilotTick().catch((err) => console.error(`${AUTOPILOT_TAG} tick failed:`, err.message || err));
      }, { scheduled: true });
      console.log(`${AUTOPILOT_TAG} started, runs hourly at :17`);
    }
  }
}

function stop() {
  if (publishTask) { publishTask.stop(); publishTask = null; }
  if (autopilotTask) { autopilotTask.stop(); autopilotTask = null; }
}

async function runOnce() {
  await publishTick();
  await autopilotTick();
}

module.exports = { start, stop, runOnce, publishTick, autopilotTick };
