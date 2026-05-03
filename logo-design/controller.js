const service = require('./service');
const notionService = require('../notion/service');
const fileService = require('../files/service');

const REQUIRED_FORM_FIELDS = ['brand_name', 'business_description'];

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
          images: result.images,
        },
        model: result.model,
      });
    } catch (persistErr) {
      console.error('Failed to persist logo-design project:', persistErr.message || persistErr);
    }

    // Mirror each generated image into tbl_files so it shows up in My Files.
    if (Array.isArray(result.images) && result.images.length) {
      try {
        await Promise.all(
          result.images.map((img, idx) =>
            fileService.recordFile({
              projectId,
              projectName,
              fileName: `${projectName}-concept-${idx + 1}.png`,
              url: img.url,
              userEmail: userEmail || null,
              category: 'Branding & Design',
              serviceType: 'logo_design',
              source: 'generated',
              mimeType: img.content_type || 'image/png',
            })
          )
        );
      } catch (fileErr) {
        console.error('Failed to persist generated logo files:', fileErr.message || fileErr);
      }
    }

    return res.status(200).json({
      success: true,
      project_id: projectId,
      ...result,
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
