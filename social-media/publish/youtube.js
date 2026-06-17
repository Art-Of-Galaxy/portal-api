// Publish to YouTube as a Short.
//
// YouTube requires the actual video bytes uploaded via a resumable
// session; we cannot just hand it a URL. We stream the source file
// (Higgsfield output mirrored to S3) into youtube.videos.insert.
//
// All Shorts include "#shorts" in the title or description so YouTube
// surfaces them in the Shorts shelf.

const { google } = require('googleapis');
const oauthGoogle = require('../../social-connections/oauth_google');

async function fetchVideoStream(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video from ${url} (HTTP ${res.status})`);
  return res.body; // Web ReadableStream; googleapis accepts this on Node 18+
}

async function publish({ post, connection, assets }) {
  if (connection?.platform !== 'youtube') {
    throw new Error('publish/youtube called with non-youtube connection');
  }
  if (post.content_type !== 'reel') {
    // For v1 we only support uploading videos to YouTube. Image-only
    // content types are skipped on this platform.
    return { platform: 'youtube', skipped: 'youtube_supports_video_only' };
  }
  if (!assets?.video_url) throw new Error('YouTube publish requires a video_url');

  // Refresh the access token if we have a refresh token. Google access
  // tokens last ~1 hour, so most scheduled posts need this.
  let accessToken = connection.access_token;
  if (connection.refresh_token) {
    try {
      const refreshed = await oauthGoogle.refreshAccessToken(connection.refresh_token);
      if (refreshed?.access_token) accessToken = refreshed.access_token;
    } catch (err) {
      console.warn('[youtube] refresh token failed:', err.message || err);
    }
  }

  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  const yt = google.youtube({ version: 'v3', auth: oauth2 });

  // Compose a Shorts-friendly title and description.
  const hookOrHeadline = post.spec?.hook || post.spec?.headline || 'New from us';
  const baseTitle = String(hookOrHeadline).replace(/\n/g, ' ').slice(0, 90);
  const title = `${baseTitle} #shorts`;
  const description = [
    post.caption || '',
    Array.isArray(post.hashtags) ? post.hashtags.join(' ') : (post.hashtags || ''),
    '#shorts',
  ].filter(Boolean).join('\n\n').slice(0, 4500);

  const body = await fetchVideoStream(assets.video_url);

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, categoryId: '22' /* People & Blogs */ },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    },
    media: { body },
  });

  return {
    platform: 'youtube',
    platform_post_id: res.data?.id,
    permalink: res.data?.id ? `https://youtube.com/shorts/${res.data.id}` : null,
  };
}

module.exports = { publish };
