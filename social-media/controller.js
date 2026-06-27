// REST endpoints for the Social Media Studio.
//
// Flow:
//   POST  /api/social-media/generate    -> Claude spec + cover image
//   POST  /api/social-media/save        -> create or update a tbl_social_posts row (draft, scheduled, or published)
//   POST  /api/social-media/:id/publish -> immediate publish
//   GET   /api/social-media/library     -> list user's posts (filterable)
//   GET   /api/social-media/stats       -> sidebar stats (this week)
//   POST  /api/social-media/run-scheduler -> manual tick (admin only)

const { poll } = require('../config/dbconfig');
const service = require('./service');
const publisher = require('./publish');
const scheduler = require('./scheduler');

function getUserEmail(req) {
  return (
    req.headers['x-user-email']
    || req.body?.user_email
    || req.query?.user_email
    || ''
  ).toString().trim().toLowerCase();
}

function normalizeHashtags(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .join(' ');
  }
  return String(tags || '').trim();
}

async function generate(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const { brief, model } = req.body || {};
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'user_email is required' });
    }
    const result = await service.generateContent({ brief, requestedModel: model });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('social-media/generate error:', err);
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message || 'Generation failed' });
  }
}

async function save(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) {
      return res.status(400).json({ success: false, message: 'user_email is required' });
    }
    const {
      post_id, project_id, content_type, brief, spec, cover, caption, hashtags,
      platforms = [], status, scheduled_for, batch_parent_id,
    } = req.body || {};

    const assets = cover ? { cover_url: cover.url || cover, cover_content_type: cover.content_type || null } : null;
    const platformsStr = Array.isArray(platforms) ? platforms.join(',') : String(platforms || '');
    const hashtagsStr = normalizeHashtags(hashtags);
    const allowedStatus = new Set(['draft', 'scheduled', 'published', 'failed']);
    const safeStatus = allowedStatus.has(status) ? status : 'draft';

    if (post_id) {
      const r = await poll.query(
        `UPDATE tbl_social_posts
            SET content_type = COALESCE($2, content_type),
                brief_json   = COALESCE($3::jsonb, brief_json),
                spec_json    = COALESCE($4::jsonb, spec_json),
                assets_json  = COALESCE($5::jsonb, assets_json),
                caption      = COALESCE($6, caption),
                hashtags     = COALESCE($7, hashtags),
                platforms    = COALESCE($8, platforms),
                status       = COALESCE($9, status),
                scheduled_for = $10,
                updated_at   = NOW()
          WHERE id = $1 AND user_email = $11
          RETURNING id, status, scheduled_for`,
        [
          post_id,
          content_type || null,
          brief ? JSON.stringify(brief) : null,
          spec ? JSON.stringify(spec) : null,
          assets ? JSON.stringify(assets) : null,
          caption || null,
          hashtagsStr || null,
          platformsStr || null,
          safeStatus,
          scheduled_for || null,
          userEmail,
        ]
      );
      const row = r?.rows?.[0];
      if (!row) return res.status(404).json({ success: false, message: 'Post not found' });
      return res.status(200).json({ success: true, post_id: row.id, status: row.status });
    }

    const r = await poll.query(
      `INSERT INTO tbl_social_posts
          (user_email, project_id, content_type, brief_json, spec_json, assets_json,
           caption, hashtags, platforms, status, scheduled_for, batch_parent_id)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb,
                $7, $8, $9, $10, $11, $12)
        RETURNING id, status`,
      [
        userEmail,
        project_id || null,
        content_type || 'post',
        brief ? JSON.stringify(brief) : null,
        spec ? JSON.stringify(spec) : null,
        assets ? JSON.stringify(assets) : null,
        caption || null,
        hashtagsStr || null,
        platformsStr,
        safeStatus,
        scheduled_for || null,
        batch_parent_id || null,
      ]
    );
    const row = r?.rows?.[0];
    return res.status(200).json({ success: true, post_id: row.id, status: row.status });
  } catch (err) {
    console.error('social-media/save error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Save failed' });
  }
}

