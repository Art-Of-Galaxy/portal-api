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
const webScraper = require('../helper/web_scraper');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.BLOG_ENGINE_MODEL || 'claude-sonnet-4-6';
const IMAGE_MODEL = process.env.BLOG_ENGINE_IMAGE_MODEL || 'fal-ai/nano-banana';

// Toggle: when "true", the agent generates one fal.ai image per
// section in addition to the featured image. Off by default to keep
// fal.ai credit consumption predictable. Claude always writes the
// per-section image_prompt + image_alt in the spec, regardless of
// the toggle, so flipping it on later just starts producing images
// without needing a regenerate.
const INLINE_IMAGES_ENABLED = String(process.env.BLOG_ENGINE_INLINE_IMAGES || '').toLowerCase() === 'true';

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

PER-SECTION IMAGES
Every section must include an image_prompt and an image_alt, even though the publisher may or may not actually generate the image (controlled by an operator toggle). Write them as if they will be used:
- image_prompt: concrete subject + composition + mood + palette that mirrors the section heading. Suitable for fal.ai. No on-image text.
- image_alt: 8-14 words, describes the image and includes a contextual keyword naturally.

INFOGRAPHICS (data_visuals)
Add 1-3 infographic blocks where they genuinely help comprehension. Skip them if the topic does not call for one. Pick the type that fits:

- stat_grid: 3-4 numeric callouts side by side. Use when you have real numbers (percentages, durations, counts). items: [{value: "87%", label: "of users felt calmer", sub: "in a 4-week study"}]
- key_takeaways: 3-5 bullet summary placed near the end of the article. items: [{text: "Take ashwagandha at night for sleep support"}]
- process_steps: numbered steps with title + 1-sentence body. Use for "how to" sections. items: [{title: "Brew", body: "Steep one teabag in hot water for 5 minutes."}]
- pros_cons: two-column lists. Use when comparing one option's tradeoffs. items: [{label: "Pure formulation, no fillers", kind: "pro"}, {label: "Higher price per serving", kind: "con"}]
- comparison: header row + 2-4 product/option rows. Use the FIXED column keys col1/col2/col3/col4. items[0] is the header with column display names {label: "", col1: "Calm Stack", col2: "Focus Stack", col3: "Energy Stack"}, then each row {label: "Caffeine free", col1: "Yes", col2: "No", col3: "No"}.

Each visual needs:
- type: one of the 5 above
- title: short heading for the visual (e.g. "How adaptogens work", "Calm vs Focus vs Energy", "Key takeaways")
- place_after_anchor: a section anchor id from your sections array, OR "lead" for right after the lead, OR "before_faq" for just before the FAQ section.
- items: array shaped per the type above.

