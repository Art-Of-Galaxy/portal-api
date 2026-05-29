// AI Strategist conversation service. Wraps Claude with a strict JSON
// contract so the frontend always gets:
//   { reply, suggestions, brief, checklist, ready_to_generate, summary }
//
// One service-agnostic LLM driver, configured per-domain via domains.js
// (logo_design today, brand_guidelines / rebranding etc. as we add them).

const Anthropic = require('@anthropic-ai/sdk');
const { poll } = require('../config/dbconfig');
const { getDomain, isKnownService } = require('./domains');
const { definitionsForDomain, runTool } = require('./tools');
const usage = require('../usage/service');

const ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
const DEFAULT_MODEL = process.env.STRATEGIST_MODEL || 'claude-sonnet-4-6';

const client = new Anthropic();

const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'suggestions', 'brief', 'checklist', 'ready_to_generate'],
  properties: {
    reply: {
      type: 'string',
      description:
        'The next assistant message shown to the user. 1 to 3 short sentences. No em dashes (—) or double-dash (--). One question at a time.',
    },
    suggestions: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
      description:
        'Up to 6 short quick-reply chip labels the user can tap as answers. Empty if a free-text reply is required.',
    },
    multi_select: {
      type: 'boolean',
      description:
        'Set true when the question can have MORE THAN ONE answer (e.g. "which of these apply to your business?" or "which platforms do you sell on?"). When true, the UI lets the user tick multiple chips and submit them together. Default false (single choice / chip auto-submits).',
    },
    brief: {
      type: 'object',
      description:
        'The full running structured brief after this turn. Merge in new info from the user. Keep prior fields intact unless the user changed them.',
    },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'active', 'done'] },
        },
      },
      description:
        'One entry per domain checklist step. Exactly one should be "active" until the brief is ready_to_generate, at which point all become "done".',
    },
    ready_to_generate: {
      type: 'boolean',
      description:
        'Set true as soon as every REQUIRED field in the brief has a non-empty value. Do NOT wait for the user to explicitly say "generate" — once required fields are filled you should set this true and tell the user the brief is ready. The user clicks the generate button from the UI.',
    },
    summary: {
      type: 'string',
      description:
        'A short human recap of the collected brief, shown alongside the generate confirmation. Required when ready_to_generate is true, omitted otherwise.',
    },
    route: {
      type: 'string',
      description:
        'Optional deep-link path to navigate the user to (e.g. "/new-projects/branding-design/logo"). ONLY set when the user has clearly chosen a service to start, or you are recommending they jump to a specific portal page. Empty string or omit otherwise.',
    },
    chat_title: {
      type: 'string',
      description:
        'A short, descriptive title for THIS conversation, 2 to 5 words, no quotes. Set this on the FIRST turn as soon as the user has revealed what they want (e.g. "Bean There logo", "Streetwear brand strategy", "File audit"). Update it later only if the topic clearly shifts. Empty string means do not change the title. This becomes the conversation label in the sidebar; without it every chat reads as "Untitled chat".',
    },
  },
};

function buildSystemPrompt(domain) {
  const lines = [
    domain.persona,
    '',
    'Checklist steps (in canonical order):',
    domain.checklist.map((s) => `  - ${s.id}: ${s.label}`).join('\n') || '  (none)',
    '',
    'Brief schema (the fields you are filling):',
    Object.entries(domain.brief_shape)
      .map(([key, def]) => {
        const opts = def.options ? ` (options: ${def.options.join(', ')})` : '';
        const req = def.required ? ' [required]' : '';
        return `  - ${key}: ${def.type} - ${def.label}${opts}${req}`;
      })
      .join('\n') || '  (none)',
    '',
    `Minimum required to generate: ${(domain.min_required || []).join(', ') || '(none)'}.`,
    '',
    'Respond with ONLY the JSON object that matches the provided schema. No prose, no markdown, no leading text. Strings inside the JSON must not contain em dashes or double-dashes.',
  ];
  return lines.join('\n');
}

