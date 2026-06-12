// Printing Design service.
//
// Unlike logo-design or brand-guidelines, Printing Design is a BRIEF
// SUBMISSION flow — the actual artwork is produced by the human design
// team, not the AI. What we do here is take the intake form, run it
// through Claude to produce a polished, personalized brief spec (summary,
// at-a-glance pillars, timeline, deliverables, next steps) that the
// frontend renders as a confirmation page.

const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.PRINTING_DESIGN_MODEL || 'claude-sonnet-4-6';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a senior print designer and creative director at Art of Galaxy, an AI-services agency.

You receive a structured client intake form for a Printing Design engagement (brochure, ebook, flyer, or poster). You produce a personalized confirmation brief that the AOG portal renders on the project page after the client submits.

Your output must:
- Be specific and actionable, never generic.
- NEVER use em dashes (—) or double-dash (--) anywhere. They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Reflect the client's actual format, size, audience, and content state. Do not echo their inputs back verbatim, translate them into designer-quality language.
- Recommend the correct print specs and deliverables for the chosen format. A trifold A4 brochure has different bleeds and deliverables than a 24x36 poster or a 50-page ebook.
- Calibrate the timeline to the format complexity (a poster is faster than a 50-page ebook).
- Calibrate the "next steps" to what's actually outstanding (if the client said they don't have content, surface that as a near-term action; if they have assets ready, skip that step).
- Keep every description short enough to fit a sidebar tile or two-line card (1 to 3 sentences).

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any prose, markdown, or commentary.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'print_summary',
    'format_label',
    'size_label',
    'audience_label',
    'content_status_label',
    'pillars',
    'visual_direction',
    'tone_chips',
    'timeline',
    'deliverables',
    'next_steps',
  ],
  properties: {
    print_summary: {
      type: 'string',
      description: 'A 1 to 2 sentence executive description of the print piece, who it is for, and what it is communicating.',
    },
    format_label: {
      type: 'string',
      description: 'A short label for the format, like "Brochure - Trifold" or "Ebook - 24 pages" or "Poster - 18x24in".',
    },
    size_label: {
      type: 'string',
      description: 'The size with both name and dimensions, like "A4 - 210x297mm" or "Letter - 8.5x11in".',
    },
    fold_label: {
      type: 'string',
      description: 'Fold name if applicable to the format (e.g. "Trifold", "Z-fold", "Gatefold"). Empty string for non-folded formats.',
    },
    audience_label: {
      type: 'string',
      description: 'A condensed audience descriptor like "Creative professionals 28 to 42" or "B2B decision makers".',
    },
    content_status_label: {
      type: 'string',
      description: 'A short status, one of "Ready to go", "Draft ready", or "Copy to be written" (or similar 2 to 4 word phrase).',
    },
    pillars: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'highlight', 'blurb', 'icon'],
        properties: {
          label:     { type: 'string', description: 'Short uppercase-style label like "Print format" or "Visual direction".' },
          highlight: { type: 'string', description: 'A short emphasized phrase, the headline of the pillar.' },
          blurb:     { type: 'string', description: 'A 1 to 2 sentence explanation under the highlight.' },
          icon:      { type: 'string', description: 'An emoji that fits the pillar.' },
        },
      },
      description: 'EXACTLY 3 pillars summarising the project at a glance: (1) Print format, (2) Content status, (3) Visual direction. Return them in that order.',
    },
    visual_direction: {
      type: 'string',
      description: '1 to 2 sentences describing the visual mood and tone the designer will work toward, grounded in the client tones.',
    },
    tone_chips: {
      type: 'array',
      items: { type: 'string' },
      description: '2 to 4 short tone phrases that match what the client selected (e.g. "Clean and professional", "Warm and friendly").',
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'duration', 'description'],
        properties: {
          phase:       { type: 'string', description: 'Phase name like "Brief review and creative direction".' },
          duration:    { type: 'string', description: 'Duration like "1 to 2 days" or "Week 1 to 2".' },
          description: { type: 'string', description: '1 to 2 sentences of what the designer is doing in this phase.' },
        },
      },
      description: 'Exactly 4 timeline phases describing the production flow from brief review through print-ready delivery, calibrated to this format and content state.',
    },
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name:        { type: 'string' },
          description: { type: 'string' },
        },
      },
      description: '3 to 5 concrete deliverables (Print-ready PDF, Digital RGB version, Flat artwork, Layered source files, etc.), with format-correct specs (CMYK, DPI, bleed) baked into the description.',
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
      description: '3 to 5 numbered action items the client should complete to keep the project moving (send brand assets, approve layout grid, provide final copy, sign off on draft, etc.). Calibrated to what they actually still owe.',
    },
  },
};

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

async function generatePrintingDesign({ form, requestedModel }) {
  const model = pickModel(requestedModel);

  const system = [
    { type: 'text', text: SYSTEM_PROMPT },
    {
      type: 'text',
      text: `Output schema (the JSON you return MUST conform):\n${JSON.stringify(OUTPUT_SCHEMA)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const userPayload = JSON.stringify({ intake: form }, null, 2);

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system,
    messages: [{
      role: 'user',
      content: `Here is the client's printing-design intake form. Generate the personalized brief spec as JSON conforming to the schema.\n\n${userPayload}`,
    }],
    output_config: {
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');

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
    brief: parsed,
  };
}

module.exports = {
  generatePrintingDesign,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
