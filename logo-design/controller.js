const service = require('./service');
const notionService = require('../notion/service');
const fileService = require('../files/service');
const s3 = require('../helper/s3_storage');

const REQUIRED_FORM_FIELDS = ['brand_name', 'business_description'];

function safeBrandSlug(value) {
  return String(value || 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'logo';
}

function inferExtensionFromContentType(contentType, fallbackUrl) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/gif': 'gif',
  };
  if (map[ct]) return map[ct];
  if (ct.includes('/')) {
    const tail = ct.split('/')[1].split('+')[0].replace(/[^a-z0-9]/g, '');
    if (tail) return tail === 'jpeg' ? 'jpg' : tail;
  }
  if (typeof fallbackUrl === 'string') {
    const m = fallbackUrl.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m) return m[1].toLowerCase();
  }
  return 'png';
}

// Mirror fal.ai's temporary CDN URLs to S3 so the generated assets persist
// long after the fal URL expires. Returns a new images[] with the persistent
// URL when S3 is configured, otherwise returns the originals untouched.
async function persistGeneratedImages({ images, brandSlug }) {
  if (!Array.isArray(images) || !images.length) return images || [];
  if (!s3.isConfigured()) return images;

  const persisted = await Promise.all(
    images.map(async (img, idx) => {
      try {
        const ext = inferExtensionFromContentType(img.content_type, img.url);
        const original = `${brandSlug}-concept-${idx + 1}.${ext}`;
        const uploaded = await s3.uploadFromUrl(img.url, {
          prefix: `generated/logo-design/${brandSlug}`,
          originalName: original,
        });
        return {
          ...img,
          url: uploaded.url,
          content_type: uploaded.contentType || img.content_type || null,
          original_url: img.url,
        };
      } catch (mirrorErr) {
        console.error(
          `[logo-design] failed to mirror image ${idx + 1} to S3, falling back to fal URL:`,
          mirrorErr.message || mirrorErr
        );
        return img;
      }
    })
  );
  return persisted;
}

async function generate(req, res) {
  try {
    const { form, model, num_images: numImages, user_email: userEmail } = req.body || {};

    if (!form || typeof form !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'Missing "form" object in request body.',
      });
    }

    const missing = REQUIRED_FORM_FIELDS.filter((k) => {
      const v = form[k];
      return v === undefined || v === null || String(v).trim() === '';
    });
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    const result = await service.generateLogoDesign({
      form,
      requestedModel: model,
      numImages,
    });

    const projectName = String(form.brand_name).trim() || 'Logo Design Request';
    const brandSlug = safeBrandSlug(projectName);

    // Mirror to S3 first so the URLs we persist are the long-lived ones.
    const persistedImages = await persistGeneratedImages({
      images: result.images,
      brandSlug,
    });

    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName,
        category: 'Branding & Design',
        serviceType: 'logo_design',
        userEmail: userEmail || null,
        inputData: form,
        outputData: {
          prompt: result.prompt,
          seed: result.seed,
          images: persistedImages,
        },
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist logo-design project:', persistErr.message || persistErr);
    }

    // Mirror each generated image into tbl_files so it shows up in My Files.
    if (Array.isArray(persistedImages) && persistedImages.length) {
      try {
        await Promise.all(
          persistedImages.map((img, idx) => {
            const ext = inferExtensionFromContentType(img.content_type, img.url);
            return fileService.recordFile({
              projectId,
              projectName,
              fileName: `${projectName}-concept-${idx + 1}.${ext}`,
              url: img.url,
              userEmail: userEmail || null,
              category: 'Branding & Design',
              serviceType: 'logo_design',
              source: 'generated',
              mimeType: img.content_type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            });
          })
        );
      } catch (fileErr) {
        console.error('Failed to persist generated logo files:', fileErr.message || fileErr);
      }
    }

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
      images: persistedImages,
    });
  } catch (err) {
    console.error('logo-design/generate error:', err);
    const status = err.status || err.statusCode || 500;
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: err.message || 'Internal server error',
    });
  }
}

function listModels(_req, res) {
  return res.status(200).json({
    success: true,
    default_model: service.DEFAULT_MODEL,
    models: service.ALLOWED_MODELS,
  });
}

module.exports = {
  generate,
  listModels,
};