async function publishNow(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const postId = Number(req.params.id);
    if (!Number.isInteger(postId)) return res.status(400).json({ success: false, message: 'Invalid post id' });

    // Belt-and-braces: confirm ownership before publishing.
    const rows = await poll.query(
      `SELECT id FROM tbl_social_posts WHERE id = $1 AND user_email = $2 LIMIT 1`,
      [postId, userEmail]
    );
    if (!rows?.length) return res.status(404).json({ success: false, message: 'Post not found' });

    const result = await publisher.publishPost({ postId });
    return res.status(200).json({ success: result.ok, ...result });
  } catch (err) {
    console.error('social-media/publishNow error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Publish failed' });
  }
}

// Single-post fetch. The Hub's content cards link to
// /new-projects/social/create?post=ID; the Create flow loads the row
// via this endpoint and jumps to the Preview / Schedule step so the
// user doesn't have to regenerate the brief from scratch.
async function getPost(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid post id' });

    const rows = await poll.query(
      `SELECT id, user_email, project_id, content_type, brief_json, spec_json,
              assets_json, caption, hashtags, platforms, status,
              scheduled_for, published_at, batch_parent_id, metrics_json,
              created_at, updated_at
         FROM tbl_social_posts
        WHERE id = $1 AND user_email = $2
        LIMIT 1`,
      [id, userEmail]
    );
    const row = (rows || [])[0];
    if (!row) return res.status(404).json({ success: false, message: 'Post not found' });

    const post = {
      id: row.id,
      project_id: row.project_id,
      content_type: row.content_type,
      brief: row.brief_json || {},
      spec: row.spec_json || {},
      assets: row.assets_json || {},
      caption: row.caption || '',
      hashtags: row.hashtags || '',
      platforms: String(row.platforms || '').split(',').filter(Boolean),
      status: row.status,
      scheduled_for: row.scheduled_for,
      published_at: row.published_at,
      batch_parent_id: row.batch_parent_id,
      metrics: row.metrics_json || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    return res.status(200).json({ success: true, post });
  } catch (err) {
    console.error('social-media/getPost error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Load failed' });
  }
}

