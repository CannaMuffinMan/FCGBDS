/**
 * FCGBDS Customer System Main Server — Open Source Edition
 * Production-ready bot defense system for customer deployment.
 * Free and open source (MIT). No license key required.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import * as path from 'path';
import crypto from 'crypto';

import { createBotDefenseMiddleware, BotDefenseMiddleware } from './botDefense';
import { createUpdateManager, UpdateManager } from './updateManager';
import { createTelemetryManager, TelemetryManager } from './telemetryManager';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parsePathList(value: string | undefined, fallback: string[]): string[] {
  const raw = value?.trim();
  if (!raw) return fallback;
  return raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function ensureRequiredProtectedPaths(paths: string[]): string[] {
  const required = ['/api/chat-bridge/session/validate'];
  const normalized = new Set(paths.map((p) => p.trim()).filter(Boolean));
  for (const p of required) normalized.add(p);
  return Array.from(normalized);
}

function getClientIp(req: express.Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  if (forwarded) return forwarded.split(',')[0].trim();
  return String(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown');
}

function encryptIpForLog(ip: string, key: string): string {
  const normalizedIp = String(ip || 'unknown').trim().toLowerCase();
  const safeKey = String(key || '').trim() || 'fcgbds-ip-log-key';
  return crypto.createHmac('sha256', safeKey).update(normalizedIp).digest('hex').slice(0, 16);
}

const config = {
  port: parseInt(process.env.PORT || '3001'),
  host: process.env.HOST || '0.0.0.0',
  apiBaseUrl: process.env.FCG_API_BASE_URL || 'https://PLACEHOLDER_API_BASE_URL',
  telemetryEndpoint: process.env.FCG_TELEMETRY_ENDPOINT || '/api/fcgbds/telemetry',
  blockchainAnchorEndpoint: process.env.FCG_BLOCKCHAIN_ANCHOR_ENDPOINT || '/api/fcgbds/telemetry',
  blockchainAnchorEnabled: process.env.BLOCKCHAIN_ANCHOR_ENABLED !== 'false',
  blockchainNetwork: process.env.BLOCKCHAIN_ANCHOR_NETWORK || 'fcg-mainnet-remote',
  instanceId: process.env.FCGBDS_INSTANCE_ID || '',
  updateEndpoint: process.env.FCG_UPDATE_ENDPOINT || '/api/fcgbds/updates',
  botDefenseEnabled: process.env.BOT_DEFENSE_ENABLED === 'true',
  botDefenseRuntimeMode: process.env.BOT_DEFENSE_RUNTIME_MODE || 'zero-offload',
  botDefenseMaxIpHits: parseInt(process.env.BOT_DEFENSE_MAX_IP_HITS || '20'),
  botDefenseMaxDeviceHits: parseInt(process.env.BOT_DEFENSE_MAX_DEVICE_HITS || '15'),
  botDefenseMaxPayloadHits: parseInt(process.env.BOT_DEFENSE_MAX_PAYLOAD_HITS || '8'),
  botDefenseIpWindowMs: parseInt(process.env.BOT_DEFENSE_IP_WINDOW_MS || '60000'),
  botDefenseDeviceWindowMs: parseInt(process.env.BOT_DEFENSE_DEVICE_WINDOW_MS || '60000'),
  botDefensePayloadWindowMs: parseInt(process.env.BOT_DEFENSE_PAYLOAD_WINDOW_MS || '120000'),
  botDefenseExpectedHostname: process.env.BOT_DEFENSE_EXPECTED_HOSTNAME || '',
  botDefensePaths: ensureRequiredProtectedPaths(
    parsePathList(process.env.BOT_DEFENSE_PATHS, [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/email/login',
      '/api/auth/email/register',
      '/api/user/profile',
      '/api/payment',
    ]),
  ),
  autoUpdateEnabled: process.env.AUTO_UPDATE_ENABLED === 'true',
  updateCheckInterval: parseInt(process.env.UPDATE_CHECK_INTERVAL || '3600000'),
  updateBackupEnabled: process.env.UPDATE_BACKUP_ENABLED === 'true',
  telemetryEnabled: process.env.TELEMETRY_ENABLED !== 'false',
  telemetrySendInterval: parseInt(process.env.TELEMETRY_SEND_INTERVAL || '300000'),
  logLevel: process.env.LOG_LEVEL || 'info',
  installPath: path.join(__dirname, '..'),
};

const ipLogEncryptionKey = process.env.FCGBDS_LOG_IP_KEY || 'fcgbds-ip-log-key';

// Initialize components
const botDefense = createBotDefenseMiddleware({
  maxIpHits: config.botDefenseMaxIpHits,
  maxDeviceHits: config.botDefenseMaxDeviceHits,
  maxPayloadHits: config.botDefenseMaxPayloadHits,
  ipWindowMs: config.botDefenseIpWindowMs,
  deviceWindowMs: config.botDefenseDeviceWindowMs,
  payloadWindowMs: config.botDefensePayloadWindowMs,
  expectedHostname: config.botDefenseExpectedHostname,
  protectedPaths: config.botDefensePaths,
});

const updateManager = createUpdateManager({
  apiBaseUrl: config.apiBaseUrl,
  updateEndpoint: config.updateEndpoint,
  currentVersion: process.env.npm_package_version || '1.0.0',
  autoUpdateEnabled: config.autoUpdateEnabled,
  updateCheckInterval: config.updateCheckInterval,
  backupEnabled: config.updateBackupEnabled,
  installPath: config.installPath,
});

const telemetryManager = createTelemetryManager({
  botDefense,
  apiBaseUrl: config.apiBaseUrl,
  telemetryEndpoint: config.telemetryEndpoint,
  blockchainAnchorEndpoint: config.blockchainAnchorEndpoint,
  blockchainAnchorEnabled: config.blockchainAnchorEnabled,
  blockchainNetwork: config.blockchainNetwork,
  instanceId: config.instanceId,
  sendInterval: config.telemetrySendInterval,
  enabled: config.telemetryEnabled,
});

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  const startTime = Date.now();
  const encryptedClientIp = encryptIpForLog(getClientIp(req), ipLogEncryptionKey);
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const blocked = res.statusCode === 429 || res.statusCode === 403;
    telemetryManager.recordRequest(blocked);
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms ip=${encryptedClientIp}`);
  });
  next();
});

if (config.botDefenseEnabled) {
  app.use(botDefense.middleware);
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    openSource: true,
    botDefense: botDefense.getStats(),
    telemetry: telemetryManager.getStatus(),
    update: updateManager.getStatus(),
  });
});

app.get('/api/fcgbds/status', (_req, res) => {
  res.json({
    openSource: true,
    botDefense: botDefense.getStats(),
    telemetry: telemetryManager.getStatus(),
    update: updateManager.getStatus(),
  });
});

app.post('/api/fcgbds/check-updates', async (_req, res) => {
  try {
    const updateInfo = await updateManager.checkForUpdates();
    if (updateInfo) {
      res.json({ updateAvailable: true, version: updateInfo.version, releaseNotes: updateInfo.releaseNotes, required: updateInfo.required });
    } else {
      res.json({ updateAvailable: false });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/fcgbds/install-update', async (_req, res) => {
  try {
    const updateInfo = await updateManager.checkForUpdates();
    if (!updateInfo) return res.status(400).json({ error: 'No updates available' });
    const success = await updateManager.installUpdate(updateInfo);
    if (success) {
      res.json({ success: true, message: `Updated to ${updateInfo.version}` });
    } else {
      res.status(500).json({ error: 'Update installation failed' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/fcgbds/telemetry/send', async (_req, res) => {
  try {
    await telemetryManager.sendTelemetry();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.use('/api/*path', (_req, res) => {
  res.json({ message: 'FCGBDS protection active', protected: true, timestamp: new Date().toISOString() });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  telemetryManager.stop();
  updateManager.stopAutoCheck();
  botDefense.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  telemetryManager.stop();
  updateManager.stopAutoCheck();
  botDefense.destroy();
  process.exit(0);
});

async function startServer() {
  try {
    console.log('FCGBDS Open Source Edition — no license key required.');
    telemetryManager.start();
    updateManager.startAutoCheck();
    app.listen(config.port, config.host, () => {
      console.log(`FCGBDS Customer System v${process.env.npm_package_version || '1.0.0'} running on ${config.host}:${config.port}`);
      console.log('Bot defense:', config.botDefenseEnabled ? 'ENABLED' : 'DISABLED');
      console.log('Auto updates:', config.autoUpdateEnabled ? 'ENABLED' : 'DISABLED');
      console.log('Telemetry:', config.telemetryEnabled ? 'ENABLED' : 'DISABLED');
      console.log('Blockchain anchor:', config.blockchainAnchorEnabled ? `ENABLED (${config.blockchainNetwork})` : 'DISABLED');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