function pickModel(requested, domain) {
  if (requested && ALLOWED_MODELS.has(requested)) return requested;
  // Domains can opt into a faster / cheaper model by default (e.g. the
  // manager uses Haiku for snappier responses since it's mostly routing
  // and short conversational turns rather than long-form generation).
  if (domain?.default_model && ALLOWED_MODELS.has(domain.default_model)) {
    return domain.default_model;
  }
  return DEFAULT_MODEL;
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // Some models occasionally wrap JSON in ```json ... ```; strip and retry.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ }
  }
  // Last resort: grab the first { ... } block.
  const m = trimmed.match(/\{[\s\S]+\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* nope */ }
  }
  return null;
}

function stripEmDashes(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+--\s+/g, ', ')
    .replace(/--/g, '-');
}

function sanitizeTurn(turn) {
  if (!turn || typeof turn !== 'object') return turn;
  if (typeof turn.reply === 'string') turn.reply = stripEmDashes(turn.reply);
  if (typeof turn.summary === 'string') turn.summary = stripEmDashes(turn.summary);
  if (Array.isArray(turn.suggestions)) {
    turn.suggestions = turn.suggestions
      .map((s) => (typeof s === 'string' ? stripEmDashes(s) : null))
      .filter(Boolean)
      .slice(0, 6);
  }
  if (typeof turn.route !== 'string') turn.route = '';
  // Whitelist routes to portal paths only (defense against hallucinated URLs).
  if (turn.route && !/^\/[A-Za-z0-9/_-]*$/.test(turn.route)) turn.route = '';
  turn.multi_select = Boolean(turn.multi_select);
  // Chat title: 60 chars max, single line, no surrounding quotes. Empty
  // string means "leave the existing title alone".
  if (typeof turn.chat_title === 'string') {
    turn.chat_title = stripEmDashes(turn.chat_title)
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim()
      .slice(0, 60);
  } else {
    turn.chat_title = '';
  }
  return turn;
}

// Fallback: if the model didn't set ready_to_generate but every required
// field in the domain's brief has a non-empty value, flip it on ourselves.
// This is the safety net for the "I gave all my details but the button
// never appeared" failure mode.
function computeReadyFallback(domain, brief) {
  const required = domain.min_required || [];
  if (!required.length) return false;
  return required.every((key) => {
    const v = brief?.[key];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
  });
}

function emptyBriefForDomain(domain) {
  const out = {};
  for (const [key, def] of Object.entries(domain.brief_shape || {})) {
    if (def.type === 'string_array' || def.type === 'enum_array' || def.type === 'hex_array' || def.type === 'file_array') {
      out[key] = [];
    } else {
      out[key] = '';
    }
  }
  return out;
}

function defaultChecklist(domain) {
  return (domain.checklist || []).map((step, i) => ({
    id: step.id,
    status: i === 0 ? 'active' : 'pending',
  }));
}

// ---------- DB layer ----------

async function createSession({ userEmail, service }) {
  const domain = getDomain(service);
  if (!domain) throw Object.assign(new Error('Unknown service'), { status: 400 });

  const brief = emptyBriefForDomain(domain);
  const checklist = defaultChecklist(domain);

  const insert = await poll.query(
    `INSERT INTO tbl_strategist_sessions (user_email, service, brief, checklist, state)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, 'in_progress')
     RETURNING id, user_email, service, brief, checklist, ready_to_generate, state, project_id, created_at, updated_at`,
    [userEmail || null, service, JSON.stringify(brief), JSON.stringify(checklist)]
  );
  const session = insert.rows[0];

  // Seed with the assistant greeting so the UI has something to render
  // immediately without paying for an LLM round-trip.
  const greeting = domain.greeting;
  const chips = Array.isArray(domain.greeting_chips) ? domain.greeting_chips : [];

  await poll.query(
    `INSERT INTO tbl_strategist_messages (session_id, role, content, suggestions)
     VALUES ($1, 'assistant', $2, $3::jsonb)`,
    [session.id, greeting, JSON.stringify(chips)]
  );

  return loadSession(session.id);
}

// The DB columns are TIMESTAMP WITHOUT TIME ZONE and we write via NOW()
// which is UTC. node-pg reads them back by parsing the string AS LOCAL
// TIME, so the resulting Date silently shifts by the backend server's
// TZ offset (we saw ~5h of drift in chats created from an IST server,
// which exactly matches the UTC+5:30 offset). This helper takes the
// pg-returned Date (or string) and produces a real UTC ISO so the
// frontend's `Date.now() - then` math is correct regardless of where
// the backend is hosted.
function asUtcIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  // Shift forward by the local TZ offset so the Date's UTC components
  // match what was actually stored. getTimezoneOffset returns minutes
  // and is positive for west of UTC, negative for east.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
}

