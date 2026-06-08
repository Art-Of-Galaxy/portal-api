// Thin subprocess wrapper around the `higgsfield` CLI.
//
// The CLI handles auth (the operator runs `higgsfield auth login` on the
// host once), JSON output is requested via the global --json flag, and
// results come back as plain objects.
//
// We isolate the spawn here so that swapping to the REST API later only
// touches this file. The CLI's exit code is non-zero on hard failures
// (uploading, schema rejection); soft failures like a `failed` job
// status are reported in the JSON payload and surfaced to the caller.

// cross-spawn is a drop-in replacement for child_process.spawn that
// papers over Windows-specific issues:
//   - finds .cmd / .bat shims via PATHEXT,
//   - works around Node 22's CVE-2024-27980 hardening which throws
//     EINVAL when shell:false is used with .cmd files,
//   - escapes arguments correctly for cmd.exe.
// On Linux/macOS it just calls through to child_process.spawn.
const { spawn } = require('cross-spawn');

// Resolve the binary name once. On Windows, Node's spawn() (with
// shell:false, which we want for safety) does NOT consult PATHEXT, so
// the bare name "higgsfield" fails with ENOENT even though
// `higgsfield.cmd` is on PATH. npm/Go installers always drop a `.cmd`
// shim alongside the binary on Windows, so we target that explicitly.
// Operators can still override with HIGGSFIELD_BIN (e.g. for a custom
// install path or a forked CLI).
function resolveHiggsfieldBin() {
  if (process.env.HIGGSFIELD_BIN) return process.env.HIGGSFIELD_BIN;
  if (process.platform === 'win32') return 'higgsfield.cmd';
  return 'higgsfield';
}

const HIGGSFIELD_BIN = resolveHiggsfieldBin();

// Higgsfield's CLI writes structured failure JSON to stderr in the form
// `Error: { ...json... }`. Parse it so callers can branch on error_type
// (e.g. credit exhaustion) instead of guessing from a raw text blob.
function parseHiggsfieldError(stderr) {
  if (!stderr || typeof stderr !== 'string') return null;
  const match = stderr.match(/Error:\s*(\{[\s\S]+\})\s*$/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[1]);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// Map known Higgsfield error_type values to a human sentence + the
// correct HTTP status so the frontend can render meaningful guidance.
function friendlyMessageFor(parsed) {
  const type = String(parsed?.error_type || '').toLowerCase();
  switch (type) {
    case 'not_enough_credits':
      return {
        status: 402,
        message: 'Higgsfield ran out of credits before this video could render. Top up the Higgsfield workspace (info@artofgalaxy.com) and try again.',
      };
    case 'unauthorized':
    case 'unauthenticated':
      return {
        status: 401,
        message: 'Higgsfield is not authenticated on this server. Run `higgsfield auth login` on the host and retry.',
      };
    case 'rate_limited':
      return {
        status: 429,
        message: 'Higgsfield is rate limiting requests right now. Wait a minute and try again.',
      };
    case 'invalid_input':
    case 'validation_error':
      return {
        status: 400,
        message: 'Higgsfield rejected the brief. Check that your product image and form values are valid.',
      };
    case 'safety_blocked':
    case 'content_policy':
      return {
        status: 422,
        message: 'Higgsfield blocked this prompt or image under its content policy. Tweak the brief and retry.',
      };
    default:
      return {
        status: 502,
        message: `Higgsfield returned an error (${type || 'unknown'}). Try again or contact support if it persists.`,
      };
  }
}

// How long to wait for a single CLI invocation. Generation can run up
// to ~30 minutes; expose this as an env var so ops can tune it.
const DEFAULT_TIMEOUT_MS = Number(process.env.HIGGSFIELD_TIMEOUT_MS) || 30 * 60 * 1000;

function runCli(args, { timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const proc = spawn(HIGGSFIELD_BIN, args, {
      cwd,
      shell: false,
      env: process.env,
    });

    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(Object.assign(new Error('higgsfield CLI timed out'), {
        status: 504,
        command: ['higgsfield', ...args].join(' '),
      }));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      reject(Object.assign(new Error(`higgsfield CLI launch failed: ${err.message}`), {
        status: 500,
        command: ['higgsfield', ...args].join(' '),
      }));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (code !== 0) {
        const parsed = parseHiggsfieldError(stderr);
        if (parsed) {
          const friendly = friendlyMessageFor(parsed);
          return reject(Object.assign(new Error(friendly.message), {
            status: friendly.status,
            errorCode: parsed.error_type || 'higgsfield_error',
            higgsfield: parsed,
            exitCode: code,
            stderr: stderr.trim(),
            stdout: stdout.trim(),
            command: ['higgsfield', ...args].join(' '),
          }));
        }
        return reject(Object.assign(new Error(
          `higgsfield CLI exited ${code}: ${stderr.trim() || stdout.trim() || 'no output'}`
        ), {
          status: 502,
          errorCode: 'higgsfield_cli_failed',
          exitCode: code,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
          command: ['higgsfield', ...args].join(' '),
        }));
      }
      return resolve({ stdout, stderr });
    });
  });
}

