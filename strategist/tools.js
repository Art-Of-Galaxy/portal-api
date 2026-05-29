// Tools the AI Manager (and any future domain) can call during a turn.
// Each tool has an Anthropic-compatible JSON schema definition and an
// executor function. The executor receives { userEmail } so it can scope
// reads to the calling user.

const { poll } = require('../config/dbconfig');
const logoDesignService = require('../logo-design/service');
const usageService = require('../usage/service');
const fileService = require('../files/service');
const notionService = require('../notion/service');
const s3 = require('../helper/s3_storage');

const TOOL_DEFINITIONS = {
  generate_logo_design: {
    name: 'generate_logo_design',
    description:
      "Generate logo concept images for the client INSIDE THE CHAT. Call this once you've collected at least the brand_name and a one-line business_description from the user. You do NOT need every optional field, sensible defaults are fine. Returns a project_id plus the generated image URLs which the chat will render inline as cards. Use this instead of redirecting the user to the logo design page unless they explicitly ask for the custom form.",
    input_schema: {
      type: 'object',
      required: ['brand_name', 'business_description'],
      properties: {
        brand_name:           { type: 'string', description: 'Exact brand name to render on the logo.' },
        tagline:              { type: 'string', description: 'Optional tagline / slogan.' },
        business_description: { type: 'string', description: 'One or two sentences on what the brand does and who it serves.' },
        logo_style: {
          type: 'string',
          enum: ['vintage', 'mascot', 'wordmark', 'monogram', 'combination', 'minimalist'],
          description: 'Visual style direction. Pick the best fit from the conversation, do not ask the user to choose from this list verbatim.',
        },
        selected_colors: {
          type: 'array',
          items: { type: 'string', enum: ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'teal', 'grey'] },
          description: 'Color families the brand should lean into.',
        },
        custom_colors: {
          type: 'array',
          items: { type: 'string', description: 'Hex color like #1A4FB0' },
          description: 'Specific hex codes the brand uses, if the user provided any.',
        },
        selected_typography: {
          type: 'array',
          items: { type: 'string', enum: ['serif', 'sans', 'script', 'modern', 'display', 'condensed'] },
        },
        additional_notes: { type: 'string', description: 'Anything else from the conversation worth conditioning on.' },
        num_images:       { type: 'integer', minimum: 1, maximum: 4, description: 'Number of concepts to generate (default 4).' },
      },
    },
  },
  get_user_profile: {
    name: 'get_user_profile',
    description:
      "Returns the calling client's portal profile (name, email, brand / company name, industry, business description, social handles, goals, services they're interested in, and any onboarding context they provided). Use this when you need to personalise the conversation, recall what business they run, or recommend a service tailored to them. Cheap, idempotent, safe to call once at the start of a topic.",
    input_schema: { type: 'object', properties: {} },
  },
  list_user_projects: {
    name: 'list_user_projects',
    description:
      "Returns the calling client's most recent projects from the AOG portal. Use this when the user asks 'what am I working on', 'where did I leave off', 'show me my projects', or any similar question about their portfolio inside the portal. Returns up to 10 projects with id, name, service_type, status name, and the date they were last updated.",
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'How many projects to return (default 10).',
        },
      },
    },
  },
  list_user_files: {
    name: 'list_user_files',
    description:
      "Returns the calling client's most recently uploaded or generated files (logos, mockups, brand guideline exports, etc.). Use when the user asks about their assets, references, or wants to find an earlier upload. Returns up to 10 files with name, url, category, service_type, and source ('upload' or 'generated').",
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'How many files to return (default 10).',
        },
      },
    },
  },
};

async function execute_get_user_profile({ userEmail }) {
  if (!userEmail) return { note: 'No user_email available, cannot scope profile.' };
  const rows = await poll.query(
    `SELECT id, name, email, phone, dob, profile_photo_url, onboarding_data, is_admin, created_at
       FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1`,
    [userEmail]
  );
  const row = (rows || [])[0];
  if (!row) return { note: 'No profile row found for this user.' };
  return {
    name: row.name,
    email: row.email,
    phone: row.phone || null,
    profile_photo_url: row.profile_photo_url || null,
    is_admin: Boolean(row.is_admin),
    member_since: row.created_at,
    // onboarding_data is a free-form JSONB blob captured during signup
    // — keep the model-facing structure shallow so it can read it.
    onboarding: row.onboarding_data || null,
  };
}

