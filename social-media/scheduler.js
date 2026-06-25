// node-cron based scheduler for tbl_social_posts.
//
// Every minute we look for posts with status='scheduled' and
// scheduled_for <= NOW(), flip them to 'publishing' (so two scheduler
// ticks can't pick up the same row), then run the publisher.
//
// The scheduler is started from app.js. Set SOCIAL_SCHEDULER=off in env
// to disable it on instances that should not publish (e.g. a one-off
// migration container).

const cron = require('node-cron');
const { poll } = require('../config/dbconfig');
const publisher = require('./publish');

const TASK_NAME = '[social-media:scheduler]';
let task = null;

// Atomically claim a batch of due posts so two ticks don't double-publish.
// FOR UPDATE SKIP LOCKED is the standard Postgres idiom; falls back to
// a plain UPDATE when running on a Postgres < 9.5.
async function claimDuePosts(limit = 1) {
  // The pg wrapper in config/dbconfig.js unwraps `.rows` only for SELECT
  // commands. UPDATE...RETURNING comes back as { rowCount, rows } so we
  // always read .rows. Default batch size is 1 to keep each invocation
  // under Vercel's 10s Hobby function timeout (publishing a post can
  // take 5-15s per platform).
  try {
    const result = await poll.query(
      `WITH due AS (
         SELECT id FROM tbl_social_posts
          WHERE status = 'scheduled' AND scheduled_for <= NOW()
          ORDER BY scheduled_for ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE tbl_social_posts p
          SET status = 'publishing', updated_at = NOW()
         FROM due
        WHERE p.id = due.id
       RETURNING p.id`,
      [limit]
    );
    const rows = Array.isArray(result) ? result : (result?.rows || []);
    return rows.map((r) => r.id);
  } catch (err) {
    console.warn(`${TASK_NAME} claim CTE failed, falling back:`, err.message || err);
    const result = await poll.query(
      `UPDATE tbl_social_posts
          SET status = 'publishing', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM tbl_social_posts
           WHERE status = 'scheduled' AND scheduled_for <= NOW()
           ORDER BY scheduled_for ASC
           LIMIT $1
        )
        RETURNING id`,
      [limit]
    );
    const rows = Array.isArray(result) ? result : (result?.rows || []);
    return rows.map((row) => row.id);
  }
}

// Recovery: rows stuck at 'publishing' (Lambda timed out, deploy mid-tick,
// crash) get flipped back to 'scheduled' after 5 minutes so the next tick
// retries them.
async function recoverStuckPublishing() {
  try {
    await poll.query(
      `UPDATE tbl_social_posts
          SET status = 'scheduled', updated_at = NOW()
        WHERE status = 'publishing'
          AND updated_at < NOW() - INTERVAL '5 minutes'`
    );
  } catch (err) {
    console.warn(`${TASK_NAME} recovery sweep failed:`, err.message || err);
  }
}

async function tick() {
  await recoverStuckPublishing();
  let ids = [];
  try {
    ids = await claimDuePosts(1);
  } catch (err) {
    console.error(`${TASK_NAME} claim error:`, err.message || err);
    return;
  }
  if (!ids.length) return;
  console.log(`${TASK_NAME} publishing ${ids.length} due post(s): ${ids.join(', ')}`);
  for (const id of ids) {
    try {
      await publisher.publishPost({ postId: id });
    } catch (err) {
      console.error(`${TASK_NAME} publish ${id} threw:`, err.message || err);
      // publisher.publishPost already marks the row failed on inner errors;
      // any throw here means something hard like loadPost failed. Reset to
      // 'failed' to avoid a stuck 'publishing' state.
      try {
        await poll.query(
          `UPDATE tbl_social_posts SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'publishing'`,
          [id]
        );
      } catch { /* ignore */ }
    }
  }
}

function start() {
  if (task) return; // already started
  if ((process.env.SOCIAL_SCHEDULER || '').toLowerCase() === 'off') {
    console.log(`${TASK_NAME} disabled via SOCIAL_SCHEDULER=off`);
    return;
  }
  // Every minute. Cron pattern: minute hour day-of-month month day-of-week
  task = cron.schedule('* * * * *', () => {
    tick().catch((err) => console.error(`${TASK_NAME} tick failed:`, err.message || err));
  }, { scheduled: true });
  console.log(`${TASK_NAME} started, polling every minute`);
}

function stop() {
  if (!task) return;
  task.stop();
  task = null;
}

// Exposed so the controller can offer a "Publish now" or "Run scheduler"
// admin endpoint, useful when debugging.
async function runOnce() {
  await tick();
}

module.exports = { start, stop, runOnce, tick };