Do NOT pad: if the topic does not benefit from a visual of a given type, leave it out.

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
        required: ['heading', 'anchor', 'html', 'image_prompt', 'image_alt'],
        properties: {
          heading: { type: 'string', description: 'H2 heading text. Conversational + keyword-relevant.' },
          anchor: { type: 'string', description: 'URL fragment id (lowercase, hyphenated, no spaces) for the TOC link.' },
          html: { type: 'string', description: 'Section body HTML. Starts with a 50-80 word direct-answer <p>, then lists/tables/sub-headings. Allowed tags: p, h3, ul, ol, li, strong, em, a, table, thead, tbody, tr, th, td, figure, figcaption, blockquote. NO h1, h2, img, script, inline styles.' },
          image_prompt: { type: 'string', description: 'fal.ai prompt for an inline section image that visually represents the section heading. Concrete subject + composition + mood + palette. No on-image text.' },
          image_alt: { type: 'string', description: 'Alt text for the inline section image (8-14 words, includes contextual keyword naturally).' },
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
    data_visuals: {
      type: 'array',
      description: 'Infographic blocks the agent decides to insert into the article. Pick the type that fits the topic. Only include visuals that genuinely help the reader, do not pad. Aim for 1-3 per article.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'place_after_anchor', 'title', 'items'],
        properties: {
          type: {
            type: 'string',
            enum: ['stat_grid', 'key_takeaways', 'process_steps', 'pros_cons', 'comparison'],
            description: 'stat_grid: 3-4 numeric callouts. key_takeaways: 3-5 bullet summary. process_steps: numbered steps with titles + body. pros_cons: two-column lists. comparison: header row + product/option rows.',
          },
          place_after_anchor: {
            type: 'string',
            description: 'Where to insert the visual. Use a section anchor id, or "lead" to place right after the lead, or "before_faq" to place just before the FAQ.',
          },
          title: { type: 'string', description: 'Heading shown above the visual (e.g. "Key takeaways", "How it works"). Required.' },
          items: {
            type: 'array',
            description: 'Items inside the visual. Shape depends on type. stat_grid: [{value, label, sub?}]. key_takeaways: [{text}]. process_steps: [{title, body}]. pros_cons: [{label, kind: "pro"|"con"}]. comparison: first item is header [{label, ...columns}], rest are rows.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                // Shared / generic fields used across visual types.
                // Anthropic's structured output requires additionalProperties:false,
                // so we enumerate every key any visual type might use.
                // None are required individually; per-type validation
                // happens at render time in renderVisual().
                value:  { type: 'string', description: 'stat_grid: the big number/text.' },
                label:  { type: 'string', description: 'stat_grid/comparison: short label. pros_cons: the pro/con copy.' },
                sub:    { type: 'string', description: 'stat_grid: tiny sub-label under the number.' },
                text:   { type: 'string', description: 'key_takeaways: the bullet text.' },
                title:  { type: 'string', description: 'process_steps: step heading.' },
                body:   { type: 'string', description: 'process_steps: 1-sentence step explanation.' },
                kind:   { type: 'string', enum: ['pro', 'con'], description: 'pros_cons only.' },
                col1:   { type: 'string', description: 'comparison: column 1 cell value.' },
                col2:   { type: 'string', description: 'comparison: column 2 cell value.' },
                col3:   { type: 'string', description: 'comparison: column 3 cell value.' },
                col4:   { type: 'string', description: 'comparison: column 4 cell value.' },
              },
            },
          },
        },
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

