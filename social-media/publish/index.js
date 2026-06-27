// Publisher orchestrator. Takes one tbl_social_posts row, generates any
// missing assets (Reels videos), loops the post's target platforms,
// calls the right per-platform publisher, records every attempt in
// tbl_social_post_runs, and flips the post to published or failed.

const { poll } = require('../../config/dbconfig');
const connectionsService = require('../../social-connections/service');
const higgsfield = require('../../helper/higgsfield_cli');
const s3 = require('../../helper/s3_storage');
const smService = require('../service');
const igPublisher = require('./instagram');
const fbPublisher = require('./facebook');
const ytPublisher = require('./youtube');

const PLATFORM_PUBLISHERS = {
  instagram: igPublisher.publish,
  facebook:  fbPublisher.publish,
  youtube:   ytPublisher.publish,
};

function safeSlug(value) {
  return String(value || 'social')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'social';
}

// ---------- Asset prep ----------

// For Reels we generate the actual video via Higgsfield at publish time
// (not at brief generation time) so drafts stay cheap. The output URL
// is persisted back to assets_json so subsequent re-publishes don't
// re-generate.
async function ensureReelsVideo(post) {
  const existingVideo = post.assets_json?.video_url;
  if (existingVideo) return existingVideo;

  const prompt = post.spec_json?.video_prompt;
  if (!prompt) throw new Error('Reels publish: spec is missing video_prompt');
  const duration = Math.max(15, Math.min(60, Number(post.spec_json?.duration_sec) || 30));
  const brandSlug = safeSlug(post.brief_json?.brand || post.brief_json?.brand_name);

  const result = await higgsfield.generateMarketingStudioVideo({
    prompt,
    mode: 'ugc',
    aspectRatio: '9:16',
    duration,
    resolution: '720p',
    generateAudio: true,
  });
  const cdnUrl = result?.video?.url || result?.url;
  if (!cdnUrl) throw new Error('Higgsfield returned no video URL');

  // Mirror to S3 so the URL we hand to Meta / YouTube stays valid past
  // Higgsfield's CDN expiry.
  let videoUrl = cdnUrl;
  if (s3.isConfigured()) {
    try {
      const uploaded = await s3.uploadFromUrl(cdnUrl, {
        prefix: `generated/social-media/${brandSlug}/reel`,
        originalName: `${brandSlug}-reel.mp4`,
      });
      videoUrl = uploaded.url;
    } catch (err) {
      console.error('[social-media] reels mirror failed, using Higgsfield URL:', err.message || err);
    }
  }

  // Persist back to assets_json.
  const nextAssets = { ...(post.assets_json || {}), video_url: videoUrl };
  await poll.query(
    `UPDATE tbl_social_posts SET assets_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [post.id, JSON.stringify(nextAssets)]
  );
  return videoUrl;
}

// For image posts (everything except reels) Instagram + Facebook both
// require a hosted image URL. The cover is normally generated at brief
// time and saved on assets.cover_url, but if the user re-generates or
// the cover failed earlier the field can be empty. Generate it inline
// from spec.cover_prompt and persist so re-publishes don't redo it.
async function ensureCoverImage(post) {
  const existing = post.assets_json?.cover_url;
  if (existing) return existing;

  const prompt = post.spec_json?.cover_prompt;
  if (!prompt) {
    throw new Error('Post has no cover image and no cover_prompt to generate one. Re-open the draft and regenerate.');
  }
  const brandSlug = safeSlug(post.brief_json?.brand || post.brief_json?.brand_name);
  const cover = await smService.generateCoverImage({
    type: post.content_type,
    prompt,
    brandSlug,
    brief: post.brief_json || {},
  });
  if (!cover?.url) throw new Error('Cover image generation returned no URL');

  const nextAssets = { ...(post.assets_json || {}), cover_url: cover.url, cover_content_type: cover.content_type || null };
  await poll.query(
    `UPDATE tbl_social_posts SET assets_json = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [post.id, JSON.stringify(nextAssets)]
  );
  return cover.url;
}

// ---------- DB helpers ----------

async function loadPost(postId) {
  const rows = await poll.query(
    `SELECT id, user_email, project_id, content_type, brief_json, spec_json,
            assets_json, caption, hashtags, platforms, status, scheduled_for,
            published_at, batch_parent_id, metrics_json
       FROM tbl_social_posts WHERE id = $1 LIMIT 1`,
    [postId]
  );
  return (rows || [])[0] || null;
}

