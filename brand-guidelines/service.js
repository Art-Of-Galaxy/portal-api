// Brand Guidelines service.
//
// The flow:
//   1. Claude produces a structured Brand Guidelines spec (positioning,
//      voice, visual direction, typography, color system).
//   2. fal.ai produces a 4-image Logo Package + a 4-image Social Media
//      Kit, conditioned on the brand spec and the client's quiz answers.
//   3. We render four text-driven deliverables as self-contained HTML
//      docs (Brand Guidelines book, Color System, Voice One-Pager,
//      Typography Guide) and upload them to S3.
//   4. We return the structured spec + a bundle of 6 deliverable cards
//      the frontend can render in a grid.

const Anthropic = require('@anthropic-ai/sdk');
const imageGeneration = require('../helper/image_generation');
const s3 = require('../helper/s3_storage');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.BRAND_GUIDELINES_MODEL || 'claude-opus-4-7';
const LOGO_MODEL = process.env.BRAND_GUIDELINES_LOGO_MODEL || 'fal-ai/nano-banana';
const SOCIAL_MODEL = process.env.BRAND_GUIDELINES_SOCIAL_MODEL || 'fal-ai/nano-banana';

const client = new Anthropic();

// ---------- Claude prompt + schema ----------

const SYSTEM_PROMPT = `You are a senior brand strategist and design director for Art of Galaxy, an AI-services agency.

You take a structured client intake form for a Brand Guidelines Development engagement and produce a complete, professional brand guidelines specification.

Your output must:
- Be specific and actionable, never generic.
- NEVER use em dashes (—) or double-dashes (--) anywhere in the text. They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Translate client input into brand-strategist recommendations (do not just echo it back).
- Use the client's product, audience, competitors, and admired brands as concrete reference points.
- When the client gave color or typography preferences, build on them. When they did not, recommend specific options with named hex codes and typeface families.
- Justify each visual recommendation against the brand's positioning and audience, not in the abstract.
- Keep voice and tone descriptions concrete enough that a copywriter could ship from them (length: 1 to 3 sentences each).
- Always return a deliverables list that aligns with what the client asked for plus standard brand-guideline outputs.
- For social_briefs you MUST produce 4 visually distinct posts (different composition, different subject, different headline phrase). They share the brand palette and mood but should never look like 4 takes of the same image.

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any other text, prose, or markdown.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'brand_summary',
    'positioning_statement',
    'brand_essence',
    'mood_keywords',
    'verbal_identity',
    'visual_identity',
    'typography',
    'color_system',
    'logo_brief',
    'social_briefs',
    'deliverables',
    'next_steps',
  ],
  properties: {
    brand_summary: {
      type: 'string',
      description: 'A 2 to 3 sentence executive summary of the brand we are building.',
    },
    positioning_statement: {
      type: 'string',
      description: 'A single positioning sentence: For [audience], [brand] is the [category] that [unique value], because [reason to believe].',
    },
    brand_essence: {
      type: 'string',
      description: 'A 6 to 12 word distillation of the brand essence (e.g. "Urban streetwear for the 15 to 30 generation").',
    },
    mood_keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '5 to 7 mood keywords describing the visual and emotional feel.',
    },
    verbal_identity: {
      type: 'object',
      additionalProperties: false,
      required: ['voice', 'tone', 'do_say', 'dont_say', 'tagline_options'],
      properties: {
        voice:    { type: 'string', description: 'Brand voice, the constant personality. 1 to 3 sentences.' },
        tone:     { type: 'string', description: 'How the voice flexes across contexts (sales vs support vs social). 1 to 3 sentences.' },
        do_say:   { type: 'array', items: { type: 'string' }, description: '4 to 6 short phrases the brand SHOULD use.' },
        dont_say: { type: 'array', items: { type: 'string' }, description: '4 to 6 short phrases the brand should AVOID.' },
        tagline_options: { type: 'array', items: { type: 'string' }, description: '3 distinct tagline options.' },
      },
    },
    visual_identity: {
      type: 'object',
      additionalProperties: false,
      required: ['design_principles', 'logo_direction', 'imagery_direction'],
      properties: {
        design_principles: { type: 'array', items: { type: 'string' }, description: '3 to 5 design principles.' },
        logo_direction:    { type: 'string', description: 'Recommended logo direction (wordmark vs lockup vs symbol) with rationale.' },
        imagery_direction: { type: 'string', description: 'Photography or illustration direction with rationale.' },
      },
    },
    typography: {
      type: 'object',
      additionalProperties: false,
      required: ['display', 'body', 'rationale'],
      properties: {
        display: {
          type: 'object',
          additionalProperties: false,
          required: ['family', 'classification', 'usage'],
          properties: {
            family:         { type: 'string' },
            classification: { type: 'string' },
            usage:          { type: 'string' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['family', 'classification', 'usage'],
          properties: {
            family:         { type: 'string' },
            classification: { type: 'string' },
            usage:          { type: 'string' },
          },
        },
        rationale: { type: 'string' },
      },
    },
    color_system: {
      type: 'object',
      additionalProperties: false,
      required: ['primary', 'secondary', 'neutrals', 'rationale'],
      properties: {
        primary:   { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['name','hex','usage'], properties: { name: {type:'string'}, hex: {type:'string'}, usage: {type:'string'} } } },
        secondary: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name','hex','usage'], properties: { name: {type:'string'}, hex: {type:'string'}, usage: {type:'string'} } } },
        neutrals:  { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name','hex','usage'], properties: { name: {type:'string'}, hex: {type:'string'}, usage: {type:'string'} } } },
        rationale: { type: 'string' },
      },
    },
    logo_brief: {
      type: 'string',
      description: 'A 1 to 2 sentence imperative brief that describes the logo concept to a fal.ai image model. Lead with the mark style (wordmark / lockup / symbol), the dominant color from the palette, and 2 mood adjectives.',
    },
    social_briefs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Return EXACTLY 4 elements (not fewer, not more) of distinct social media post briefs for a fal.ai image model. Each one MUST describe a visually different post (different composition, different subject, different short headline rendered in the image). Required mix in this order: (1) Hero brand post with the brand tagline as the headline. (2) Quote or testimonial card with a 4 to 7 word brand-voice phrase. (3) Product or service feature with a benefit-led headline. (4) Lifestyle or mood moment with an aspirational 3 to 5 word headline. Every brief MUST include the headline string in double quotes, the composition, and the dominant palette color. Headlines MUST all be DIFFERENT.',
    },
    deliverables: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete files and assets the client will receive.',
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
      description: '3 to 5 next steps the AOG team will take after this brief is approved.',
    },
  },
};

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

async function runClaudeSpec({ form, model }) {
  const system = [
    { type: 'text', text: SYSTEM_PROMPT },
    {
      type: 'text',
      text: `Output schema (the JSON you return MUST conform):\n${JSON.stringify(OUTPUT_SCHEMA)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const userPayload = JSON.stringify({ intake: form }, null, 2);

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: `Here is the client's brand-guidelines intake form. Generate the brand guidelines spec as JSON conforming to the schema.\n\n${userPayload}`,
    }],
    output_config: {
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Failed to parse JSON from Claude: ${err.message}`);
  }

  return { parsed, stop_reason: response.stop_reason, usage: response.usage };
}

// ---------- Image generation ----------

function safeBrandSlug(value) {
  return String(value || 'brand')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'brand';
}

function paletteForPrompt(spec) {
  const primary = Array.isArray(spec?.color_system?.primary) ? spec.color_system.primary : [];
  const secondary = Array.isArray(spec?.color_system?.secondary) ? spec.color_system.secondary : [];
  const swatches = [...primary, ...secondary].slice(0, 3);
  if (!swatches.length) return '';
  return swatches.map((c) => `${c.name || ''} (${c.hex})`).filter(Boolean).join(', ');
}

function buildLogoPrompt({ brandName, spec }) {
  const palette = paletteForPrompt(spec);
  const moods = Array.isArray(spec?.mood_keywords) ? spec.mood_keywords.slice(0, 3).join(', ') : '';
  const direction = spec?.logo_brief || spec?.visual_identity?.logo_direction || '';
  const parts = [
    `Design a professional brand logo for "${brandName}".`,
    direction ? `Direction: ${direction}` : '',
    palette ? `Brand palette (use only these colors, the dominant tone must come from this set): ${palette}.` : '',
    moods ? `Mood: ${moods}.` : '',
    'Centered on a clean white background, crisp edges, scalable, suitable for digital and print.',
  ];
  return parts.filter(Boolean).join(' ');
}

// Default angles used when Claude doesn't supply 4 distinct social_briefs
// (older outputs, or a model that ignored the schema constraint). Gives us
// 4 visually different posts even in the fallback path so the deliverable
// never reads as "4 copies of the same image".
const SOCIAL_FALLBACK_ANGLES = [
  { headline: 'Built different.',  composition: 'hero brand post, oversized typography centered, generous whitespace' },
  { headline: 'In your words.',    composition: 'quote card with a short pull-quote, soft background texture, secondary palette accent' },
  { headline: 'Made for you.',     composition: 'product or service feature, single hero object on color block, benefit-led headline below' },
  { headline: 'Live the moment.',  composition: 'lifestyle moment with a candid composition, atmospheric lighting, brand color as the dominant tone' },
];

function buildSocialPromptFromBrief({ brandName, spec, brief }) {
  const palette = paletteForPrompt(spec);
  const moods = Array.isArray(spec?.mood_keywords) ? spec.mood_keywords.slice(0, 3).join(', ') : '';
  const parts = [
    `Design a high-quality square 1:1 social media post mockup in the visual identity of "${brandName}".`,
    brief ? `Direction: ${brief}` : '',
    palette ? `Brand palette (use only these colors, dominant tone must come from this set): ${palette}.` : '',
    moods ? `Mood: ${moods}.` : '',
    'Editorial composition, intentional typography rendered cleanly in the image, no real logo, photorealistic where it suits the brief.',
  ];
  return parts.filter(Boolean).join(' ');
}

// Build the 4 distinct social prompts. Prefer Claude's social_briefs (the
// schema asks for 4); fall back to the curated angles + spec.social_brief
// (legacy field) so we never end up with 4 identical generations.
function buildSocialPrompts({ brandName, spec }) {
  const fromClaude = Array.isArray(spec?.social_briefs)
    ? spec.social_briefs.filter((b) => typeof b === 'string' && b.trim().length > 8)
    : [];

  const base = [];
  for (let i = 0; i < 4; i += 1) {
    const brief = fromClaude[i] || (
      spec?.social_brief
        ? `${SOCIAL_FALLBACK_ANGLES[i].composition}. Headline: "${SOCIAL_FALLBACK_ANGLES[i].headline}". ${spec.social_brief}`
        : `${SOCIAL_FALLBACK_ANGLES[i].composition}. Headline: "${SOCIAL_FALLBACK_ANGLES[i].headline}".`
    );
    base.push(buildSocialPromptFromBrief({ brandName, spec, brief }));
  }
  return base;
}

// Generate one image per prompt (parallel). Used for the social kit so the
// 4 outputs are visually distinct posts instead of 4 variants of the same
// scene. Mirrors generateImagePack's S3 mirroring + error collection.
async function generateImagePackFromPrompts({ prompts, brandSlug, kind, model }) {
  const list = Array.isArray(prompts) ? prompts.filter(Boolean) : [];
  if (!list.length) return { model: model || LOGO_MODEL, images: [], errors: [] };

  const results = await Promise.all(list.map(async (prompt, idx) => {
    try {
      const r = await imageGeneration.generateImages({
        prompt,
        model: model || LOGO_MODEL,
        num_images: 1,
        image_size: 'square_hd',
        extra_input: { aspect_ratio: '1:1', output_format: 'png' },
      });
      const img = (r.images || [])[0];
      if (!img) return { img: null, err: 'no image returned', resolvedModel: r.model };
      if (s3.isConfigured()) {
        try {
          const uploaded = await s3.uploadFromUrl(img.url, {
            prefix: `generated/brand-guidelines/${brandSlug}/${kind}`,
            originalName: `${brandSlug}-${kind}-${idx + 1}.png`,
          });
          return {
            img: {
              ...img,
              url: uploaded.url,
              content_type: uploaded.contentType || img.content_type || 'image/png',
              original_url: img.url,
            },
            err: null,
            resolvedModel: r.model,
          };
        } catch (mirrorErr) {
          console.error(`[brand-guidelines] failed to mirror ${kind} image to S3:`, mirrorErr.message || mirrorErr);
          return { img, err: null, resolvedModel: r.model };
        }
      }
      return { img, err: null, resolvedModel: r.model };
    } catch (err) {
      console.error(`[brand-guidelines] ${kind} prompt ${idx + 1} failed:`, err.message || err);
      return { img: null, err: err.message || String(err), resolvedModel: model || LOGO_MODEL };
    }
  }));

  const images = results.map((r) => r.img).filter(Boolean);
  const errors = results.map((r) => r.err).filter(Boolean);
  const resolvedModel = results.find((r) => r.resolvedModel)?.resolvedModel || (model || LOGO_MODEL);
  return { model: resolvedModel, images, errors };
}

async function generateImagePack({ prompt, count, brandSlug, kind, model }) {
  try {
    const result = await imageGeneration.generateImages({
      prompt,
      model: model || LOGO_MODEL,
      num_images: count,
      image_size: 'square_hd',
      extra_input: { aspect_ratio: '1:1', output_format: 'png' },
    });
    let images = result.images || [];
    if (s3.isConfigured() && images.length) {
      images = await Promise.all(
        images.map(async (img, idx) => {
          try {
            const uploaded = await s3.uploadFromUrl(img.url, {
              prefix: `generated/brand-guidelines/${brandSlug}/${kind}`,
              originalName: `${brandSlug}-${kind}-${idx + 1}.png`,
            });
            return {
              ...img,
              url: uploaded.url,
              content_type: uploaded.contentType || img.content_type || 'image/png',
              original_url: img.url,
            };
          } catch (err) {
            console.error(`[brand-guidelines] failed to mirror ${kind} image to S3:`, err.message || err);
            return img;
          }
        })
      );
    }
    return { model: result.model, images, errors: result.errors };
  } catch (err) {
    console.error(`[brand-guidelines] ${kind} pack generation failed:`, err.message || err);
    return { model: model || LOGO_MODEL, images: [], errors: [err.message || String(err)] };
  }
}

// ---------- HTML deliverable rendering ----------

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hexToRgb(hex) {
  const m = String(hex || '').trim().replace(/^#/, '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToCmyk(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const k = 1 - Math.max(rn, gn, bn);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - rn - k) / (1 - k);
  const m = (1 - gn - k) / (1 - k);
  const y = (1 - bn - k) / (1 - k);
  return {
    c: Math.round(c * 100),
    m: Math.round(m * 100),
    y: Math.round(y * 100),
    k: Math.round(k * 100),
  };
}

// Quote a font family if it contains whitespace or non-word chars so the
// CSS parser accepts it. Plain identifiers (Arial, Georgia) stay bare.
function cssFontFamily(family) {
  const clean = String(family || '').replace(/["'<>]/g, '').trim();
  if (!clean) return '';
  return /[\s+]/.test(clean) ? `"${clean}"` : clean;
}

// Build a Google Fonts href for the portal's UI typeface PLUS the brand's
// recommended display and body families, so:
//   - The doc chrome (cover, headings, body) reads in Montserrat to match
//     the portal site the user opens the deliverable from.
//   - The brand-recommended faces are still loaded so the type sample
//     section in the Typography guide can render in them.
// Google Fonts silently ignores families it doesn't host, so this is safe.
function googleFontsLink(spec) {
  const brandFamilies = [
    spec?.typography?.display?.family,
    spec?.typography?.body?.family,
  ]
    .map((f) => String(f || '').replace(/["'<>]/g, '').trim())
    .filter(Boolean);
  const all = ['Montserrat', ...brandFamilies];
  const uniq = [...new Set(all)];
  const qs = uniq
    .map((name) => `family=${encodeURIComponent(name.replace(/\s+/g, '+'))}:wght@400;500;600;700;800`)
    .join('&');
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?${qs}&display=swap" rel="stylesheet">`;
}

