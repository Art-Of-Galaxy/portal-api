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

const SYSTEM_PROMPT = `You are the AOG Blog Engine, a senior SEO + GEO + AEO writer for Art of Galaxy clients publishing to Shopify.

You take a structured brief (brand, primary keyword, intent, voice, length, optional notes) and produce a publish-ready article spec that hits the full 2026 technical SEO checklist.

VOICE + COPY RULES
- Be specific, evidence-led, and on-voice. Never generic.
- NEVER use em dashes (—) or double-dashes (--). They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Conversational, direct, helpful. Write like you are explaining to one smart customer, not a search engine.
- Match the requested length: short 600-900 words, standard 1,200-1,600, long 2,000+, or auto = match the search intent.

URL + META
- URL handle: lowercase, hyphenated, primary keyword first, no stop words, no dates. e.g. "kitchen-remodeling-tampa-guide" not "blog/2024/05/our-guide-to-kitchen-remodeling".
- Meta title: <= 60 chars, primary keyword near the front, CTR-focused.
- Meta description: 140-158 chars, written to drive click-through, ends with a soft CTA.
- Open Graph title + description match the meta title + description.

HEADING + STRUCTURE
- Exactly ONE H1 (the title field). Body must NOT contain an H1.
- Proper H2 then H3 hierarchy. Every section starts with an H2.
- Primary keyword appears in: H1, the lead (first 100 words), at least one H2, meta title, and meta description.
- Include conversational, question-style H2s for GEO/AEO ("How does X work?", "What is X used for?").

CONTENT BLOCKS (return as the sections array)
Required structure of a great Shopify product/info blog:
1. Hook lead (the lead field): 1-2 sentence opener that answers the user intent in plain English (AEO win).
2. Sections (5-8): each with a clear H2, a 50-80 word direct-answer paragraph at the top, then deeper detail (lists, sub-headings, tables where useful).
3. At least one comparison or spec table when the topic supports it (use semantic <table><thead><tbody>).
4. Bullet/numbered lists for any steps or feature breakdowns.
5. Internal links: use <a href="{{INTERNAL:slug-or-keyword}}">anchor</a> placeholders for 2-5 contextually relevant links.

HTML RULES (for section.html and lead)
- Allowed tags: p, h2, h3, ul, ol, li, strong, em, a, table, thead, tbody, tr, th, td, figure, figcaption, blockquote.
- NO inline styles. NO <script>. NO <img>. NO <h1>.
- All <a> must have a meaningful anchor text (not "click here").

FAQ (always)
- 4-6 questions. Real questions a buyer would ask, not throwaway. Concise, direct answers (40-80 words each). These become FAQPage schema.

CTA BANNER (always)
- One in-body CTA banner. Heading is a benefit, body is one sentence, button text is action verb + value.

EEAT
- author_name: a believable named expert from the brand team (e.g. "Maya R., {Brand} Editorial").
- author_bio: 1 sentence about their angle.

GEO + AEO
- Lead paragraph answers the search intent in the first 1-2 sentences.
- Each section starts with a 2-3 sentence direct answer paragraph.
- FAQ section provides snippet-friendly answers.

TAGS
- 4-6 short topic tags, lowercase.

You will be given:
1. The JSON brief.
2. The JSON output schema.

Respond ONLY with valid JSON conforming to the schema. No prose outside the JSON.`;

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
    'sections',
    'faqs',
    'cta_banner',
    'image_prompt',
    'hero_alt',
    'author_name',
    'author_bio',
    'schema_type',
    'reading_time_minutes',
    'seo_score',
    'word_count',
  ],
  properties: {
    title: { type: 'string', description: 'H1, click-worthy, includes the primary keyword.' },
    kicker: { type: 'string', description: 'Short category-style kicker shown above the H1 (3 to 5 words).' },
    handle: { type: 'string', description: 'URL handle, lowercase hyphenated, primary keyword first, no dates.' },
    meta_title: { type: 'string', description: 'SEO title tag, <= 60 chars, keyword near front.' },
    meta_description: { type: 'string', description: 'SEO description, 140 to 158 chars, ends with soft CTA.' },
    tags: { type: 'array', items: { type: 'string' }, description: '4 to 6 lowercase topic tags.' },
    lead: { type: 'string', description: 'Opening lead paragraph (1-2 sentences) that answers the search intent directly. Wrap in <p> tags.' },
    sections: {
      type: 'array',
      description: '5-8 content sections. Each is an H2 with structured HTML body.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'anchor', 'html'],
        properties: {
          heading: { type: 'string', description: 'H2 heading text. Conversational + keyword-relevant.' },
          anchor: { type: 'string', description: 'URL fragment id (lowercase, hyphenated, no spaces) for the TOC link.' },
          html: { type: 'string', description: 'Section body HTML. Starts with a 50-80 word direct-answer <p>, then lists/tables/sub-headings. Allowed tags: p, h3, ul, ol, li, strong, em, a, table, thead, tbody, tr, th, td, figure, figcaption, blockquote. NO h1, h2, img, script, inline styles.' },
        },
      },
    },
    faqs: {
      type: 'array',
      description: '4 to 6 FAQ items rendered as FAQPage schema + an FAQ section at the end.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'answer'],
        properties: {
          question: { type: 'string' },
          answer:   { type: 'string' },
        },
      },
    },
    cta_banner: {
      type: 'object',
      additionalProperties: false,
      required: ['heading', 'body', 'button_text'],
      properties: {
        heading: { type: 'string', description: 'One-line benefit headline.' },
        body: { type: 'string', description: 'One sentence elaborating the value.' },
        button_text: { type: 'string', description: 'Action verb + value (e.g. "Shop the Calm Stack").' },
        button_url: { type: 'string', description: 'Optional internal URL placeholder, e.g. "{{INTERNAL:calm-stack}}". May be empty.' },
      },
    },
    image_prompt: {
      type: 'string',
      description: 'A fal.ai image prompt for the featured image. Specific composition + mood + palette + subject. No on-image text.',
    },
    hero_alt: {
      type: 'string',
      description: 'Alt text for the featured image. Describes the image AND includes the primary keyword naturally. 8-14 words.',
    },
    author_name: { type: 'string', description: 'Believable named author, e.g. "Maya R., {Brand} Editorial".' },
    author_bio:  { type: 'string', description: 'One sentence about the author perspective or expertise.' },
    schema_type: {
      type: 'string',
      enum: ['BlogPosting', 'Article', 'HowTo', 'Review'],
      description: 'Best-matching schema.org type for this article.',
    },
    reading_time_minutes: { type: 'integer', description: 'Estimated read time at 220 wpm.' },
    internal_link_suggestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 5 internal-link anchor phrases the publisher can wire to the right collection / product / other article.',
    },
    seo_score: { type: 'integer', description: 'Self-graded 0-100 SEO score for the spec.' },
    word_count: { type: 'integer', description: 'Approximate total word count across lead + all section.html + faqs.' },
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

