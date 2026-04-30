require('dotenv').config();

const express = require('express');
const app = express();
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const passport = require('./config/passport');
const authRouter = require('./auth/router');
const { ensureDatabaseSchema } = require('./config/initdb');
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Database-Id', 'X-User-Email']
}));

// Middleware to parse incoming requests
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

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
app.use('/api/rebranding', require('./rebranding/router'));
app.use('/api/ecommerce-mockups', require('./ecommerce-mockups/router'));
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
