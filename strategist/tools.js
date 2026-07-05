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
const blogEngineService = require('../blog-engine/service');
const shopifyConnectionsService = require('../shopify-connections/service');
const wpConnectionsService = require('../wordpress-connections/service');
const socialConnectionsService = require('../social-connections/service');
const socialMediaService = require('../social-media/service');

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
  list_publishing_targets: {
    name: 'list_publishing_targets',
    description:
      "Returns the client's connected publishing destinations: Shopify stores, WordPress sites, and social media accounts (Instagram, Facebook Pages, YouTube). Call this before offering to generate a blog or social post so you know what the user actually has connected. If a category is empty, tell the user they need to connect one from the Connections page and DO NOT try to publish. Result auto-renders as inline connection cards.",
    input_schema: { type: 'object', properties: {} },
  },
  generate_shopify_blog: {
    name: 'generate_shopify_blog',
    description:
      "Generate a full SEO / GEO / AEO Shopify blog article INLINE in this chat. Returns a saved draft with a link the user can click to review, edit meta / images, and publish. Requires a real brand name + primary keyword. You MUST call list_publishing_targets first if you don't already know which Shopify store to target; if the user has multiple stores, ask them which one before calling this tool. NEVER call with placeholder values.",
    input_schema: {
      type: 'object',
      required: ['brand', 'keyword'],
      properties: {
        brand:                { type: 'string', description: 'Brand name that owns the store.' },
        keyword:              { type: 'string', description: 'Primary keyword the article should rank for.' },
        shop_connection_id:   { type: 'integer', description: 'The Shopify connection id to publish to. Get from list_publishing_targets.' },
        intent: {
          type: 'string',
          enum: ['informational', 'commercial', 'transactional', 'aeo'],
          description: 'Search intent shaping the article structure. Default informational.',
        },
        length: {
          type: 'string',
          enum: ['short', 'standard', 'long', 'auto'],
          description: 'Article length target. Default standard (1,200-1,600 words).',
        },
        angle:                { type: 'string', description: 'Optional angle / notes to steer the piece.' },
        reference_url:        { type: 'string', description: 'Optional URL the writer should read as a factual + tone reference.' },
      },
    },
  },
  generate_wordpress_blog: {
    name: 'generate_wordpress_blog',
    description:
      "Generate a full SEO / GEO / AEO WordPress blog article INLINE in this chat. Returns a saved draft with a link the user can click to review, edit meta / images, and publish to their WordPress site. Same rules as generate_shopify_blog: you MUST know the target wp_connection_id (from list_publishing_targets) and you MUST NOT use placeholders. If the user has multiple WP sites, ask them which one first.",
    input_schema: {
      type: 'object',
      required: ['brand', 'keyword'],
      properties: {
        brand:              { type: 'string', description: 'Brand or site name.' },
        keyword:            { type: 'string', description: 'Primary keyword the article should rank for.' },
        wp_connection_id:   { type: 'integer', description: 'The WordPress connection id to publish to. Get from list_publishing_targets.' },
        intent: {
          type: 'string',
          enum: ['informational', 'commercial', 'transactional', 'aeo'],
        },
        length: {
          type: 'string',
          enum: ['short', 'standard', 'long', 'auto'],
        },
        angle:              { type: 'string', description: 'Optional angle / notes to steer the piece.' },
        reference_url:      { type: 'string', description: 'Optional URL the writer should read as a factual + tone reference.' },
      },
    },
  },
  generate_social_post: {
    name: 'generate_social_post',
    description:
      "Generate a social media post (Instagram / Facebook / YouTube) INLINE in this chat. Returns a saved draft with a link the user can click to review, edit caption / hashtags / cover, and publish. Requires the user to have at least one social account connected (check via list_publishing_targets first). If the user has multiple platforms, ask which ones they want the post pushed to.",
    input_schema: {
      type: 'object',
      required: ['brand', 'topic'],
      properties: {
        brand:         { type: 'string', description: 'Brand name.' },
        topic:         { type: 'string', description: 'What the post is about (short phrase or sentence).' },
        content_type: {
          type: 'string',
          enum: ['post', 'carousel', 'reel', 'thumbnail'],
          description: 'What kind of content. Default post (single image + caption).',
        },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: ['instagram', 'facebook', 'youtube'] },
          description: 'Platforms to target. Ask the user if unsure.',
        },
        angle:         { type: 'string', description: 'Optional angle / notes.' },
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

// ----- Publishing-targets tools (Shopify / WordPress / Social) -----

async function execute_list_publishing_targets({ userEmail }) {
  if (!userEmail) return { note: 'No user_email available, cannot look up connections.' };
  const [shops, wpSites, socials] = await Promise.all([
    shopifyConnectionsService.listConnections({ userEmail }).catch(() => []),
    wpConnectionsService.listConnections({ userEmail }).catch(() => []),
    socialConnectionsService.listConnections({ userEmail }).catch(() => []),
  ]);
  const shopifyStores = (shops || []).map((s) => ({
    id: s.id,
    name: s.shop_name || s.shop_domain,
    domain: s.shop_domain,
    is_primary: Boolean(s.is_primary),
  }));
  const wordpressSites = (wpSites || []).map((s) => ({
    id: s.id,
    name: s.site_name || s.site_url,
    url: s.site_url,
    is_primary: Boolean(s.is_primary),
  }));
  const socialAccounts = (socials || []).map((s) => ({
    id: s.id,
    platform: s.platform,
    account_name: s.account_name || s.account_handle || s.account_id,
    account_handle: s.account_handle || null,
    is_primary: Boolean(s.is_primary),
  }));
  return {
    shopify: shopifyStores,
    wordpress: wordpressSites,
    social: socialAccounts,
    summary: `${shopifyStores.length} Shopify store(s), ${wordpressSites.length} WordPress site(s), ${socialAccounts.length} social account(s).`,
    _attachment: {
      type: 'publishing_targets',
      shopify: shopifyStores,
      wordpress: wordpressSites,
      social: socialAccounts,
    },
  };
}

// Shared helpers for the two blog generation tools.
async function generateBlogArticleFor({
  service,
  userEmail,
  brand,
  keyword,
  intent,
  length,
  angle,
  referenceUrl,
}) {
  const briefForApi = {
    brand,
    keyword,
    intent: intent || 'informational',
    voice: {},
    length: length || 'standard',
    notes: angle || '',
    reference_url: referenceUrl || null,
  };
  const generated = await blogEngineService.generateArticle({ brief: briefForApi });
  const spec = generated.spec || {};
  return { briefForApi, generated, spec };
}

async function execute_generate_shopify_blog({ userEmail, input }) {
  if (!userEmail) return { error: 'No user_email available, cannot save the article.' };
  const brand = String(input?.brand || '').trim();
  const keyword = String(input?.keyword || '').trim();
  if (!brand || isPlaceholderBrandName(brand)) {
    return { error: 'brand looks like a placeholder. Ask the user for the real brand name before calling this tool again.' };
  }
  if (!keyword || keyword.length < 3) {
    return { error: 'keyword is missing or too short. Ask the user for the actual keyword the article should target.' };
  }

  // Resolve which Shopify connection to associate. Prefer explicit
  // input, otherwise the user's primary, otherwise the first one.
  let shopConnectionId = Number.isInteger(input?.shop_connection_id) ? input.shop_connection_id : null;
  let stores = [];
  try { stores = await shopifyConnectionsService.listConnections({ userEmail }); } catch { stores = []; }
  if (!shopConnectionId && stores.length) {
    shopConnectionId = (stores.find((s) => s.is_primary) || stores[0]).id;
  }
  if (!stores.length) {
    return { error: 'The user has no connected Shopify stores. Ask them to connect one at /new-projects/ai-integrations/shopify-blog/connections first.' };
  }

  try {
    const { briefForApi, generated, spec } = await generateBlogArticleFor({
      userEmail, brand, keyword,
      intent: input?.intent, length: input?.length, angle: input?.angle,
      referenceUrl: input?.reference_url,
    });

    const r = await poll.query(
      `INSERT INTO tbl_blog_articles
          (user_email, shop_connection_id, mode, keyword, brief_json, spec_json,
           assets_json, title, handle, meta_title, meta_description, tags,
           seo_score, word_count, status)
        VALUES ($1, $2, 'single', $3, $4::jsonb, $5::jsonb, $6::jsonb,
                $7, $8, $9, $10, $11, $12, $13, 'draft')
        RETURNING id`,
      [
        userEmail,
        shopConnectionId,
        keyword,
        JSON.stringify(briefForApi),
        JSON.stringify(spec),
        JSON.stringify({ featured: generated.featured || null, body_html: generated.body_html || '' }),
        spec.title || keyword,
        spec.handle || null,
        spec.meta_title || null,
        spec.meta_description || null,
        Array.isArray(spec.tags) ? spec.tags.join(',') : null,
        Number.isInteger(spec.seo_score) ? spec.seo_score : null,
        Number.isInteger(spec.word_count) ? spec.word_count : null,
      ]
    );
    const articleId = r?.rows?.[0]?.id;
    const shopName = stores.find((s) => s.id === shopConnectionId)?.shop_name || 'your Shopify store';
    const previewUrl = `/new-projects/ai-integrations/shopify-blog/create?article=${articleId}`;
    return {
      ok: true,
      article_id: articleId,
      title: spec.title,
      preview_url: previewUrl,
      _attachment: {
        type: 'blog_draft',
        platform: 'shopify',
        article_id: articleId,
        title: spec.title || keyword,
        meta_description: spec.meta_description || '',
        featured_url: generated.featured?.url || null,
        preview_url: previewUrl,
        target_label: shopName,
        word_count: spec.word_count || null,
        seo_score: spec.seo_score || null,
      },
      summary: `Drafted a Shopify blog "${spec.title}" for ${shopName}. The user can open it to review, tweak meta / images, and publish.`,
    };
  } catch (err) {
    return { error: err.message || 'Shopify blog generation failed.' };
  }
}

async function execute_generate_wordpress_blog({ userEmail, input }) {
  if (!userEmail) return { error: 'No user_email available, cannot save the article.' };
  const brand = String(input?.brand || '').trim();
  const keyword = String(input?.keyword || '').trim();
  if (!brand || isPlaceholderBrandName(brand)) {
    return { error: 'brand looks like a placeholder. Ask the user for the real brand name before calling this tool again.' };
  }
  if (!keyword || keyword.length < 3) {
    return { error: 'keyword is missing or too short. Ask the user for the actual keyword the article should target.' };
  }

  let wpConnectionId = Number.isInteger(input?.wp_connection_id) ? input.wp_connection_id : null;
  let sites = [];
  try { sites = await wpConnectionsService.listConnections({ userEmail }); } catch { sites = []; }
  if (!wpConnectionId && sites.length) {
    wpConnectionId = (sites.find((s) => s.is_primary) || sites[0]).id;
  }
  if (!sites.length) {
    return { error: 'The user has no connected WordPress sites. Ask them to connect one at /new-projects/ai-integrations/wp-blog/connections first.' };
  }

  try {
    const { briefForApi, generated, spec } = await generateBlogArticleFor({
      userEmail, brand, keyword,
      intent: input?.intent, length: input?.length, angle: input?.angle,
      referenceUrl: input?.reference_url,
    });

    const r = await poll.query(
      `INSERT INTO tbl_wp_articles
          (user_email, wp_connection_id, mode, keyword, brief_json, spec_json,
           assets_json, title, handle, meta_title, meta_description, tags,
           seo_score, word_count, status)
        VALUES ($1, $2, 'single', $3, $4::jsonb, $5::jsonb, $6::jsonb,
                $7, $8, $9, $10, $11, $12, $13, 'draft')
        RETURNING id`,
      [
        userEmail,
        wpConnectionId,
        keyword,
        JSON.stringify(briefForApi),
        JSON.stringify(spec),
        JSON.stringify({ featured: generated.featured || null, body_html: generated.body_html || '' }),
        spec.title || keyword,
        spec.handle || null,
        spec.meta_title || null,
        spec.meta_description || null,
        Array.isArray(spec.tags) ? spec.tags.join(',') : null,
        Number.isInteger(spec.seo_score) ? spec.seo_score : null,
        Number.isInteger(spec.word_count) ? spec.word_count : null,
      ]
    );
    const articleId = r?.rows?.[0]?.id;
    const siteName = sites.find((s) => s.id === wpConnectionId)?.site_name || 'your WordPress site';
    const previewUrl = `/new-projects/ai-integrations/wp-blog/create?article=${articleId}`;
    return {
      ok: true,
      article_id: articleId,
      title: spec.title,
      preview_url: previewUrl,
      _attachment: {
        type: 'blog_draft',
        platform: 'wordpress',
        article_id: articleId,
        title: spec.title || keyword,
        meta_description: spec.meta_description || '',
        featured_url: generated.featured?.url || null,
        preview_url: previewUrl,
        target_label: siteName,
        word_count: spec.word_count || null,
        seo_score: spec.seo_score || null,
      },
      summary: `Drafted a WordPress blog "${spec.title}" for ${siteName}. The user can open it to review, tweak meta / images, and publish.`,
    };
  } catch (err) {
    return { error: err.message || 'WordPress blog generation failed.' };
  }
}

async function execute_generate_social_post({ userEmail, input }) {
  if (!userEmail) return { error: 'No user_email available, cannot save the post.' };
  const brand = String(input?.brand || '').trim();
  const topic = String(input?.topic || '').trim();
  if (!brand || isPlaceholderBrandName(brand)) {
    return { error: 'brand looks like a placeholder. Ask the user for the real brand name before calling this tool again.' };
  }
  if (!topic || topic.length < 4) {
    return { error: 'topic is missing or too short. Ask the user what the post is about first.' };
  }

  // Resolve which platforms to target. Only include platforms the user
  // is actually connected to.
  let accounts = [];
  try { accounts = await socialConnectionsService.listConnections({ userEmail }); } catch { accounts = []; }
  if (!accounts.length) {
    return { error: 'The user has no connected social accounts. Ask them to connect one at /new-projects/social/connections first.' };
  }
  const connectedPlatforms = new Set(accounts.map((a) => a.platform));
  const requested = Array.isArray(input?.platforms) && input.platforms.length
    ? input.platforms.filter((p) => connectedPlatforms.has(p))
    : Array.from(connectedPlatforms);
  if (!requested.length) {
    return { error: `None of the requested platforms are connected. Connected: ${Array.from(connectedPlatforms).join(', ') || 'none'}.` };
  }

  const contentType = input?.content_type || 'post';
  const brief = {
    brand,
    content_type: contentType,
    platforms: requested,
    topic,
    angle: input?.angle || '',
  };
  try {
    const generated = await socialMediaService.generateContent({ brief });
    const spec = generated.spec || {};
    const cover = generated.cover || null;
    const platformsStr = requested.join(',');
    const captionText = spec.caption || '';
    const hashtagsStr = Array.isArray(spec.hashtags) ? spec.hashtags.join(' ') : (spec.hashtags || '');
    const assetsJson = cover ? { cover_url: cover.url || cover, cover_content_type: cover.content_type || null } : null;

    const r = await poll.query(
      `INSERT INTO tbl_social_posts
          (user_email, project_id, content_type, brief_json, spec_json, assets_json,
           caption, hashtags, platforms, status)
        VALUES ($1, NULL, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, 'draft')
        RETURNING id`,
      [
        userEmail,
        contentType,
        JSON.stringify(brief),
        JSON.stringify(spec),
        assetsJson ? JSON.stringify(assetsJson) : null,
        captionText,
        hashtagsStr,
        platformsStr,
      ]
    );
    const postId = r?.rows?.[0]?.id;
    const previewUrl = `/new-projects/social/create?post=${postId}`;
    return {
      ok: true,
      post_id: postId,
      preview_url: previewUrl,
      _attachment: {
        type: 'social_draft',
        post_id: postId,
        content_type: contentType,
        platforms: requested,
        caption_preview: captionText.slice(0, 220),
        cover_url: cover?.url || null,
        preview_url: previewUrl,
        target_label: requested.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(', '),
      },
      summary: `Drafted a ${contentType} for ${requested.join(', ')}. The user can open it to review the caption, cover, and publish.`,
    };
  } catch (err) {
    return { error: err.message || 'Social post generation failed.' };
  }
}

const EXECUTORS = {
  generate_logo_design: execute_generate_logo_design,
  get_user_profile: execute_get_user_profile,
  list_user_projects: execute_list_user_projects,
  list_user_files: execute_list_user_files,
  list_publishing_targets: execute_list_publishing_targets,
  generate_shopify_blog: execute_generate_shopify_blog,
  generate_wordpress_blog: execute_generate_wordpress_blog,
  generate_social_post: execute_generate_social_post,
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
