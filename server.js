#!/usr/bin/env node
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.BRIDGE_PORT || 3847;
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';

function log(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

function uuid() { return crypto.randomUUID(); }

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function askClawdius(question, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    const requestId = uuid();
    const idempotencyKey = `clawdia-${Date.now()}`;
    let response = '';
    let connected = false;
    
    const timeout = setTimeout(() => {
      log('error', 'Timeout', { requestId, responseLength: response.length });
      ws.close();
      // Return partial response if we have any
      if (response.trim()) {
        resolve(response.trim());
      } else {
        reject(new Error('Timeout'));
      }
    }, timeoutMs);
    
    const cleanup = () => { clearTimeout(timeout); ws.close(); };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'req', id: uuid(), method: 'connect',
        params: { minProtocol: 2, maxProtocol: 2, client: { name: 'clawdia', version: '1.0', platform: 'node', mode: 'client' }, caps: [] }
      }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'res' && !connected) {
        if (msg.ok) {
          connected = true;
          ws.send(JSON.stringify({
            type: 'req', id: requestId, method: 'agent',
            params: {
              message: `[CLAWDIA VOZ] ${question}\n\n(Responde BREVE, 1-2 oraciones, para voz)`,
              sessionKey: 'main',
              deliver: false,
              idempotencyKey,
              timeout: 85
            }
          }));
          log('info', 'Request sent', { question: question.substring(0, 50) });
        } else {
          cleanup();
          reject(new Error(msg.error?.message || 'Handshake failed'));
        }
        return;
      }
      
      // Capture assistant text
      if (msg.type === 'event' && msg.event === 'agent') {
        const data = msg.payload?.data || {};
        if (msg.payload?.stream === 'assistant' && data.text) {
          response = data.text;
        }
      }
      
      // Final response
      if (msg.type === 'res' && msg.id === requestId && msg.payload?.status === 'ok') {
        log('info', 'Complete', { responseLength: response.length });
        cleanup();
        resolve(response.trim() || 'Listo.');
      }
    });

    ws.on('error', (e) => { cleanup(); reject(e); });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  if (req.url === '/health') {
    sendJson(res, 200, { status: 'ok', mode: 'gateway-ws' });
    return;
  }
  
  if (req.url === '/ask' && req.method === 'POST') {
    const body = await parseBody(req);
    const toolCall = body.message?.toolCalls?.[0];
    let question = toolCall?.function?.name === 'ask_clawdius' 
      ? (typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments).question
      : body.question;
    
    if (!question) {
      if (toolCall) sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: 'No entendi.' }] });
      else sendJson(res, 400, { error: 'Missing question' });
      return;
    }
    
    log('info', 'Question', { question: question.substring(0, 60) });
    
    try {
      const answer = await askClawdius(question);
      if (toolCall) sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: answer }] });
      else sendJson(res, 200, { answer });
    } catch (e) {
      const err = 'No pude obtener respuesta.';
      if (toolCall) sendJson(res, 200, { results: [{ toolCallId: toolCall.id, result: err }] });
      else sendJson(res, 500, { error: e.message, answer: err });
    }
    return;
  }
  
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  log('info', 'Bridge started', { port: PORT, gateway: GATEWAY_URL });
  console.log(`\n🌉 Claudia Bridge on :${PORT} (Gateway WS mode)\n`);
});
