const service = require('./service');
const notionService = require('../notion/service');
const fileService = require('../files/service');
const usageService = require('../usage/service');

const REQUIRED_FORM_FIELDS = [
  'package_type',
  'brand_name',
  'product_name',
];

async function persistUploads({ projectId, projectName, uploads, userEmail }) {
  if (!Array.isArray(uploads) || !uploads.length) return;
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
        serviceType: 'packaging_design',
        source: 'upload',
        mimeType: u.mime || null,
      });
    } catch (err) {
      console.error('[packaging-design] failed to record uploaded file:', err.message || err);
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

    const result = await service.generatePackagingDesign({
      form,
      requestedModel: model,
    });

    const projectName = String(form.product_name).trim() || String(form.brand_name).trim() || 'Packaging Design Request';

    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName,
        category: 'Branding & Design',
        serviceType: 'packaging_design',
        userEmail: userEmail || null,
        inputData: form,
        outputData: { brief: result.brief },
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist packaging-design project:', persistErr.message || persistErr);
    }

    const uploads = []
      .concat(Array.isArray(form.brand_assets) ? form.brand_assets : [])
      .concat(Array.isArray(form.reference_uploads) ? form.reference_uploads : []);
    await persistUploads({
      projectId,
      projectName,
      uploads,
      userEmail: userEmail || null,
    });

    usageService.recordUsage({
      userEmail: userEmail || null,
      kind: 'llm',
      model: result.model,
      service: 'packaging_design',
      units: 1,
      meta: { project_id: projectId },
    }).catch(() => { /* logged downstream */ });

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
    });
  } catch (err) {
    console.error('packaging-design/generate error:', err);
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