async function loadSession(id) {
  // poll.query() unwraps SELECT results to the raw rows array (see
  // config/dbconfig.js adaptResult), so we operate on it directly.
  const rows = await poll.query(
    `SELECT id, user_email, service, title, brief, checklist, ready_to_generate, state, project_id, created_at, updated_at
       FROM tbl_strategist_sessions WHERE id = $1`,
    [id]
  );
  if (!rows || !rows.length) return null;
  const session = rows[0];
  session.created_at = asUtcIso(session.created_at);
  session.updated_at = asUtcIso(session.updated_at);

  const messages = await poll.query(
    `SELECT id, role, content, suggestions, attachments, created_at
       FROM tbl_strategist_messages WHERE session_id = $1 ORDER BY id ASC`,
    [id]
  );
  session.messages = (messages || []).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    suggestions: row.suggestions || [],
    attachments: row.attachments || [],
    created_at: asUtcIso(row.created_at),
  }));
  return session;
}

async function listSessions({ userEmail, service }) {
  const params = [];
  const where = ['state <> $1'];
  params.push('deleted');
  if (userEmail) {
    params.push(userEmail);
    where.push(`user_email = $${params.length}`);
  }
  if (service) {
    params.push(service);
    where.push(`service = $${params.length}`);
  }
  const sql = `
    SELECT id, service, title, brief, ready_to_generate, state, project_id, updated_at
      FROM tbl_strategist_sessions
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT 50`;
  // SELECT returns raw rows array via the poll wrapper.
  const rows = await poll.query(sql, params);
  return (rows || []).map((r) => ({
    ...r,
    updated_at: asUtcIso(r.updated_at),
  }));
}