async function execute_list_user_projects({ userEmail, input }) {
  if (!userEmail) return { rows: [], note: 'No user_email available, cannot scope projects.' };
  const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 25);
  const rows = await poll.query(
    `SELECT p.id, p.project_name, p.service_type, p.category, p.created_date, s.name AS status
       FROM tbl_projects p
       LEFT JOIN project_status s ON s.id = p.status
      WHERE p.user_email = $1 AND p.is_delete = 0
      ORDER BY p.id DESC
      LIMIT $2`,
    [userEmail, limit]
  );
  return {
    count: (rows || []).length,
    projects: (rows || []).map((r) => ({
      id: r.id,
      name: r.project_name,
      service_type: r.service_type,
      category: r.category,
      status: r.status || 'In Progress',
      created_date: r.created_date,
    })),
  };
}

async function execute_list_user_files({ userEmail, input }) {
  if (!userEmail) return { rows: [], note: 'No user_email available, cannot scope files.' };
  const limit = Math.min(Math.max(Number(input?.limit) || 10, 1), 25);
  const rows = await poll.query(
    `SELECT id, file_name, url, category, service_type, source, mime_type, created_at
       FROM tbl_files
      WHERE user_email = $1 AND is_delete = 0
      ORDER BY id DESC
      LIMIT $2`,
    [userEmail, limit]
  );
  const files = (rows || []).map((r) => ({
    id: r.id,
    name: r.file_name,
    url: r.url,
    category: r.category,
    service_type: r.service_type,
    source: r.source || 'upload',
    mime_type: r.mime_type || null,
    created_at: r.created_at,
  }));
  return {
    count: files.length,
    files,
    // The runTurn loop will hoist this onto the assistant message so the
    // chat renders these files as inline cards (image thumbs + names).
    // Hidden from the model's reply text (it just needs to know the
    // count, not re-paste URLs).
    _attachment: files.length ? {
      type: 'file_list',
      title: 'Your recent files',
      files: files.slice(0, 12),
    } : null,
  };
}

function safeBrandSlug(value) {
  return String(value || 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'logo';
}

function inferExtensionFromContentType(contentType, fallbackUrl) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif',
  };
  if (map[ct]) return map[ct];
  if (ct.includes('/')) {
    const tail = ct.split('/')[1].split('+')[0].replace(/[^a-z0-9]/g, '');
    if (tail) return tail === 'jpeg' ? 'jpg' : tail;
  }
  if (typeof fallbackUrl === 'string') {
    const m = fallbackUrl.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m) return m[1].toLowerCase();
  }
  return 'png';
}

// Reject obvious placeholder strings the LLM sometimes invents when it
// hasn't actually collected a brief yet. Generating with "Your Brand"
// produces useless output and confuses the end user, so we fail loudly
// and the manager has to go back and ask for the real name.
const PLACEHOLDER_BRAND_NAMES = new Set([
  'your brand', 'brand', 'the brand', 'brand name', 'placeholder',
  'company', 'company name', 'test', 'test brand', 'example', 'example brand',
  'sample', 'sample brand', 'tbd', 'tba', 'n/a', 'na',
]);
function isPlaceholderBrandName(name) {
  const lower = String(name || '').trim().toLowerCase();
  if (!lower) return true;
  return PLACEHOLDER_BRAND_NAMES.has(lower);
}

