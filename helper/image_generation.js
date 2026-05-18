// Reusable fal.ai image-generation wrapper.
// Any service that needs to render images (logo design, packaging mockups,
// e-commerce hero shots, etc.) should call generateImages() here instead of
// hitting fal-ai directly, so we keep credential handling and model gating
// in one place.

const { fal } = require('@fal-ai/client');

// Models we trust for production-style work. Add to this list deliberately —
// the per-service controllers should also pick a sensible default for their
// use case (e.g. nano-banana / gpt-image-1 for logos, flux-pro for
// high-fidelity mockups).
const ALLOWED_MODELS = new Set([
  // Reference-image-aware (good for matching a style we show the model)
  'fal-ai/nano-banana',          // Google Gemini 2.5 Flash Image
  'fal-ai/gpt-image-1',          // OpenAI GPT Image 1
  'fal-ai/recraft-v3',           // logo / vector aesthetics with image_url

  // Text-to-image (no reference image input)
  'fal-ai/ideogram/v2',
  'fal-ai/ideogram/v3',
  'fal-ai/flux/dev',
  'fal-ai/flux/schnell',
  'fal-ai/flux-pro/v1.1',
  'fal-ai/flux-pro/v1.1-ultra',
]);

const DEFAULT_MODEL = 'fal-ai/nano-banana';

// Per-request image cap by model. We deliberately set most flux models to
// 1 even though their schemas accept `num_images` up to 4: in practice the
// endpoint frequently returns a single image regardless of the requested
// count, so we issue N separate calls instead. This guarantees the user
// gets the number of variants they asked for, each with its own seed.
const MODEL_MAX_PER_REQUEST = {
  'fal-ai/nano-banana': 1,
  'fal-ai/gpt-image-1': 1,
  'fal-ai/recraft-v3': 1,
  'fal-ai/ideogram/v2': 1,
  'fal-ai/ideogram/v3': 1,
  'fal-ai/flux/dev': 1,
  'fal-ai/flux/schnell': 1,
  'fal-ai/flux-pro/v1.1': 1,
  'fal-ai/flux-pro/v1.1-ultra': 1,
};

// Which models accept image inputs and under which schema key. Used by
// callers (e.g. logo-design service) to decide whether to forward the
// style reference URLs and what field name to use.
//   - "image_urls" : array  -> nano-banana, gpt-image-1, ideogram v3 redux variants
//   - "image_url"  : string -> recraft v3 (single style reference)
//   - null         : no image input supported
const MODEL_IMAGE_INPUT = {
  'fal-ai/nano-banana': 'image_urls',
  'fal-ai/gpt-image-1': 'image_urls',
  'fal-ai/recraft-v3':  'image_url',
};

function imageInputKey(model) {
  return MODEL_IMAGE_INPUT[model] || null;
}

// How many fal.ai calls to fire at once. fal queues + polls under the hood,
// so we don't want a wall of parallel requests slamming our IP-level quota.
// 4 is a good sweet spot for a logo grid: 4 variants come back in roughly
// the time a single call takes, and 8/12 variants finish in 2-3 waves.
const PARALLEL_CONCURRENCY = 4;

let configured = false;
function ensureConfigured() {
  if (configured) return;
  if (process.env.FAL_KEY) {
    fal.config({ credentials: process.env.FAL_KEY });
  }
  configured = true;
}

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

function maxPerRequest(model) {
  return MODEL_MAX_PER_REQUEST[model] || 4;
}

function isUsableImage(img) {
  return Boolean(img && typeof img.url === 'string' && /^https?:\/\//i.test(img.url));
}

async function singleSubscribe(model, input) {
  const result = await fal.subscribe(model, { input, logs: false });
  const data = result?.data || {};
  const images = Array.isArray(data.images) ? data.images : [];
  return {
    request_id: result?.requestId || null,
    seed: data.seed ?? null,
    images: images
      .filter(isUsableImage)
      .map((img) => ({
        url: img.url,
        width: img.width || null,
        height: img.height || null,
        content_type: img.content_type || null,
      })),
  };
}

/**
 * Generate one or more images via fal.ai, chunking across multiple requests
 * if the requested count exceeds the model's per-request limit.
 *
 * @param {object}   opts
 * @param {string}   opts.prompt       The text prompt.
 * @param {string=}  opts.model        A model id from ALLOWED_MODELS. Falls back to DEFAULT_MODEL.
 * @param {number=}  opts.num_images   How many images to generate. Default 1.
 * @param {string=}  opts.image_size   Named size or {width, height}. Default "square_hd".
 * @param {object=}  opts.extra_input  Model-specific extra params (style, aspect_ratio, etc.)
 * @returns {Promise<{model:string, request_ids:string[], images:Array<{url:string,width?:number,height?:number,content_type?:string}>, seed?:number, errors?:string[]}>}
 */
async function generateImages({
  prompt,
  model,
  num_images = 1,
  image_size = 'square_hd',
  extra_input = {},
} = {}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('image_generation.generateImages: prompt is required');
  }

  ensureConfigured();

  if (!process.env.FAL_KEY) {
    const err = new Error('FAL_KEY environment variable is not configured.');
    err.status = 503;
    throw err;
  }

  const chosenModel = pickModel(model);
  const total = Math.max(1, Math.min(12, Number(num_images) || 1));
  const cap = maxPerRequest(chosenModel);

  // Build the chunk plan: e.g. for 6 with cap 4 -> [4, 2].
  const chunks = [];
  let remaining = total;
  while (remaining > 0) {
    const take = Math.min(cap, remaining);
    chunks.push(take);
    remaining -= take;
  }

  const baseInput = {
    prompt: prompt.trim(),
    image_size,
    ...extra_input,
  };

  const collected = [];
  const requestIds = [];
  const errors = [];
  let seed = null;

  // Run chunks with bounded concurrency: each worker picks the next chunk
  // off the queue, so we have at most PARALLEL_CONCURRENCY in flight at
  // once. With chunk size 1, asking for 4 variants finishes in ~one call's
  // wall time instead of four-in-a-row.
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const my = nextIndex;
      nextIndex += 1;
      if (my >= chunks.length) return;
      try {
        const r = await singleSubscribe(chosenModel, {
          ...baseInput,
          num_images: chunks[my],
        });
        if (r.request_id) requestIds.push(r.request_id);
        if (seed === null && r.seed != null) seed = r.seed;
        collected.push(...r.images);
      } catch (err) {
        errors.push(err?.message || String(err));
      }
    }
  }

  const workerCount = Math.min(PARALLEL_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // If every chunk failed, surface the first error.
  if (collected.length === 0 && errors.length) {
    const err = new Error(errors[0]);
    err.status = 502;
    throw err;
  }

  return {
    model: chosenModel,
    request_ids: requestIds,
    request_id: requestIds[0] || null,
    images: collected,
    seed,
    errors: errors.length ? errors : undefined,
  };
}

module.exports = {
  generateImages,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
  MODEL_MAX_PER_REQUEST,
  MODEL_IMAGE_INPUT,
  imageInputKey,
};
