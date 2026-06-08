// UGC Ads generation. Takes a structured intake form, optionally a
// reference video, and produces a single Higgsfield Marketing Studio
// video.
//
// Flow:
//   1. Persist any local-disk product images / reference video the
//      frontend already uploaded to our portal storage.
//   2. Push the local files to Higgsfield via `higgsfield upload create`.
//   3. (optional) Wrap the reference video as an ad_reference and wait
//      for it to reach status=completed.
//   4. Compose a rich Higgsfield prompt from the form using Claude.
//   5. Call `higgsfield generate create marketing_studio_video --wait`.
//   6. Surface the result url to the caller; the controller mirrors
//      the video into S3 and persists project + file + usage.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const higgsfield = require('../helper/higgsfield_cli');

const anthropic = new Anthropic();
const PROMPT_MODEL = process.env.UGC_PROMPT_MODEL || 'claude-haiku-4-5';

// Higgsfield mode values the form is allowed to submit. Anything else
// gets coerced to the default UGC mode.
const ALLOWED_MODES = new Set([
  'ugc',
  'ugc_unboxing',
  'ugc_how_to',
  'product_review',
  'ugc_virtual_try_on',
  'product_showcase',
]);
const ALLOWED_ASPECT = new Set(['9:16', '1:1', '16:9']);
const ALLOWED_RESOLUTION = new Set(['480p', '720p', '1080p']);
const ALLOWED_DURATIONS = new Set([10, 15, 20, 30]);

// Per-mode hint sprinkled into the system prompt so Claude tailors the
// language for that style of ad without us repeating it on the
// frontend. Kept tight so it doesn't dominate the user's brief.
const MODE_GUIDE = {
  ugc:                'Casual phone-filmed organic feel, handheld, candid.',
  ugc_unboxing:       'Unboxing reaction style; user opens packaging on camera.',
  ugc_how_to:         'Quick tutorial / how-to explainer with clear step beats.',
  product_review:     'Testimonial / interview style; foam-windscreen microphone in frame, word-by-word captions, street-interview energy.',
  ugc_virtual_try_on: 'Trying-on style; presenter physically interacts with / wears the product.',
  product_showcase:   'Polished brand showcase; clean studio look, controlled lighting, slow camera moves.',
};

const SYSTEM_PROMPT = `You are a senior performance-creative director who writes prompts for the Higgsfield Marketing Studio video model.

You are given a structured brief from a client form and must produce ONE Higgsfield prompt string for a single continuous take.

Rules:
- Output 1 to 3 dense paragraphs of natural English. No JSON, no markdown, no bullet points.
- Never use em dashes (—) or double-dash (--). Use a period, comma, colon, parentheses, "and" or "or".
- Be specific about: setting, time of day, presenter (age range, vibe, ethnicity if specified, wardrobe energy), camera style (handheld, static, dolly), how the product appears in frame, and the story arc beat by beat for the requested duration.
- If the mode is product_review or has interview vibes, explicitly include the foam-windscreen microphone in frame, candid handheld feel, and white serif word-by-word captions lower-center.
- Mention the product by its real name from the brief. Do NOT invent a different brand.
- End with an explicit product reveal beat ("she holds the can/bottle/box up toward the camera as a clean product reveal" or similar).
- If a reference video is being attached as an ad_reference, write the prompt assuming that style will dominate; emphasise putting the SPECIFIC product in that format.

You will be given the form fields as JSON. Respond with ONLY the prompt string. Do not include any other text.`;

function pickMode(value) {
  return ALLOWED_MODES.has(value) ? value : 'ugc';
}
function pickAspect(value) {
  return ALLOWED_ASPECT.has(value) ? value : '9:16';
}
function pickResolution(value) {
  return ALLOWED_RESOLUTION.has(value) ? value : '720p';
}
function pickDuration(value) {
  const n = Number(value);
  return ALLOWED_DURATIONS.has(n) ? n : 15;
}