async function library(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const filter = String(req.query.filter || 'all').toLowerCase();

    const allowed = new Set(['all', 'draft', 'scheduled', 'published', 'failed']);
    const where = ['p.user_email = $1'];
    const params = [userEmail];
    if (allowed.has(filter) && filter !== 'all') {
      params.push(filter);
      where.push(`p.status = $${params.length}`);
    }

    const rows = await poll.query(
      `SELECT p.id, p.content_type, p.caption, p.hashtags, p.platforms, p.status,
              p.scheduled_for, p.published_at, p.assets_json, p.spec_json,
              p.metrics_json, p.created_at, p.updated_at,
              -- Per-post run summary: how many succeeded / failed and the
              -- most recent error message. Lets the hub show a clear
              -- "X of Y published, look at platform Z" indicator even
              -- when the overall status is 'published'.
              (SELECT COUNT(*) FROM tbl_social_post_runs r
                 WHERE r.post_id = p.id AND r.state = 'success')::int AS run_success_count,
              (SELECT COUNT(*) FROM tbl_social_post_runs r
                 WHERE r.post_id = p.id AND r.state = 'error')::int AS run_error_count,
              (SELECT json_build_object(
                        'platform', r.platform,
                        'code', r.error_code,
                        'message', r.error_message,
                        'at', r.started_at
                      )
                 FROM tbl_social_post_runs r
                WHERE r.post_id = p.id AND r.state = 'error'
                ORDER BY r.started_at DESC LIMIT 1) AS last_error
         FROM tbl_social_posts p
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(p.scheduled_for, p.published_at, p.updated_at) DESC
        LIMIT 60`,
      params
    );

    const posts = (rows || []).map((r) => {
      const success = Number(r.run_success_count || 0);
      const errors = Number(r.run_error_count || 0);
      // Derived status: a row marked 'published' that had any errored
      // attempts is partially published (some platforms failed).
      let derivedStatus = r.status;
      if (r.status === 'published' && errors > 0) derivedStatus = 'partial';
      return {
        id: r.id,
        content_type: r.content_type,
        caption: r.caption,
        hashtags: r.hashtags,
        platforms: String(r.platforms || '').split(',').filter(Boolean),
        status: r.status,
        derived_status: derivedStatus, // 'draft' | 'scheduled' | 'published' | 'partial' | 'failed'
        run_success_count: success,
        run_error_count: errors,
        last_error: r.last_error || null,
        scheduled_for: r.scheduled_for,
        published_at: r.published_at,
        cover_url: r.assets_json?.cover_url || null,
        spec: r.spec_json,
        metrics: r.metrics_json || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    return res.status(200).json({ success: true, posts });
  } catch (err) {
    console.error('social-media/library error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Library load failed' });
  }
}

async function stats(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });

    const rows = await poll.query(
      `SELECT
         SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS posts_created,
         SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END)::int                   AS scheduled,
         SUM(CASE WHEN status = 'published' AND published_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS published_week,
         SUM(CASE WHEN content_type = 'carousel' AND created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS mix_carousel,
         SUM(CASE WHEN content_type = 'reel'     AND created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS mix_reel,
         SUM(CASE WHEN content_type = 'post'     AND created_at >= NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)::int AS mix_post
       FROM tbl_social_posts
       WHERE user_email = $1`,
      [userEmail]
    );
    const r = (rows || [])[0] || {};
    return res.status(200).json({
      success: true,
      this_week: {
        posts_created: Number(r.posts_created || 0),
        scheduled: Number(r.scheduled || 0),
        published_week: Number(r.published_week || 0),
      },
      content_mix: {
        carousel: Number(r.mix_carousel || 0),
        reel:     Number(r.mix_reel || 0),
        post:     Number(r.mix_post || 0),
      },
    });
  } catch (err) {
    console.error('social-media/stats error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Stats load failed' });
  }
}

async function runScheduler(_req, res) {
  // Manual tick: useful for ops + tests. Anyone calling this just walks
  // the same queue the cron walks every minute, so it's safe to expose
  // behind app-level auth.
  try {
    await scheduler.runOnce();
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('social-media/runScheduler error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Scheduler tick failed' });
  }
}

function isAuthorizedCron(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return true;
  return (req.headers['authorization'] || '') === `Bearer ${secret}`;
}

// Vercel Cron hits this every minute. node-cron does not work on
// serverless (process dies between requests), so the in-memory cron
// is a no-op on Vercel and the real schedule lives in vercel.json.
async function cronPublishTick(req, res) {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  try {
    await scheduler.tick();
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('social-media/cronPublishTick error:', err);
    return res.status(500).json({ success: false, message: err.message || 'tick failed' });
  }
}

async function schedulerHealth(_req, res) {
  try {
    const now = await poll.query(`SELECT NOW() AS now`);
    const due = await poll.query(
      `SELECT id, user_email, status, scheduled_for,
              (scheduled_for - NOW()) AS until_due,
              (scheduled_for <= NOW()) AS is_due
         FROM tbl_social_posts
        WHERE status IN ('scheduled', 'publishing')
        ORDER BY scheduled_for ASC NULLS LAST
        LIMIT 5`
    );
    return res.status(200).json({
      success: true,
      server_now: (now[0] || now.rows?.[0])?.now || null,
      cron_secret_set: Boolean((process.env.CRON_SECRET || '').trim()),
      scheduler_env: process.env.SOCIAL_SCHEDULER || 'on',
      next_due: due || [],
    });
  } catch (err) {
    console.error('social-media/schedulerHealth error:', err);
    return res.status(500).json({ success: false, message: err.message || 'health failed' });
  }
}

module.exports = {
  generate, save, publishNow, library, stats, getPost, runScheduler,
  cronPublishTick, schedulerHealth,
};