// Doc chrome (cover, headings, body, lists) uses Montserrat so the
// rendered deliverables read as part of the portal. The recommended
// BRAND typefaces are scoped to the inline samples in the Typography
// guide (see renderTypeDoc) so the chrome stays consistent across all
// brands.
const DOC_BASE_STYLES = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f7f7f5;color:#171613;line-height:1.55;padding:48px 0}
  h1,h2,h3,.cover h1{font-family:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
  .page{max-width:780px;margin:0 auto;background:#fff;border-radius:14px;padding:56px 64px;box-shadow:0 12px 40px rgba(17,44,75,.08)}
  .cover{margin-bottom:48px;padding-bottom:24px;border-bottom:1px solid #e8e6e1}
  .cover .eyebrow{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#5540ff;margin-bottom:10px}
  .cover h1{font-size:34px;font-weight:800;letter-spacing:-.5px;margin-bottom:6px;color:#0f1c2e}
  .cover .essence{font-size:15px;color:#434e5d}
  h2{font-size:20px;font-weight:700;letter-spacing:-.2px;margin:36px 0 14px;color:#0f1c2e}
  h3{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#5540ff;margin:26px 0 10px}
  p{font-size:14.5px;margin-bottom:10px;color:#171613}
  .lead{font-size:16px;color:#434e5d}
  .pill-row{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0 18px}
  .pill{font-size:12px;font-weight:500;padding:5px 12px;border-radius:20px;background:rgba(85,64,255,.08);color:#5540ff;border:1px solid rgba(85,64,255,.16)}
  .swatch-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:14px 0 22px}
  .swatch{border:1px solid #e8e6e1;border-radius:10px;overflow:hidden}
  .swatch-block{height:80px}
  .swatch-meta{padding:10px 12px}
  .swatch-name{font-size:13px;font-weight:600;color:#0f1c2e}
  .swatch-tokens{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:#434e5d;margin-top:4px;line-height:1.45}
  .swatch-usage{font-size:11.5px;color:#6b6860;margin-top:6px}
  .twocol{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}
  .quote-box{background:#f2f1ee;border-left:3px solid #5540ff;padding:14px 18px;border-radius:0 10px 10px 0;margin:14px 0}
  .quote-box em{font-style:italic;color:#171613;font-size:14.5px}
  ul.clean{list-style:none;padding:0}
  ul.clean li{padding:8px 0;border-bottom:1px solid #f2f1ee;font-size:14px;display:flex;align-items:flex-start;gap:10px;color:#171613}
  ul.clean li::before{content:'';display:block;width:6px;height:6px;border-radius:50%;background:#5540ff;flex-shrink:0;margin-top:9px}
  ul.clean.warn li::before{background:#e84d4d}
  ul.clean.good li::before{background:#00bf6f}
  .footer-credit{margin-top:48px;padding-top:18px;border-top:1px solid #e8e6e1;font-size:11.5px;color:#9b988f;text-align:center}
  @media print{body{background:#fff;padding:0} .page{box-shadow:none;border-radius:0;padding:24px 32px}}
`;

function renderDocShell({ title, brandName, essence, body, spec }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${escapeHtml(brandName)}</title>${googleFontsLink(spec)}<style>${DOC_BASE_STYLES}</style></head><body><div class="page"><div class="cover"><div class="eyebrow">${escapeHtml(title)}</div><h1>${escapeHtml(brandName)}</h1>${essence ? `<div class="essence">${escapeHtml(essence)}</div>` : ''}</div>${body}<div class="footer-credit">Generated by Art of Galaxy · AOG AI Brand Strategist</div></div></body></html>`;
}

function renderColorBlocks(swatches, label) {
  if (!Array.isArray(swatches) || !swatches.length) return '';
  const blocks = swatches.map((sw) => {
    const rgb = hexToRgb(sw.hex);
    const cmyk = rgb ? rgbToCmyk(rgb.r, rgb.g, rgb.b) : null;
    const tokens = [
      `HEX ${sw.hex || ''}`,
      rgb ? `RGB ${rgb.r}, ${rgb.g}, ${rgb.b}` : '',
      cmyk ? `CMYK ${cmyk.c}, ${cmyk.m}, ${cmyk.y}, ${cmyk.k}` : '',
    ].filter(Boolean).join('<br>');
    return `<div class="swatch"><div class="swatch-block" style="background:${escapeHtml(sw.hex || '#ccc')}"></div><div class="swatch-meta"><div class="swatch-name">${escapeHtml(sw.name || sw.hex || '')}</div><div class="swatch-tokens">${tokens}</div><div class="swatch-usage">${escapeHtml(sw.usage || '')}</div></div></div>`;
  }).join('');
  return `<h3>${escapeHtml(label)}</h3><div class="swatch-grid">${blocks}</div>`;
}

function renderGuidelinesDoc({ brandName, spec }) {
  const verbal = spec.verbal_identity || {};
  const visual = spec.visual_identity || {};
  const typo = spec.typography || {};
  const colors = spec.color_system || {};
  const body = `
    <p class="lead">${escapeHtml(spec.brand_summary || '')}</p>
    <div class="quote-box"><em>${escapeHtml(spec.positioning_statement || '')}</em></div>
    ${Array.isArray(spec.mood_keywords) && spec.mood_keywords.length ? `<h2>Brand Mood</h2><div class="pill-row">${spec.mood_keywords.map((m) => `<span class="pill">${escapeHtml(m)}</span>`).join('')}</div>` : ''}
    <h2>Verbal Identity</h2>
    <h3>Voice</h3><p>${escapeHtml(verbal.voice || '')}</p>
    <h3>Tone</h3><p>${escapeHtml(verbal.tone || '')}</p>
    <div class="twocol">
      <div><h3>Do say</h3><ul class="clean good">${(verbal.do_say || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div><h3>Don't say</h3><ul class="clean warn">${(verbal.dont_say || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    </div>
    ${Array.isArray(verbal.tagline_options) && verbal.tagline_options.length ? `<h3>Tagline options</h3><ul class="clean">${verbal.tagline_options.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
    <h2>Visual Identity</h2>
    ${Array.isArray(visual.design_principles) && visual.design_principles.length ? `<h3>Design principles</h3><ul class="clean">${visual.design_principles.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
    <h3>Logo direction</h3><p>${escapeHtml(visual.logo_direction || '')}</p>
    <h3>Imagery direction</h3><p>${escapeHtml(visual.imagery_direction || '')}</p>
    <h2>Typography</h2>
    <h3>Display: ${escapeHtml(typo.display?.family || '')}</h3>
    <p><strong>${escapeHtml(typo.display?.classification || '')}</strong>. ${escapeHtml(typo.display?.usage || '')}</p>
    <h3>Body: ${escapeHtml(typo.body?.family || '')}</h3>
    <p><strong>${escapeHtml(typo.body?.classification || '')}</strong>. ${escapeHtml(typo.body?.usage || '')}</p>
    <p>${escapeHtml(typo.rationale || '')}</p>
    <h2>Color System</h2>
    ${renderColorBlocks(colors.primary,   'Primary palette')}
    ${renderColorBlocks(colors.secondary, 'Secondary palette')}
    ${renderColorBlocks(colors.neutrals,  'Neutrals')}
    <p>${escapeHtml(colors.rationale || '')}</p>
    ${Array.isArray(spec.next_steps) && spec.next_steps.length ? `<h2>Next steps</h2><ul class="clean">${spec.next_steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : ''}
  `;
  return renderDocShell({
    title: 'Brand Guidelines',
    brandName,
    essence: spec.brand_essence,
    body,
    spec,
  });
}

function renderColorSystemDoc({ brandName, spec }) {
  const colors = spec.color_system || {};
  const body = `
    <p class="lead">Color tokens for digital and print use. Every swatch is listed with HEX, RGB and CMYK values so the system stays consistent across both surfaces.</p>
    ${renderColorBlocks(colors.primary,   'Primary palette')}
    ${renderColorBlocks(colors.secondary, 'Secondary palette')}
    ${renderColorBlocks(colors.neutrals,  'Neutrals')}
    <h2>Rationale</h2><p>${escapeHtml(colors.rationale || '')}</p>
  `;
  return renderDocShell({
    title: 'Color System Reference',
    brandName,
    essence: spec.brand_essence,
    body,
    spec,
  });
}

function renderVoiceDoc({ brandName, spec }) {
  const v = spec.verbal_identity || {};
  const body = `
    <p class="lead">A one-page reference for anyone writing copy in the ${escapeHtml(brandName)} voice.</p>
    <h2>Voice</h2><p>${escapeHtml(v.voice || '')}</p>
    <h2>Tone</h2><p>${escapeHtml(v.tone || '')}</p>
    <div class="twocol">
      <div><h3>Do say</h3><ul class="clean good">${(v.do_say || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
      <div><h3>Don't say</h3><ul class="clean warn">${(v.dont_say || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    </div>
    ${Array.isArray(v.tagline_options) && v.tagline_options.length ? `<h2>Tagline options</h2><ul class="clean">${v.tagline_options.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
  `;
  return renderDocShell({
    title: 'Brand Voice One-Pager',
    brandName,
    essence: spec.brand_essence,
    body,
    spec,
  });
}

function renderTypeDoc({ brandName, spec }) {
  const t = spec.typography || {};
  // Build an inline font-family fragment that quotes multi-word families.
  // Without quoting, "Helvetica Neue" becomes invalid CSS and falls back
  // to the browser default, which is what produced the unstyled samples
  // the user reported.
  const sample = (family) => {
    const css = cssFontFamily(family);
    return css ? `font-family:${css},Georgia,sans-serif` : '';
  };
  const body = `
    <p class="lead">A hierarchy reference for the ${escapeHtml(brandName)} type system.</p>
    <h2>Display: ${escapeHtml(t.display?.family || '')}</h2>
    <div style="${sample(t.display?.family || '')};font-size:46px;font-weight:700;line-height:1.05;color:#0f1c2e;margin:8px 0 6px">Aa Bb 1234</div>
    <p><strong>${escapeHtml(t.display?.classification || '')}</strong>. ${escapeHtml(t.display?.usage || '')}</p>
    <h2>Body: ${escapeHtml(t.body?.family || '')}</h2>
    <div style="${sample(t.body?.family || '')};font-size:18px;line-height:1.6;color:#0f1c2e;margin:8px 0 6px">The quick brown fox jumps over the lazy dog. 1234567890</div>
    <p><strong>${escapeHtml(t.body?.classification || '')}</strong>. ${escapeHtml(t.body?.usage || '')}</p>
    <h2>Pairing rationale</h2><p>${escapeHtml(t.rationale || '')}</p>
    <h2>Hierarchy reference</h2>
    <div style="${sample(t.display?.family || '')};font-size:36px;font-weight:700;color:#0f1c2e;margin-bottom:6px">H1 / Hero headline</div>
    <div style="${sample(t.display?.family || '')};font-size:24px;font-weight:600;color:#0f1c2e;margin-bottom:6px">H2 / Section headline</div>
    <div style="${sample(t.body?.family || '')};font-size:18px;font-weight:600;color:#0f1c2e;margin-bottom:6px">H3 / Sub-section</div>
    <div style="${sample(t.body?.family || '')};font-size:15px;color:#0f1c2e;margin-bottom:6px">Body / Paragraph text used across long-form reading surfaces.</div>
    <div style="${sample(t.body?.family || '')};font-size:12px;color:#6b6860">Caption / Metadata text used for tags and asides.</div>
  `;
  return renderDocShell({
    title: 'Typography Usage Guide',
    brandName,
    essence: spec.brand_essence,
    body,
    spec,
  });
}

// ---------- S3 upload of HTML deliverables ----------

async function uploadHtmlDoc({ brandSlug, name, html }) {
  if (!s3.isConfigured()) return null;
  const key = s3.keyForUpload({
    prefix: `generated/brand-guidelines/${brandSlug}/docs`,
    originalName: `${brandSlug}-${name}.html`,
    contentType: 'text/html',
  });
  return s3.uploadBuffer({
    key,
    body: Buffer.from(html, 'utf8'),
    contentType: 'text/html; charset=utf-8',
  }).then((url) => ({ url, content_type: 'text/html', key })).catch((err) => {
    console.error(`[brand-guidelines] failed to upload ${name} doc:`, err.message || err);
    return null;
  });
}

// ---------- Main entry ----------

async function generateBrandGuidelines({ form, requestedModel }) {
  const model = pickModel(requestedModel);
  const brandName = String(form?.brand_name || '').trim() || 'Untitled Brand';
  const brandSlug = safeBrandSlug(brandName);

  // 1. Claude spec
  const { parsed: spec, stop_reason, usage } = await runClaudeSpec({ form, model });

  // 2 + 3 in parallel: fal.ai image packs + HTML deliverables to S3.
  // Logo pack repeats one prompt 4x (variations of the same mark). Social
  // pack runs 4 distinct prompts so the deliverable shows 4 different
  // posts, not 4 takes of the same scene.
  const logoPrompt = buildLogoPrompt({ brandName, spec });
  const socialPrompts = buildSocialPrompts({ brandName, spec });

  const [logoPack, socialPack, guidelinesUpload, colorUpload, voiceUpload, typeUpload] = await Promise.all([
    generateImagePack({ prompt: logoPrompt, count: 4, brandSlug, kind: 'logo', model: LOGO_MODEL }),
    generateImagePackFromPrompts({ prompts: socialPrompts, brandSlug, kind: 'social', model: SOCIAL_MODEL }),
    uploadHtmlDoc({ brandSlug, name: 'brand-guidelines', html: renderGuidelinesDoc({ brandName, spec }) }),
    uploadHtmlDoc({ brandSlug, name: 'color-system',     html: renderColorSystemDoc({ brandName, spec }) }),
    uploadHtmlDoc({ brandSlug, name: 'brand-voice',      html: renderVoiceDoc({ brandName, spec }) }),
    uploadHtmlDoc({ brandSlug, name: 'typography-guide', html: renderTypeDoc({ brandName, spec }) }),
  ]);

  const deliverables = [
    {
      id: 'guidelines',
      name: 'Brand Guidelines PDF',
      description: 'Full brand book covering positioning, voice, visuals, type, and color.',
      kind: 'document',
      url: guidelinesUpload?.url || null,
      preview_url: guidelinesUpload?.url || null,
      icon: 'book',
      accent: '#5540ff',
    },
    {
      id: 'logo',
      name: 'Logo Package',
      description: '4 concept renders. SVG, PNG, light and dark variants.',
      kind: 'image_pack',
      images: logoPack.images,
      url: logoPack.images?.[0]?.url || null,
      preview_url: logoPack.images?.[0]?.url || null,
      icon: 'sparkles',
      accent: '#7c3aed',
    },
    {
      id: 'color',
      name: 'Color System Reference',
      description: 'HEX, RGB and CMYK for print and digital use.',
      kind: 'document',
      url: colorUpload?.url || null,
      preview_url: colorUpload?.url || null,
      icon: 'palette',
      accent: '#ec4899',
    },
    {
      id: 'social',
      name: 'Social Media Kit',
      description: '4 post mockups in the brand style. Ready for Reels and stories.',
      kind: 'image_pack',
      images: socialPack.images,
      url: socialPack.images?.[0]?.url || null,
      preview_url: socialPack.images?.[0]?.url || null,
      icon: 'smartphone',
      accent: '#377cc7',
    },
    {
      id: 'voice',
      name: 'Brand Voice One-Pager',
      description: "Do, don't, taglines, voice and tone reference for any copywriter.",
      kind: 'document',
      url: voiceUpload?.url || null,
      preview_url: voiceUpload?.url || null,
      icon: 'pen',
      accent: '#00bf6f',
    },
    {
      id: 'typography',
      name: 'Typography Usage Guide',
      description: 'Display and body pairing with a full hierarchy reference.',
      kind: 'document',
      url: typeUpload?.url || null,
      preview_url: typeUpload?.url || null,
      icon: 'type',
      accent: '#1e1b48',
    },
  ];

  const imageGenErrors = [
    ...(logoPack.errors || []).map((m) => `Logo pack: ${m}`),
    ...(socialPack.errors || []).map((m) => `Social pack: ${m}`),
  ];

  return {
    model,
    stop_reason,
    usage,
    guidelines: spec,
    deliverables,
    logo_images: logoPack.images,
    social_images: socialPack.images,
    logo_prompt: logoPrompt,
    social_prompts: socialPrompts,
    errors: imageGenErrors.length ? imageGenErrors : undefined,
  };
}

// Map slugs → render functions so the controller can serve any doc on
// demand from the persisted spec (and the frontend can re-render fresh
// HTML for view/download even when the S3 upload at generation time
// silently failed).
const DOC_RENDERERS = {
  'brand-guidelines': renderGuidelinesDoc,
  'color-system':     renderColorSystemDoc,
  'brand-voice':      renderVoiceDoc,
  'typography-guide': renderTypeDoc,
};

function renderDocBySlug({ slug, brandName, spec }) {
  const fn = DOC_RENDERERS[slug];
  if (!fn) return null;
  return fn({ brandName, spec });
}

module.exports = {
  generateBrandGuidelines,
  renderDocBySlug,
  DOC_SLUGS: Object.keys(DOC_RENDERERS),
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