function safeString(value, max = 600) {
  return String(value || '').trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

async function downloadToTemp(url, hintExt) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const ext = hintExt || (() => {
    try {
      const p = new URL(url).pathname;
      const m = p.match(/\.([a-zA-Z0-9]{2,5})$/);
      return m ? `.${m[1].toLowerCase()}` : '.bin';
    } catch { return '.bin'; }
  })();
  const tmpPath = path.join(os.tmpdir(), `aog-ugc-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  const res = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    res.data.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return tmpPath;
}

async function composePrompt({ form, mode, hasAdReference }) {
  const briefForLlm = {
    product_name: form.product_name,
    product_description: form.product_description,
    style_mode: mode,
    style_hint: MODE_GUIDE[mode] || MODE_GUIDE.ugc,
    duration_seconds: form.duration,
    aspect_ratio: form.aspect_ratio,
    tone: safeArray(form.tone),
    target_audience: form.target_audience,
    key_message: form.key_message,
    talking_points: form.talking_points,
    reference_links: safeArray(form.reference_links),
    has_ad_reference_video: Boolean(hasAdReference),
  };

  const completion = await anthropic.messages.create({
    model: PROMPT_MODEL,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `Brief JSON:\n${JSON.stringify(briefForLlm, null, 2)}\n\nReturn the Higgsfield prompt string now.` },
    ],
  });
  const text = (completion.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();

  // Defensive em-dash strip — the rest of the portal style rule applies.
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+--\s+/g, ', ')
    .replace(/--/g, '-');
}

async function uploadAssetsToHiggsfield({ productImageUrls, referenceVideoUrl }) {
  const tempPaths = [];
  const cleanups = [];
  try {
    // Product images: download each to a temp file, then upload to higgsfield.
    const imageUploadIds = [];
    for (const url of productImageUrls) {
      const tmp = await downloadToTemp(url);
      if (!tmp) continue;
      tempPaths.push(tmp);
      const up = await higgsfield.uploadFile(tmp);
      if (up?.id) imageUploadIds.push(up.id);
    }

    // Optional reference video → ad_reference.
    let adReferenceId = null;
    if (referenceVideoUrl) {
      const tmp = await downloadToTemp(referenceVideoUrl);
      if (tmp) {
        tempPaths.push(tmp);
        const up = await higgsfield.uploadFile(tmp);
        if (up?.id) {
          const ref = await higgsfield.createAdReferenceFromVideo(up.id);
          if (ref?.id) {
            const finished = await higgsfield.waitForAdReferenceReady(ref.id, {
              intervalMs: 6000,
              timeoutMs: 10 * 60 * 1000,
            });
            if (finished?.status === 'completed') {
              adReferenceId = ref.id;
            }
          }
        }
      }
    }

    cleanups.push(() => tempPaths.forEach((p) => {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }));

    return { imageUploadIds, adReferenceId, cleanup: () => cleanups.forEach((fn) => fn()) };
  } catch (err) {
    cleanups.push(() => tempPaths.forEach((p) => {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }));
    cleanups.forEach((fn) => fn());
    throw err;
  }
}

async function generateUgcAd({ form }) {
  if (!form || typeof form !== 'object') {
    throw Object.assign(new Error('Missing "form" object in request body'), { status: 400 });
  }
  const productName = safeString(form.product_name);
  const productDescription = safeString(form.product_description, 800);
  if (!productName) {
    throw Object.assign(new Error('product_name is required'), { status: 400 });
  }
  if (!productDescription || productDescription.length < 8) {
    throw Object.assign(new Error('product_description is too short'), { status: 400 });
  }

  const productImageUrls = safeArray(form.product_image_urls).map(safeString).filter(Boolean);
  if (!productImageUrls.length) {
    throw Object.assign(new Error('At least one product image is required'), { status: 400 });
  }

  const mode = pickMode(form.mode);
  const aspectRatio = pickAspect(form.aspect_ratio);
  const duration = pickDuration(form.duration);
  const resolution = pickResolution(form.resolution);
  const generateAudio = form.generate_audio !== false;

  // Normalize for the LLM brief.
  const normalizedForm = {
    product_name: productName,
    product_description: productDescription,
    mode,
    aspect_ratio: aspectRatio,
    duration,
    resolution,
    generate_audio: generateAudio,
    tone: safeArray(form.tone).map(safeString).filter(Boolean).slice(0, 4),
    target_audience: safeString(form.target_audience, 240),
    key_message: safeString(form.key_message, 240),
    talking_points: safeString(form.talking_points, 600),
    reference_links: safeArray(form.reference_links).map(safeString).filter(Boolean),
  };

  // Upload images / build ad reference.
  const referenceVideoUrl = safeString(form.reference_video_url) || null;
  const upload = await uploadAssetsToHiggsfield({
    productImageUrls,
    referenceVideoUrl,
  });

  let result;
  try {
    const prompt = await composePrompt({
      form: normalizedForm,
      mode,
      hasAdReference: Boolean(upload.adReferenceId),
    });

    const job = await higgsfield.generateMarketingStudioVideo({
      prompt,
      imageUploadIds: upload.imageUploadIds,
      adReferenceId: upload.adReferenceId,
      mode,
      aspectRatio,
      duration,
      resolution,
      generateAudio,
    });

    // The CLI returns an array of jobs; pick the first.
    const item = Array.isArray(job) ? job[0] : job;
    if (!item || item.status === 'failed') {
      throw Object.assign(new Error(item?.fail_reason || 'Higgsfield generation failed'), {
        status: 502,
        higgsfield_response: item,
      });
    }
    const videoUrl = item?.result_url || item?.params?.result_url || '';
    if (!videoUrl) {
      throw Object.assign(new Error('Higgsfield returned no result_url'), {
        status: 502,
        higgsfield_response: item,
      });
    }

    result = {
      prompt,
      job_id: item.id,
      model: 'marketing_studio_video',
      mode,
      aspect_ratio: aspectRatio,
      duration,
      resolution,
      generate_audio: generateAudio,
      video: {
        url: videoUrl,
        content_type: 'video/mp4',
      },
      ad_reference_id: upload.adReferenceId || null,
      image_upload_ids: upload.imageUploadIds,
      raw: item,
    };
  } finally {
    if (typeof upload.cleanup === 'function') {
      upload.cleanup();
    }
  }

  return result;
}

module.exports = {
  generateUgcAd,
  ALLOWED_MODES: Array.from(ALLOWED_MODES),
  ALLOWED_ASPECT: Array.from(ALLOWED_ASPECT),
  ALLOWED_RESOLUTION: Array.from(ALLOWED_RESOLUTION),
};
