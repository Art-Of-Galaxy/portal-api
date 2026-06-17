// Publish to a Facebook Page via the Pages API.
//
// - Image post: POST /{page-id}/photos with url + message
// - Reels:      POST /{page-id}/video_reels (start) + upload + publish

const axios = require('axios');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function captionWithBullets({ caption, hashtags, slides }) {
  const parts = [];
  if (caption) parts.push(caption);
  if (Array.isArray(slides) && slides.length) {
    parts.push(slides.map((s, i) => `${i + 1}. ${s.headline}${s.body ? ` ${s.body}` : ''}`).join('\n'));
  }
  if (Array.isArray(hashtags) && hashtags.length) {
    parts.push(hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '));
  }
  return parts.join('\n\n');
}

async function publishImage({ pageId, pageToken, imageUrl, message }) {
  const url = `${GRAPH_BASE}/${pageId}/photos`;
  const res = await axios.post(url, null, {
    params: { url: imageUrl, message, published: 'true', access_token: pageToken },
  });
  return { id: res.data?.id, post_id: res.data?.post_id || res.data?.id };
}

// Reels API requires a 2-step flow (init + finish). For v1 we use the
// simpler "video by URL" path on /videos which Meta accepts for Pages
// and shows up in the feed, but with no Reels-tab placement. Real Reels
// publishing on FB requires resumable upload; we'll add it in v2.
async function publishVideo({ pageId, pageToken, videoUrl, message }) {
  const url = `${GRAPH_BASE}/${pageId}/videos`;
  const res = await axios.post(url, null, {
    params: { file_url: videoUrl, description: message, access_token: pageToken },
  });
  return { id: res.data?.id, post_id: res.data?.id };
}

async function publish({ post, connection, assets }) {
  if (connection?.platform !== 'facebook') {
    throw new Error('publish/facebook called with non-facebook connection');
  }
  const pageToken = connection.access_token;
  const pageId = connection.account_id;
  if (!pageToken || !pageId) throw new Error('Facebook connection is missing access_token or account_id');

  const message = captionWithBullets({
    caption: post.caption,
    hashtags: typeof post.hashtags === 'string' ? post.hashtags.split(/[\s,]+/).filter(Boolean) : post.hashtags,
    slides: post.spec?.slides,
  });

  let resp;
  if (post.content_type === 'reel') {
    if (!assets?.video_url) throw new Error('Reel publish requires a video_url');
    resp = await publishVideo({ pageId, pageToken, videoUrl: assets.video_url, message });
  } else {
    if (!assets?.cover_url) throw new Error('Facebook publish requires a cover_url');
    resp = await publishImage({ pageId, pageToken, imageUrl: assets.cover_url, message });
  }

  return {
    platform: 'facebook',
    platform_post_id: resp.post_id || resp.id,
    permalink: null,
  };
}

module.exports = { publish };