async function execute_generate_logo_design({ userEmail, input }) {
  const brandName = String(input?.brand_name || '').trim();
  const businessDescription = String(input?.business_description || '').trim();
  if (!brandName || isPlaceholderBrandName(brandName)) {
    return {
      error: 'brand_name looks like a placeholder. Ask the user for the real brand name before calling this tool again.',
    };
  }
  if (!businessDescription || businessDescription.length < 8) {
    return {
      error: 'business_description is missing or too short. Ask the user to describe what the brand does (one sentence) before calling this tool again.',
    };
  }

  const form = {
    brand_name: brandName,
    tagline: input?.tagline || '',
    business_description: businessDescription,
    logo_style: input?.logo_style || '',
    selected_colors: Array.isArray(input?.selected_colors) ? input.selected_colors : [],
    custom_colors: Array.isArray(input?.custom_colors) ? input.custom_colors : [],
    selected_typography: Array.isArray(input?.selected_typography) ? input.selected_typography : [],
    reference_links: [],
    reference_uploads: [],
    competitor_links: [],
    competitor_names: '',
    additional_notes: input?.additional_notes || '',
  };

  const numImages = Math.min(Math.max(Number(input?.num_images) || 4, 1), 4);

  try {
    const result = await logoDesignService.generateLogoDesign({
      form,
      numImages,
    });

    // Mirror to S3 so URLs persist past fal.ai's CDN expiry.
    const brandSlug = safeBrandSlug(brandName);
    let images = result.images || [];
    if (s3.isConfigured()) {
      images = await Promise.all(
        images.map(async (img, idx) => {
          try {
            const ext = inferExtensionFromContentType(img.content_type, img.url);
            const uploaded = await s3.uploadFromUrl(img.url, {
              prefix: `generated/logo-design/${brandSlug}`,
              originalName: `${brandSlug}-concept-${idx + 1}.${ext}`,
            });
            return {
              ...img,
              url: uploaded.url,
              content_type: uploaded.contentType || img.content_type || null,
              original_url: img.url,
            };
          } catch (mirrorErr) {
            console.error('[strategist] failed to mirror logo image to S3:', mirrorErr.message || mirrorErr);
            return img;
          }
        })
      );
    }

    // Persist as a project + per-image file rows so the assets show up in
    // My Files / My Projects exactly like the form flow does.
    let projectId = null;
    try {
      projectId = await notionService.save_service_request({
        projectName: brandName,
        category: 'Branding & Design',
        serviceType: 'logo_design',
        userEmail: userEmail || null,
        inputData: form,
        outputData: { prompt: result.prompt, seed: result.seed, images },
        model: result.model,
      });
    } catch (persistErr) {
      console.error('[strategist] failed to persist generated project:', persistErr.message || persistErr);
    }

    if (Array.isArray(images) && images.length) {
      try {
        await Promise.all(
          images.map((img, idx) => {
            const ext = inferExtensionFromContentType(img.content_type, img.url);
            return fileService.recordFile({
              projectId,
              projectName: brandName,
              fileName: `${brandName}-concept-${idx + 1}.${ext}`,
              url: img.url,
              userEmail: userEmail || null,
              category: 'Branding & Design',
              serviceType: 'logo_design',
              source: 'generated',
              mimeType: img.content_type || `image/${ext === 'jpg' ? 'jpeg' : ext}`,
            });
          })
        );
      } catch (fileErr) {
        console.error('[strategist] failed to persist generated files:', fileErr.message || fileErr);
      }
    }

    // Record credit usage best-effort.
    usageService.recordUsage({
      userEmail: userEmail || null,
      kind: 'image',
      model: result.model,
      service: 'logo_design',
      units: images.length,
      meta: { project_id: projectId, source: 'strategist' },
    }).catch(() => { /* logged downstream */ });

    return {
      ok: true,
      project_id: projectId,
      model: result.model,
      // The runTurn loop reads `images` and `attachment` to surface them
      // as inline cards in the chat.
      images: images.map((img, idx) => ({
        url: img.url,
        content_type: img.content_type,
        label: `Concept ${idx + 1}`,
      })),
      _attachment: {
        type: 'logo_concepts',
        project_id: projectId,
        brand_name: brandName,
        images: images.map((img, idx) => ({ url: img.url, label: `Concept ${idx + 1}` })),
      },
      summary: `Generated ${images.length} logo concept${images.length === 1 ? '' : 's'} for ${brandName}.`,
    };
  } catch (err) {
    return { error: err.message || 'Logo generation failed.' };
  }
}

const EXECUTORS = {
  generate_logo_design: execute_generate_logo_design,
  get_user_profile: execute_get_user_profile,
  list_user_projects: execute_list_user_projects,
  list_user_files: execute_list_user_files,
};

function definitionsForDomain(domain) {
  const names = Array.isArray(domain?.tools) ? domain.tools : [];
  return names.map((n) => TOOL_DEFINITIONS[n]).filter(Boolean);
}

async function runTool({ name, input, userEmail }) {
  const exec = EXECUTORS[name];
  if (!exec) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await exec({ userEmail, input });
  } catch (err) {
    return { error: err.message || 'Tool execution failed' };
  }
}

module.exports = {
  definitionsForDomain,
  runTool,
};
