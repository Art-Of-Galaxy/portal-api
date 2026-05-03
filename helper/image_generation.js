// Reusable fal.ai image-generation wrapper.
// Any service that needs to render images (logo design, packaging mockups,
// e-commerce hero shots, etc.) should call generateImages() here instead of
// hitting fal-ai directly, so we keep credential handling and model gating
// in one place.

const { fal } = require('@fal-ai/client');

// Models we trust for production-style work. Add to this list deliberately —
// the per-service controllers should also pick a sensible default for their
// use case (e.g. recraft-v3 for logos, flux-pro for high-fidelity mockups).
const ALLOWED_MODELS = new Set([
  'fal-ai/recraft-v3',          // strong with text + logo / vector aesthetics
  'fal-ai/ideogram/v2',         // also strong with on-image text
  'fal-ai/flux/dev',            // general-purpose, fast iteration
  'fal-ai/flux/schnell',        // fastest, lower quality
  'fal-ai/flux-pro/v1.1',       // highest quality general purpose
  'fal-ai/flux-pro/v1.1-ultra', // very high quality
]);

const DEFAULT_MODEL = 'fal-ai/recraft-v3';

// Per-request image cap by model. fal.ai enforces these on its side so picking
// 8 from a model that allows 4 silently returns 4. We chunk to honor the user.
const MODEL_MAX_PER_REQUEST = {
  'fal-ai/recraft-v3': 6,
  'fal-ai/ideogram/v2': 4,
  'fal-ai/flux/dev': 4,
  'fal-ai/flux/schnell': 4,
  'fal-ai/flux-pro/v1.1': 4,
  'fal-ai/flux-pro/v1.1-ultra': 1,
};

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

  // Run sequentially: fal.ai rate-limits on burst, and the user is already
  // waiting for the loader UI either way. Sequential keeps the failure
  // surface small (we can return partial results if a later chunk dies).
  for (const chunkSize of chunks) {
    try {
      const r = await singleSubscribe(chosenModel, {
        ...baseInput,
        num_images: chunkSize,
      });
      if (r.request_id) requestIds.push(r.request_id);
      if (seed === null && r.seed != null) seed = r.seed;
      collected.push(...r.images);
    } catch (err) {
      errors.push(err?.message || String(err));
      // Don't abort: keep whatever earlier chunks produced.
    }
  }

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
};
