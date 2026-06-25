// Two cron jobs for the Blog Engine.
//
// 1. Publish cron (every minute): atomically claims tbl_blog_articles
//    rows where status='scheduled' and scheduled_for<=NOW(), flips
//    them to 'publishing', and calls publisher.publishArticle.
//
// 2. Autopilot cron (every hour): keeps each active autopilot's
//    queued article count up to its queue_depth.
//
// Both started from app.js. Disable individually via env:
//   BLOG_PUBLISH_SCHEDULER=off
//   BLOG_AUTOPILOT_SCHEDULER=off

const cron = require('node-cron');
const { poll } = require('../config/dbconfig');
const publisher = require('./publisher');
const autopilot = require('./autopilot');

const PUBLISH_TAG  = '[blog-engine:publish]';
const AUTOPILOT_TAG = '[blog-engine:autopilot]';
let publishTask = null;
let autopilotTask = null;

async function claimDueArticles(limit = 3) {
  // The pg wrapper in config/dbconfig.js unwraps `.rows` only for SELECT
  // commands. For UPDATE...RETURNING it returns { rowCount, rows }, so we
  // always have to read the .rows field. Lower the default batch to 1
  // because publishArticle does several Shopify GraphQL calls and we want
  // to stay well under Vercel's 10s Hobby function timeout.
  try {
    const result = await poll.query(
      `WITH due AS (
         SELECT id FROM tbl_blog_articles
          WHERE status = 'scheduled' AND scheduled_for <= NOW()
          ORDER BY scheduled_for ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE tbl_blog_articles a
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
      `UPDATE tbl_blog_articles
          SET status = 'publishing', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM tbl_blog_articles
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

// Recovery: if a previous tick crashed (Lambda timed out, deploy
// rolled, etc.) the row gets stuck at status='publishing' forever.
// Flip anything older than 5 minutes back to 'scheduled' so the next
// tick picks it up again.
async function recoverStuckPublishing() {
  try {
    await poll.query(
      `UPDATE tbl_blog_articles
          SET status = 'scheduled', updated_at = NOW()
        WHERE status = 'publishing'
          AND updated_at < NOW() - INTERVAL '5 minutes'`
    );
  } catch (err) {
    console.warn(`${PUBLISH_TAG} recovery sweep failed:`, err.message || err);
  }
}

async function publishTick() {
  await recoverStuckPublishing();
  let ids = [];
  // Batch size = 1 to keep each invocation under Vercel's 10s Hobby
  // function timeout. publishArticle uploads the featured image to
  // Shopify Files (stagedUploadsCreate + multipart POST + polling) then
  // calls articleCreate + metafieldsSet, easily 5-15s per article.
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
      // publisher.publishArticle already marks the row failed on inner
      // errors; this catch handles outer throws.
      try {
        // eslint-disable-next-line no-await-in-loop
        await poll.query(
          `UPDATE tbl_blog_articles SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'publishing'`,
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
    if ((process.env.BLOG_PUBLISH_SCHEDULER || '').toLowerCase() === 'off') {
      console.log(`${PUBLISH_TAG} disabled via BLOG_PUBLISH_SCHEDULER=off`);
    } else {
      publishTask = cron.schedule('* * * * *', () => {
        publishTick().catch((err) => console.error(`${PUBLISH_TAG} tick failed:`, err.message || err));
      }, { scheduled: true });
      console.log(`${PUBLISH_TAG} started, polling every minute`);
    }
  }
  if (!autopilotTask) {
    if ((process.env.BLOG_AUTOPILOT_SCHEDULER || '').toLowerCase() === 'off') {
      console.log(`${AUTOPILOT_TAG} disabled via BLOG_AUTOPILOT_SCHEDULER=off`);
    } else {
      // Hourly: keeps the queue full without hammering Claude every minute.
      autopilotTask = cron.schedule('7 * * * *', () => {
        autopilotTick().catch((err) => console.error(`${AUTOPILOT_TAG} tick failed:`, err.message || err));
      }, { scheduled: true });
      console.log(`${AUTOPILOT_TAG} started, runs hourly at :07`);
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
