const archiver = require('archiver');
const service = require('./service');
const notionService = require('../notion/service');
const authService = require('../auth/service');
const fileService = require('../files/service');
const usageService = require('../usage/service');

// Allow image URLs ONLY from hosts we generate to (our S3 bucket + the
// fal.ai CDN families). Prevents the zip endpoint from being abused as
// an open HTTP proxy / SSRF gadget.
const IMAGE_URL_HOST_ALLOWLIST = [
  /^([a-z0-9-]+)\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/i,
  /(^|\.)fal\.ai$/i,
  /(^|\.)fal\.media$/i,
  /(^|\.)fal\.run$/i,
];

function isAllowedImageUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return IMAGE_URL_HOST_ALLOWLIST.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function safeZipName(value) {
  return String(value || 'brand-package')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'brand-package';
}

function safeFilename(value, fallback = 'file') {
  return String(value || fallback)
    .replace(/[\r\n"\\/:*?<>|]/g, '_')
    .slice(0, 120) || fallback;
}

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

// Renders a single brand-guidelines document on demand from the spec the
// client already has in state. We do NOT rely on the S3-hosted HTML for
// view/download because:
//   - Some operator environments don't have S3 configured (HTML upload
//     returns null at generation time, so deliverable.url is null).
//   - Re-rendering keeps view + download working for projects generated
//     before HTML uploads were wired up.
async function renderDoc(req, res) {
  try {
    const { spec, slug, brand_name: brandName, as_download: asDownload } = req.body || {};
    if (!spec || typeof spec !== 'object') {
      return res.status(400).json({ success: false, message: 'Missing spec.' });
    }
    if (!slug || !service.DOC_SLUGS.includes(slug)) {
      return res.status(400).json({ success: false, message: `Unknown doc slug. Allowed: ${service.DOC_SLUGS.join(', ')}` });
    }
    const html = service.renderDocBySlug({ slug, brandName: brandName || 'Brand', spec });
    if (!html) {
      return res.status(500).json({ success: false, message: 'Renderer returned empty output.' });
    }
    const filename = safeFilename(`${safeZipName(brandName)}-${slug}.html`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (asDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }
    return res.status(200).send(html);
  } catch (err) {
    console.error('brand-guidelines/render-doc error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Render failed' });
  }
}

// Streams a zip back to the browser. Accepts a list of doc slugs (rendered
// on the fly from the spec) plus a list of image URLs (each fetched and
// piped into the archive). Used for per-card pack downloads AND for the
// "Download all files" CTA.
async function downloadZip(req, res) {
  try {
    const {
      spec,
      brand_name: brandName = 'Brand',
      zip_name: zipName,
      docs = [],
      images = [],
    } = req.body || {};

    if ((!Array.isArray(docs) || !docs.length) && (!Array.isArray(images) || !images.length)) {
      return res.status(400).json({ success: false, message: 'Nothing to zip.' });
    }
    if (docs.length && (!spec || typeof spec !== 'object')) {
      return res.status(400).json({ success: false, message: 'Docs requested but spec is missing.' });
    }

    const safeBrand = safeZipName(brandName);
    const finalZipName = safeFilename(`${safeZipName(zipName || `${safeBrand}-brand-package`)}.zip`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${finalZipName}"`);
    res.setHeader('Cache-Control', 'no-store');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', (err) => {
      // ENOENT and similar non-fatals are logged but don't abort the stream.
      console.warn('[brand-guidelines/zip] archiver warning:', err.message || err);
    });
    archive.on('error', (err) => {
      console.error('[brand-guidelines/zip] archiver error:', err.message || err);
      // If headers already sent we can't switch to JSON — just end the stream.
      try { res.status(500).end(); } catch { /* ignore */ }
    });
    archive.pipe(res);

    // 1. Render and add each requested HTML doc.
    for (const slug of docs) {
      if (!service.DOC_SLUGS.includes(slug)) continue;
      const html = service.renderDocBySlug({ slug, brandName, spec });
      if (!html) continue;
      archive.append(html, { name: `docs/${safeFilename(`${safeBrand}-${slug}.html`)}` });
    }

    // 2. Fetch each whitelisted image URL and add to the archive. Run
    //    fetches sequentially to keep memory bounded; image packs are
    //    only ~4-8 files so the latency hit is acceptable.
    for (const img of images) {
      if (!img || typeof img !== 'object') continue;
      const { url, folder = '', filename } = img;
      if (!isAllowedImageUrl(url)) {
        console.warn(`[brand-guidelines/zip] skipping disallowed url: ${url}`);
        continue;
      }
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[brand-guidelines/zip] fetch ${url} returned ${response.status}`);
          continue;
        }
        const buf = Buffer.from(await response.arrayBuffer());
        const safeFolder = String(folder || '').replace(/[^a-z0-9-_/]+/gi, '-').replace(/^\/+|\/+$/g, '');
        const safeName = safeFilename(filename || url.split('/').pop() || 'image.png');
        const entryName = safeFolder ? `${safeFolder}/${safeName}` : safeName;
        archive.append(buf, { name: entryName });
      } catch (err) {
        console.warn(`[brand-guidelines/zip] failed to fetch ${url}:`, err.message || err);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('brand-guidelines/zip error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: err.message || 'Zip failed' });
    }
    try { res.end(); } catch { /* ignore */ }
  }
}

module.exports = {
  generate,
  listModels,
  renderDoc,
  downloadZip,
};