// Slugify a heading into an anchor id we can use for the TOC.
function anchorSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Build the article body that Shopify will render. Order matches the
// 2026 SEO checklist's recommended blog layout:
//   1. Hero stats strip (reading time + author + date)
//   2. Lead paragraph (direct-answer for AEO)
//   3. Table of Contents (anchor links to each section H2)
//   4. Sections (H2 + anchored content)
//   5. In-body CTA banner
//   6. FAQ section + FAQPage schema
//   7. All other JSON-LD schemas (BlogPosting, BreadcrumbList, Organization)
//
// shopContext (optional) is what the publisher passes once it knows the
// shop / blog / article handle. Without it we render the FAQ schema only;
// with it we render the full BlogPosting + Breadcrumb + Organization.
function composeBodyHtml({ spec, customImageUrl, shopContext, featuredUrl, publishedIso }) {
  const parts = [];
  const articleType = ['Article', 'BlogPosting', 'HowTo', 'Review'].includes(spec.schema_type)
    ? spec.schema_type
    : 'BlogPosting';

  // 1. Stats strip (Shopify themes also render author + date, but we
  //    include reading time inline because most themes don't compute it).
  const statBits = [];
  if (spec.reading_time_minutes) statBits.push(`${spec.reading_time_minutes} min read`);
  if (spec.author_name) statBits.push(`By ${escapeHtml(spec.author_name)}`);
  if (statBits.length) {
    parts.push(`<p class="article-meta"><em>${statBits.join(' &middot; ')}</em></p>`);
  }

  // 2. Lead
  if (spec.lead) parts.push(`<p class="lead">${spec.lead}</p>`);

  // Optional inline image right after the lead
  if (customImageUrl) {
    parts.push(`<figure><img src="${customImageUrl}" alt="${escapeHtml(spec.hero_alt || spec.title || '')}" loading="lazy"/></figure>`);
  }

  // 3. Table of contents from sections[]
  const sections = Array.isArray(spec.sections) ? spec.sections : [];
  if (sections.length >= 3) {
    parts.push('<nav class="article-toc"><h2>In this article</h2><ul>');
    sections.forEach((s) => {
      const anchor = anchorSlug(s.anchor || s.heading);
      parts.push(`<li><a href="#${anchor}">${escapeHtml(s.heading)}</a></li>`);
    });
    parts.push('</ul></nav>');
  }

  // 4. Sections with anchored H2s
  if (sections.length) {
    sections.forEach((s) => {
      const anchor = anchorSlug(s.anchor || s.heading);
      parts.push(`<h2 id="${anchor}">${escapeHtml(s.heading)}</h2>`);
      parts.push(s.html || '');
    });
  } else if (spec.body_html) {
    // Backward compatibility for older spec shape (no sections[]).
    parts.push(spec.body_html);
  }

  // 5. In-body CTA banner
  const cta = spec.cta_banner;
  if (cta && cta.heading) {
    parts.push('<aside class="article-cta">');
    parts.push(`<h3>${escapeHtml(cta.heading)}</h3>`);
    if (cta.body) parts.push(`<p>${escapeHtml(cta.body)}</p>`);
    if (cta.button_text) {
      const href = cta.button_url || '#';
      parts.push(`<p><a class="article-cta-btn" href="${escapeHtml(href)}">${escapeHtml(cta.button_text)}</a></p>`);
    }
    parts.push('</aside>');
  }

  // 6. FAQ block
  if (Array.isArray(spec.faqs) && spec.faqs.length) {
    parts.push('<h2 id="faq">Frequently asked questions</h2>');
    spec.faqs.forEach((f) => {
      parts.push(`<h3>${escapeHtml(f.question)}</h3>`);
      parts.push(`<p>${escapeHtml(f.answer)}</p>`);
    });
  }

  // 7. JSON-LD schemas. FAQPage is always rendered if we have FAQs.
  // BlogPosting + BreadcrumbList + Organization need shopContext so the
  // publisher rewires the body before publish.
  const ldBlocks = [];
  if (Array.isArray(spec.faqs) && spec.faqs.length) {
    ldBlocks.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: spec.faqs.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    });
  }
  if (shopContext?.shopDomain) {
    const articleUrl = shopContext.articleUrl
      || `https://${shopContext.primaryDomain || shopContext.shopDomain}/blogs/${shopContext.blogHandle || 'news'}/${spec.handle || ''}`;
    const baseUrl = `https://${shopContext.primaryDomain || shopContext.shopDomain}`;
    const orgName = shopContext.shopName || shopContext.shopDomain;
    ldBlocks.push({
      '@context': 'https://schema.org',
      '@type': articleType,
      headline: spec.title,
      description: spec.meta_description,
      image: featuredUrl ? [featuredUrl] : undefined,
      datePublished: publishedIso || new Date().toISOString(),
      dateModified: publishedIso || new Date().toISOString(),
      author: spec.author_name ? {
        '@type': 'Person',
        name: spec.author_name,
        description: spec.author_bio || undefined,
      } : undefined,
      publisher: {
        '@type': 'Organization',
        name: orgName,
        url: baseUrl,
        logo: shopContext.logoUrl ? {
          '@type': 'ImageObject',
          url: shopContext.logoUrl,
        } : undefined,
      },
      mainEntityOfPage: {
        '@type': 'WebPage',
        '@id': articleUrl,
      },
    });
    ldBlocks.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
        { '@type': 'ListItem', position: 2, name: (shopContext.blogTitle || 'Blog'), item: `${baseUrl}/blogs/${shopContext.blogHandle || 'news'}` },
        { '@type': 'ListItem', position: 3, name: spec.title, item: articleUrl },
      ],
    });
    ldBlocks.push({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: orgName,
      url: baseUrl,
      logo: shopContext.logoUrl || undefined,
    });
  }
  ldBlocks.forEach((ld) => {
    parts.push(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
  });

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

// Standalone featured-image regeneration. Used by the Preview screen's
// "Regenerate" button when the user wants a new fal.ai image without
// re-running the whole article. Takes the existing image_prompt (or a
// user override) + the same reference image plumbing as the initial
// generation. Mirrors to S3 when configured so the URL is permanent.
async function regenerateFeaturedImage({ prompt, brand, referenceImageUrls = [] } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw Object.assign(new Error('prompt is required'), { status: 400 });
  }
  const brandSlug = safeBrandSlug(brand || 'article');
  const brief = { reference_images: referenceImageUrls };
  const featured = await generateFeaturedImage({ prompt, brandSlug, brief });
  if (!featured?.url) {
    throw Object.assign(new Error('Image generation returned no image'), { status: 502 });
  }
  return { ...featured, source: 'fal' };
}

module.exports = {
  generateArticle,
  regenerateFeaturedImage,
  composeBodyHtml,
  DEFAULT_MODEL,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
};
