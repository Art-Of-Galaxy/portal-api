// REST endpoints for the Blog Engine.
//
// Article CRUD + generation:
//   POST   /api/blog-engine/generate      generate spec + image (preview)
//   POST   /api/blog-engine/save          save / update an article row
//   POST   /api/blog-engine/bulk          bulk-create one article per keyword
//   POST   /api/blog-engine/:id/publish   publish now
//   GET    /api/blog-engine/library       list articles (filter by status)
//   GET    /api/blog-engine/stats         dashboard stats
//   GET    /api/blog-engine/articles/:id  single fetch (for re-edit)
//
// Autopilot:
//   POST   /api/blog-engine/autopilot          create/update
//   GET    /api/blog-engine/autopilot          list mine
//   PATCH  /api/blog-engine/autopilot/:id      pause/resume/edit
//   DELETE /api/blog-engine/autopilot/:id      remove
//
// Ops:
//   POST   /api/blog-engine/run-scheduler      manual tick

const { poll } = require('../config/dbconfig');
const service = require('./service');
const publisher = require('./publisher');
const autopilot = require('./autopilot');
const scheduler = require('./scheduler');

function getUserEmail(req) {
  return (
    req.headers['x-user-email']
    || req.body?.user_email
    || req.query?.user_email
    || ''
  ).toString().trim().toLowerCase();
}

// ---------- generation + save ----------

async function generate(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const { brief, model } = req.body || {};
    const result = await service.generateArticle({ brief, requestedModel: model });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('blog-engine/generate error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Generation failed' });
  }
}

function tagsToString(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t || '').trim()).filter(Boolean).join(',');
  return String(tags || '').trim();
}

async function save(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const {
      id, shop_connection_id, mode = 'single', keyword,
      brief, spec, featured, body_html,
      title, handle, meta_title, meta_description, tags,
      seo_score, word_count,
      status = 'draft', scheduled_for, target_blog_id, target_blog_title,
    } = req.body || {};

    const assetsJson = (featured || body_html) ? { featured: featured || null, body_html: body_html || '' } : null;
    const specJson = spec ? { ...spec, target_blog_id: target_blog_id || null, target_blog_title: target_blog_title || null } : null;
    const briefJson = brief || null;
    const allowedStatus = new Set(['draft', 'scheduled', 'published', 'failed']);
    const safeStatus = allowedStatus.has(status) ? status : 'draft';

    if (id) {
      const r = await poll.query(
        `UPDATE tbl_blog_articles
            SET shop_connection_id = COALESCE($2, shop_connection_id),
                mode               = COALESCE($3, mode),
                keyword            = COALESCE($4, keyword),
                brief_json         = COALESCE($5::jsonb, brief_json),
                spec_json          = COALESCE($6::jsonb, spec_json),
                assets_json        = COALESCE($7::jsonb, assets_json),
                title              = COALESCE($8, title),
                handle             = COALESCE($9, handle),
                meta_title         = COALESCE($10, meta_title),
                meta_description   = COALESCE($11, meta_description),
                tags               = COALESCE($12, tags),
                seo_score          = COALESCE($13, seo_score),
                word_count         = COALESCE($14, word_count),
                status             = COALESCE($15, status),
                scheduled_for      = $16,
                updated_at         = NOW()
          WHERE id = $1 AND user_email = $17
          RETURNING id, status`,
        [
          id,
          shop_connection_id || null,
          mode || null, keyword || null,
          briefJson ? JSON.stringify(briefJson) : null,
          specJson ? JSON.stringify(specJson) : null,
          assetsJson ? JSON.stringify(assetsJson) : null,
          title || null, handle || null,
          meta_title || null, meta_description || null,
          tagsToString(tags) || null,
          Number.isInteger(seo_score) ? seo_score : null,
          Number.isInteger(word_count) ? word_count : null,
          safeStatus, scheduled_for || null,
          userEmail,
        ]
      );
      const row = r?.rows?.[0];
      if (!row) return res.status(404).json({ success: false, message: 'Article not found' });
      return res.status(200).json({ success: true, article_id: row.id, status: row.status });
    }

    const r = await poll.query(
      `INSERT INTO tbl_blog_articles
          (user_email, shop_connection_id, mode, keyword, brief_json, spec_json,
           assets_json, title, handle, meta_title, meta_description, tags,
           seo_score, word_count, status, scheduled_for)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
                $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id, status`,
      [
        userEmail, shop_connection_id || null, mode, keyword || null,
        briefJson ? JSON.stringify(briefJson) : null,
        specJson ? JSON.stringify(specJson) : null,
        assetsJson ? JSON.stringify(assetsJson) : null,
        title || null, handle || null,
        meta_title || null, meta_description || null,
        tagsToString(tags) || null,
        Number.isInteger(seo_score) ? seo_score : null,
        Number.isInteger(word_count) ? word_count : null,
        safeStatus, scheduled_for || null,
      ]
    );
    return res.status(200).json({ success: true, article_id: r?.rows?.[0]?.id, status: r?.rows?.[0]?.status });
  } catch (err) {
    console.error('blog-engine/save error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Save failed' });
  }
}

