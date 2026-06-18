/**
 * FCGBDS Telemetry System
 * Sends usage statistics and security events back to FCG systems
 */

import axios from 'axios';
import crypto from 'crypto';
import os from 'os';
import { BotDefenseMiddleware } from './botDefense';

export interface TelemetryConfig {
  botDefense: BotDefenseMiddleware;
  apiBaseUrl: string;
  telemetryEndpoint: string;
  blockchainAnchorEndpoint: string;
  blockchainAnchorEnabled: boolean;
  blockchainNetwork: string;
  instanceId?: string;
  sendInterval: number; // milliseconds
  enabled: boolean;
}

export interface TelemetryData {
  timestamp: number;
  licenseKey: string;
  version: string;
  uptime: number;
  botDefenseStats: any;
  blockedRequests: number;
  totalRequests: number;
  systemInfo: any;
}

export interface AnchoredDataPoint {
  schemaVersion: string;
  source: string;
  instanceId: string;
  network: string;
  type: string;
  capturedAt: number;
  payload: Record<string, any>;
  payloadHash: string;
}

export class TelemetryManager {
  private config: TelemetryConfig;
  private sendInterval?: NodeJS.Timeout;
  private startTime: number = Date.now();
  private requestCount: number = 0;
  private blockedCount: number = 0;
  private instanceId: string;
  private anchorSentCount: number = 0;
  private anchorFailedCount: number = 0;
  private lastAnchorHash: string | null = null;
  private lastAnchorAt: number | null = null;
  private lastAnchorError: string | null = null;

  constructor(config: TelemetryConfig) {
    this.config = config;
    this.instanceId = String(
      this.config.instanceId || process.env.FCGBDS_INSTANCE_ID || os.hostname() || 'fcgbds-instance'
    ).trim();
  }

  /**
   * Start telemetry collection and sending
   */
  public start(): void {
    if (!this.config.enabled) {
      console.log('[TelemetryManager] Telemetry disabled');
      return;
    }

    console.log('[TelemetryManager] Starting telemetry collection');
    this.sendInterval = setInterval(() => {
      this.sendTelemetry();
    }, this.config.sendInterval);
  }

  /**
   * Stop telemetry collection
   */
  public stop(): void {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = undefined;
    }
  }

  /**
   * Record a request
   */
  public recordRequest(blocked: boolean = false): void {
    this.requestCount++;
    if (blocked) {
      this.blockedCount++;
    }
  }

  /**
   * Collect system information
   */
  private getSystemInfo(): any {
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      cpuUsage: process.cpuUsage(),
    };
  }

  private hashPayload(payload: Record<string, any>): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(payload || {}))
      .digest('hex');
  }

  private createAnchoredDataPoint(type: string, payload: Record<string, any>): AnchoredDataPoint {
    return {
      schemaVersion: 'fcgbds.anchor.v1',
      source: 'fcgbds-customer-system',
      instanceId: this.instanceId,
      network: this.config.blockchainNetwork,
      type,
      capturedAt: Date.now(),
      payload,
      payloadHash: this.hashPayload(payload),
    };
  }

  private async sendAnchoredDataPoints(dataPoints: AnchoredDataPoint[]): Promise<void> {
    if (!this.config.blockchainAnchorEnabled) {
      return;
    }

    if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
      return;
    }

    try {
      const response = await axios.post(
        `${this.config.apiBaseUrl}${this.config.blockchainAnchorEndpoint}`,
        {
          action: 'anchor_datapoints',
          dataPoints,
          timestamp: Date.now(),
        },
        {
          timeout: 7000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'FCGBDS-Customer/1.0.0',
          },
        }
      );

      this.anchorSentCount += dataPoints.length;
      this.lastAnchorAt = Date.now();
      this.lastAnchorHash = String(response?.data?.anchorBatchId || dataPoints[dataPoints.length - 1]?.payloadHash || '');
      this.lastAnchorError = null;
      console.log(`[TelemetryManager] Anchored ${dataPoints.length} datapoint(s)`);
    } catch (error: any) {
      this.anchorFailedCount += dataPoints.length;
      this.lastAnchorError = error.message;
      console.warn('[TelemetryManager] Anchor datapoint send failed:', error.message);
    }
  }

  /**
   * Collect telemetry data
   */
  private async collectTelemetry(): Promise<TelemetryData> {
    return {
      timestamp: Date.now(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: Date.now() - this.startTime,
      botDefenseStats: this.config.botDefense.getStats(),
      blockedRequests: this.blockedCount,
      totalRequests: this.requestCount,
      systemInfo: this.getSystemInfo(),
    };
  }

  /**
   * Send telemetry data
   */
  public async sendTelemetry(): Promise<void> {
    try {
      const data = await this.collectTelemetry();

      await axios.post(
        `${this.config.apiBaseUrl}${this.config.telemetryEndpoint}`,
        {
          action: 'telemetry',
          data,
        },
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'FCGBDS-Customer/1.0.0',
          },
        }
      );

      console.log('[TelemetryManager] Telemetry sent successfully');

      const anchored = this.createAnchoredDataPoint('periodic_telemetry_summary', {
        blockedRequests: data.blockedRequests,
        totalRequests: data.totalRequests,
        uptimeMs: data.uptime,
        version: data.version,
        botDefenseStats: data.botDefenseStats,
      });
      await this.sendAnchoredDataPoints([anchored]);
    } catch (error: any) {
      console.warn('[TelemetryManager] Telemetry send failed:', error.message);
    }
  }

  /**
   * Send security event
   */
  public async sendSecurityEvent(eventType: string, details: any): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      await axios.post(
        `${this.config.apiBaseUrl}${this.config.telemetryEndpoint}`,
        {
          action: 'security_event',
          eventType,
          details,
          timestamp: Date.now(),
        },
        {
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'FCGBDS-Customer/1.0.0',
          },
        }
      );

      console.log(`[TelemetryManager] Security event sent: ${eventType}`);

      const anchored = this.createAnchoredDataPoint('security_event', {
        eventType,
        detailsHash: this.hashPayload(details || {}),
      });
      await this.sendAnchoredDataPoints([anchored]);
    } catch (error: any) {
      console.warn('[TelemetryManager] Security event send failed:', error.message);
    }
  }

  /**
   * Get current telemetry status
   */
  public getStatus(): any {
    return {
      enabled: this.config.enabled,
      totalRequests: this.requestCount,
      blockedRequests: this.blockedCount,
      uptime: Date.now() - this.startTime,
      nextSendTime: this.sendInterval
        ? new Date(Date.now() + this.config.sendInterval).toISOString()
        : null,
      blockchainAnchor: {
        enabled: this.config.blockchainAnchorEnabled,
        network: this.config.blockchainNetwork,
        sent: this.anchorSentCount,
        failed: this.anchorFailedCount,
        lastAnchorHash: this.lastAnchorHash,
        lastAnchorAt: this.lastAnchorAt ? new Date(this.lastAnchorAt).toISOString() : null,
        lastError: this.lastAnchorError,
      },
    };
  }
}

/**
 * Create telemetry manager instance
 */
export function createTelemetryManager(config: TelemetryConfig): TelemetryManager {
  return new TelemetryManager(config);
}
