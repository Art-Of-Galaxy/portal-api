const service = require('./service');
const notionService = require('../notion/service');

const REQUIRED_FORM_FIELDS = [
  'current_brand_name',
  'whats_not_working',
];

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

    const result = await service.generateRebranding({
      form,
      requestedModel: model,
    });

    // Persist as a project under Branding & Design / rebranding.
    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName: String(form.current_brand_name).trim() || 'Rebranding Request',
        category: 'Branding & Design',
        serviceType: 'rebranding',
        userEmail: userEmail || null,
        inputData: form,
        outputData: result.rebranding,
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist rebranding project:', persistErr.message || persistErr);
    }

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
    });
  } catch (err) {
    console.error('rebranding/generate error:', err);
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
