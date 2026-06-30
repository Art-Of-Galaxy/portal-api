require('dotenv').config();

const express = require('express');
const filesController = require('./files/controller');
const s3 = require('./helper/s3_storage');
const app = express();
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('./config/passport');
const authRouter = require('./auth/router');
const { ensureDatabaseSchema } = require('./config/initdb');

// Print storage backend once at module load. On Vercel/Lambda this fires
// on every cold start; in dev it fires on every restart. Makes it trivial
// to confirm whether uploads are going to S3 or falling back to local disk
// (which is ephemeral on serverless and a common cause of "uploads vanish").
(() => {
  const info = s3.describeStorage();
  if (info.storage === 's3') {
    console.log(
      `[storage] Uploads → S3 bucket "${info.bucket}" in ${info.region}`
    );
  } else {
    console.warn(
      `[storage] Uploads → LOCAL DISK (S3 not configured). Missing env: ${info.missing_env.join(', ')}`
    );
    if (filesController.IS_SERVERLESS) {
      console.warn(
        '[storage] Running on serverless: local disk is ephemeral, files will disappear between cold starts.'
      );
    }
  }
})();
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Security middleware
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Database-Id', 'X-User-Email']
}));

// Middleware to parse incoming requests
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Serve user-uploaded files. Mounted before session/passport so static asset
// requests don't pay the session-lookup cost. helmet's default
// cross-origin-resource-policy would block <img> tags from the Vite dev
// server, so relax it just for /uploads.
//
// The uploads directory is resolved at request time (filesController picks a
// writable path: /tmp on serverless, ./uploads in dev). We don't pre-create
// it at startup because /var/task is read-only on Vercel/Lambda.
app.use(
  '/uploads',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  (req, res, next) => {
    express.static(filesController.uploadsRootDir(), {
      fallthrough: true,
      maxAge: '7d',
    })(req, res, next);
  }
);

// Session middleware (required for Passport OAuth)
app.use(
  session({
    secret: process.env.SECRET_KEY || 'default_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // Set to true if using HTTPS
  })
);

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// API Routes
app.use('/api/authentication', authRouter);
app.use('/api/notion', require('./notion/router'));
app.use('/api/staff', require('./staff/router'));
app.use('/api/brand-guidelines', require('./brand-guidelines/router'));
app.use('/api/printing-design', require('./printing-design/router'));
app.use('/api/packaging-design', require('./packaging-design/router'));
app.use('/api/social-media', require('./social-media/router'));
app.use('/api/social-connections', require('./social-connections/router'));
app.use('/api/shopify-connections', require('./shopify-connections/router'));
app.use('/api/blog-engine', require('./blog-engine/router'));
app.use('/api/wordpress-connections', require('./wordpress-connections/router'));
app.use('/api/wp-blog-engine', require('./wp-blog-engine/router'));
app.use('/api/rebranding', require('./rebranding/router'));
app.use('/api/ecommerce-mockups', require('./ecommerce-mockups/router'));
app.use('/api/logo-design', require('./logo-design/router'));
app.use('/api/ugc-ads', require('./ugc-ads/router'));
app.use('/api/strategist', require('./strategist/router'));
app.use('/api/quiz-drafts', require('./quiz-drafts/router'));
app.use('/api/usage', require('./usage/router'));
app.use('/api/revisions', require('./revisions/router'));
app.use('/api/files', require('./files/router'));
app.use('/api/admin', require('./admin/router'));

app.get('/', (_req, res) => {
  res.status(200).json({ status: true, message: 'AOG Portal API is running' });
});
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: true, message: 'AOG Portal API is running' });
});
app.get('/api/db-health', async (_req, res) => {
  try {
    await initializeDatabaseSchema();
    return res.status(200).json({ status: true, message: 'Database initialization succeeded' });
  } catch (error) {
    console.error('Database health check failed:', error);
    return res.status(500).json({
      status: false,
      message: 'Database initialization failed',
    });
  }
});

// Storage diagnostic — tells you whether uploads are routing to S3 or
// falling back to local disk. Public on purpose (no secrets returned).
app.get('/api/storage-health', (_req, res) => {
  const info = s3.describeStorage();
  return res.status(200).json({
    success: true,
    ...info,
    is_serverless: Boolean(filesController.IS_SERVERLESS),
    supported_extensions: s3.SUPPORTED_EXTENSIONS,
  });
});

// Server Listen
const PORT = process.env.PORT || 3000;
let schemaReadyPromise = null;

function initializeDatabaseSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureDatabaseSchema().catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

async function startServer() {
  try {
    await initializeDatabaseSchema();
    // Kick off the social-media post scheduler (cron, every minute).
    // Disable on per-instance basis with SOCIAL_SCHEDULER=off.
    try { require('./social-media/scheduler').start(); }
    catch (err) { console.error('Failed to start social-media scheduler:', err.message || err); }
    // Daily health probe for stored social connection tokens. Flips
    // hard-failed tokens to state='reauth_required' so the UI prompts.
    try { require('./social-connections/health').start(); }
    catch (err) { console.error('Failed to start connection health probe:', err.message || err); }
    // Blog Engine cron jobs: publish queue (every minute) + autopilot
    // refill (hourly). Disable per-cron via env BLOG_PUBLISH_SCHEDULER /
    // BLOG_AUTOPILOT_SCHEDULER.
    try { require('./blog-engine/scheduler').start(); }
    catch (err) { console.error('Failed to start blog-engine scheduler:', err.message || err); }
    // WordPress Blog Engine: separate cron jobs (publish + autopilot
    // refill). Disable per-cron via WP_BLOG_PUBLISH_SCHEDULER /
    // WP_BLOG_AUTOPILOT_SCHEDULER. On Vercel serverless the in-memory
    // cron is a no-op anyway; the real schedule is driven via HTTP
    // cron-job.org hitting /api/wp-blog-engine/cron/*.
    try { require('./wp-blog-engine/scheduler').start(); }
    catch (err) { console.error('Failed to start wp-blog-engine scheduler:', err.message || err); }

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
    process.exit(1);
  }
}

app.initializeDatabaseSchema = initializeDatabaseSchema;
app.startServer = startServer;

if (require.main === module) {
  startServer();
}

module.exports = app;
