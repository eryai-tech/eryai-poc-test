/**
 * Logger Module - Strukturerad JSON-loggning för Scaleway
 * 
 * Features:
 * - JSON-format (perfekt för Scaleway Cockpit/Grafana)
 * - Request ID tracking
 * - Component tagging
 * - Latency measurement helpers
 * - Human-readable error messages
 * 
 * Log Levels:
 * - trace: Detaljerad debug (ej i produktion)
 * - debug: Debug info
 * - info: Normal operation
 * - warn: Varningar (ej fel men värt att notera)
 * - error: Fel som påverkar funktionalitet
 * - fatal: Systemkritiska fel
 */

import pino from 'pino';
import { randomUUID } from 'crypto';

// Base logger configuration
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'eryai-engine',
    version: '1.0.0-poc',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label.toUpperCase() })
  }
});

/**
 * Create a child logger for a specific component
 */
export function createComponentLogger(component) {
  return logger.child({ component });
}

/**
 * Create a request-scoped logger with unique request ID
 */
export function createRequestLogger(component, existingRequestId = null) {
  const requestId = existingRequestId || randomUUID().substring(0, 8);
  return {
    logger: logger.child({ component, requestId }),
    requestId
  };
}

/**
 * Timer utility for measuring latency
 */
export function createTimer() {
  const start = Date.now();
  return {
    elapsed: () => Date.now() - start,
    elapsedSeconds: () => ((Date.now() - start) / 1000).toFixed(3)
  };
}

/**
 * Human-readable error messages
 * Maps technical errors to understandable explanations
 */
const ERROR_EXPLANATIONS = {
  // Database errors
  'ECONNREFUSED': {
    message: 'Database connection refused',
    hint: 'Database server is not running or network is blocked',
    action: 'Check DATABASE_URL and that Scaleway SQL is running'
  },
  'ENOTFOUND': {
    message: 'Database host not found',
    hint: 'DNS lookup failed for database host',
    action: 'Verify DATABASE_URL hostname is correct'
  },
  'connection timeout': {
    message: 'Database connection timeout',
    hint: 'Database took too long to respond',
    action: 'Check network connectivity and database health'
  },
  'SSL required': {
    message: 'Database requires SSL connection',
    hint: 'Connection string missing sslmode=require',
    action: 'Add ?sslmode=require to DATABASE_URL'
  },
  
  // Mistral errors
  '401': {
    message: 'Mistral API authentication failed',
    hint: 'API key is invalid or expired',
    action: 'Check MISTRAL_API_KEY in environment variables'
  },
  '429': {
    message: 'Mistral API rate limit reached',
    hint: 'Too many requests sent to Mistral',
    action: 'Wait a moment and retry, or upgrade Mistral plan'
  },
  '500': {
    message: 'Mistral API internal error',
    hint: 'Mistral service is experiencing issues',
    action: 'Check status.mistral.ai and retry later'
  },
  '503': {
    message: 'Mistral API temporarily unavailable',
    hint: 'Service is overloaded or under maintenance',
    action: 'Wait and retry in a few minutes'
  },
  'RATE_LIMITED': {
    message: 'AI service rate limit reached',
    hint: 'Too many requests in short time',
    action: 'Implement exponential backoff'
  },
  
  // Generic
  'ETIMEDOUT': {
    message: 'Network request timed out',
    hint: 'External service took too long to respond',
    action: 'Check network and service status'
  },
  'fetch failed': {
    message: 'Network request failed',
    hint: 'Could not reach external service',
    action: 'Check internet connectivity and firewall rules'
  }
};

/**
 * Get human-readable error info
 */
export function getErrorInfo(error) {
  const errorString = error.message || String(error);
  const statusCode = error.status || error.statusCode;
  
  // Check for status code match first
  if (statusCode && ERROR_EXPLANATIONS[String(statusCode)]) {
    return ERROR_EXPLANATIONS[String(statusCode)];
  }
  
  // Check for message match
  for (const [key, info] of Object.entries(ERROR_EXPLANATIONS)) {
    if (errorString.toLowerCase().includes(key.toLowerCase())) {
      return info;
    }
  }
  
  // Default
  return {
    message: 'Unexpected error occurred',
    hint: errorString,
    action: 'Check full error details in logs'
  };
}

/**
 * Log an error with human-readable context
 */
export function logError(logger, error, context = {}) {
  const errorInfo = getErrorInfo(error);
  
  logger.error({
    ...context,
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack,
      code: error.code,
      status: error.status || error.statusCode
    },
    humanReadable: {
      summary: errorInfo.message,
      hint: errorInfo.hint,
      suggestedAction: errorInfo.action
    }
  }, `❌ ${errorInfo.message}`);
}

/**
 * Boundary log helpers for external service calls
 */
export const boundaryLog = {
  /**
   * Log outgoing request to external service
   */
  outgoing: (logger, service, details = {}) => {
    logger.info({
      boundary: 'OUTGOING',
      service,
      ...details
    }, `→ Calling ${service}`);
  },
  
  /**
   * Log incoming response from external service
   */
  incoming: (logger, service, latencyMs, details = {}) => {
    const status = details.success !== false ? 'SUCCESS' : 'FAILED';
    logger.info({
      boundary: 'INCOMING',
      service,
      latencyMs,
      latencySeconds: (latencyMs / 1000).toFixed(3),
      status,
      ...details
    }, `← ${service} responded in ${latencyMs}ms [${status}]`);
  }
};

// Export default logger for simple use cases
export default logger;