async function appendMessage({ sessionId, role, content, suggestions, attachments }) {
  await poll.query(
    `INSERT INTO tbl_strategist_messages (session_id, role, content, suggestions, attachments)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      sessionId,
      role,
      content,
      JSON.stringify(suggestions || []),
      attachments && attachments.length ? JSON.stringify(attachments) : null,
    ]
  );
}

async function persistTurn({ sessionId, brief, checklist, readyToGenerate, title }) {
  await poll.query(
    `UPDATE tbl_strategist_sessions
        SET brief = $2::jsonb,
            checklist = $3::jsonb,
            ready_to_generate = $4,
            title = COALESCE($5, title),
            updated_at = NOW()
      WHERE id = $1`,
    [
      sessionId,
      JSON.stringify(brief || {}),
      JSON.stringify(checklist || []),
      Boolean(readyToGenerate),
      title || null,
    ]
  );
}

async function markCompleted({ sessionId, projectId }) {
  await poll.query(
    `UPDATE tbl_strategist_sessions
        SET state = 'completed', project_id = COALESCE($2, project_id), updated_at = NOW()
      WHERE id = $1`,
    [sessionId, projectId || null]
  );
}

// Soft delete: flip state to 'deleted'. listSessions already filters
// state <> 'deleted', so the chat disappears from the sidebar without
// losing history (audit / undo later if we want).
async function deleteSession({ sessionId, userEmail }) {
  // Scope by user_email when we have it, so a user can only delete
  // their own sessions. When no email is supplied (anonymous), only
  // require the id.
  if (userEmail) {
    await poll.query(
      `UPDATE tbl_strategist_sessions
          SET state = 'deleted', updated_at = NOW()
        WHERE id = $1 AND LOWER(user_email) = LOWER($2)`,
      [sessionId, userEmail]
    );
  } else {
    await poll.query(
      `UPDATE tbl_strategist_sessions
          SET state = 'deleted', updated_at = NOW()
        WHERE id = $1`,
      [sessionId]
    );
  }
}

// ---------- LLM turn ----------

const MAX_TOOL_ITERATIONS = 4;

async function runTurn({ session, userMessage, model, userEmail }) {
  const domain = getDomain(session.service);
  if (!domain) throw Object.assign(new Error('Unknown service'), { status: 400 });

  // Persist the user message first so it's part of the next loadSession() result.
  await appendMessage({
    sessionId: session.id,
    role: 'user',
    content: userMessage,
    suggestions: [],
  });

  // Build conversation history for the LLM. The greeting we seeded counts
  // as the first assistant turn; LLM messages alternate user/assistant.
  const history = [...session.messages, { role: 'user', content: userMessage }];

  // Stitch consecutive same-role text-only messages so the Anthropic API
  // sees strict user/assistant alternation. Each `content` here is a
  // string at this point; tool_use/tool_result blocks get appended later
  // in the loop as content arrays.
  const llmMessages = [];
  for (const msg of history) {
    if (!msg.content) continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (llmMessages.length && llmMessages[llmMessages.length - 1].role === role
        && typeof llmMessages[llmMessages.length - 1].content === 'string') {
      llmMessages[llmMessages.length - 1].content += `\n\n${msg.content}`;
    } else {
      llmMessages.push({ role, content: msg.content });
    }
  }

  const systemPrompt = buildSystemPrompt(domain);
  const briefSoFar = session.brief || emptyBriefForDomain(domain);

  // Embed the current brief + schema reminder inside the final user message
  // so the model sees "here's what you already know" without mutating the
  // user-visible message itself.
  const lastUser = llmMessages[llmMessages.length - 1];
  if (typeof lastUser.content === 'string') {
    lastUser.content = [
      lastUser.content,
      '',
      '<context>',
      `Current brief (as filled so far): ${JSON.stringify(briefSoFar)}`,
      `Schema for your JSON response: ${JSON.stringify(TURN_SCHEMA)}`,
      '</context>',
    ].join('\n');
  }

  const tools = definitionsForDomain(domain);
  const selectedModel = pickModel(model, domain);

  // Prompt-cache the system prompt + tool definitions: they're stable
  // across turns and account for most of the input-token cost, so caching
  // them shaves both latency and price. cache_control on the last system
  // block + last tool block marks the prefix for reuse for ~5 minutes.
  const systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  const cachedTools = tools.length
    ? tools.map((t, i) =>
        i === tools.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' } }
          : t
      )
    : [];

  // Tool-use loop. Anthropic returns `stop_reason: "tool_use"` when the
  // model wants to call a tool; we execute every tool_use block and pass
  // tool_result blocks back in the next request. Bounded by
  // MAX_TOOL_ITERATIONS so a misbehaving model can't spin forever.
  // While we loop we also collect any `_attachment` payloads returned by
  // tools (e.g. generated logos) so we can surface them as inline cards
  // on the final assistant message.
  let completion = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const producedAttachments = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    completion = await client.messages.create({
      model: selectedModel,
      max_tokens: 1500,
      system: systemBlocks,
      messages: llmMessages,
      ...(cachedTools.length ? { tools: cachedTools } : {}),
    });
    totalInputTokens += completion.usage?.input_tokens || 0;
    totalOutputTokens += completion.usage?.output_tokens || 0;

    if (completion.stop_reason !== 'tool_use') break;

    // Echo the assistant's tool_use blocks, then append a user message
    // containing the matching tool_result blocks.
    llmMessages.push({ role: 'assistant', content: completion.content });

    const toolUses = (completion.content || []).filter((b) => b.type === 'tool_use');
    const toolResults = await Promise.all(
      toolUses.map(async (block) => {
        const result = await runTool({
          name: block.name,
          input: block.input || {},
          userEmail,
        });
        // Pull attachments OUT of the result before showing it to the
        // model: the LLM only needs to know "the tool succeeded and made
        // N images", not re-serialize the URLs in its reply text.
        if (result && result._attachment) {
          producedAttachments.push(result._attachment);
          delete result._attachment;
        }
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      })
    );
    // Append the tool_result blocks AND a short text reminder that the
    // next response must still follow the JSON schema. Without this,
    // Haiku in particular tends to drift into a plain "Here you go!"
    // text reply and we lose the structured envelope.
    llmMessages.push({
      role: 'user',
      content: [
        ...toolResults,
        {
          type: 'text',
          text: 'Now reply to the user. Your next response MUST be the JSON object that matches the schema. Do not include any text outside the JSON. The user-facing message goes in the "reply" field. If tools produced images, mention them briefly in "reply" (the UI renders the images automatically, do not paste URLs).',
        },
      ],
    });
  }

  // Record token usage best-effort; don't block the response on failure.
  if (totalInputTokens || totalOutputTokens) {
    usage.recordUsage({
      userEmail,
      kind: 'llm',
      model: selectedModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      service: session.service,
    }).catch(() => { /* logged downstream */ });
  }

  // Concatenate all text blocks (Haiku sometimes emits multiple after a
  // tool call) so we don't lose the visible part of the reply.
  const text = (completion.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();
  const parsed = extractJson(text);

  // Graceful fallback: if the model returned a plain text reply (common
  // after a tool call, especially with Haiku), treat the whole text as
  // the assistant's reply and reuse the prior brief / checklist instead
  // of failing the turn. The attachments from tool results are still
  // attached separately below.
  const fallbackReply =
    text ||
    (producedAttachments.length
      ? "Here's what I made for you."
      : "Sorry, I got tangled up. Could you say that again?");

  const safeParsed = parsed && typeof parsed === 'object' ? parsed : {
    reply: fallbackReply,
    suggestions: [],
    brief: briefSoFar,
    checklist: session.checklist || defaultChecklist(domain),
    ready_to_generate: false,
    summary: '',
    route: '',
  };

  const mergedBrief = safeParsed.brief && typeof safeParsed.brief === 'object'
    ? { ...briefSoFar, ...safeParsed.brief }
    : briefSoFar;

  const turn = sanitizeTurn({
    reply: typeof safeParsed.reply === 'string' && safeParsed.reply.trim()
      ? safeParsed.reply
      : fallbackReply,
    suggestions: Array.isArray(safeParsed.suggestions) ? safeParsed.suggestions : [],
    multi_select: Boolean(safeParsed.multi_select),
    brief: mergedBrief,
    checklist: Array.isArray(safeParsed.checklist) && safeParsed.checklist.length
      ? safeParsed.checklist
      : (session.checklist || defaultChecklist(domain)),
    // Trust the LLM, but if every required field is filled and the LLM
    // forgot to flip the flag, do it for them.
    ready_to_generate: Boolean(safeParsed.ready_to_generate) || computeReadyFallback(domain, mergedBrief),
    summary: typeof safeParsed.summary === 'string' ? safeParsed.summary : '',
    route: typeof safeParsed.route === 'string' ? safeParsed.route : '',
    chat_title: typeof safeParsed.chat_title === 'string' ? safeParsed.chat_title : '',
  });

  // Persist a chip_meta attachment when multi_select is on so that a
  // page reload re-renders the chips in multi-select mode (the
  // suggestions array on its own doesn't carry that flag).
  const persistedAttachments = turn.multi_select
    ? [...producedAttachments, { type: 'chip_meta', multi_select: true }]
    : producedAttachments;

  await appendMessage({
    sessionId: session.id,
    role: 'assistant',
    content: turn.reply,
    suggestions: turn.suggestions,
    attachments: persistedAttachments,
  });

  // Title precedence: explicit chat_title from the LLM > brand_name on
  // the running brief > leave whatever the column already has. The
  // SQL update uses COALESCE, so passing null keeps the existing title.
  await persistTurn({
    sessionId: session.id,
    brief: turn.brief,
    checklist: turn.checklist,
    readyToGenerate: turn.ready_to_generate,
    title: turn.chat_title?.trim() || turn.brief?.brand_name || null,
  });

  return {
    session_id: session.id,
    reply: turn.reply,
    suggestions: turn.suggestions,
    multi_select: turn.multi_select,
    brief: turn.brief,
    checklist: turn.checklist,
    ready_to_generate: turn.ready_to_generate,
    summary: turn.summary,
    route: turn.route,
    // The persisted title (LLM-supplied chat_title > brand_name > the
    // session's current title). Surfaced so AIManager can update the
    // sidebar row immediately without a re-fetch.
    title: turn.chat_title?.trim() || turn.brief?.brand_name || session.title || null,
    attachments: persistedAttachments,
  };
}

module.exports = {
  ALLOWED_MODELS: Array.from(ALLOWED_MODELS),
  DEFAULT_MODEL,
  createSession,
  loadSession,
  listSessions,
  runTurn,
  markCompleted,
  deleteSession,
  isKnownService,
};
