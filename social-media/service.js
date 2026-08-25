// Social Media Studio core service.
//
// Generates a structured content spec via Claude for each content type
// (carousel, reel, post, thumbnail, profile, batch). The spec includes
// everything the preview screen needs: headlines, slide narrative,
// scene script, caption, hashtags, and a fal.ai prompt for the cover
// or main image. We generate the cover image inline so the preview
// shows real artwork; videos for Reels are generated later, at publish
// time, because they're expensive.

const Anthropic = require('@anthropic-ai/sdk');
const imageGeneration = require('../helper/image_generation');
const s3 = require('../helper/s3_storage');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.SOCIAL_MEDIA_MODEL || 'claude-sonnet-4-6';
const IMAGE_MODEL = process.env.SOCIAL_MEDIA_IMAGE_MODEL || 'fal-ai/nano-banana';

const client = new Anthropic();

const ALLOWED_TYPES = new Set(['carousel', 'reel', 'post', 'thumbnail', 'profile', 'batch']);
const ALLOWED_PLATFORMS = new Set(['instagram', 'facebook', 'youtube']);

// Style rules we want every Claude response to follow. Kept short and
// stable so the prompt cache stays warm across requests.
const STYLE_RULES = `Style rules you MUST follow in every reply:
- Be specific and actionable, never generic. Every line should feel written by a senior brand social editor, not a content mill.
- NEVER use em dashes (—) or double-dashes (--). They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Captions: open with a scroll-stopping first line (the "hook") that works even when Instagram truncates after ~125 characters. Then short punchy paragraphs, line breaks between thoughts, one clear CTA at the end. Write in the brand's voice, calibrated to the goal (awareness, engagement, sales, authority). No corporate filler, no "In today's fast-paced world".
- Hashtags: 5 to 8 short, relevant tags. Mix one or two brand tags with 3 to 5 niche tags. No spammy hashtag clouds.
- IMAGE PROMPT QUALITY BAR (critical): every image prompt must describe a finished, premium social graphic, not a stock photo. Include ALL of: (1) the exact on-image text rendered verbatim and its typographic treatment (weight, scale, placement), (2) the composition and layout grid, (3) the color palette with specific hues, (4) the subject or visual metaphor, (5) lighting and texture cues (soft studio light, grain, gradient mesh, editorial flat-lay, etc). Aim for the look of a top-tier DTC brand feed: confident typography, generous negative space, consistent palette. Mention nothing about Instagram, Facebook, or AOG.
- When reference images are provided in the brief, mirror their palette, mood, and product presentation. The user gave them as ground truth for how the brand should look.`;

// ---------- Per-type system prompts + JSON schemas ----------

const CAROUSEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'tag', 'slides', 'caption', 'hashtags', 'cover_prompt', 'palette'],
  properties: {
    headline: { type: 'string', description: 'Cover slide headline, 4 to 8 words.' },
    tag:      { type: 'string', description: 'Short pre-headline tag (e.g. "Swipe →", "New drop").' },
    slides: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tag', 'headline', 'body', 'image_prompt'],
        properties: {
          tag:      { type: 'string', description: '2 to 4 word slide eyebrow.' },
          headline: { type: 'string', description: '3 to 7 word slide headline.' },
          body:     { type: 'string', description: '1 to 2 sentence body copy, under 180 chars.' },
          image_prompt: {
            type: 'string',
            description: 'fal.ai prompt for THIS slide’s full design, 4:5 portrait. Must include: the slide headline text rendered verbatim as the dominant typographic element, the body copy as smaller supporting text, the shared visual system (same palette, same font feel, same layout grid as the cover), plus the slide-specific subject or metaphor. These render as finished social graphics, not photos with text slapped on.',
          },
        },
      },
      description: 'EXACTLY the requested slide count, in narrative order. Slide 1 in this array is the SECOND card the viewer sees (the cover_prompt image is the first).',
    },
    caption:      { type: 'string', description: 'Caption for the post, 2 to 5 short paragraphs, friendly + on-voice. Open with a hook line that mirrors the cover headline.' },
    hashtags:     { type: 'array', items: { type: 'string' }, description: '5 to 8 hashtags with the # prefix.' },
    cover_prompt: { type: 'string', description: 'fal.ai prompt for the carousel COVER image (card 1 of the carousel). 4:5 portrait. Mention the on-image headline verbatim, make it the hero element. Must establish the visual system (palette, typography feel, layout) every slide prompt then repeats.' },
    palette:      { type: 'string', description: 'CSS gradient string for the slide backgrounds, e.g. "linear-gradient(150deg,#0f766e,#134e4a)".' },
  },
};

const REEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hook', 'scenes', 'caption', 'hashtags', 'cover_prompt', 'video_prompt', 'duration_sec'],
  properties: {
    hook:     { type: 'string', description: '3 to 7 word scroll-stopper that overlays the cover.' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['range', 'on_screen', 'voiceover'],
        properties: {
          range:     { type: 'string', description: 'Time range, e.g. "0 to 3s".' },
          on_screen: { type: 'string', description: 'What the viewer sees on screen.' },
          voiceover: { type: 'string', description: 'What the voiceover or narrator says.' },
        },
      },
      description: '4 to 6 scenes spanning the reel duration.',
    },
    caption:      { type: 'string', description: 'Reel caption, 1 to 3 short paragraphs, voice-led.' },
    hashtags:     { type: 'array', items: { type: 'string' }, description: '5 to 8 hashtags with the # prefix.' },
    cover_prompt: { type: 'string', description: 'fal.ai prompt for the reel cover thumbnail. Vertical 9:16.' },
    video_prompt: { type: 'string', description: 'Higgsfield marketing_studio_video prompt for the actual reel.' },
    duration_sec: { type: 'integer', description: 'Final video duration in seconds (15 to 60).' },
  },
};

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'sub', 'tag', 'caption', 'hashtags', 'cover_prompt', 'palette', 'format'],
  properties: {
    headline:     { type: 'string', description: '4 to 8 word headline overlayed on the image.' },
    sub:          { type: 'string', description: 'Short supporting line under the headline.' },
    tag:          { type: 'string', description: 'Eyebrow tag, e.g. "New drop", "Stat" 2 to 3 words.' },
    caption:      { type: 'string', description: 'Caption, 2 to 4 short paragraphs.' },
    hashtags:     { type: 'array', items: { type: 'string' }, description: '5 to 8 hashtags with the # prefix.' },
    cover_prompt: { type: 'string', description: 'fal.ai prompt for the post image. Square or 4:5 portrait.' },
    palette:      { type: 'string', description: 'CSS gradient fallback if the image fails.' },
    format:       { type: 'string', description: 'Either "square" or "portrait".' },
  },
};

const THUMBNAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kicker', 'title', 'cover_prompt'],
  properties: {
    kicker:       { type: 'string', description: 'Pre-title kicker, e.g. "30 DAY TEST". All caps.' },
    title:        { type: 'string', description: '3 to 6 word title, all caps, in two lines if needed.' },
    cover_prompt: { type: 'string', description: 'fal.ai prompt for the 16:9 thumbnail. Massive legible text, high contrast.' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mark', 'cover_prompt'],
  properties: {
    mark:         { type: 'string', description: 'Single character or short monogram for the avatar.' },
    cover_prompt: { type: 'string', description: 'fal.ai prompt for the 1:1 profile image.' },
  },
};

const BATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['theme', 'posts'],
  properties: {
    theme: { type: 'string', description: 'Short 1 sentence summary of the weekly theme.' },
    posts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'time', 'content_type', 'brief'],
        properties: {
          day:          { type: 'string', description: 'Day-of-week label like "Mon".' },
          time:         { type: 'string', description: 'Recommended publish time HH:MM in 24h.' },
          content_type: { type: 'string', description: 'One of carousel, reel, post, thumbnail.' },
          brief:        { type: 'string', description: 'A 1 to 2 sentence topic for that post.' },
        },
      },
      description: 'Exactly the requested number of posts.',
    },
  },
};

const SCHEMAS = {
  carousel:  CAROUSEL_SCHEMA,
  reel:      REEL_SCHEMA,
  post:      POST_SCHEMA,
  thumbnail: THUMBNAIL_SCHEMA,
  profile:   PROFILE_SCHEMA,
  batch:     BATCH_SCHEMA,
};

