const service = require('./service');
const notionService = require('../notion/service');
const authService = require('../auth/service');

const REQUIRED_FORM_FIELDS = [
  'brand_name',
  'product_description',
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

    const clientContext = await authService.getServiceContextByEmail(userEmail);
    const enrichedForm = clientContext ? { ...form, client_profile_context: clientContext } : form;

    const result = await service.generateBrandGuidelines({
      form: enrichedForm,
      requestedModel: model,
    });

    // Persist as a project so it shows up in My Projects under the right category.
    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName: String(form.brand_name).trim() || 'Brand Guidelines Request',
        category: 'Branding & Design',
        serviceType: 'brand_guidelines',
        userEmail: userEmail || null,
        inputData: enrichedForm,
        outputData: result.guidelines,
        model: result.model,
      });
    } catch (persistErr) {
      // Non-fatal — we still return the AI output, but flag the persistence failure.
      console.error('Failed to persist brand-guidelines project:', persistErr.message || persistErr);
    }

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
