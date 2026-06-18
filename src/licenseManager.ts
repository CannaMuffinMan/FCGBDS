/**
 * FCGBDS License Manager — Open Source Edition
 *
 * The FCGBDS is free and open source software (MIT License).
 * No license key, no remote validation, no expiry. This module
 * is a compatibility shim for code that previously referenced it.
 */

export interface LicenseValidationResult {
  valid: boolean;
  devAccountId?: string;
  expiresAt?: string;
  error?: string;
  telemetryRequired?: boolean;
}

export interface LicenseConfig {
  /** Unused in open source edition. */
  licenseKey?: string;
  /** Unused in open source edition. */
  licenseSecret?: string;
  apiBaseUrl?: string;
  telemetryEndpoint?: string;
  enableRemoteValidation?: boolean;
}

export class LicenseManager {
  constructor(_config?: LicenseConfig) {}

  /** Always valid — open source edition requires no license key. */
  public async validateLicense(_licenseKey?: string): Promise<LicenseValidationResult> {
    return { valid: true, devAccountId: 'open-source', expiresAt: 'never' };
  }

  /** No-op — telemetry is opt-in local only in open source edition. */
  public async sendTelemetry(_data: any): Promise<boolean> {
    return true;
  }

  /** Always returns a valid status. */
  public async getLicenseStatus(): Promise<any> {
    return {
      valid: true,
      expiresAt: 'never',
      openSource: true,
      lastValidation: new Date().toISOString(),
    };
  }
}

export function createLicenseManager(_config?: LicenseConfig): LicenseManager {
  return new LicenseManager(_config);
}
