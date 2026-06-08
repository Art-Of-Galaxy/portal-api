const service = require('./service');
const notionService = require('../notion/service');
const fileService = require('../files/service');
const usageService = require('../usage/service');
const s3 = require('../helper/s3_storage');

function safeBrandSlug(value) {
  return String(value || 'ugc-ad')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ugc-ad';
}

// Mirror the Higgsfield CDN video to S3 so the URL we persist stays
// valid after Higgsfield rotates its temporary asset URLs.
async function persistVideo({ video, brandSlug }) {
  if (!video?.url) return video;
  if (!s3.isConfigured()) return video;
  try {
    const uploaded = await s3.uploadFromUrl(video.url, {
      prefix: `generated/ugc-ads/${brandSlug}`,
      originalName: `${brandSlug}.mp4`,
    });
    return {
      ...video,
      url: uploaded.url,
      content_type: uploaded.contentType || video.content_type || 'video/mp4',
      original_url: video.url,
    };
  } catch (err) {
    console.error('[ugc-ads] failed to mirror video to S3, using Higgsfield URL:', err.message || err);
    return video;
  }
}

async function generate(req, res) {
  try {
    const { form, user_email: userEmail } = req.body || {};
    const result = await service.generateUgcAd({ form });

    const projectName = String(form.product_name).trim() || 'UGC Ads Request';
    const brandSlug = safeBrandSlug(projectName);

    const persistedVideo = await persistVideo({ video: result.video, brandSlug });

    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName,
        category: 'AI Video Production',
        serviceType: 'ugc_ads',
        userEmail: userEmail || null,
        inputData: form,
        outputData: {
          prompt: result.prompt,
          mode: result.mode,
          aspect_ratio: result.aspect_ratio,
          duration: result.duration,
          resolution: result.resolution,
          job_id: result.job_id,
          video: persistedVideo,
        },
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist ugc-ads project:', persistErr.message || persistErr);
    }

    if (persistedVideo?.url) {
      try {
        await fileService.recordFile({
          projectId,
          projectName,
          fileName: `${projectName}-ugc-ad.mp4`,
          url: persistedVideo.url,
          userEmail: userEmail || null,
          category: 'AI Video Production',
          serviceType: 'ugc_ads',
          source: 'generated',
          mimeType: persistedVideo.content_type || 'video/mp4',
        });
      } catch (fileErr) {
        console.error('Failed to persist ugc-ad file:', fileErr.message || fileErr);
      }
    }

    // Record usage. One video = one unit. The usage service maps this
    // to a credit cost via its rate table.
    usageService.recordUsage({
      userEmail: userEmail || null,
      kind: 'video',
      model: result.model,
      service: 'ugc_ads',
      units: 1,
      meta: { project_id: projectId, job_id: result.job_id, duration: result.duration },
    }).catch(() => { /* logged downstream */ });

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
      video: persistedVideo,
    });
  } catch (err) {
    console.error('ugc-ads/generate error:', err);
    const status = err.status || err.statusCode || 500;
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: err.message || 'Internal server error',
      // Pass the structured error code (set by the higgsfield helper)
      // so the frontend can render a specific banner, e.g.
      // not_enough_credits => offer a top-up link.
      error_code: err.errorCode || null,
      ...(err.higgsfield ? { higgsfield: err.higgsfield } : {}),
    });
  }
}

function listModes(_req, res) {
  return res.status(200).json({
    success: true,
    modes: service.ALLOWED_MODES,
    aspect_ratios: service.ALLOWED_ASPECT,
    resolutions: service.ALLOWED_RESOLUTION,
  });
}

module.exports = {
  generate,
  listModes,
};
