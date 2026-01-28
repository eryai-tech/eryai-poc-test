/**
 * ERYAI ENGINE PoC - EU-Sovereign Multi-Tenant AI Chat
 * 
 * Med professionell observerbarhet:
 * - Strukturerad JSON-loggning (pino)
 * - Request ID tracking
 * - Boundary logs för externa anrop
 * - Human-readable errors
 */

import http from 'http';
import { URL } from 'url';
import { handleChat } from './lib/chatEngine.js';
import { getGreeting, getMessages } from './lib/db.js';
import { healthCheck } from './lib/health.js';
import { createRequestLogger, createTimer, logError } from './lib/logger.js';
import { rateLimit } from './lib/rateLimit.js';
import { runSetup } from './lib/setup.js';

const PORT = process.env.PORT || 8080;

// Parse JSON body
async function parseBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

// Parse query params
function parseQuery(url) {
  const params = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

// Main request handler
async function handleRequest(req, res) {
  const { logger, requestId } = createRequestLogger('server');
  const requestTimer = createTimer();
  
  // Add request ID to response headers for tracing
  res.setHeader('X-Request-ID', requestId);
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Test-Mode, X-Request-ID');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const query = parseQuery(url);
  const isTestMode = req.headers['x-test-mode'] === 'true';

  // Log incoming request
  logger.info({
    event: 'REQUEST_START',
    method: req.method,
    path,
    query,
    testMode: isTestMode,
    userAgent: req.headers['user-agent']?.substring(0, 50)
  }, `▶ ${req.method} ${path}`);

  try {
    // ============================================
    // GET /health - Health check
    // ============================================
    if (path === '/health' && req.method === 'GET') {
      const result = await healthCheck(requestId);
      
      const statusCode = result.ok ? 200 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      
      logger.info({
        event: 'REQUEST_END',
        path,
        statusCode,
        latencyMs: requestTimer.elapsed(),
        healthy: result.ok
      }, `◀ ${path} ${statusCode} (${requestTimer.elapsed()}ms)`);
      
      return res.end(JSON.stringify(result));
    }

    // ============================================
    // POST /api/setup - Database setup (run once)
    // ============================================
    if (path === '/api/setup' && req.method === 'POST') {
      logger.info({ event: 'SETUP_START' }, '🔧 Running database setup...');
      
      try {
        const result = await runSetup();
        
        if (result.success) {
          logger.info({ event: 'SETUP_SUCCESS', results: result.results }, '✅ Setup complete');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            message: 'Database setup complete!',
            results: result.results
          }));
        } else {
          logger.error({ event: 'SETUP_FAILED', error: result.error }, '❌ Setup failed');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: result.error,
            results: result.results
          }));
        }
      } catch (error) {
        logger.error({ event: 'SETUP_ERROR', error: error.message }, '❌ Setup error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }

    // ============================================
    // GET /api/greeting
    // ============================================
    if (path === '/api/greeting' && req.method === 'GET') {
      const { slug } = query;
      
      if (!slug) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        logger.warn({ event: 'VALIDATION_ERROR', path, error: 'Missing slug' }, 'Missing slug parameter');
        return res.end(JSON.stringify({ error: 'slug parameter required' }));
      }

      const result = await getGreeting(slug, requestId);
      
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        logger.warn({ event: 'NOT_FOUND', path, slug }, `Customer not found: ${slug}`);
        return res.end(JSON.stringify({ error: 'Customer not found' }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      logger.info({
        event: 'REQUEST_END',
        path,
        statusCode: 200,
        latencyMs: requestTimer.elapsed(),
        slug
      }, `◀ ${path} 200 (${requestTimer.elapsed()}ms)`);
      
      return res.end(JSON.stringify(result));
    }

    // ============================================
    // GET /api/messages
    // ============================================
    if (path === '/api/messages' && req.method === 'GET') {
      const { sessionId } = query;
      
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        logger.warn({ event: 'VALIDATION_ERROR', path, error: 'Missing sessionId' }, 'Missing sessionId parameter');
        return res.end(JSON.stringify({ error: 'sessionId parameter required' }));
      }

      const result = await getMessages(sessionId, requestId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      logger.info({
        event: 'REQUEST_END',
        path,
        statusCode: 200,
        latencyMs: requestTimer.elapsed(),
        messageCount: result.messages?.length || 0
      }, `◀ ${path} 200 (${requestTimer.elapsed()}ms) - ${result.messages?.length || 0} messages`);
      
      return res.end(JSON.stringify(result));
    }

    // ============================================
    // POST /api/chat - Main chat endpoint
    // ============================================
    if (path === '/api/chat' && req.method === 'POST') {
      // Rate limiting - protect Mistral budget
      if (!rateLimit(req, res)) {
        logger.warn({ event: 'RATE_LIMITED', path }, '⛔ Request rate limited');
        return; // Response already sent by rateLimit()
      }

      const body = await parseBody(req);
      const { prompt, history, sessionId, customerId, slug, companion } = body;

      // Validation
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        logger.warn({ event: 'VALIDATION_ERROR', path, error: 'Invalid prompt' }, 'Invalid or missing prompt');
        return res.end(JSON.stringify({ error: 'Invalid prompt' }));
      }

      if (!slug && !customerId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        logger.warn({ event: 'VALIDATION_ERROR', path, error: 'Missing identifier' }, 'Missing slug or customerId');
        return res.end(JSON.stringify({ error: 'slug or customerId required' }));
      }

      logger.info({
        event: 'CHAT_START',
        slug,
        companion,
        sessionId: sessionId?.substring(0, 8),
        promptLength: prompt.length,
        historyLength: history?.length || 0
      }, `💬 Chat request: ${slug}${companion ? ` (${companion})` : ''}`);

      const result = await handleChat({
        prompt: prompt.trim(),
        history,
        sessionId,
        customerId,
        slug,
        companion,
        isTestMode,
        requestId
      });

      if (result.error) {
        const statusCode = result.status || 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        
        logger.error({
          event: 'CHAT_ERROR',
          path,
          statusCode,
          error: result.error,
          latencyMs: requestTimer.elapsed()
        }, `◀ ${path} ${statusCode} - ${result.error}`);
        
        return res.end(JSON.stringify({ error: result.error }));
      }

      // Add timing headers
      res.setHeader('X-Total-Time-Ms', String(requestTimer.elapsed()));
      res.setHeader('X-DB-Time-Ms', String(result.metrics?.dbTime || 0));
      res.setHeader('X-AI-Time-Ms', String(result.metrics?.aiTime || 0));
      res.setHeader('X-TTFT-Ms', String(result.metrics?.ttft || 0));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      
      logger.info({
        event: 'CHAT_SUCCESS',
        path,
        statusCode: 200,
        latencyMs: requestTimer.elapsed(),
        metrics: result.metrics,
        sessionId: result.sessionId?.substring(0, 8),
        responseLength: result.response?.length || 0
      }, `◀ ${path} 200 (${requestTimer.elapsed()}ms) TTFT=${result.metrics?.ttft}ms`);

      return res.end(JSON.stringify({
        response: result.response,
        sessionId: result.sessionId,
        _metrics: {
          totalTime: requestTimer.elapsed(),
          dbTime: result.metrics?.dbTime,
          aiTime: result.metrics?.aiTime,
          ttft: result.metrics?.ttft
        }
      }));
    }

    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    logger.warn({ event: 'NOT_FOUND', path, method: req.method }, `Route not found: ${req.method} ${path}`);
    return res.end(JSON.stringify({ error: 'Not found' }));

  } catch (error) {
    logError(logger, error, {
      event: 'REQUEST_ERROR',
      path,
      method: req.method,
      latencyMs: requestTimer.elapsed()
    });
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ 
      error: 'Internal server error',
      requestId 
    }));
  }
}