async function runClaude({ brief, model, referenceScrape }) {
  // We used to pass the full OUTPUT_SCHEMA via output_config for
  // constrained decoding, but the schema grew large enough (sections +
  // data_visuals + faqs + cta_banner + author + schema + ...) that
  // Anthropic's grammar compiler started timing out with 400
  // "Grammar compilation timed out". Sonnet 4.6 reliably returns
  // valid JSON when instructed to via the system prompt, so we now
  // drop the strict mode and just ask for JSON conforming to the
  // documented schema. We still JSON.parse the text block and surface
  // a clear error if it's malformed.
  const system = [
    { type: 'text', text: SYSTEM_PROMPT },
    {
      type: 'text',
      text:
        `Output schema (the JSON you return MUST conform). Return ONLY the JSON, no surrounding prose, no markdown fences.\n`
        + JSON.stringify(OUTPUT_SCHEMA),
      cache_control: { type: 'ephemeral' },
    },
  ];
  // Build the user message. Reference website context (if any) goes
  // first so the writer treats it as background, then the brief.
  const userParts = [];
  if (referenceScrape) {
    userParts.push(webScraper.formatScrapeForPrompt(referenceScrape));
    userParts.push(
      'Use the reference website above for factual grounding, structural inspiration, and tone matching. '
      + 'DO NOT copy sentences verbatim. The article you generate must be original, longer-form, and SEO-optimized to the brief below. '
      + 'Cite or paraphrase facts when relevant. If the reference does not cover something needed by the brief, fall back on best-practice knowledge.'
    );
  }
  userParts.push(`Brief:\n${JSON.stringify(brief, null, 2)}`);

  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    messages: [{
      role: 'user',
      content: userParts.join('\n\n'),
    }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  const raw = String(textBlock.text || '').trim();
  // Strip an optional ```json ... ``` fence Claude sometimes wraps
  // around output despite the instruction.
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch (err) {
    console.error('[blog-engine] failed to JSON.parse model output:', err.message);
    console.error('[blog-engine] raw output (first 500 chars):', stripped.slice(0, 500));
    throw Object.assign(new Error('Article generation returned invalid JSON. Try again.'), { status: 502 });
  }
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

// Render one infographic block as semantic HTML. The Shopify theme is
// expected to style the .aog-viz-* classes, but the markup is sensible
// without any CSS so screenshots / RSS readers / plain rendering still
// look clean. All text is escaped to prevent prompt-injected HTML.
function renderVisual(visual) {
  if (!visual || !Array.isArray(visual.items) || !visual.items.length) return '';
  const title = visual.title ? `<h3 class="aog-viz-title">${escapeHtml(visual.title)}</h3>` : '';
  switch (visual.type) {
    case 'stat_grid': {
      const cells = visual.items.map((it) => `
        <div class="aog-stat">
          <span class="aog-stat-num">${escapeHtml(it.value || '')}</span>
          <span class="aog-stat-label">${escapeHtml(it.label || '')}</span>
          ${it.sub ? `<span class="aog-stat-sub">${escapeHtml(it.sub)}</span>` : ''}
        </div>`).join('');
      return `<aside class="aog-viz aog-viz-stat-grid">${title}<div class="aog-stat-row">${cells}</div></aside>`;
    }
    case 'key_takeaways': {
      const lis = visual.items.map((it) => `<li>${escapeHtml(it.text || '')}</li>`).join('');
      return `<aside class="aog-viz aog-viz-takeaways">${title}<ul>${lis}</ul></aside>`;
    }
    case 'process_steps': {
      const steps = visual.items.map((it, i) => `
        <li class="aog-step">
          <span class="aog-step-num">${i + 1}</span>
          <div class="aog-step-body">
            <strong>${escapeHtml(it.title || '')}</strong>
            ${it.body ? `<p>${escapeHtml(it.body)}</p>` : ''}
          </div>
        </li>`).join('');
      return `<aside class="aog-viz aog-viz-steps">${title}<ol class="aog-steps">${steps}</ol></aside>`;
    }
    case 'pros_cons': {
      const pros = visual.items.filter((it) => it.kind === 'pro').map((it) => `<li>${escapeHtml(it.label || '')}</li>`).join('');
      const cons = visual.items.filter((it) => it.kind === 'con').map((it) => `<li>${escapeHtml(it.label || '')}</li>`).join('');
      return `<aside class="aog-viz aog-viz-procons">${title}
        <div class="aog-procons-row">
          <div class="aog-procons-col aog-procons-pro"><h4>Pros</h4><ul>${pros}</ul></div>
          <div class="aog-procons-col aog-procons-con"><h4>Cons</h4><ul>${cons}</ul></div>
        </div></aside>`;
    }
    case 'comparison': {
      const [header, ...rows] = visual.items;
      if (!header) return '';
      const cols = Object.keys(header).filter((k) => k !== 'label');
      const thead = `<thead><tr><th></th>${cols.map((c) => `<th>${escapeHtml(header[c] || c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr><th scope="row">${escapeHtml(r.label || '')}</th>${cols.map((c) => `<td>${escapeHtml(r[c] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
      return `<aside class="aog-viz aog-viz-comparison">${title}<table class="aog-comparison">${thead}${tbody}</table></aside>`;
    }
    default:
      return '';
  }
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

  // Group infographic visuals by their place_after_anchor for easy
  // injection. Keys: "lead" (after the lead paragraph), section anchor
  // ids, and "before_faq" (just before the FAQ block).
  const visuals = Array.isArray(spec.data_visuals) ? spec.data_visuals : [];
  const visualsByAnchor = visuals.reduce((acc, v) => {
    const key = anchorSlug(v.place_after_anchor || 'lead') || 'lead';
    if (!acc[key]) acc[key] = [];
    acc[key].push(v);
    return acc;
  }, {});
  if (visualsByAnchor.lead) {
    visualsByAnchor.lead.forEach((v) => parts.push(renderVisual(v)));
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

  // 4. Sections with anchored H2s. Inline image (when generated) sits
  // between the H2 and the body so it acts as a visual anchor for the
  // section. Alt text comes from spec.image_alt for accessibility + SEO.
  // Infographic visuals matching this section's anchor are inserted at
  // the end of the section.
  if (sections.length) {
    sections.forEach((s) => {
      const anchor = anchorSlug(s.anchor || s.heading);
      parts.push(`<h2 id="${anchor}">${escapeHtml(s.heading)}</h2>`);
      if (s.image_url) {
        const alt = escapeHtml(s.image_alt || s.heading || '');
        parts.push(`<figure><img src="${escapeHtml(s.image_url)}" alt="${alt}" loading="lazy"/>${s.image_alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`);
      }
      parts.push(s.html || '');
      if (visualsByAnchor[anchor]) {
        visualsByAnchor[anchor].forEach((v) => parts.push(renderVisual(v)));
      }
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

  // Visuals slotted to render just before the FAQ block.
  if (visualsByAnchor.before_faq) {
    visualsByAnchor.before_faq.forEach((v) => parts.push(renderVisual(v)));
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

  // Optional: if the brief carries a reference URL, scrape it now and
  // pass the digest into Claude as context. Failure is non-fatal so a
  // bad URL doesn't block the article (we log and continue).
  let referenceScrape = null;
  if (brief.reference_url && String(brief.reference_url).trim()) {
    try {
      referenceScrape = await webScraper.scrapeReferenceUrl(brief.reference_url);
    } catch (err) {
      console.warn('[blog-engine] reference URL scrape failed (continuing without):', err.message || err);
    }
  }

  const spec = await runClaude({ brief, model, referenceScrape });

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

  // Inline section images: opt-in via BLOG_ENGINE_INLINE_IMAGES=true so
  // fal.ai credit consumption stays predictable. When off, sections are
  // text-only; alt + prompt fields are still in the spec so flipping the
  // env on later starts generating without needing a regenerate.
  if (INLINE_IMAGES_ENABLED && Array.isArray(spec.sections) && spec.sections.length) {
    try {
      spec.sections = await generateSectionImages({
        sections: spec.sections,
        brandSlug,
        brief,
      });
    } catch (err) {
      console.warn('[blog-engine] section image batch failed (continuing text-only):', err.message || err);
    }
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

// Generate one inline image per section in parallel, bounded to avoid
// burning credits / rate limits. Skips silently per section if fal.ai
// errors so the article still publishes. Returns a copy of sections[]
// with `image_url` and `image_content_type` attached where successful.
async function generateSectionImages({ sections, brandSlug, brief }) {
  if (!Array.isArray(sections) || !sections.length) return sections || [];
  const out = sections.map((s) => ({ ...s }));
  const CONCURRENCY = 3;
  let next = 0;
  async function worker() {
    while (true) {
      const my = next; next += 1;
      if (my >= out.length) return;
      const s = out[my];
      if (!s.image_prompt) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await imageGeneration.generateImages({
          prompt: s.image_prompt,
          model: IMAGE_MODEL,
          num_images: 1,
          image_size: 'landscape_16_9',
          extra_input: withReferenceImages({ aspect_ratio: '16:9', output_format: 'png' }, IMAGE_MODEL, referenceImageUrls(brief)),
        });
        const img = (r.images || [])[0];
        if (!img?.url) continue;
        if (s3.isConfigured()) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const uploaded = await s3.uploadFromUrl(img.url, {
              prefix: `generated/blog-engine/${brandSlug}/sections`,
              originalName: `${brandSlug}-section-${my + 1}.png`,
            });
            s.image_url = uploaded.url;
            s.image_content_type = uploaded.contentType || 'image/png';
            continue;
          } catch (mirrorErr) {
            console.warn('[blog-engine] section image S3 mirror failed:', mirrorErr.message || mirrorErr);
          }
        }
        s.image_url = img.url;
        s.image_content_type = img.content_type || 'image/png';
      } catch (err) {
        console.warn(`[blog-engine] section ${my + 1} image gen failed (continuing without):`, err.message || err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, out.length) }, () => worker()));
  return out;
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
