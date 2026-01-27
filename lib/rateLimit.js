/**
 * Rate Limiter - In-memory rate limiting
 * 
 * Skyddar mot:
 * - Script-kiddies som bränner Mistral-budget
 * - Accidental infinite loops
 * - DoS-försök
 * 
 * Begränsningar:
 * - In-memory = resettas vid container restart
 * - Ej distribuerad = fungerar ej med multiple replicas
 * - För produktion: överväg Redis-baserad rate limiting
 */

import { createComponentLogger } from './logger.js';

const logger = createComponentLogger('rateLimiter');

// Store: IP -> { count, windowStart }
const requestCounts = new Map();

// Configuration
const CONFIG = {
  windowMs: 30 * 1000,     // 30 sekunder
  maxRequests: 10,          // Max 10 requests per window
  cleanupIntervalMs: 60 * 1000  // Cleanup var 60:e sekund
};

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [ip, data] of requestCounts.entries()) {
    if (now - data.windowStart > CONFIG.windowMs * 2) {
      requestCounts.delete(ip);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.debug({ event: 'RATE_LIMIT_CLEANUP', cleaned }, `Cleaned ${cleaned} stale entries`);
  }
}, CONFIG.cleanupIntervalMs);

/**
 * Get client IP from request
 */
export function getClientIP(req) {
  // Check common proxy headers
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return realIp;
  }
  
  // Fallback to socket
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Check rate limit for a client
 * 
 * @param {string} clientIP - Client IP address
 * @returns {{ allowed: boolean, remaining: number, retryAfter?: number }}
 */
export function checkRateLimit(clientIP) {
  const now = Date.now();
  const data = requestCounts.get(clientIP);
  
  // New client or window expired
  if (!data || (now - data.windowStart) > CONFIG.windowMs) {
    requestCounts.set(clientIP, { count: 1, windowStart: now });
    return { 
      allowed: true, 
      remaining: CONFIG.maxRequests - 1 
    };
  }
  
  // Within window
  if (data.count >= CONFIG.maxRequests) {
    const retryAfter = Math.ceil((CONFIG.windowMs - (now - data.windowStart)) / 1000);
    
    logger.warn({
      event: 'RATE_LIMIT_EXCEEDED',
      clientIP: clientIP.substring(0, 10) + '...',
      count: data.count,
      retryAfter
    }, `⛔ Rate limit exceeded for ${clientIP.substring(0, 10)}...`);
    
    return { 
      allowed: false, 
      remaining: 0,
      retryAfter 
    };
  }
  
  // Increment and allow
  data.count++;
  return { 
    allowed: true, 
    remaining: CONFIG.maxRequests - data.count 
  };
}

/**
 * Rate limit middleware helper
 * 
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @returns {boolean} - true if request should proceed, false if rate limited
 */
export function rateLimit(req, res) {
  const clientIP = getClientIP(req);
  const result = checkRateLimit(clientIP);
  
  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', CONFIG.maxRequests.toString());
  res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
  res.setHeader('X-RateLimit-Window', (CONFIG.windowMs / 1000).toString());
  
  if (!result.allowed) {
    res.setHeader('Retry-After', result.retryAfter.toString());
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Too many requests',
      message: `Du skickar för många meddelanden. Vänta ${result.retryAfter} sekunder.`,
      retryAfter: result.retryAfter
    }));
    return false;
  }
  
  return true;
}

/**
 * Get current rate limit stats (for monitoring)
 */
export function getRateLimitStats() {
  return {
    activeClients: requestCounts.size,
    config: {
      windowMs: CONFIG.windowMs,
      maxRequests: CONFIG.maxRequests
    }
  };
}
