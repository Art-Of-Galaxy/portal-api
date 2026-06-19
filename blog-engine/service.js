// Blog Engine: generate a single SEO/GEO/AEO-optimized article via
// Claude, then optionally generate a featured image via fal.ai.
//
// The user can also pass a custom featured image URL (uploaded via
// the portal's file uploader) or one or more reference image URLs
// that the fal.ai image model will condition on (great when they want
// the featured image to match a brand-asset style).

const Anthropic = require('@anthropic-ai/sdk');
const imageGeneration = require('../helper/image_generation');
const s3 = require('../helper/s3_storage');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.BLOG_ENGINE_MODEL || 'claude-sonnet-4-6';
const IMAGE_MODEL = process.env.BLOG_ENGINE_IMAGE_MODEL || 'fal-ai/nano-banana';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are the AOG Blog Engine, a senior SEO + GEO + AEO writer for Art of Galaxy clients publishing on Shopify.

You take a structured brief (brand, primary keyword, intent, voice, length, optional notes) and produce a publish-ready article spec.

Your output MUST:
- Be specific, evidence-led, and on-voice. Never generic.
- NEVER use em dashes (—) or double-dashes (--). They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Target the keyword naturally: in the H1, the first 100 words, at least one H2, and meta tags. Do not stuff.
- Match the requested length (short 600-900 words, standard 1,200-1,600, long 2,000+, or auto = match intent).
- Always include a 3 to 5 question FAQ block at the end with concise answers (these become FAQ schema).
- Body must be valid semantic HTML using <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <a> only. No inline styles. No <script>. No <img> in body (the featured image is handled separately).
- For internal link suggestions, output them as <a href="{{INTERNAL:slug-or-keyword}}"> placeholders; the publisher replaces these later or leaves them as deferred TODOs.
- Meta title: <= 60 chars. Meta description: 140 to 158 chars, written to drive click-through.
- URL handle: lowercase, hyphenated, no stop words, primary keyword first.
- Tags: 3 to 6 short topic tags.

You will be given:
1. The JSON brief.
2. The JSON output schema.

Respond ONLY with JSON conforming to the schema.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title',
    'kicker',
    'handle',
    'meta_title',
    'meta_description',
    'tags',
    'lead',
    'body_html',
    'faqs',
    'image_prompt',
    'seo_score',
    'word_count',
  ],
  properties: {
    title: { type: 'string', description: 'H1, click-worthy, includes the primary keyword.' },
    kicker: { type: 'string', description: 'Short category-style kicker shown above the H1 (3 to 5 words).' },
    handle: { type: 'string', description: 'URL handle, lowercase hyphenated.' },
    meta_title: { type: 'string', description: 'SEO title tag, <= 60 chars.' },
    meta_description: { type: 'string', description: 'SEO description, 140 to 158 chars.' },
    tags: { type: 'array', items: { type: 'string' }, description: '3 to 6 topic tags, lowercase.' },
    lead: { type: 'string', description: 'Opening lead paragraph, 1 to 2 sentences, hooks the reader.' },
    body_html: { type: 'string', description: 'The article body as valid semantic HTML (excluding the lead and FAQ block which are returned separately).' },
    faqs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer'],
        properties: {
          question: { type: 'string' },
          answer:   { type: 'string' },
        },
      },
      description: '3 to 5 FAQ items rendered as FAQ schema and an FAQ section at the end of the body.',
    },
    image_prompt: {
      type: 'string',
      description: 'A fal.ai image prompt for the featured image. Specific composition + mood + palette + subject matching the article. No on-image text.',
    },
    internal_link_suggestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 5 internal-link anchor phrases the publisher can wire to the right collection / product / other article.',
    },
    seo_score: { type: 'integer', description: 'Self-graded 0-100 SEO score for the spec.' },
    word_count: { type: 'integer', description: 'Approximate word count of body_html (excluding lead and FAQs).' },
  },
};

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

function safeBrandSlug(value) {
  return String(value || 'article')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'article';
}

