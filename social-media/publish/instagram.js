// Publish to Instagram Business via the Instagram Graph API.
//
// Two paths:
//   - IMAGE post   : create media container → publish
//   - REELS        : create media container with video_url, poll until
//                    FINISHED, publish.
// Multi-slide carousels are NOT yet wired in v1; we publish the cover
// image and fold the slide bullets into the caption instead.

const axios = require('axios');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function captionWithBullets({ caption, hashtags, slides }) {
  const parts = [];
  if (caption) parts.push(caption);
  if (Array.isArray(slides) && slides.length) {
    const bullets = slides
      .map((s, i) => `${i + 1}/ ${s.headline}${s.body ? ` — ${s.body}` : ''}`.replace(/—/g, ',').replace(/--/g, ','))
      .join('\n');
    parts.push(bullets);
  }
  if (Array.isArray(hashtags) && hashtags.length) {
    parts.push(hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '));
  }
  return parts.join('\n\n');
}

async function createImageContainer({ igUserId, accessToken, imageUrl, caption }) {
  const url = `${GRAPH_BASE}/${igUserId}/media`;
  const res = await axios.post(url, null, {
    params: { image_url: imageUrl, caption, access_token: accessToken },
  });
  return res.data?.id;
}

async function createReelsContainer({ igUserId, accessToken, videoUrl, caption }) {
  const url = `${GRAPH_BASE}/${igUserId}/media`;
  const res = await axios.post(url, null, {
    params: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: 'true',
      access_token: accessToken,
    },
  });
  return res.data?.id;
}

// Reels containers need polling because Meta processes the video
// asynchronously. We poll up to ~3 minutes; longer = caller can retry.
async function waitForContainerReady({ containerId, accessToken, intervalMs = 5000, timeoutMs = 3 * 60 * 1000 }) {
  const url = `${GRAPH_BASE}/${containerId}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await axios.get(url, { params: { fields: 'status_code,status', access_token: accessToken } });
    const code = res.data?.status_code;
    if (code === 'FINISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Instagram container ${containerId} ended in state ${code}: ${res.data?.status || ''}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Instagram container ${containerId} did not finish in time.`);
}

async function publishContainer({ igUserId, accessToken, containerId }) {
  const url = `${GRAPH_BASE}/${igUserId}/media_publish`;
  const res = await axios.post(url, null, {
    params: { creation_id: containerId, access_token: accessToken },
  });
  return res.data?.id;
}

// Connection.meta.linked_page_id is what the Pages OAuth callback stored.
// We use the Page's access token (connection.access_token) to publish to
// the linked IG account (connection.account_id is the ig-user-id).
async function publish({ post, connection, assets }) {
  if (connection?.platform !== 'instagram') {
    throw new Error('publish/instagram called with non-instagram connection');
  }
  const accessToken = connection.access_token;
  const igUserId = connection.account_id;
  if (!accessToken || !igUserId) throw new Error('Instagram connection is missing access_token or account_id');

  const caption = captionWithBullets({
    caption: post.caption,
    hashtags: typeof post.hashtags === 'string' ? post.hashtags.split(/[\s,]+/).filter(Boolean) : post.hashtags,
    slides: post.spec?.slides,
  });

  let containerId;
  if (post.content_type === 'reel') {
    if (!assets?.video_url) throw new Error('Reel publish requires a video_url');
    containerId = await createReelsContainer({ igUserId, accessToken, videoUrl: assets.video_url, caption });
    await waitForContainerReady({ containerId, accessToken });
  } else {
    if (!assets?.cover_url) throw new Error('Instagram publish requires a cover_url');
    containerId = await createImageContainer({ igUserId, accessToken, imageUrl: assets.cover_url, caption });
  }
  const mediaId = await publishContainer({ igUserId, accessToken, containerId });
  return {
    platform: 'instagram',
    platform_post_id: mediaId,
    permalink: null, // could fetch with /{id}?fields=permalink
  };
}

module.exports = { publish };