// Generate one article per keyword. Used by the "Bulk from Keywords"
// mode AND by the "Topic Cluster" mode (which is bulk + a pillar tag).
async function bulk(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const { keywords, brief = {}, shop_connection_id, scheduled_for, target_blog_id, mode = 'bulk' } = req.body || {};
    const list = Array.isArray(keywords) ? keywords : String(keywords || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return res.status(400).json({ success: false, message: 'No keywords provided' });

    const created = [];
    for (const keyword of list.slice(0, 25)) {  // hard cap to protect quotas
      try {
        // eslint-disable-next-line no-await-in-loop
        const generated = await service.generateArticle({
          brief: { ...brief, keyword },
        });
        const spec = generated.spec || {};
        // eslint-disable-next-line no-await-in-loop
        const r = await poll.query(
          `INSERT INTO tbl_blog_articles
              (user_email, shop_connection_id, mode, keyword, brief_json, spec_json,
               assets_json, title, handle, meta_title, meta_description, tags,
               seo_score, word_count, status, scheduled_for)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
                    $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id`,
          [
            userEmail, shop_connection_id || null, mode, keyword,
            JSON.stringify({ ...brief, keyword }),
            JSON.stringify({ ...spec, target_blog_id: target_blog_id || null }),
            JSON.stringify({ featured: generated.featured || null, body_html: generated.body_html || '' }),
            spec.title || keyword, spec.handle || null,
            spec.meta_title || null, spec.meta_description || null,
            Array.isArray(spec.tags) ? spec.tags.join(',') : null,
            Number.isInteger(spec.seo_score) ? spec.seo_score : null,
            Number.isInteger(spec.word_count) ? spec.word_count : null,
            scheduled_for ? 'scheduled' : 'draft',
            scheduled_for || null,
          ]
        );
        created.push({ keyword, id: r?.rows?.[0]?.id });
      } catch (err) {
        console.error(`[blog-engine] bulk gen "${keyword}" failed:`, err.message || err);
        created.push({ keyword, error: err.message });
      }
    }
    return res.status(200).json({ success: true, created });
  } catch (err) {
    console.error('blog-engine/bulk error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Bulk failed' });
  }
}

async function publishNow(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid article id' });
    const rows = await poll.query(`SELECT id FROM tbl_blog_articles WHERE id = $1 AND user_email = $2 LIMIT 1`, [id, userEmail]);
    if (!rows?.length) return res.status(404).json({ success: false, message: 'Article not found' });
    const result = await publisher.publishArticle({ articleId: id, publishImmediately: true });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('blog-engine/publishNow error:', err);
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Publish failed' });
  }
}