// Create server
const server = http.createServer(handleRequest);

// Startup logging
server.listen(PORT, () => {
  const { logger } = createRequestLogger('startup');
  
  logger.info({
    event: 'SERVER_START',
    port: PORT,
    nodeVersion: process.version,
    stack: 'EU-Sovereign (Scaleway + Mistral)'
  }, `🚀 EryAI Engine PoC started on port ${PORT}`);
  
  // Pretty console output for local dev
  if (process.env.NODE_ENV !== 'production') {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('        ERYAI ENGINE PoC - EU-SOVEREIGN STACK      ');
    console.log('═══════════════════════════════════════════════════');
    console.log(`🚀 Running on port ${PORT}`);
    console.log(`📍 Stack: Scaleway (FR) + Mistral (FR)`);
    console.log(`📊 Logs: JSON format (pipe to pino-pretty for dev)`);
    console.log('');
    console.log('Endpoints:');
    console.log(`  GET  /health              - Health check`);
    console.log(`  POST /api/setup           - Initialize database`);
    console.log(`  GET  /api/greeting?slug=  - Get customer greeting`);
    console.log(`  GET  /api/messages?sessionId= - Get session messages`);
    console.log(`  POST /api/chat            - Chat with AI`);
    console.log('═══════════════════════════════════════════════════');
    console.log('');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  const { logger } = createRequestLogger('shutdown');
  logger.info({ event: 'SERVER_SHUTDOWN' }, '⏹️ Received SIGTERM, shutting down gracefully');
  server.close(() => {
    logger.info({ event: 'SERVER_CLOSED' }, '✅ Server closed');
    process.exit(0);
  });
});
