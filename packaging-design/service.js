// Packaging Design service.
//
// Like printing-design, packaging is a BRIEF SUBMISSION flow. The actual
// dieline + artwork is produced by the human design team. What we do
// here: take the intake form, run it through Claude to produce a
// polished, personalized brief spec (package summary, at-a-glance
// pillars, finish chips, production timeline, deliverables, next steps)
// that the frontend renders as a confirmation page.

const Anthropic = require('@anthropic-ai/sdk');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.PACKAGING_DESIGN_MODEL || 'claude-sonnet-4-6';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a senior packaging designer and production lead at Art of Galaxy, an AI-services agency.

You receive a structured client intake form for a Packaging Design engagement (box / folding carton, label, shrink sleeve, or bag / pouch). You produce a personalized confirmation brief that the AOG portal renders on the project page after the client submits.

Your output must:
- Be specific and actionable, never generic.
- NEVER use em dashes (—) or double-dash (--) anywhere. They read as AI-generated. Use a period, comma, colon, parentheses, "and" or "or" instead.
- Reflect the client's actual package type, style, dimensions, finishes, eco preference, and SKU complexity. Do not echo their inputs back verbatim, translate them into designer-quality language.
- Use correct production language. A straight tuck end box has different dielines and deliverables than a stand-up gusset pouch or a full-body shrink sleeve.
- Calibrate the timeline to the complexity (a single label is faster than a 10-SKU box family).
- Calibrate the "next steps" to what's actually outstanding (if the client has a dieline on file, do not ask for one; if they have no brand assets, surface that as a near-term action).
- Keep every description short enough to fit a sidebar tile or two-line card (1 to 3 sentences).

You will be given:
1. A JSON object containing the client's submitted intake form.
2. A JSON output schema you must conform to.

Respond ONLY with the JSON output. Do not include any prose, markdown, or commentary.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'package_summary',
    'type_label',
    'style_label',
    'size_label',
    'material_label',
    'eco_label',
    'pillars',
    'finish_chips',
    'design_direction',
    'timeline',
    'deliverables',
    'next_steps',
  ],
  properties: {
    package_summary: {
      type: 'string',
      description: '1 to 2 sentence executive description of the product inside, who it is for, and the packaging context.',
    },
    type_label: {
      type: 'string',
      description: 'Short label for the package family, e.g. "📦 Box", "🏷️ Label", "🍶 Shrink sleeve", "🛍️ Bag / Pouch".',
    },
    style_label: {
      type: 'string',
      description: 'The exact style picked, e.g. "Straight Tuck End", "Stand-Up Gusset", "Full Body Sleeve". Empty string if unspecified.',
    },
    size_label: {
      type: 'string',
      description: 'Dimensions with units, e.g. "4 x 6 x 2 in" or "120 x 180 x 40 mm". Empty string if dimensions were not given.',
    },
    material_label: {
      type: 'string',
      description: 'Material recommendation, e.g. "Standard SBS", "Recycled kraft", "PET shrink film". Lean on the client cues plus your judgement.',
    },
    eco_label: {
      type: 'string',
      description: 'A short eco status, e.g. "Eco preferred", "Standard materials", "Open to suggestions".',
    },
    pillars: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'highlight', 'blurb', 'icon'],
        properties: {
          label:     { type: 'string', description: 'Short uppercase-style label like "Package type" or "Production notes".' },
          highlight: { type: 'string', description: 'A short emphasized phrase, the headline of the pillar.' },
          blurb:     { type: 'string', description: '1 to 2 sentences explanation under the highlight.' },
          icon:      { type: 'string', description: 'An emoji that fits the pillar.' },
        },
      },
      description: 'EXACTLY 3 pillars summarising the project at a glance: (1) Package type, (2) Dimensions and finish, (3) Production notes. Return them in that order.',
    },
    finish_chips: {
      type: 'array',
      items: { type: 'string' },
      description: '2 to 5 short finish phrases that match what the client selected (e.g. "Matte", "Spot UV", "Embossing", "Soft touch").',
    },
    design_direction: {
      type: 'string',
      description: '1 to 2 sentences describing the visual mood and shelf-impact direction the designer will work toward.',
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'duration', 'description'],
        properties: {
          phase:       { type: 'string', description: 'Phase name like "Asset collection and alignment" or "Pre-production proof".' },
          duration:    { type: 'string', description: 'Duration like "Day 1 to 2", "Week 1", "Week 2 to 3".' },
          description: { type: 'string', description: '1 to 2 sentences of what the designer is doing in this phase.' },
        },
      },
      description: 'Exactly 4 timeline phases describing the production flow from asset collection through delivery, calibrated to this package type and complexity.',
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
      description: '3 to 5 concrete deliverables (Print-ready dieline, 3D mockup renders, Separated panel artwork, Layered source files, etc.) with format-correct specs baked in.',
    },
    next_steps: {
      type: 'array',
      items: { type: 'string' },
      description: '3 to 5 action items the client should complete to keep the project moving (send dieline source, share brand assets, sign off on flat proof, provide barcode and SKU details, etc.). Calibrated to what they actually still owe.',
    },
  },
};

function pickModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (ALLOWED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

async function generatePackagingDesign({ form, requestedModel }) {
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
      content: `Here is the client's packaging-design intake form. Generate the personalized brief spec as JSON conforming to the schema.\n\n${userPayload}`,
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
  generatePackagingDesign,
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
};
