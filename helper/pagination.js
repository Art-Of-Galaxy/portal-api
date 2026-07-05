// Pagination helper for list endpoints. Standardizes the `?limit=&offset=`
// query params and the response envelope so every list in the API
// looks the same to the frontend.
//
// Usage in a controller:
//
//   const { limit, offset } = pagination.parse(req);
//   const rows = await poll.query(`... LIMIT $1 OFFSET $2`, [limit, offset, ...]);
//   const total = (await poll.query(`SELECT COUNT(*) AS c FROM ...`))[0]?.c || 0;
//   return res.status(200).json({
//     success: true,
//     items: rows,
//     pagination: pagination.envelope({ total, limit, offset }),
//   });
//
// Frontend response contract:
//   pagination: { total, limit, offset, has_more, next_offset }
//
// Defaults: limit=10, max=100, offset=0. Callers can override defaults
// per-endpoint (e.g. admin tables might want limit=25).

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// Parse the pagination query params off req. Returns clamped/coerced
// integers. Never throws — invalid input falls back to defaults.
function parse(req, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const q = req?.query || {};
  const rawLimit = Number(q.limit);
  const rawOffset = Number(q.offset);
  let limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (limit < 1) limit = 1;
  let offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  if (offset < 0) offset = 0;
  return { limit, offset };
}

// Build the response `pagination` object.
function envelope({ total, limit, offset }) {
  const t = Math.max(0, Number(total) || 0);
  const l = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  const o = Math.max(0, Number(offset) || 0);
  const nextOffset = o + l;
  return {
    total: t,
    limit: l,
    offset: o,
    has_more: nextOffset < t,
    next_offset: nextOffset < t ? nextOffset : null,
  };
}

module.exports = {
  parse,
  envelope,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