async function recordRun({ postId, platform, state, platformPostId, errorCode, errorMessage }) {
  await poll.query(
    `INSERT INTO tbl_social_post_runs
        (post_id, platform, started_at, finished_at, state, platform_post_id, error_code, error_message)
      VALUES ($1, $2, NOW(), NOW(), $3, $4, $5, $6)`,
    [postId, platform, state, platformPostId || null, errorCode || null, errorMessage || null]
  );
}

async function markStatus(postId, status) {
  // Cast $2 explicitly so postgres doesn't deduce two different types
  // for the same parameter (status column is VARCHAR(16), the comparison
  // literal is TEXT). Without the cast pg throws 42P08 "inconsistent
  // types deduced for parameter $2".
  await poll.query(
    `UPDATE tbl_social_posts
        SET status = $2::varchar,
            published_at = CASE WHEN $2::varchar = 'published' THEN NOW() ELSE published_at END,
            updated_at = NOW()
      WHERE id = $1`,
    [postId, status]
  );
}

// ---------- Main entry ----------

async function publishPost({ postId }) {
  const post = await loadPost(postId);
  if (!post) throw Object.assign(new Error(`Post ${postId} not found`), { status: 404 });
  const platforms = String(post.platforms || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!platforms.length) {
    await markStatus(postId, 'failed');
    throw new Error('Post has no target platforms');
  }

  // Make sure the right asset exists before we touch any publishers.
  // Reels need a video, image posts (post / carousel / thumbnail /
  // profile) need a cover image URL. Both are generated/cached on the
  // post row so re-publishes don't re-run the upstream generators.
  let assets = { ...(post.assets_json || {}) };
  if (post.content_type === 'reel') {
    try {
      assets.video_url = await ensureReelsVideo(post);
    } catch (err) {
      console.error('[social-media] ensureReelsVideo failed:', err.message || err);
      await recordRun({
        postId,
        platform: 'reel_render',
        state: 'error',
        errorCode: 'video_render_failed',
        errorMessage: err.message,
      });
      await markStatus(postId, 'failed');
      return { ok: false, error: err.message };
    }
  } else if (platforms.some((p) => p === 'instagram' || p === 'facebook')) {
    // YouTube uses video only; IG + FB image posts both need cover_url.
    try {
      assets.cover_url = await ensureCoverImage(post);
    } catch (err) {
      console.error('[social-media] ensureCoverImage failed:', err.message || err);
      await recordRun({
        postId,
        platform: 'cover_render',
        state: 'error',
        errorCode: 'cover_render_failed',
        errorMessage: err.message,
      });
      await markStatus(postId, 'failed');
      return { ok: false, error: err.message };
    }
  }

  const results = [];
  for (const platform of platforms) {
    const publisher = PLATFORM_PUBLISHERS[platform];
    if (!publisher) {
      await recordRun({ postId, platform, state: 'error', errorCode: 'unknown_platform' });
      results.push({ platform, error: 'unknown_platform' });
      continue;
    }
    // Fan out to every connected account for this platform. If the
    // user has two Instagrams connected, the post goes to both. Each
    // attempt is recorded as its own run row so we can show per-account
    // outcomes in the UI.
    const connections = await connectionsService.getAllConnectionsWithTokens({
      userEmail: post.user_email,
      platform,
    });
    if (!connections.length) {
      await recordRun({ postId, platform, state: 'error', errorCode: 'not_connected' });
      results.push({ platform, error: 'not_connected' });
      continue;
    }
    for (const connection of connections) {
      try {
        const result = await publisher({ post, connection, assets });
        await recordRun({
          postId,
          platform,
          state: 'success',
          platformPostId: result.platform_post_id || null,
        });
        results.push({
          platform,
          connection_id: connection.id,
          account_handle: connection.account_handle,
          ...result,
        });
      } catch (err) {
        const apiErr = err?.response?.data?.error || {};
        console.error(`[social-media] ${platform} publish failed for connection ${connection.id}:`, apiErr.message || err.message);
        await recordRun({
          postId,
          platform,
          state: 'error',
          errorCode: apiErr.code ? String(apiErr.code) : (apiErr.type || 'publish_failed'),
          errorMessage: apiErr.message || err.message,
        });
        results.push({
          platform,
          connection_id: connection.id,
          account_handle: connection.account_handle,
          error: apiErr.message || err.message,
        });
      }
    }
  }

  const anySuccess = results.some((r) => !r.error);
  await markStatus(postId, anySuccess ? 'published' : 'failed');
  return { ok: anySuccess, results };
}

module.exports = { publishPost };