function systemPromptFor(type) {
  return `You are the AOG Social Media Agent at Art of Galaxy, an Instagram-first content studio. You produce publish-ready, premium Instagram content that looks like it came from a top-tier DTC brand's in-house design team.

You take a structured brief (brand, topic, goal, tone, content type, target slide count) and produce a publish-ready ${type} spec.

${STYLE_RULES}

CAROUSEL VISUAL SYSTEM (when type is carousel):
- The cover and every slide must share ONE visual system: same palette, same typographic voice, same layout grid. A viewer swiping through should feel like they're reading one designed document, not a random image dump.
- The cover is the thumbnail that earns the tap: dominant headline, high contrast, minimal clutter.
- Each slide advances the narrative: eyebrow tag, one headline idea, short supporting body. The final slide should carry the CTA.

You will be given:
1. A JSON brief. It may include reference_images the user uploaded; treat their look as the brand's ground truth.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output, no prose.`;
}

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

function assertType(t) {
  if (!ALLOWED_TYPES.has(t)) {
    throw Object.assign(new Error(`Unknown content_type: ${t}`), { status: 400 });
  }
}

async function runClaude({ type, brief, model }) {
  assertType(type);
  const schema = SCHEMAS[type];
  const system = [
    { type: 'text', text: systemPromptFor(type) },
    {
      type: 'text',
      text: `Output schema (the JSON you return MUST conform):\n${JSON.stringify(schema)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system,
    messages: [{
      role: 'user',
      content: `Brief:\n${JSON.stringify({ content_type: type, ...brief }, null, 2)}`,
    }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  return JSON.parse(textBlock.text);
}

// ---------- Image generation for covers ----------

function safeSlug(value) {
  return String(value || 'social')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'social';
}

function uploadedReferenceUrls(brief) {
  const urls = []
    .concat(Array.isArray(brief?.product_uploads) ? brief.product_uploads : [])
    .concat(Array.isArray(brief?.brand_assets) ? brief.brand_assets : [])
    .concat(Array.isArray(brief?.reference_images) ? brief.reference_images : [])
    .map((a) => (typeof a === 'string' ? a : a?.url))
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  return [...new Set(urls)].slice(0, 3);
}

function withReferenceImages(extras, model, urls) {
  const key = imageGeneration.imageInputKey(model);
  if (!key || !Array.isArray(urls) || urls.length === 0) return extras;
  if (key === 'image_urls') return { ...extras, image_urls: urls.slice(0, 3) };
  if (key === 'image_url')  return { ...extras, image_url: urls[0] };
  return extras;
}

// Aspect ratio per content type so fal.ai gets the right canvas.
const ASPECT_BY_TYPE = {
  carousel:  { aspect_ratio: '4:5',  image_size: 'square_hd' },
  reel:      { aspect_ratio: '9:16', image_size: 'portrait_16_9' },
  post:      { aspect_ratio: '1:1',  image_size: 'square_hd' },
  thumbnail: { aspect_ratio: '16:9', image_size: 'landscape_16_9' },
  profile:   { aspect_ratio: '1:1',  image_size: 'square_hd' },
};

async function generateCoverImage({ type, prompt, brandSlug, brief }) {
  if (!prompt) return null;
  const aspect = ASPECT_BY_TYPE[type] || ASPECT_BY_TYPE.post;
  const refs = uploadedReferenceUrls(brief);
  const extras = withReferenceImages({ ...aspect, output_format: 'png' }, IMAGE_MODEL, refs);
  try {
    const r = await imageGeneration.generateImages({
      prompt,
      model: IMAGE_MODEL,
      num_images: 1,
      image_size: aspect.image_size,
      extra_input: extras,
    });
    const img = (r.images || [])[0];
    if (!img) return null;
    if (s3.isConfigured()) {
      try {
        const uploaded = await s3.uploadFromUrl(img.url, {
          prefix: `generated/social-media/${brandSlug}/${type}`,
          originalName: `${brandSlug}-${type}-cover.png`,
        });
        return { url: uploaded.url, content_type: uploaded.contentType || 'image/png', original_url: img.url };
      } catch (err) {
        console.error('[social-media] cover mirror failed:', err.message || err);
      }
    }
    return { url: img.url, content_type: img.content_type || 'image/png' };
  } catch (err) {
    console.error('[social-media] cover image failed:', err.message || err);
    return null;
  }
}

// Generate one image per carousel slide in parallel (bounded). Each
// slide's image_prompt comes from the spec. Failures are per-slide
// soft: a slide without an image renders as a text-on-gradient card in
// the preview and is skipped at publish time. Returns an array aligned
// with spec.slides: [{ url, content_type } | null, ...].
async function generateSlideImages({ slides, brandSlug, brief }) {
  if (!Array.isArray(slides) || !slides.length) return [];
  const aspect = ASPECT_BY_TYPE.carousel;
  const refs = uploadedReferenceUrls(brief);
  const extras = withReferenceImages({ ...aspect, output_format: 'png' }, IMAGE_MODEL, refs);
  const out = new Array(slides.length).fill(null);
  const CONCURRENCY = 3;
  let next = 0;
  async function worker() {
    while (true) {
      const my = next; next += 1;
      if (my >= slides.length) return;
      const prompt = slides[my]?.image_prompt;
      if (!prompt) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await imageGeneration.generateImages({
          prompt,
          model: IMAGE_MODEL,
          num_images: 1,
          image_size: aspect.image_size,
          extra_input: extras,
        });
        const img = (r.images || [])[0];
        if (!img?.url) continue;
        if (s3.isConfigured()) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const uploaded = await s3.uploadFromUrl(img.url, {
              prefix: `generated/social-media/${brandSlug}/carousel`,
              originalName: `${brandSlug}-slide-${my + 2}.png`,
            });
            out[my] = { url: uploaded.url, content_type: uploaded.contentType || 'image/png' };
            continue;
          } catch (mirrorErr) {
            console.error('[social-media] slide mirror failed:', mirrorErr.message || mirrorErr);
          }
        }
        out[my] = { url: img.url, content_type: img.content_type || 'image/png' };
      } catch (err) {
        console.error(`[social-media] slide ${my + 1} image failed (continuing):`, err.message || err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slides.length) }, () => worker()));
  return out;
}

// ---------- Main entry ----------

async function generateContent({ brief, requestedModel }) {
  if (!brief || typeof brief !== 'object') {
    throw Object.assign(new Error('brief is required'), { status: 400 });
  }
  const contentType = String(brief.content_type || '').toLowerCase();
  assertType(contentType);
  const platforms = (Array.isArray(brief.platforms) ? brief.platforms : [])
    .map((p) => String(p).toLowerCase())
    .filter((p) => ALLOWED_PLATFORMS.has(p));
  const model = pickModel(requestedModel);
  const brandSlug = safeSlug(brief.brand || brief.brand_name);

  const spec = await runClaude({ type: contentType, brief: { ...brief, platforms }, model });

  // Generate the cover image now so the preview screen has something
  // real to render. Videos for Reels are deferred until publish time.
  //
  // If fal.ai fails (credits exhausted, rate-limited, model gated)
  // we fall back to the FIRST image the user uploaded with the brief.
  // That way the saved post always has a usable cover_url and the
  // publisher never needs to retry image generation. The user can
  // still swap the image later via the preview screen if they want.
  let cover = null;
  let coverSource = null;
  if (spec.cover_prompt && contentType !== 'batch') {
    cover = await generateCoverImage({
      type: contentType,
      prompt: spec.cover_prompt,
      brandSlug,
      brief,
    });
    if (cover?.url) coverSource = 'fal';
  }
  if (!cover?.url) {
    const uploaded = uploadedReferenceUrls(brief);
    if (uploaded.length) {
      cover = { url: uploaded[0], content_type: null };
      coverSource = 'user_upload';
      console.warn('[social-media] cover generation skipped/failed, using uploaded brief image as cover');
    }
  }

  // Carousels: one designed image per slide, generated at brief time so
  // (a) the preview shows the real finished cards and (b) publish never
  // has to touch fal.ai. Aligned with spec.slides by index.
  let slideImages = [];
  if (contentType === 'carousel' && Array.isArray(spec.slides) && spec.slides.length) {
    try {
      slideImages = await generateSlideImages({ slides: spec.slides, brandSlug, brief });
    } catch (err) {
      console.error('[social-media] slide image batch failed (continuing with cover only):', err.message || err);
      slideImages = [];
    }
  }

  return {
    model,
    image_model: IMAGE_MODEL,
    content_type: contentType,
    platforms,
    spec,
    cover, // { url, content_type } or null
    cover_source: coverSource, // 'fal' | 'user_upload' | null
    slide_images: slideImages, // carousel only; aligned with spec.slides, null gaps allowed
  };
}

module.exports = {
  ALLOWED_TYPES: Array.from(ALLOWED_TYPES),
  ALLOWED_PLATFORMS: Array.from(ALLOWED_PLATFORMS),
  generateContent,
  generateCoverImage,
  DEFAULT_MODEL,
};
