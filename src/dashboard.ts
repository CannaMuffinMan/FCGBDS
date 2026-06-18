/**
 * FCGBDS Local Dashboard
 * Web interface for monitoring and managing the FCGBDS system
 */

import express from 'express';
import path from 'path';
import axios from 'axios';
import basicAuth from 'express-basic-auth';

const dashboardApp = express();
const FCGBDS_API_URL = process.env.FCGBDS_API_URL || 'http://localhost:3001';
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3002');
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'changeme';

// Basic authentication
dashboardApp.use(basicAuth({
  users: { [DASHBOARD_USERNAME]: DASHBOARD_PASSWORD },
  challenge: true,
  realm: 'FCGBDS Dashboard',
}));

// Serve static files
dashboardApp.use(express.static(path.join(__dirname, 'public')));

// API proxy to FCGBDS system
dashboardApp.get('/api/status', async (req, res) => {
  try {
    const response = await axios.get(`${FCGBDS_API_URL}/api/fcgbds/status`);
    res.json(response.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dashboardApp.get('/api/health', async (req, res) => {
  try {
    const response = await axios.get(`${FCGBDS_API_URL}/health`);
    res.json(response.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dashboardApp.post('/api/check-updates', async (req, res) => {
  try {
    const response = await axios.post(`${FCGBDS_API_URL}/api/fcgbds/check-updates`);
    res.json(response.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

dashboardApp.post('/api/install-update', async (req, res) => {
  try {
    const response = await axios.post(`${FCGBDS_API_URL}/api/fcgbds/install-update`);
    res.json(response.data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Main dashboard route
dashboardApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start dashboard server
dashboardApp.listen(DASHBOARD_PORT, () => {
  console.log(`FCGBDS Dashboard running on http://localhost:${DASHBOARD_PORT}`);
  console.log(`Username: ${DASHBOARD_USERNAME}`);
  console.log(`Password: ${DASHBOARD_PASSWORD}`);
});