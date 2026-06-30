// Lightweight HTML scraper for blog-engine "reference website" briefs.
// No third-party HTML parser dependency, just axios + regex. The output
// is a structured digest the agent can read: title, meta description,
// h1/h2/h3 list, first ~2500 chars of visible body text.
//
// We deliberately keep this tiny: it's a hint for the writer, not a
// crawler. One URL per article brief, no link following.

const axios = require('axios');

const MAX_TEXT = 4000;       // hard cap on extracted body text length
const MAX_HEADINGS = 25;     // per-level
const REQUEST_TIMEOUT = 15_000;
const USER_AGENT = 'AOG-Blog-Engine/1.0 (+content brief reference scraper)';

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function strip(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}

function extractFirstMatch(html, regex) {
  const m = html.match(regex);
  return m ? strip(m[1]) : '';
}

function extractAll(html, regex, limit) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const v = strip(m[1]);
    if (v) out.push(v);
    if (limit && out.length >= limit) break;
  }
  return out;
}

// Pull the visible body text by stripping script/style/nav blocks then
// flattening tags to whitespace. Crude but fine for an LLM prompt input.
function extractBodyText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      .replace(/<form[\s\S]*?<\/form>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

/**
 * Fetch a URL and extract a structured digest for prompt injection.
 *
 * @param {string} url
 * @returns {Promise<{
 *   url: string,
 *   title: string,
 *   meta_description: string,
 *   og_title: string,
 *   og_description: string,
 *   h1: string[],
 *   h2: string[],
 *   h3: string[],
 *   body_text: string,
 *   fetched_at: string,
 * }>}
 */
async function scrapeReferenceUrl(url) {
  const target = normalizeUrl(url);
  if (!target) throw Object.assign(new Error('A reference URL is required'), { status: 400 });

  let html;
  try {
    const res = await axios.get(target, {
      timeout: REQUEST_TIMEOUT,
      maxContentLength: 5 * 1024 * 1024, // cap at 5MB to avoid huge pages
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en;q=0.9',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    html = String(res.data || '');
  } catch (err) {
    const e = new Error(`Could not fetch reference URL: ${err.message}`);
    e.status = err.response?.status || 502;
    throw e;
  }

  if (!html) {
    const e = new Error('Reference URL returned no HTML');
    e.status = 502;
    throw e;
  }

  return {
    url: target,
    title:            extractFirstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    meta_description: extractFirstMatch(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
                     || extractFirstMatch(html, /<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i),
    og_title:         extractFirstMatch(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
                     || extractFirstMatch(html, /<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i),
    og_description:   extractFirstMatch(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)
                     || extractFirstMatch(html, /<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i),
    h1:        extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi, MAX_HEADINGS),
    h2:        extractAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, MAX_HEADINGS),
    h3:        extractAll(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi, MAX_HEADINGS),
    body_text: extractBodyText(html),
    fetched_at: new Date().toISOString(),
  };
}

// Format a scrape result into a compact prompt block. Designed to be
// pasted into the user message before the brief so the writer can
// reference real content/tone/structure from the source.
function formatScrapeForPrompt(scrape) {
  if (!scrape || !scrape.url) return '';
  const lines = [
    '--- REFERENCE WEBSITE CONTEXT ---',
    `Source URL: ${scrape.url}`,
    scrape.title ? `Page title: ${scrape.title}` : null,
    (scrape.og_title && scrape.og_title !== scrape.title) ? `OG title: ${scrape.og_title}` : null,
    scrape.meta_description ? `Meta description: ${scrape.meta_description}` : null,
    (scrape.og_description && scrape.og_description !== scrape.meta_description) ? `OG description: ${scrape.og_description}` : null,
    scrape.h1?.length ? `H1: ${scrape.h1.join(' | ')}` : null,
    scrape.h2?.length ? `H2 outline: ${scrape.h2.slice(0, 12).join(' | ')}` : null,
    scrape.h3?.length ? `H3 outline: ${scrape.h3.slice(0, 12).join(' | ')}` : null,
    '',
    'Page body excerpt (use as factual / tone reference, do NOT copy):',
    scrape.body_text || '(no extractable body text)',
    '--- END REFERENCE ---',
  ];
  return lines.filter(Boolean).join('\n');
}

module.exports = {
  scrapeReferenceUrl,
  formatScrapeForPrompt,
};
