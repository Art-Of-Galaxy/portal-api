// E-Commerce Mockups service.
//
// Two-step pipeline mirroring brand-guidelines:
//   1. Claude produces a structured creative spec (product description,
//      claims, target customer, mockup metadata, 6 per-mockup prompts).
//   2. fal.ai runs 6 distinct image-generation calls, one per mockup
//      type (Hero on white, Branded color hero, Lifestyle scene, Feature
//      highlights, Homepage banner, Packaging flat-lay), each conditioned
//      on the brand palette and the uploaded product images so the
//      mockups actually feature the real product.

const Anthropic = require('@anthropic-ai/sdk');
const imageGeneration = require('../helper/image_generation');
const s3 = require('../helper/s3_storage');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.ECOMMERCE_MOCKUPS_MODEL || 'claude-sonnet-4-6';
const MOCKUP_MODEL = process.env.ECOMMERCE_MOCKUPS_IMAGE_MODEL || 'fal-ai/nano-banana';

const client = new Anthropic();

// Stable system prompt. Must NOT contain timestamps/UUIDs/per-request data
// or the prompt cache prefix invalidates on every request.
const SYSTEM_PROMPT = `You are a senior e-commerce creative director for Art of Galaxy, an AI-services agency.

You take a structured intake form for an E-Commerce Mockups engagement (Amazon, Shopify, Etsy, WooCommerce, etc.) and produce a personalized creative brief PLUS exactly 6 distinct image-generation prompts for the production model (fal.ai Flux / nano-banana). The frontend will render the brief on the project page and the 6 generated images as a downloadable mockup grid.

Your output must:
- Be specific and actionable, never generic.
- NEVER use em dashes (—) or double-dashes (--) anywhere. They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Reflect the client's actual platforms, product, claims, target customer, and visual style. Do not echo their inputs back verbatim; translate them into designer-quality language.
- For platform_specs: include ONLY the platforms the client selected. Amazon main image is square JPEG (3000x3000, 96 DPI, pure white background, product fills 85%+). Shopify benefits from 2048x2048 PDP + 4096x2048 hero banner. Etsy 2700x2025 lifestyle-friendly. WooCommerce mirrors Shopify but theme-driven.
- For claims_strip: surface 3 to 5 punchy short claims (3 to 6 words each) the user can see at a glance. If the client wrote longer claims, distill them.
- For target_customer_label: 1 short sentence (under 18 words) describing the ideal buyer.

THE 6 MOCKUPS (CRITICAL):
You MUST produce EXACTLY 6 mockup entries, in this canonical order, regardless of what the client selected. Each must include label, platform (Amazon / Shopify / Both / first selected platform), description, and a fal.ai-ready prompt with the product, key claim, background style, palette, and composition baked in. Headlines and claim overlays inside the images MUST all be different across the 6 entries. The 6 mockups are:
  1. Hero on white     (Amazon main image: pure white background, product hero, no text overlay)
  2. Branded color hero (Branded color background, bold typography hero, headline as overlay)
  3. Lifestyle scene   (Real-world environment showing the product in use, atmospheric lighting)
  4. Feature highlights (Infographic style: product centered with 3 callout badges of the top claims)
  5. Homepage banner   (Shopify/site banner aspect-leaning composition, 4096x2048 feel, headline overlay)
  6. Packaging flat-lay (Overhead arrangement showing the product, packaging, and a hero claim card)

Skip platforms the client did not pick when assigning platform tags, but ALWAYS deliver all 6 mockups so the deliverable feels complete.

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any prose, markdown, or commentary.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'executive_summary',
    'product_label',
    'target_customer_label',
    'claims_strip',
    'visual_style_labels',
    'mockup_type_labels',
    'platform_specs',
    'mockups',
    'production_notes',
    'next_steps',
  ],
  properties: {
    executive_summary: {
      type: 'string',
      description: '2 to 3 sentence overview of the mockup engagement and the recommended creative direction.',
    },
    product_label: {
      type: 'string',
      description: 'A short product description for the sidebar, 1 sentence under 20 words.',
    },
    target_customer_label: {
      type: 'string',
      description: 'Target buyer in one short sentence under 18 words.',
    },
    claims_strip: {
      type: 'array',
      items: { type: 'string' },
      description: '3 to 5 distilled short claims (3 to 6 words each) rendered as pill chips at the top of the mockup grid.',
    },
    visual_style_labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Background style chips for the sidebar, mirrors the client picks (e.g. "White / Transparent", "Lifestyle / Scene").',
    },
    mockup_type_labels: {
      type: 'array',
      items: { type: 'string' },
      description: 'Mockup type chips for the sidebar (e.g. "Hero image", "Feature highlights", "Lifestyle scenes").',
    },
    platform_specs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'image_specs', 'main_image_rules'],
        properties: {
          platform: { type: 'string', description: 'Platform name (Amazon, Shopify, Etsy, WooCommerce, or client other).' },
          image_specs: { type: 'string', description: 'Concrete pixel dims, aspect, format, color profile required.' },
          main_image_rules: { type: 'string', description: 'Hard rules for the primary listing image on this platform.' },
        },
      },
      description: 'One entry per platform the client picked. Omit unselected platforms.',
    },
    mockups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'platform', 'description', 'prompt'],
        properties: {
          id:          { type: 'string', description: 'Slug: hero_on_white, branded_color_hero, lifestyle_scene, feature_highlights, homepage_banner, packaging_flatlay.' },
          label:       { type: 'string', description: 'Short title shown in the card footer (e.g. "Hero on White").' },
          platform:    { type: 'string', description: 'Amazon, Shopify, Both, or whichever client platform fits best.' },
          description: { type: 'string', description: 'Two-line subtitle shown above the card icon (e.g. "Hero · Main image").' },
          prompt:      { type: 'string', description: 'Imperative fal.ai prompt: product + composition + palette + headline overlay if any. Distinct across the 6 mockups.' },
        },
      },
      description: 'EXACTLY 6 entries in the canonical order described in the system prompt.',
    },
    production_notes: {
      type: 'string',
      description: '1 to 2 sentence note for the sidebar model card, mentioning the image model used and the platform export targets.',
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
      content: `Here is the client's e-commerce mockups intake form. Generate the creative spec + 6 mockup prompts as JSON conforming to the schema.\n\n${userPayload}`,
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
  return String(value || 'ecom-mockup')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ecom-mockup';
}

