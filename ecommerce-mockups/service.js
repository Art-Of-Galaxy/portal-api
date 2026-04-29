const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.ECOMMERCE_MOCKUPS_MODEL || 'claude-opus-4-7';

// Reads ANTHROPIC_API_KEY from the environment.
const client = new Anthropic();

// Stable system prompt — must NOT contain timestamps/UUIDs/per-request data,
// otherwise the prompt cache prefix invalidates on every request.
const SYSTEM_PROMPT = `You are a senior e-commerce creative director for Art of Galaxy, an AI-services agency. You produce production-ready creative briefs for e-commerce product mockups across Amazon, Shopify, Etsy, WooCommerce, and other marketplaces.

You take a structured intake form for an E-Commerce Mockups engagement and produce a complete, actionable mockup creative brief: a creative summary, per-platform image specs (only for the platforms the client picked), background/scene direction, visual style notes, a per-mockup shot list grounded in the mockup types the client selected, feature callouts, a production checklist, and the deliverables the AOG team will produce.

Your output must:
- Be specific and actionable, never generic.
- Treat each platform's known image specs as constraints (Amazon main image needs pure white background, square, product fills 85%+; Shopify hero allows lifestyle; Etsy benefits from styled flat-lays; WooCommerce mirrors Shopify but is theme-driven). When a platform was NOT selected, omit it from per_platform_specs entirely.
- Map every selected mockup type (hero image, product close-ups, feature highlights, lifestyle scenes, packaging display) to a concrete shot in shot_list. Do not invent mockup types the client did not select unless clearly required by a selected platform (e.g., Amazon almost always needs a hero on white).
- Anchor the visual direction to the client's chosen background style and brand cues. If the client said they have brand guidelines, defer to them; if not, recommend specific palette mood + 1-3 anchor hex options.
- Use the listed key features / selling points as the source of truth for feature_callouts and ensure each callout is short enough to overlay on an image (≤ 7 words).
- Keep the production checklist sequenced (prep → shoot/render → retouch → export per platform) and tie export specs to the platforms picked.
- Never pad. If a section has nothing useful to add given the brief, return an empty array — do not invent.

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any other text, prose, or markdown.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'executive_summary',
    'creative_concept',
    'per_platform_specs',
    'visual_direction',
    'shot_list',
    'feature_callouts',
    'production_checklist',
    'deliverables',
    'next_steps',
  ],
  properties: {
    executive_summary: {
      type: 'string',
      description: '2-3 sentence overview of the mockup engagement and recommended creative direction.',
    },
    creative_concept: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'big_idea', 'audience_hook'],
      properties: {
        headline: {
          type: 'string',
          description: 'A single short line that captures the visual concept.',
        },
        big_idea: {
          type: 'string',
          description: '1-2 sentences explaining the core creative idea behind the mockups.',
        },
        audience_hook: {
          type: 'string',
          description: 'Why this concept resonates with the stated target customer.',
        },
      },
    },
    per_platform_specs: {
      type: 'array',
      description: 'One entry per platform the client selected. Omit platforms that were not selected.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'image_specs', 'main_image_rules', 'recommended_variants'],
        properties: {
          platform: {
            type: 'string',
            description: 'Platform name, e.g. Amazon, Shopify, Etsy, WooCommerce, or the client-supplied "Other" value.',
          },
          image_specs: {
            type: 'string',
            description: 'Concrete pixel dimensions, aspect ratio, file format, and color profile required by this platform.',
          },
          main_image_rules: {
            type: 'string',
            description: 'Hard rules for the primary listing image on this platform (background, framing, props, text overlay rules).',
          },
          recommended_variants: {
            type: 'array',
            items: { type: 'string' },
            description: '3-5 secondary image types to ship alongside the main image for this platform.',
          },
        },
      },
    },
    visual_direction: {
      type: 'object',
      additionalProperties: false,
      required: ['background', 'lighting', 'color_palette', 'props_and_styling', 'typography_overlay'],
      properties: {
        background: {
          type: 'string',
          description: 'Background direction grounded in the client\'s preferred background style.',
        },
        lighting: {
          type: 'string',
          description: 'Lighting setup direction (soft/hard, key/fill, time-of-day for lifestyle).',
        },
        color_palette: {
          type: 'string',
          description: 'Palette mood plus 1-3 anchor hex options, mapped to background / accent / overlay roles.',
        },
        props_and_styling: {
          type: 'string',
          description: 'Props, surfaces, and styling cues that fit the product and audience.',
        },
        typography_overlay: {
          type: 'string',
          description: 'Type pairing + size/weight guidance for any on-image callouts. Keep readable on small thumbnails.',
        },
      },
    },
    shot_list: {
      type: 'array',
      description: 'One entry per mockup type the client selected, plus any platform-required shot (e.g. Amazon hero on white).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shot', 'purpose', 'composition', 'platforms'],
        properties: {
          shot: {
            type: 'string',
            description: 'Short shot name, e.g. "Hero on white", "Macro feature: spout detail".',
          },
          purpose: {
            type: 'string',
            description: '1 sentence on what this shot has to communicate.',
          },
          composition: {
            type: 'string',
            description: 'Framing, angle, focal length feel, and product placement.',
          },
          platforms: {
            type: 'array',
            items: { type: 'string' },
            description: 'Which selected platforms this shot ships to.',
          },
        },
      },
    },
    feature_callouts: {
      type: 'array',
      description: 'On-image text callouts derived from the client\'s key features / selling points. Each label ≤ 7 words.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'supporting_detail'],
        properties: {
          label: {
            type: 'string',
            description: 'Short overlay text (≤ 7 words).',
          },
          supporting_detail: {
            type: 'string',
            description: '1 sentence the overlay summarizes — for the designer\'s reference.',
          },
        },
      },
    },
    production_checklist: {
      type: 'array',
      description: 'Sequenced steps from prep through per-platform export.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'detail'],
        properties: {
          step: { type: 'string', description: 'Short step name.' },
          detail: { type: 'string', description: '1-2 sentences on what happens in this step.' },
        },
      },
    },
    deliverables: {
      type: 'array',
      description: 'Concrete files the client receives. Each item should call out the platform(s) it serves where relevant.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'scope'],
        properties: {
          item: { type: 'string' },
          scope: { type: 'string' },
        },
      },
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 next steps the AOG team will take after this brief is approved.',
    },
  },
};

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

async function generateEcommerceMockups({ form, requestedModel }) {
  const model = pickModel(requestedModel);

  const system = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
    },
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
    messages: [
      {
        role: 'user',
        content: `Here is the client's e-commerce mockups intake form. Generate the mockup creative brief as JSON conforming to the schema.\n\n${userPayload}`,
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Claude returned no text block');
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Failed to parse JSON from Claude: ${err.message}`);
  }

  return {
    model,
    stop_reason: response.stop_reason,
    usage: response.usage,
    mockups: parsed,
  };
}

module.exports = {
  generateEcommerceMockups,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