// Run a CLI command and parse its stdout as JSON.
async function runJson(args, opts) {
  const { stdout } = await runCli([...args, '--json'], opts);
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // Some commands emit progress lines before the final JSON; grab the
    // last balanced { ... } or [ ... ] block as a recovery path.
    const lastBrace = Math.max(trimmed.lastIndexOf('{'), trimmed.lastIndexOf('['));
    const lastClose = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (lastBrace >= 0 && lastClose > lastBrace) {
      const candidate = trimmed.slice(lastBrace, lastClose + 1);
      try { return JSON.parse(candidate); } catch { /* fall through */ }
    }
    throw Object.assign(new Error(`higgsfield CLI returned non-JSON: ${err.message}`), {
      status: 502,
      raw: trimmed.slice(0, 2000),
    });
  }
}

// Wait until an async job reaches a terminal status.
async function waitForStatus(getter, { intervalMs = 6000, timeoutMs = 10 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const obj = await getter();
    const status = obj?.status;
    if (status === 'completed' || status === 'failed') return obj;
    if (Date.now() > deadline) {
      throw Object.assign(new Error(`Higgsfield job did not finish in time (status=${status})`), {
        status: 504,
        last: obj,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ----- Convenience commands the ugc-ads service actually uses -----

async function uploadFile(localPath) {
  const obj = await runJson(['upload', 'create', localPath], { timeoutMs: 5 * 60 * 1000 });
  if (!obj?.id) {
    throw Object.assign(new Error('higgsfield upload returned no id'), { status: 502, response: obj });
  }
  return obj;
}

async function createAdReferenceFromVideo(videoUploadId) {
  return runJson([
    'marketing-studio', 'ad-references', 'create',
    '--video-input', videoUploadId,
  ]);
}

async function getAdReference(id) {
  return runJson(['marketing-studio', 'ad-references', 'get', id]);
}

async function waitForAdReferenceReady(id, opts) {
  return waitForStatus(() => getAdReference(id), opts);
}

async function generateMarketingStudioVideo({
  prompt,
  imageUploadIds = [],
  adReferenceId = null,
  mode = 'ugc',
  aspectRatio = '9:16',
  duration = 15,
  resolution = '720p',
  generateAudio = true,
}) {
  const args = [
    'generate', 'create', 'marketing_studio_video',
    '--prompt', prompt,
    '--mode', mode,
    '--aspect_ratio', aspectRatio,
    '--duration', String(duration),
    '--resolution', resolution,
    '--generate_audio', generateAudio ? 'true' : 'false',
    '--wait',
  ];
  // CLI supports repeated --image flags for multiple product images.
  for (const id of imageUploadIds) {
    if (id) { args.push('--image', id); }
  }
  if (adReferenceId) {
    args.push('--ad_reference_id', adReferenceId);
  }
  return runJson(args);
}

async function getAccountStatus() {
  // The CLI's `account status` doesn't currently support --json; we
  // parse the human-readable line: "<email> — <plan> plan, <credits> credits".
  try {
    const { stdout } = await runCli(['account', 'status'], { timeoutMs: 30_000 });
    const text = stdout.trim();
    return { ok: true, raw: text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  runCli,
  runJson,
  uploadFile,
  createAdReferenceFromVideo,
  getAdReference,
  waitForAdReferenceReady,
  generateMarketingStudioVideo,
  getAccountStatus,
};
