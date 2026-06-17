const service = require('./service');
const notionService = require('../notion/service');
const authService = require('../auth/service');
const fileService = require('../files/service');
const usageService = require('../usage/service');

const REQUIRED_FORM_FIELDS = [
  'product_name',
];

function safeBrandSlug(value) {
  return String(value || 'ecom-mockup')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ecom-mockup';
}

// Persist every generated mockup image (and any uploaded asset) to
// tbl_files so they show up in My Files alongside other branding work.
async function persistOutputs({ projectId, projectName, mockupsList, uploads, userEmail }) {
  const slug = safeBrandSlug(projectName);
  // Generated mockups
  if (Array.isArray(mockupsList)) {
    for (let i = 0; i < mockupsList.length; i += 1) {
      const m = mockupsList[i];
      if (!m?.url) continue;
      try {
        await fileService.recordFile({
          projectId,
          projectName,
          fileName: `${slug}-${m.id || `mockup-${i + 1}`}.png`,
          url: m.url,
          userEmail,
          category: 'Branding & Design',
          serviceType: 'ecommerce_mockups',
          source: 'generated',
          mimeType: m.content_type || 'image/png',
        });
      } catch (err) {
        console.error('[ecommerce-mockups] failed to record mockup file:', err.message || err);
      }
    }
  }
  // User uploads
  if (Array.isArray(uploads)) {
    for (const u of uploads) {
      if (!u?.url) continue;
      try {
        await fileService.recordFile({
          projectId,
          projectName,
          fileName: u.name || u.url.split('/').pop() || 'upload',
          url: u.url,
          userEmail,
          category: 'Branding & Design',
          serviceType: 'ecommerce_mockups',
          source: 'upload',
          mimeType: u.mime || null,
        });
      } catch (err) {
        console.error('[ecommerce-mockups] failed to record uploaded file:', err.message || err);
      }
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

    const result = await service.generateEcommerceMockups({
      form: enrichedForm,
      requestedModel: model,
    });

    const projectName = String(form.product_name).trim() || 'E-Commerce Mockups Request';

    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName,
        category: 'Branding & Design',
        serviceType: 'ecommerce_mockups',
        userEmail: userEmail || null,
        inputData: enrichedForm,
        outputData: result.mockups,
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist ecommerce-mockups project:', persistErr.message || persistErr);
    }

    const mockupsList = Array.isArray(result.mockups?.mockups) ? result.mockups.mockups : [];
    const uploads = []
      .concat(Array.isArray(form.product_uploads) ? form.product_uploads : [])
      .concat(Array.isArray(form.brand_assets) ? form.brand_assets : []);
    await persistOutputs({
      projectId,
      projectName,
      mockupsList,
      uploads,
      userEmail: userEmail || null,
    });

    // Roughly: 1 LLM call + 6 image generations. Charge by image count.
    const generatedCount = mockupsList.filter((m) => m?.url).length;
    usageService.recordUsage({
      userEmail: userEmail || null,
      kind: 'image',
      model: result.image_model || result.model,
      service: 'ecommerce_mockups',
      units: generatedCount,
      meta: { project_id: projectId },
    }).catch(() => { /* logged downstream */ });

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
    });
  } catch (err) {
    console.error('ecommerce-mockups/generate error:', err);
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
