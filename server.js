#!/usr/bin/env node
/**
 * Claudia Bridge - HTTP bridge between Vapi (Claudia) and Clawdius
 * 
 * This service receives questions from Claudia (voice assistant)
 * and forwards them to Clawdius, then returns the response.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Configuration
const PORT = process.env.BRIDGE_PORT || 3847;
const AUTH_TOKEN = process.env.BRIDGE_TOKEN || 'claudia-secret-token';
const CLAWDIUS_WEBHOOK = process.env.CLAWDIUS_WEBHOOK || null;

// In-memory store for pending requests (question -> response)
const pendingRequests = new Map();

// Logging
function log(level, msg, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, msg, ...data }));
}

// Parse JSON body
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Send JSON response
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Verify auth token
function verifyAuth(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7) === AUTH_TOKEN;
  }
  return false;
}

// Forward question to Clawdius via internal mechanism
// For now, this creates a pending request and waits for response
async function askClawdius(question, context, timeoutMs = 30000) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  log('info', 'Forwarding question to Clawdius', { requestId, question });
  
  // Create a promise that will be resolved when Clawdius responds
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Timeout waiting for Clawdius response'));
    }, timeoutMs);
    
    pendingRequests.set(requestId, {
      question,
      context,
      resolve: (answer) => {
        clearTimeout(timeout);
        pendingRequests.delete(requestId);
        resolve(answer);
      },
      createdAt: Date.now()
    });
    
    // Log the pending request for Clawdius to pick up
    // In production, this would send via webhook or internal API
    log('info', 'CLAWDIUS_QUESTION', { 
      requestId, 
      question, 
      context,
      respondTo: `POST /respond/${requestId}`
    });
    
    // If we have a webhook configured, call it
    if (CLAWDIUS_WEBHOOK) {
      const webhookUrl = new URL(CLAWDIUS_WEBHOOK);
      const postData = JSON.stringify({ requestId, question, context });
      
      const options = {
        hostname: webhookUrl.hostname,
        port: webhookUrl.port || (webhookUrl.protocol === 'https:' ? 443 : 80),
        path: webhookUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const protocol = webhookUrl.protocol === 'https:' ? https : http;
      const webhookReq = protocol.request(options, (webhookRes) => {
        log('info', 'Webhook response', { status: webhookRes.statusCode });
      });
      webhookReq.on('error', (e) => {
        log('error', 'Webhook error', { error: e.message });
      });
      webhookReq.write(postData);
      webhookReq.end();
    }
  });
}

// Request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;
  
  log('info', 'Request received', { method, path });
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Health check
  if (path === '/health' && method === 'GET') {
    sendJson(res, 200, { 
      status: 'ok', 
      service: 'claudia-bridge',
      pendingRequests: pendingRequests.size,
      timestamp: new Date().toISOString()
    });
    return;
  }
  
  // Main endpoint: Claudia asks a question
  if (path === '/ask' && method === 'POST') {
    if (!verifyAuth(req)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    
    try {
      const body = await parseBody(req);
      const { question, context } = body;
      
      if (!question) {
        sendJson(res, 400, { error: 'Missing question field' });
        return;
      }
      
      const answer = await askClawdius(question, context || '');
      
      sendJson(res, 200, {
        answer,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      log('error', 'Error processing question', { error: e.message });
      sendJson(res, 500, { 
        error: e.message,
        answer: 'Lo siento, no pude obtener respuesta de Clawdius en este momento.'
      });
    }
    return;
  }
  
  // Endpoint for Clawdius to respond
  if (path.startsWith('/respond/') && method === 'POST') {
    const requestId = path.replace('/respond/', '');
    const pending = pendingRequests.get(requestId);
    
    if (!pending) {
      sendJson(res, 404, { error: 'Request not found or expired' });
      return;
    }
    
    try {
      const body = await parseBody(req);
      const { answer } = body;
      
      if (!answer) {
        sendJson(res, 400, { error: 'Missing answer field' });
        return;
      }
      
      log('info', 'Received response from Clawdius', { requestId });
      pending.resolve(answer);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  
  // List pending requests (for debugging)
  if (path === '/pending' && method === 'GET') {
    const requests = [];
    for (const [id, req] of pendingRequests) {
      requests.push({
        id,
        question: req.question,
        age: Date.now() - req.createdAt
      });
    }
    sendJson(res, 200, { pending: requests });
    return;
  }
  
  // 404 for unknown routes
  sendJson(res, 404, { error: 'Not found' });
}

// Create server
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    log('error', 'Unhandled error', { error: e.message });
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

// Start server
server.listen(PORT, () => {
  log('info', 'Claudia Bridge started', { 
    port: PORT,
    webhook: CLAWDIUS_WEBHOOK || 'none'
  });
  console.log(`\n🌉 Claudia Bridge listening on http://localhost:${PORT}`);
  console.log(`   POST /ask - Claudia asks a question`);
  console.log(`   POST /respond/:id - Clawdius responds`);
  console.log(`   GET /health - Health check`);
  console.log(`   GET /pending - List pending requests\n`);
});
