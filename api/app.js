/**
 * CoreIdentity PCM — API Application
 * Private Capital Markets Platform
 * Version: 1.0.0
 */

'use strict';

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const { v4: uuid } = require('uuid');
require('dotenv').config();

const { errorHandler }   = require('./middleware/error-handler');
const { requestLogger }  = require('./middleware/request-logger');
const { authenticate }   = require('./middleware/authenticate');
const { authorize }      = require('./middleware/authorize');
const healthRouter       = require('./routes/health');
const clientsRouter      = require('./routes/clients');
const assetsRouter       = require('./routes/assets');
const pehfRouter         = require('./routes/pehf');
const formsRouter        = require('./routes/forms');
const pipelineRouter     = require('./routes/pipeline');
const authRouter         = require('./routes/auth');
const uploadRouter       = require('./routes/upload');
const downloadRouter     = require('./routes/download');
const clientAuthRouter   = require('./routes/client-auth');
const referrersRouter    = require('./routes/referrers');
const leadsRouter        = require('./routes/leads');
const agentsRouter       = require('./routes/agents');
const activityRouter     = require('./routes/activity');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── TRUST PROXY (ALB) ────────────────────────────────────────────────────────
app.set('trust proxy', 1);

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: ['https://app.coregenisis.com','https://admin.coregenisis.com','https://client.coregenisis.com','https://coreg-admin-portal.pages.dev','https://coreg-client-portal.pages.dev','https://coreg-unified-portal.pages.dev'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID']
}));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later.' }
});
app.use(limiter);

// ─── REQUEST MIDDLEWARE ───────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  req.requestId = req.headers['x-request-id'] || uuid();
  next();
});
app.use(requestLogger);
app.use(morgan('combined'));

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/ping', (_req, res) => res.json({ ok: true }));
app.use('/health',    healthRouter);
app.get('/api/v1/health', healthRouter.coregHealth); // no auth — liveness probe
app.use('/api/v1/auth',     authRouter);
app.use('/api/v1/upload',   authenticate, uploadRouter);
app.use('/api/v1/download',     authenticate, downloadRouter);
app.use('/api/v1/client-auth',  clientAuthRouter);
app.use('/api/v1/referrers',    authenticate, referrersRouter);
app.use('/api/v1/leads/public',       leadsRouter);
app.use('/api/v1/leads/terms-acceptance', leadsRouter);
app.use('/api/v1/leads',        authenticate, leadsRouter);
app.use('/api/v1/agents',       authenticate, agentsRouter);
app.use('/api/v1/activity',     authenticate, activityRouter); // multipart/form-data
app.use('/api/v1/clients',  authenticate, clientsRouter);
app.use('/api/v1/assets',   authenticate, assetsRouter);
app.use('/api/v1/pehf',     authenticate, pehfRouter);
app.use('/api/v1/forms',    authenticate, formsRouter);
app.use('/api/v1/pipeline', authenticate, pipelineRouter);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'PCM API started',
    port: PORT,
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  }));
});

module.exports = app;
