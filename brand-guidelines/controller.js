const service = require('./service');
const notionService = require('../notion/service');
const authService = require('../auth/service');
const fileService = require('../files/service');
const usageService = require('../usage/service');

const REQUIRED_FORM_FIELDS = [
  'brand_name',
  'product_description',
];

function safeBrandSlug(value) {
  return String(value || 'brand')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'brand';
}

// Persist every deliverable (HTML doc URLs + image-pack image URLs) so they
// show up in My Files exactly the way logo-design and ugc-ads outputs do.
async function persistDeliverables({ projectId, projectName, deliverables, userEmail }) {
  if (!Array.isArray(deliverables) || !deliverables.length) return;
  const slug = safeBrandSlug(projectName);
  for (const d of deliverables) {
    try {
      if (d.kind === 'document' && d.url) {
        await fileService.recordFile({
          projectId,
          projectName,
          fileName: `${slug}-${d.id}.html`,
          url: d.url,
          userEmail,
          category: 'Branding & Design',
          serviceType: 'brand_guidelines',
          source: 'generated',
          mimeType: 'text/html',
        });
      } else if (d.kind === 'image_pack' && Array.isArray(d.images)) {
        for (let i = 0; i < d.images.length; i += 1) {
          const img = d.images[i];
          if (!img?.url) continue;
          await fileService.recordFile({
            projectId,
            projectName,
            fileName: `${slug}-${d.id}-${i + 1}.png`,
            url: img.url,
            userEmail,
            category: 'Branding & Design',
            serviceType: 'brand_guidelines',
            source: 'generated',
            mimeType: img.content_type || 'image/png',
          });
        }
      }
    } catch (err) {
      console.error(`[brand-guidelines] failed to record file for ${d.id}:`, err.message || err);
    }
  }
}

async function generate(req, res) {
  try {
    const { form, model, user_email: userEmail } = req.body || {};

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

    const clientContext = await authService.getServiceContextByEmail(userEmail);
    const enrichedForm = clientContext ? { ...form, client_profile_context: clientContext } : form;

    const result = await service.generateBrandGuidelines({
      form: enrichedForm,
      requestedModel: model,
    });

    const projectName = String(form.brand_name).trim() || 'Brand Guidelines Request';

    // Persist as a project so it shows up in My Projects under the right category.
    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName,
        category: 'Branding & Design',
        serviceType: 'brand_guidelines',
        userEmail: userEmail || null,
        inputData: enrichedForm,
        outputData: {
          guidelines: result.guidelines,
          deliverables: result.deliverables,
          logo_prompt: result.logo_prompt,
          social_prompts: result.social_prompts,
        },
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist brand-guidelines project:', persistErr.message || persistErr);
    }

    // Persist each deliverable to tbl_files so they're reachable from My Files.
    await persistDeliverables({
      projectId,
      projectName,
      deliverables: result.deliverables,
      userEmail: userEmail || null,
    });

    // Best-effort usage recording. Roughly: 1 LLM call + 8 images (4 logo + 4 social).
    usageService.recordUsage({
      userEmail: userEmail || null,
      kind: 'image',
      model: result.model,
      service: 'brand_guidelines',
      units: (result.logo_images?.length || 0) + (result.social_images?.length || 0),
      meta: { project_id: projectId, source: 'brand_guidelines' },
    }).catch(() => { /* logged downstream */ });

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
    });
  } catch (err) {
    console.error('brand-guidelines/generate error:', err);
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