async function getArticle(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const rows = await poll.query(
      `SELECT id, shop_connection_id, autopilot_id, mode, keyword, brief_json, spec_json,
              assets_json, title, handle, meta_title, meta_description, tags,
              seo_score, word_count, status, scheduled_for, published_at,
              shopify_article_id, shopify_blog_id, shopify_url, error_code, error_message,
              created_at, updated_at
         FROM tbl_blog_articles WHERE id = $1 AND user_email = $2 LIMIT 1`,
      [id, userEmail]
    );
    const r = (rows || [])[0];
    if (!r) return res.status(404).json({ success: false, message: 'Article not found' });
    return res.status(200).json({ success: true, article: {
      id: r.id, shop_connection_id: r.shop_connection_id, autopilot_id: r.autopilot_id,
      mode: r.mode, keyword: r.keyword,
      brief: r.brief_json || {}, spec: r.spec_json || {}, assets: r.assets_json || {},
      title: r.title, handle: r.handle, meta_title: r.meta_title, meta_description: r.meta_description,
      tags: typeof r.tags === 'string' ? r.tags.split(',').filter(Boolean) : (r.tags || []),
      seo_score: r.seo_score, word_count: r.word_count,
      status: r.status, scheduled_for: r.scheduled_for, published_at: r.published_at,
      shopify_article_id: r.shopify_article_id, shopify_blog_id: r.shopify_blog_id, shopify_url: r.shopify_url,
      error_code: r.error_code, error_message: r.error_message,
      created_at: r.created_at, updated_at: r.updated_at,
    } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Load failed' });
  }
}

async function library(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const filter = String(req.query.filter || 'all').toLowerCase();
    const where = ['user_email = $1'];
    const params = [userEmail];
    if (['draft', 'scheduled', 'published', 'failed'].includes(filter)) {
      params.push(filter);
      where.push(`status = $${params.length}`);
    }
    const rows = await poll.query(
      `SELECT id, shop_connection_id, mode, keyword, title, handle, tags,
              seo_score, word_count, status, scheduled_for, published_at,
              shopify_url, assets_json, created_at, updated_at
         FROM tbl_blog_articles
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(scheduled_for, published_at, updated_at) DESC
        LIMIT 80`,
      params
    );
    const articles = (rows || []).map((r) => ({
      id: r.id,
      shop_connection_id: r.shop_connection_id,
      mode: r.mode,
      keyword: r.keyword,
      title: r.title,
      handle: r.handle,
      tags: typeof r.tags === 'string' ? r.tags.split(',').filter(Boolean) : [],
      seo_score: r.seo_score,
      word_count: r.word_count,
      status: r.status,
      scheduled_for: r.scheduled_for,
      published_at: r.published_at,
      shopify_url: r.shopify_url,
      featured_url: r.assets_json?.featured?.url || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    return res.status(200).json({ success: true, articles });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Library load failed' });
  }
}

async function stats(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const rows = await poll.query(
      `SELECT
         SUM(CASE WHEN status = 'published' AND published_at >= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END)::int AS published_30d,
         SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END)::int                                                AS queued,
         AVG(CASE WHEN status = 'published' THEN seo_score END)::int                                              AS avg_seo,
         SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END)::int                                                    AS drafts
       FROM tbl_blog_articles WHERE user_email = $1`,
      [userEmail]
    );
    const r = (rows || [])[0] || {};
    return res.status(200).json({
      success: true,
      stats: {
        published_30d: Number(r.published_30d || 0),
        queued: Number(r.queued || 0),
        avg_seo: Number(r.avg_seo || 0),
        drafts: Number(r.drafts || 0),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Stats load failed' });
  }
}

// ---------- autopilot ----------

async function createOrUpdateAutopilot(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const {
      id, shop_connection_id, blog_id, blog_title,
      keywords, cadence, publish_time = '08:00',
      voice, intent = 'informational', length = 'standard',
      queue_depth = 5, status = 'active', timezone = 'UTC',
    } = req.body || {};
    if (!shop_connection_id) return res.status(400).json({ success: false, message: 'shop_connection_id is required' });
    const list = Array.isArray(keywords) ? keywords : String(keywords || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return res.status(400).json({ success: false, message: 'At least one keyword is required' });
    if (!cadence) return res.status(400).json({ success: false, message: 'cadence is required' });

    if (id) {
      const r = await poll.query(
        `UPDATE tbl_blog_autopilots
            SET shop_connection_id = $2, blog_id = $3, blog_title = $4,
                keywords_json = $5::jsonb, cadence = $6, publish_time = $7,
                voice_json = $8::jsonb, intent = $9, length = $10,
                queue_depth = $11, status = $12, timezone = $13, updated_at = NOW()
          WHERE id = $1 AND user_email = $14
          RETURNING id, status`,
        [
          id, shop_connection_id, blog_id || null, blog_title || null,
          JSON.stringify(list), cadence, publish_time,
          voice ? JSON.stringify(voice) : null, intent, length,
          Number(queue_depth) || 5, status, timezone, userEmail,
        ]
      );
      const row = r?.rows?.[0];
      if (!row) return res.status(404).json({ success: false, message: 'Autopilot not found' });
      return res.status(200).json({ success: true, autopilot_id: row.id, status: row.status });
    }

    const r = await poll.query(
      `INSERT INTO tbl_blog_autopilots
          (user_email, shop_connection_id, blog_id, blog_title, keywords_json,
           cadence, publish_time, voice_json, intent, length, queue_depth, status, timezone)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
        RETURNING id`,
      [
        userEmail, shop_connection_id, blog_id || null, blog_title || null,
        JSON.stringify(list), cadence, publish_time,
        voice ? JSON.stringify(voice) : null, intent, length,
        Number(queue_depth) || 5, status, timezone,
      ]
    );
    // Trigger an immediate first draft so the user sees movement.
    const autopilotId = r?.rows?.[0]?.id;
    if (autopilotId) {
      try {
        const auto = (await poll.query(
          `SELECT id, user_email, shop_connection_id, blog_id, blog_title,
                  keywords_json, cadence, publish_time, voice_json, intent, length,
                  queue_depth, next_publish_at FROM tbl_blog_autopilots WHERE id = $1`,
          [autopilotId]
        ))?.[0];
        if (auto) {
          // Fire-and-forget initial draft so the POST returns fast.
          autopilot.tickAutopilot(auto).catch((err) => {
            console.error('[blog-engine] initial autopilot tick failed:', err.message || err);
          });
        }
      } catch (err) {
        console.warn('[blog-engine] could not seed autopilot draft:', err.message || err);
      }
    }
    return res.status(200).json({ success: true, autopilot_id: autopilotId });
  } catch (err) {
    console.error('blog-engine/createOrUpdateAutopilot error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Autopilot save failed' });
  }
}

async function listAutopilots(req, res) {
  try {
    const userEmail = getUserEmail(req);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    const rows = await poll.query(
      `SELECT id, shop_connection_id, blog_id, blog_title, keywords_json,
              cadence, publish_time, voice_json, intent, length, queue_depth,
              status, next_publish_at, last_drafted_at, published_count, created_at
         FROM tbl_blog_autopilots WHERE user_email = $1 ORDER BY created_at DESC`,
      [userEmail]
    );
    const autopilots = (rows || []).map((r) => ({
      ...r,
      keywords: Array.isArray(r.keywords_json) ? r.keywords_json : [],
      voice: r.voice_json || null,
    }));
    return res.status(200).json({ success: true, autopilots });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'List failed' });
  }
}

async function patchAutopilot(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    const { status, cadence, publish_time, queue_depth, keywords } = req.body || {};
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    const fields = ['updated_at = NOW()'];
    const params = [id, userEmail];
    if (status !== undefined)       { params.push(status);       fields.push(`status = $${params.length}`); }
    if (cadence !== undefined)      { params.push(cadence);      fields.push(`cadence = $${params.length}`); }
    if (publish_time !== undefined) { params.push(publish_time); fields.push(`publish_time = $${params.length}`); }
    if (queue_depth !== undefined)  { params.push(Number(queue_depth) || 5); fields.push(`queue_depth = $${params.length}`); }
    if (keywords !== undefined) {
      const list = Array.isArray(keywords) ? keywords : String(keywords || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      params.push(JSON.stringify(list));
      fields.push(`keywords_json = $${params.length}::jsonb`);
    }
    await poll.query(
      `UPDATE tbl_blog_autopilots SET ${fields.join(', ')} WHERE id = $1 AND user_email = $2`,
      params
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Update failed' });
  }
}

async function destroyAutopilot(req, res) {
  try {
    const userEmail = getUserEmail(req);
    const id = Number(req.params.id);
    if (!userEmail) return res.status(400).json({ success: false, message: 'user_email is required' });
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id' });
    await poll.query(
      `UPDATE tbl_blog_autopilots SET status = 'archived', updated_at = NOW() WHERE id = $1 AND user_email = $2`,
      [id, userEmail]
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Delete failed' });
  }
}

async function runScheduler(_req, res) {
  try {
    await scheduler.runOnce();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Scheduler tick failed' });
  }
}

module.exports = {
  generate, save, bulk, publishNow, getArticle, library, stats,
  createOrUpdateAutopilot, listAutopilots, patchAutopilot, destroyAutopilot,
  runScheduler,
};