// Image URLs from the client's uploaded product photos (and brand assets
// if any). These get passed to fal.ai as reference images so the generated
// mockups actually feature the client's product instead of a stand-in.
function uploadedImageUrls(form) {
  const buckets = [
    Array.isArray(form?.product_uploads) ? form.product_uploads : [],
    Array.isArray(form?.brand_assets)    ? form.brand_assets    : [],
  ];
  const urls = buckets
    .flat()
    .map((a) => (typeof a === 'string' ? a : a?.url))
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    .filter((u) => /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$|#)/i.test(u));
  return [...new Set(urls)].slice(0, 4);
}

function withReferenceImages(extras, model, urls) {
  const key = imageGeneration.imageInputKey(model);
  if (!key || !Array.isArray(urls) || urls.length === 0) return extras;
  if (key === 'image_urls') return { ...extras, image_urls: urls.slice(0, 3) };
  if (key === 'image_url')  return { ...extras, image_url: urls[0] };
  return extras;
}

// Generate one image per mockup prompt (parallel). Each mockup is a
// distinct scene so we never repeat the same composition.
async function generateMockupImages({ mockups, brandSlug, model, referenceImageUrls }) {
  const list = Array.isArray(mockups) ? mockups.filter((m) => m && m.prompt) : [];
  if (!list.length) return { model: model || MOCKUP_MODEL, images: [], errors: [] };

  const baseExtras = withReferenceImages(
    { aspect_ratio: '1:1', output_format: 'png' },
    model || MOCKUP_MODEL,
    referenceImageUrls
  );

  const results = await Promise.all(list.map(async (m, idx) => {
    try {
      const r = await imageGeneration.generateImages({
        prompt: m.prompt,
        model: model || MOCKUP_MODEL,
        num_images: 1,
        image_size: 'square_hd',
        extra_input: baseExtras,
      });
      const img = (r.images || [])[0];
      if (!img) return { idx, img: null, err: 'no image returned', resolvedModel: r.model };
      if (s3.isConfigured()) {
        try {
          const uploaded = await s3.uploadFromUrl(img.url, {
            prefix: `generated/ecommerce-mockups/${brandSlug}`,
            originalName: `${brandSlug}-${m.id || `mockup-${idx + 1}`}.png`,
          });
          return {
            idx,
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
          console.error('[ecommerce-mockups] failed to mirror image to S3:', mirrorErr.message || mirrorErr);
          return { idx, img, err: null, resolvedModel: r.model };
        }
      }
      return { idx, img, err: null, resolvedModel: r.model };
    } catch (err) {
      console.error(`[ecommerce-mockups] prompt ${idx + 1} failed:`, err.message || err);
      return { idx, img: null, err: err.message || String(err), resolvedModel: model || MOCKUP_MODEL };
    }
  }));

  // Preserve order: pair each mockup with its result.
  const images = results.map((r) => r.img);
  const errors = results.map((r) => r.err).filter(Boolean);
  const resolvedModel = results.find((r) => r.resolvedModel)?.resolvedModel || (model || MOCKUP_MODEL);
  return { model: resolvedModel, images, errors };
}

// ---------- Main entry ----------

async function generateEcommerceMockups({ form, requestedModel }) {
  const model = pickModel(requestedModel);
  const brandName = String(form?.brand_name || form?.product_name || '').trim() || 'Untitled Product';
  const brandSlug = safeBrandSlug(form?.product_name || brandName);

  // 1. Structured spec + 6 prompts from Claude.
  const { parsed: spec, stop_reason, usage } = await runClaudeSpec({ form, model });

  const mockupDefs = Array.isArray(spec.mockups) ? spec.mockups : [];

  // 2. Fire fal.ai for each of the 6 mockup prompts in parallel.
  const referenceImageUrls = uploadedImageUrls(form);
  const pack = await generateMockupImages({
    mockups: mockupDefs,
    brandSlug,
    model: MOCKUP_MODEL,
    referenceImageUrls,
  });

  // Merge the generated image URL onto each mockup entry so the frontend
  // can render the card grid in the canonical 6-card order without
  // re-aligning by index.
  const mockupsWithImages = mockupDefs.map((m, i) => {
    const img = pack.images[i] || null;
    return {
      id: m.id || `mockup-${i + 1}`,
      label: m.label || `Mockup ${i + 1}`,
      platform: m.platform || '',
      description: m.description || '',
      prompt: m.prompt || '',
      url: img?.url || null,
      content_type: img?.content_type || null,
      original_url: img?.original_url || null,
    };
  });

  return {
    model,
    image_model: pack.model,
    stop_reason,
    usage,
    mockups: {
      ...spec,
      mockups: mockupsWithImages,
    },
    errors: pack.errors.length ? pack.errors : undefined,
  };
}

module.exports = {
  generateEcommerceMockups,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
