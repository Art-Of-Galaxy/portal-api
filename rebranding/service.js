const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.REBRANDING_MODEL || 'claude-opus-4-7';

// Reads ANTHROPIC_API_KEY from the environment.
const client = new Anthropic();

// Stable system prompt — must NOT contain timestamps/UUIDs/per-request data,
// otherwise the prompt cache prefix invalidates on every request.
const SYSTEM_PROMPT = `You are a senior brand strategist and creative director for Art of Galaxy, an AI-services agency that runs rebranding engagements end-to-end.

You take a structured intake form for a Rebranding engagement and produce a complete rebranding plan: an honest assessment of the current brand, the new positioning, the desired brand essence, the visual and verbal direction, the messaging pillars, a phased rollout plan, and the concrete deliverables tailored to the scope the client selected.

Your output must:
- Be specific and actionable, never generic or platitudinous.
- Treat the rebrand as an evolution from the current state — name what is changing and why, do not describe the new brand in a vacuum.
- Where the client referenced specific competitors or admired brands, use them as concrete reference points.
- For deliverable scope, only include items the client checked or that are clearly required for a credible rebrand at this scope; do not pad the list.
- Keep visual direction prescriptive but open enough that a designer can interpret it (e.g., recommend a typographic classification + named candidate families, recommend palette mood + 1-3 anchor hex options).
- Phase the rollout realistically (typical 3-4 phases: discovery/strategy → identity design → asset rollout → launch & change-management).

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any other text, prose, or markdown.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'executive_summary',
    'current_state_assessment',
    'new_positioning',
    'brand_essence',
    'visual_direction',
    'messaging_pillars',
    'rollout_plan',
    'deliverables',
    'risks',
    'next_steps',
  ],
  properties: {
    executive_summary: {
      type: 'string',
      description: '2-3 sentence overview of the rebrand opportunity and recommended direction.',
    },
    current_state_assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'whats_not_working', 'risks_of_no_action'],
      properties: {
        headline: {
          type: 'string',
          description: 'A single sentence summarizing where the current brand stands.',
        },
        whats_not_working: {
          type: 'array',
          items: { type: 'string' },
          description: '3-5 specific issues with the current brand, grounded in the client input.',
        },
        risks_of_no_action: {
          type: 'array',
          items: { type: 'string' },
          description: '2-4 concrete risks if the brand is not refreshed.',
        },
      },
    },
    new_positioning: {
      type: 'object',
      additionalProperties: false,
      required: ['positioning_statement', 'what_changes', 'audience_focus'],
      properties: {
        positioning_statement: {
          type: 'string',
          description: 'For [audience], [brand] is the [category] that [unique value], because [reason to believe].',
        },
        what_changes: {
          type: 'string',
          description: 'Concise paragraph: what shifts from current → new.',
        },
        audience_focus: {
          type: 'string',
          description: 'Who the new brand is built for, expressed as audience profile.',
        },
      },
    },
    brand_essence: {
      type: 'object',
      additionalProperties: false,
      required: ['values', 'perception_goals', 'voice_direction'],
      properties: {
        values: {
          type: 'array',
          items: { type: 'string' },
          description: '3-5 values, derived from client input.',
        },
        perception_goals: {
          type: 'array',
          items: { type: 'string' },
          description: '3-5 short statements of how the brand should be perceived after the rebrand.',
        },
        voice_direction: {
          type: 'string',
          description: '2-3 sentences on the brand voice evolution.',
        },
      },
    },
    visual_direction: {
      type: 'object',
      additionalProperties: false,
      required: ['logo', 'typography', 'color', 'imagery'],
      properties: {
        logo: {
          type: 'string',
          description: 'Recommended logo direction (wordmark vs lockup vs symbol) with rationale.',
        },
        typography: {
          type: 'string',
          description: 'Typography direction: classifications + 1-3 named candidate families with usage hints.',
        },
        color: {
          type: 'string',
          description: 'Palette mood, 1-3 anchor hex options, and how they map to primary/secondary/neutral roles.',
        },
        imagery: {
          type: 'string',
          description: 'Photography / illustration / iconography direction with rationale.',
        },
      },
    },
    messaging_pillars: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pillar', 'description'],
        properties: {
          pillar: { type: 'string', description: 'Short pillar name.' },
          description: { type: 'string', description: '1-2 sentences explaining the pillar.' },
        },
      },
      description: '3-5 messaging pillars the new brand will lean on.',
    },
    rollout_plan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'duration', 'activities'],
        properties: {
          phase: { type: 'string', description: 'Phase name.' },
          duration: { type: 'string', description: 'Approximate duration, e.g., "2-3 weeks".' },
          activities: { type: 'string', description: 'What happens in this phase.' },
        },
      },
      description: '3-4 phases — typically Discovery/Strategy → Identity Design → Asset Rollout → Launch.',
    },
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'scope'],
        properties: {
          item: { type: 'string', description: 'Deliverable name.' },
          scope: { type: 'string', description: 'What the deliverable includes (1-2 sentences).' },
        },
      },
      description: 'Reflects the scope the client selected, plus any standard outputs required.',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 risks or change-management considerations the team should plan for.',
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

async function generateRebranding({ form, requestedModel }) {
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
        content: `Here is the client's rebranding intake form. Generate the rebranding plan as JSON conforming to the schema.\n\n${userPayload}`,
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
    rebranding: parsed,
  };
}

module.exports = {
  generateRebranding,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
