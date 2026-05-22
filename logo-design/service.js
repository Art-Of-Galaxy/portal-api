// Logo design generation — turns a structured intake form into a fal.ai
// image generation call via the shared image_generation helper.

const imageGeneration = require('../helper/image_generation');

// Models we expose for logo work. Nano Banana (Gemini 2.5 Flash Image) is
// now the default because it handles reference-image conditioning out of
// the box — when the user picks a style we send the example references
// for that style and it produces something visually in the same family.
// Flux Pro 1.1 stays available for text-only generation where the brief
// is the only input that matters.
const ALLOWED_MODELS = new Set([
  'fal-ai/nano-banana',
  'fal-ai/nano-banana-2',
  'fal-ai/nano-banana-pro',
  'fal-ai/recraft-v3',
  'fal-ai/ideogram/v2',
  'fal-ai/ideogram/v3',
  'fal-ai/flux/dev',
  'fal-ai/flux-pro/v1.1',
  'fal-ai/flux-pro/v1.1-ultra',
]);
const DEFAULT_MODEL = process.env.LOGO_DESIGN_MODEL || 'fal-ai/nano-banana';

// Style directives — phrased as imperatives so they survive the prompt
// being interpreted by Flux Pro / Recraft. Each one explicitly excludes
// the OTHER style families to stop the model defaulting to a mascot.
const STYLE_DIRECTIVES = {
  vintage:
    'a VINTAGE / RETRO BADGE logo with classic typography, weathered detailing, and an old-school crest feel. ' +
    'It must NOT contain any mascot, character, or animal illustration. It must NOT be a modern minimalist or tech-style mark.',
  mascot:
    'a MASCOT logo featuring an illustrated character, animal, or creature as the focal element. ' +
    'It MUST be character-driven. It must NOT be a pure wordmark or geometric monogram.',
  wordmark:
    'a WORDMARK logo — the brand name set in carefully tuned typography, with NO symbol, NO icon, and NO illustration. ' +
    'Pure typography only.',
  monogram:
    'a MONOGRAM logo built from the brand initials, geometric and balanced, optionally inside a simple containing shape. ' +
    'It must NOT include the full brand name spelled out, NO mascot, NO illustration.',
  combination:
    'a COMBINATION MARK with both a clean symbol AND the brand name lockup beside or beneath it. ' +
    'Symbol and wordmark working together as one cohesive lockup. NO mascot illustrations.',
  minimalist:
    'a MINIMALIST modern logo with clean lines, generous whitespace, and a single bold visual idea. ' +
    'It must NOT contain any mascot, character, or vintage badge styling.',
};

const TYPOGRAPHY_DESCRIPTIONS = {
  serif: 'serif typography',
  sans: 'sans-serif typography',
  script: 'flowing handwritten script typography',
  modern: 'bold modern typography',
  display: 'high-impact display typography',
  condensed: 'condensed / narrow typography',
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}
function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
function isHex(value) {
  return typeof value === 'string' && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}
function normalizeHex(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  return v.startsWith('#') ? v.toUpperCase() : `#${v.toUpperCase()}`;
}
function hexToHsv(hex) {
  const m = String(hex || '').trim().replace(/^#/, '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const num = parseInt(m[1], 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

// Map a hex value to a friendly english description so the AI prompt
// reads "deep navy blue (#1A4FB0)" instead of just a hex code, which
// gives the image model something semantic to anchor on.
function nearestColorName(hex) {
  const hsv = hexToHsv(hex);
  if (!hsv) return null;
  const { h, s, v } = hsv;

  if (v < 0.1) return 'black';
  if (v > 0.95 && s < 0.08) return 'white';
  if (s < 0.12) {
    if (v > 0.78) return 'light grey';
    if (v > 0.45) return 'grey';
    return 'dark grey';
  }

  let base;
  if (h < 15 || h >= 345) base = 'red';
  else if (h < 40)  base = 'orange';
  else if (h < 65)  base = 'yellow';
  else if (h < 95)  base = 'lime green';
  else if (h < 165) base = 'green';
  else if (h < 195) base = 'teal';
  else if (h < 245) base = 'blue';
  else if (h < 290) base = 'purple';
  else              base = 'pink';

  let modifier = '';
  if (v < 0.35)            modifier = 'dark ';
  else if (v < 0.55)       modifier = 'deep ';
  else if (s < 0.35 && v > 0.7) modifier = 'soft ';
  else if (s < 0.55 && v > 0.6) modifier = 'muted ';
  else if (s > 0.85 && v > 0.75) modifier = 'vivid ';

  return modifier + base;
}

// Friendly names for the color-theory cards the user can tap on the form.
// Keep these aligned with COLOR_THEORY in LogoDesignForm.jsx.
const COLOR_FAMILY_LABEL = {
  blue: 'blue',
  purple: 'purple',
  pink: 'pink',
  red: 'red',
  orange: 'orange',
  yellow: 'yellow',
  green: 'green',
  teal: 'teal',
  grey: 'grey',
};

function describeColors(form) {
  const items = [];

  // 1) Color families the user tapped from the theory cards. Pure semantic
  //    intent ("blue", "warm orange") rather than a specific hex.
  safeArray(form.selected_colors).forEach((id) => {
    const family = COLOR_FAMILY_LABEL[String(id || '').toLowerCase()];
    if (family) items.push(family);
  });

  // 2) Specific hex codes from the color picker — these override / refine.
  safeArray(form.custom_colors).forEach((raw) => {
    const trimmed = safeString(raw);
    if (!isHex(trimmed)) return;
    const hex = normalizeHex(trimmed);
    const name = nearestColorName(hex);
    items.push(name ? `${name} (${hex})` : hex);
  });

  // Dedupe while preserving order, then cap at 4 so the prompt stays focused.
  const seen = new Set();
  const out = [];
  for (const v of items) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 4) break;
  }
  return out;
}

