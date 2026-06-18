/**
 * FCGBDS Update System
 * Handles automatic updates and version management
 */

import axios, { AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as semver from 'semver';

const execAsync = promisify(exec);

export interface UpdateConfig {
  apiBaseUrl: string;
  updateEndpoint: string;
  currentVersion: string;
  autoUpdateEnabled: boolean;
  updateCheckInterval: number; // milliseconds
  backupEnabled: boolean;
  installPath: string;
}

export interface UpdateInfo {
  version: string;
  downloadUrl: string;
  checksum: string;
  releaseNotes: string;
  required: boolean;
}

export class UpdateManager {
  private config: UpdateConfig;
  private checkInterval?: NodeJS.Timeout;
  private lastCheckTime: number = 0;

  constructor(config: UpdateConfig) {
    this.config = config;
  }

  /**
   * Start automatic update checking
   */
  public startAutoCheck(): void {
    if (!this.config.autoUpdateEnabled) {
      console.log('[UpdateManager] Auto-update disabled');
      return;
    }

    console.log('[UpdateManager] Starting auto-update checks');
    this.checkInterval = setInterval(() => {
      this.checkForUpdates();
    }, this.config.updateCheckInterval);
  }

  /**
   * Stop automatic update checking
   */
  public stopAutoCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
  }

  /**
   * Check for available updates
   */
  public async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      console.log('[UpdateManager] Checking for updates...');

      const response: AxiosResponse = await axios.get(
        `${this.config.apiBaseUrl}${this.config.updateEndpoint}`,
        {
          params: {
            currentVersion: this.config.currentVersion,
          },
          timeout: 10000,
          headers: {
            'User-Agent': 'FCGBDS-Customer/1.0.0',
          },
        }
      );

      const updateInfo: UpdateInfo = response.data;

      if (semver.gt(updateInfo.version, this.config.currentVersion)) {
        console.log(`[UpdateManager] Update available: ${updateInfo.version}`);
        return updateInfo;
      } else {
        console.log('[UpdateManager] No updates available');
        return null;
      }
    } catch (error: any) {
      console.warn('[UpdateManager] Update check failed:', error.message);
      return null;
    }
  }

  /**
   * Download and install update
   */
  public async installUpdate(updateInfo: UpdateInfo): Promise<boolean> {
    try {
      console.log(`[UpdateManager] Installing update ${updateInfo.version}`);

      // Create backup if enabled
      if (this.config.backupEnabled) {
        await this.createBackup();
      }

      // Download update
      const downloadPath = path.join(this.config.installPath, `fcgbds-${updateInfo.version}.tar.gz`);
      await this.downloadFile(updateInfo.downloadUrl, downloadPath);

      // Verify checksum
      const isValid = await this.verifyChecksum(downloadPath, updateInfo.checksum);
      if (!isValid) {
        throw new Error('Checksum verification failed');
      }

      // Extract update
      await this.extractUpdate(downloadPath, this.config.installPath);

      // Run post-install script if exists
      await this.runPostInstall();

      // Update version
      this.config.currentVersion = updateInfo.version;

      console.log(`[UpdateManager] Update ${updateInfo.version} installed successfully`);
      return true;
    } catch (error: any) {
      console.error('[UpdateManager] Update installation failed:', error.message);
      await this.rollbackBackup();
      return false;
    }
  }

  /**
   * Download file from URL
   */
  private async downloadFile(url: string, destPath: string): Promise<void> {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30000,
    });

    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  /**
   * Verify file checksum
   */
  private async verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    return hash === expectedChecksum;
  }

  /**
   * Extract update archive
   */
  private async extractUpdate(archivePath: string, extractPath: string): Promise<void> {
    // Use tar command (assuming it's available)
    const { stdout, stderr } = await execAsync(`tar -xzf "${archivePath}" -C "${extractPath}"`);
    if (stderr) {
      console.warn('[UpdateManager] Tar warnings:', stderr);
    }
  }

  /**
   * Run post-install script
   */
  private async runPostInstall(): Promise<void> {
    const postInstallScript = path.join(this.config.installPath, 'post-install.sh');
    if (fs.existsSync(postInstallScript)) {
      console.log('[UpdateManager] Running post-install script');
      const { stdout, stderr } = await execAsync(`bash "${postInstallScript}"`);
      if (stderr) {
        console.warn('[UpdateManager] Post-install warnings:', stderr);
      }
    }
  }

  /**
   * Create backup of current installation
   */
  private async createBackup(): Promise<void> {
    const backupPath = path.join(this.config.installPath, 'backup', `fcgbds-${this.config.currentVersion}-${Date.now()}`);
    console.log(`[UpdateManager] Creating backup: ${backupPath}`);

    // Create backup directory
    fs.mkdirSync(backupPath, { recursive: true });

    // Copy important files
    const filesToBackup = ['dist', 'node_modules', 'package.json', 'config'];
    for (const file of filesToBackup) {
      const srcPath = path.join(this.config.installPath, file);
      if (fs.existsSync(srcPath)) {
        await this.copyRecursive(srcPath, path.join(backupPath, file));
      }
    }
  }

  /**
   * Rollback to backup
   */
  private async rollbackBackup(): Promise<void> {
    console.log('[UpdateManager] Rolling back to backup');
    // Implementation would depend on backup structure
    // For now, just log that rollback is needed
  }

  /**
   * Recursively copy directory
   */
  private async copyRecursive(src: string, dest: string): Promise<void> {
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      const files = fs.readdirSync(src);
      for (const file of files) {
        await this.copyRecursive(path.join(src, file), path.join(dest, file));
      }
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  /**
   * Get current status
   */
  public getStatus(): any {
    return {
      currentVersion: this.config.currentVersion,
      autoUpdateEnabled: this.config.autoUpdateEnabled,
      lastCheckTime: new Date(this.lastCheckTime).toISOString(),
      nextCheckTime: this.checkInterval
        ? new Date(Date.now() + this.config.updateCheckInterval).toISOString()
        : null,
    };
  }
}

/**
 * Create update manager instance
 */
export function createUpdateManager(config: UpdateConfig): UpdateManager {
  return new UpdateManager(config);
}