// Returns up to 3 https image URLs the user uploaded as references.
function referenceImageUrls(brief) {
  const refs = []
    .concat(Array.isArray(brief?.reference_images) ? brief.reference_images : [])
    .concat(Array.isArray(brief?.brand_assets) ? brief.brand_assets : [])
    .map((a) => (typeof a === 'string' ? a : a?.url))
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    .filter((u) => /\.(png|jpe?g|webp|gif|bmp|svg)(\?|$|#)/i.test(u));
  return [...new Set(refs)].slice(0, 3);
}

function withReferenceImages(extras, model, urls) {
  const key = imageGeneration.imageInputKey(model);
  if (!key || !Array.isArray(urls) || urls.length === 0) return extras;
  if (key === 'image_urls') return { ...extras, image_urls: urls.slice(0, 3) };
  if (key === 'image_url')  return { ...extras, image_url: urls[0] };
  return extras;
}

async function runClaude({ brief, model }) {
  const system = [
    { type: 'text', text: SYSTEM_PROMPT },
    {
      type: 'text',
      text: `Output schema (the JSON you return MUST conform):\n${JSON.stringify(OUTPUT_SCHEMA)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: `Brief:\n${JSON.stringify(brief, null, 2)}`,
    }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  return JSON.parse(textBlock.text);
}

// Generate a featured image via fal.ai unless the user gave us one.
// 16:9 landscape so it works well as a Shopify article featured image.
async function generateFeaturedImage({ prompt, brandSlug, brief }) {
  if (!prompt) return null;
  const refs = referenceImageUrls(brief);
  const extras = withReferenceImages({ aspect_ratio: '16:9', output_format: 'png' }, IMAGE_MODEL, refs);
  try {
    const r = await imageGeneration.generateImages({
      prompt,
      model: IMAGE_MODEL,
      num_images: 1,
      image_size: 'landscape_16_9',
      extra_input: extras,
    });
    const img = (r.images || [])[0];
    if (!img) return null;
    if (s3.isConfigured()) {
      try {
        const uploaded = await s3.uploadFromUrl(img.url, {
          prefix: `generated/blog-engine/${brandSlug}`,
          originalName: `${brandSlug}-featured.png`,
        });
        return { url: uploaded.url, content_type: uploaded.contentType || 'image/png', original_url: img.url };
      } catch (err) {
        console.error('[blog-engine] image mirror failed:', err.message || err);
      }
    }
    return { url: img.url, content_type: img.content_type || 'image/png' };
  } catch (err) {
    console.error('[blog-engine] image gen failed:', err.message || err);
    return null;
  }
}

// Compose the final body HTML by gluing lead + body_html + FAQ block.
// Featured image is set via Shopify's Article.image, not inline in the
// body, so we don't insert it here.
function composeBodyHtml({ spec, customImageUrl }) {
  const parts = [];
  if (spec.lead) parts.push(`<p class="lead">${spec.lead}</p>`);
  // Optional: if the user uploaded a custom inline image, place it after
  // the lead. Inline alt text from the title for accessibility + SEO.
  if (customImageUrl) {
    parts.push(`<p><img src="${customImageUrl}" alt="${escapeHtml(spec.title || '')}" loading="lazy"/></p>`);
  }
  parts.push(spec.body_html || '');
  if (Array.isArray(spec.faqs) && spec.faqs.length) {
    parts.push('<h2>Frequently asked questions</h2>');
    spec.faqs.forEach((f) => {
      parts.push(`<p><strong>${escapeHtml(f.question)}</strong></p>`);
      parts.push(`<p>${escapeHtml(f.answer)}</p>`);
    });
    // FAQ schema as JSON-LD; Shopify renders it as-is in body.
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: spec.faqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    };
    parts.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  }
  return parts.join('\n');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function generateArticle({ brief, requestedModel }) {
  if (!brief || typeof brief !== 'object') throw Object.assign(new Error('brief is required'), { status: 400 });
  const keyword = String(brief.keyword || '').trim();
  if (!keyword) throw Object.assign(new Error('brief.keyword is required'), { status: 400 });
  const model = pickModel(requestedModel);
  const brandSlug = safeBrandSlug(brief.brand || keyword);

  const spec = await runClaude({ brief, model });

  // Image strategy:
  // 1. User-provided featured image URL wins.
  // 2. Otherwise, generate one with fal.ai using the spec's image_prompt
  //    plus any reference images they uploaded.
  let featured = null;
  if (brief.custom_featured_image_url) {
    featured = { url: brief.custom_featured_image_url, source: 'user' };
  } else {
    const gen = await generateFeaturedImage({
      prompt: spec.image_prompt,
      brandSlug,
      brief,
    });
    if (gen) featured = { ...gen, source: 'fal' };
  }

  const bodyHtml = composeBodyHtml({
    spec,
    customImageUrl: brief.inline_image_url || null,
  });

  return {
    model,
    image_model: IMAGE_MODEL,
    spec,
    featured,        // { url, content_type, source }
    body_html: bodyHtml,
  };
}

module.exports = {
  generateArticle,
  DEFAULT_MODEL,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
};
