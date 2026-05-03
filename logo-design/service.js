// Logo design generation — turns a structured intake form into a fal.ai
// image generation call via the shared image_generation helper.

const imageGeneration = require('../helper/image_generation');

// Models we expose for logo work. Recraft v3 is the default because it
// renders text and clean vector-style logos better than the flux models.
const ALLOWED_MODELS = new Set([
  'fal-ai/recraft-v3',
  'fal-ai/ideogram/v2',
  'fal-ai/flux/dev',
  'fal-ai/flux-pro/v1.1',
]);
const DEFAULT_MODEL = process.env.LOGO_DESIGN_MODEL || 'fal-ai/recraft-v3';

const STYLE_DESCRIPTIONS = {
  vintage: 'vintage, hand-crafted, retro badge style with classic typography and weathered detailing',
  mascot: 'illustrated mascot logo featuring a friendly character or animal as the focal element',
  wordmark: 'wordmark logo — pure typography only, no symbol, with carefully tuned letterforms',
  monogram: 'monogram logo built from initials, geometric and balanced',
  combination: 'combination mark with both a symbol and the brand name lockup',
  minimalist: 'minimalist, modern logo with clean lines, generous whitespace and a single bold idea',
};

const TYPOGRAPHY_DESCRIPTIONS = {
  serif: 'serif typography',
  sans: 'sans-serif typography',
  script: 'flowing script typography',
  modern: 'bold modern typography',
  display: 'high-impact display typography',
  condensed: 'condensed/narrow typography',
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildPrompt(form) {
  const parts = [];
  const brand = safeString(form.brand_name) || 'the brand';
  const styleId = safeString(form.logo_style);
  const styleDesc = STYLE_DESCRIPTIONS[styleId] || 'modern, professional logo style';

  parts.push(`Design a ${styleDesc} for "${brand}".`);

  const tagline = safeString(form.tagline);
  if (tagline) parts.push(`Tagline to consider: "${tagline}".`);

  const description = safeString(form.business_description);
  if (description) parts.push(`Business context: ${description}.`);

  const colors = [];
  safeArray(form.selected_colors).forEach((c) => colors.push(c));
  safeArray(form.custom_colors).forEach((c) => {
    const trimmed = safeString(c);
    if (trimmed) colors.push(trimmed);
  });
  if (colors.length) {
    parts.push(`Color palette: ${colors.slice(0, 4).join(', ')}.`);
  }

  const typo = safeArray(form.selected_typography)
    .map((id) => TYPOGRAPHY_DESCRIPTIONS[id] || id)
    .filter(Boolean);
  if (typo.length) {
    parts.push(`Typography preferences: ${typo.join(' and ')}.`);
  }

  const refs = safeArray(form.reference_links).map(safeString).filter(Boolean);
  if (refs.length) {
    parts.push(`Visual references for inspiration (do not copy): ${refs.join(', ')}.`);
  }

  const competitors = safeArray(form.competitor_links).map(safeString).filter(Boolean);
  const competitorNames = safeString(form.competitor_names);
  if (competitors.length) {
    parts.push(`Differentiate from competitors: ${competitors.join(', ')}.`);
  }
  if (competitorNames) {
    parts.push(`Competitor notes: ${competitorNames}.`);
  }

  const notes = safeString(form.additional_notes);
  if (notes) parts.push(notes);

  parts.push(
    'Final logo should be high-quality, scalable, professional, centered on a clean white background, with crisp edges suitable for both digital and print branding.'
  );

  return parts.join(' ');
}

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

// Some fal.ai models accept extra inputs (e.g. recraft-v3 has a `style`
// parameter that biases output toward "logo_raster" / "vector_illustration").
function modelExtras(model) {
  if (model === 'fal-ai/recraft-v3') {
    return { style: 'vector_illustration' };
  }
  if (model === 'fal-ai/ideogram/v2') {
    return { style: 'design', expand_prompt: true };
  }
  if (model === 'fal-ai/flux-pro/v1.1' || model === 'fal-ai/flux-pro/v1.1-ultra') {
    // PNG so we keep crisp edges and (eventual) transparency support.
    // safety_tolerance "2" matches the fal default but we set it explicitly
    // so prompts like "luxury liquor brand" don't trip the strictest filter.
    return { output_format: 'png', safety_tolerance: '2' };
  }
  if (model === 'fal-ai/flux/dev' || model === 'fal-ai/flux/schnell') {
    return { output_format: 'png' };
  }
  return {};
}

async function generateLogoDesign({ form, requestedModel, numImages = 4 }) {
  const model = pickModel(requestedModel);
  const prompt = buildPrompt(form);

  const result = await imageGeneration.generateImages({
    prompt,
    model,
    num_images: Math.max(1, Math.min(12, Number(numImages) || 4)),
    image_size: 'square_hd',
    extra_input: modelExtras(model),
  });

  return {
    model: result.model,
    prompt,
    seed: result.seed,
    request_id: result.request_id,
    images: result.images,
    errors: result.errors,
  };
}

module.exports = {
  generateLogoDesign,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
