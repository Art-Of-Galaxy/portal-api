const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.BRAND_GUIDELINES_MODEL || 'claude-opus-4-7';

// Reads ANTHROPIC_API_KEY from the environment.
const client = new Anthropic();

// Stable system prompt — must NOT contain timestamps/UUIDs/per-request data,
// otherwise the prompt cache prefix invalidates on every request.
const SYSTEM_PROMPT = `You are a senior brand strategist and design director for Art of Galaxy, an AI-services agency.

You take a structured client intake form for a Brand Guidelines Development engagement and produce a complete, professional brand guidelines specification.

Your output must:
- Be specific and actionable, never generic.
- Translate client input into brand-strategist recommendations (do not just echo it back).
- Use the client's product, audience, competitors, and admired brands as concrete reference points.
- When the client gave color or typography preferences, build on them; when they did not, recommend specific options with named hex codes / typeface families.
- Justify each visual recommendation against the brand's positioning and audience, not in the abstract.
- Keep voice/tone descriptions concrete enough that a copywriter could ship from them (length: 1-3 sentences each).
- Always return a deliverables list that aligns with what the client asked for plus standard brand-guideline outputs.

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any other text, prose, or markdown.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'brand_summary',
    'positioning_statement',
    'verbal_identity',
    'visual_identity',
    'typography',
    'color_system',
    'deliverables',
    'next_steps',
  ],
  properties: {
    brand_summary: {
      type: 'string',
      description: 'A 2-3 sentence executive summary of the brand we are building.',
    },
    positioning_statement: {
      type: 'string',
      description: 'A single positioning sentence: For [audience], [brand] is the [category] that [unique value], because [reason to believe].',
    },
    verbal_identity: {
      type: 'object',
      additionalProperties: false,
      required: ['voice', 'tone', 'do_say', 'dont_say', 'tagline_options'],
      properties: {
        voice: {
          type: 'string',
          description: 'Brand voice — the constant personality. 1-3 sentences.',
        },
        tone: {
          type: 'string',
          description: 'How the voice flexes across contexts (sales vs support vs social). 1-3 sentences.',
        },
        do_say: {
          type: 'array',
          items: { type: 'string' },
          description: '4-6 short phrases or principles the brand SHOULD use.',
        },
        dont_say: {
          type: 'array',
          items: { type: 'string' },
          description: '4-6 short phrases or anti-patterns the brand should AVOID.',
        },
        tagline_options: {
          type: 'array',
          items: { type: 'string' },
          description: '3 distinct tagline options.',
        },
      },
    },
    visual_identity: {
      type: 'object',
      additionalProperties: false,
      required: ['design_principles', 'mood_keywords', 'logo_direction', 'imagery_direction'],
      properties: {
        design_principles: {
          type: 'array',
          items: { type: 'string' },
          description: '3-5 design principles (e.g., "Editorial restraint over ornament").',
        },
        mood_keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '5-7 mood keywords describing the visual feel.',
        },
        logo_direction: {
          type: 'string',
          description: 'Recommended logo direction: wordmark vs lockup vs symbol, with rationale.',
        },
        imagery_direction: {
          type: 'string',
          description: 'Photography / illustration direction with rationale.',
        },
      },
    },
    typography: {
      type: 'object',
      additionalProperties: false,
      required: ['display', 'body', 'rationale'],
      properties: {
        display: {
          type: 'object',
          additionalProperties: false,
          required: ['family', 'classification', 'usage'],
          properties: {
            family: { type: 'string', description: 'Recommended display typeface family name.' },
            classification: { type: 'string', description: 'Serif / Sans Serif / Script / Modern / Display / Condensed.' },
            usage: { type: 'string', description: 'Where to use it.' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['family', 'classification', 'usage'],
          properties: {
            family: { type: 'string' },
            classification: { type: 'string' },
            usage: { type: 'string' },
          },
        },
        rationale: {
          type: 'string',
          description: 'Why this pair fits the brand and audience.',
        },
      },
    },
    color_system: {
      type: 'object',
      additionalProperties: false,
      required: ['primary', 'secondary', 'neutrals', 'rationale'],
      properties: {
        primary: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'hex', 'usage'],
            properties: {
              name: { type: 'string' },
              hex: { type: 'string', description: 'Hex like #1A4FB0 (uppercase, with #).' },
              usage: { type: 'string' },
            },
          },
        },
        secondary: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'hex', 'usage'],
            properties: {
              name: { type: 'string' },
              hex: { type: 'string' },
              usage: { type: 'string' },
            },
          },
        },
        neutrals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'hex', 'usage'],
            properties: {
              name: { type: 'string' },
              hex: { type: 'string' },
              usage: { type: 'string' },
            },
          },
        },
        rationale: {
          type: 'string',
          description: 'Why this palette fits the positioning, audience, and admired brands.',
        },
      },
    },
    deliverables: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete files / assets the client will receive — incorporates what they checked + standard guideline outputs.',
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

async function generateBrandGuidelines({ form, requestedModel }) {
  const model = pickModel(requestedModel);

  // Stable prefix: SYSTEM_PROMPT + the schema text. We mark a single
  // cache breakpoint on the LAST stable system block so tools+system cache
  // together, and the volatile form payload sits in the user turn.
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
        content: `Here is the client's brand-guidelines intake form. Generate the brand guidelines spec as JSON conforming to the schema.\n\n${userPayload}`,
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
    guidelines: parsed,
  };
}

module.exports = {
  generateBrandGuidelines,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