function buildPrompt(form) {
  const brand = safeString(form.brand_name) || 'the brand';
  const styleId = safeString(form.logo_style);
  const styleDirective = STYLE_DIRECTIVES[styleId] || 'a clean, professional, modern logo';

  const parts = [];

  // 1) Lead with the strongest possible style directive — what the model
  //    sees first weighs heavily on its output.
  parts.push(`Design ${styleDirective}`);
  parts.push(`Brand name: "${brand}".`);

  const tagline = safeString(form.tagline);
  if (tagline) parts.push(`Include the tagline: "${tagline}".`);

  const description = safeString(form.business_description);
  if (description) parts.push(`Business context: ${description}`);

  const colors = describeColors(form);
  if (colors.length) {
    parts.push(`Color palette (use these specifically): ${colors.join(', ')}.`);
  }

  const typo = safeArray(form.selected_typography)
    .map((id) => TYPOGRAPHY_DESCRIPTIONS[id] || id)
    .filter(Boolean);
  if (typo.length) {
    parts.push(`Typography style: ${typo.join(' combined with ')}.`);
  }

  // 2) References: NEVER paste raw URLs — fal.ai's Flux Pro endpoint
  //    rejects prompts containing URLs ("Unprocessable Entity" 422).
  //    Mention them generically so the AI knows the user has style
  //    preferences without crashing the request.
  const refLinks = safeArray(form.reference_links).map(safeString).filter(Boolean);
  const refUploads = safeArray(form.reference_uploads).filter(
    (u) => u && (u.url || typeof u === 'string')
  );
  const totalRefs = refLinks.length + refUploads.length;
  if (totalRefs > 0) {
    parts.push(
      `The client has provided ${totalRefs} visual reference${totalRefs === 1 ? '' : 's'} ` +
      'for inspiration. Match the aesthetic mood, tone, and craft level of those references; ' +
      'do not copy any specific composition.'
    );
  }

  const competitorNames = safeString(form.competitor_names);
  const competitorLinks = safeArray(form.competitor_links).map(safeString).filter(Boolean);
  if (competitorLinks.length || competitorNames) {
    parts.push(
      'Make this logo visually distinct from the brand\'s competitors — different mark style, ' +
      'different palette, or different typography choice.'
    );
    if (competitorNames) parts.push(`Competitor notes: ${competitorNames}`);
  }

  const notes = safeString(form.additional_notes);
  if (notes) parts.push(`Additional notes from client: ${notes}`);

  // Quality directive
  parts.push(
    'High-quality, scalable, professional logo. Centered on a clean white background. ' +
    'Crisp edges. Suitable for both digital and print.'
  );

  // 3) Repeat the style at the END as a final directive — this consistently
  //    nudges Flux Pro to honour the style choice over generic defaults.
  parts.push(`STYLE REQUIREMENT (must follow): ${styleDirective}`);

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
  if (model === 'fal-ai/ideogram/v2' || model === 'fal-ai/ideogram/v3') {
    return { style: 'design', expand_prompt: true };
  }
  if (model === 'fal-ai/flux-pro/v1.1' || model === 'fal-ai/flux-pro/v1.1-ultra') {
    // PNG so we keep crisp edges. safety_tolerance "5" stops routine brand
    // language ("liquor", "fitness", "weapons", anatomical references) from
    // silently filtering out variants. "6" is sometimes account-restricted.
    return { output_format: 'png', safety_tolerance: '5' };
  }
  if (model === 'fal-ai/flux/dev' || model === 'fal-ai/flux/schnell') {
    return { output_format: 'png' };
  }
  if (model === 'fal-ai/nano-banana') {
    return { aspect_ratio: '1:1', output_format: 'png' };
  }
  if (model === 'fal-ai/gpt-image-1') {
    return { output_format: 'png', quality: 'high' };
  }
  return {};
}

// Attach style-reference image URLs in whichever shape the model expects.
// - nano-banana / gpt-image-1: `image_urls` (array, up to 3)
// - recraft-v3                : `image_url`  (single string, the first ref)
// - everything else            : nothing (text-only)
function attachStyleRefs(extras, model, urls) {
  const key = imageGenerationImageInputKey(model);
  if (!key || !Array.isArray(urls) || urls.length === 0) return extras;
  const cleaned = urls
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter((u) => /^https?:\/\//i.test(u));
  if (cleaned.length === 0) return extras;
  if (key === 'image_urls') {
    return { ...extras, image_urls: cleaned.slice(0, 3) };
  }
  if (key === 'image_url') {
    return { ...extras, image_url: cleaned[0] };
  }
  return extras;
}

const imageGenerationImageInputKey = imageGeneration.imageInputKey;

async function generateLogoDesign({ form, requestedModel, numImages = 4 }) {
  const model = pickModel(requestedModel);
  const prompt = buildPrompt(form);

  const styleRefs = safeArray(form.style_reference_urls);
  const extras = attachStyleRefs(modelExtras(model), model, styleRefs);

  const result = await imageGeneration.generateImages({
    prompt,
    model,
    num_images: Math.max(1, Math.min(12, Number(numImages) || 4)),
    image_size: 'square_hd',
    extra_input: extras,
  });

  return {
    model: result.model,
    prompt,
    seed: result.seed,
    request_id: result.request_id,
    images: result.images,
    errors: result.errors,
    reference_count: styleRefs.length,
  };
}

module.exports = {
  generateLogoDesign,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
