/**
 * Health check module
 * 
 * Testar alla komponenter och returnerar strukturerad status
 */

import { testConnection, initSchema, seedDemoData } from './db.js';
import { testMistral, getMistralMetrics } from './mistral.js';
import { createComponentLogger, createTimer } from './logger.js';
import { getRateLimitStats } from './rateLimit.js';

const healthLogger = createComponentLogger('health');
let schemaInitialized = false;

/**
 * Run full health check
 * 
 * Returns 200 if all critical components are healthy
 * Returns 500 if any critical component is unhealthy
 */
export async function healthCheck(requestId) {
  const logger = healthLogger.child({ requestId });
  const timer = createTimer();
  
  logger.info({ event: 'HEALTH_CHECK_START' }, '🔍 Starting health check...');

  const results = {
    ok: true,
    timestamp: new Date().toISOString(),
    requestId,
    stack: 'EU-Sovereign (Scaleway 🇫🇷 + Mistral 🇫🇷)',
    version: '1.0.0-poc',
    components: {},
    targets: {
      dbLatency: '< 50ms',
      aiLatency: '< 1000ms',
      ttft: '< 500ms'
    }
  };

  // ============================================
  // 1. TEST DATABASE
  // ============================================
  logger.info({ event: 'HEALTH_CHECK_DB' }, '→ Testing database...');
  try {
    const dbResult = await testConnection(requestId);
    results.components.database = {
      status: dbResult.ok ? 'healthy' : 'unhealthy',
      latencyMs: dbResult.latency,
      database: dbResult.database,
      meetsTarget: dbResult.latency < 50
    };
    
    if (!dbResult.ok) {
      results.ok = false;
      results.components.database.error = dbResult.error;
    }
  } catch (error) {
    results.components.database = { 
      status: 'unhealthy', 
      error: error.message 
    };
    results.ok = false;
  }

  // ============================================
  // 2. INITIALIZE SCHEMA (once)
  // ============================================
  if (results.components.database?.status === 'healthy' && !schemaInitialized) {
    logger.info({ event: 'HEALTH_CHECK_SCHEMA' }, '→ Initializing schema...');
    try {
      await initSchema(requestId);
      await seedDemoData(requestId);
      schemaInitialized = true;
      results.components.database.schemaInitialized = true;
      results.components.database.demoDataSeeded = true;
    } catch (error) {
      logger.warn({ 
        event: 'SCHEMA_INIT_WARNING',
        error: error.message 
      }, `Schema init warning: ${error.message}`);
      results.components.database.schemaError = error.message;
    }
  } else if (schemaInitialized) {
    results.components.database.schemaInitialized = true;
  }

  // ============================================
  // 3. TEST MISTRAL
  // ============================================
  logger.info({ event: 'HEALTH_CHECK_MISTRAL' }, '→ Testing Mistral AI...');
  try {
    const mistralResult = await testMistral(requestId);
    results.components.mistral = {
      status: mistralResult.ok ? 'healthy' : 'unhealthy',
      latencyMs: mistralResult.latency,
      model: mistralResult.model,
      meetsTarget: mistralResult.latency < 1000
    };
    
    if (!mistralResult.ok) {
      results.ok = false;
      results.components.mistral.error = mistralResult.error;
    }
  } catch (error) {
    results.components.mistral = { 
      status: 'unhealthy', 
      error: error.message 
    };
    results.ok = false;
  }

  // ============================================
  // SUMMARY
  // ============================================
  results.totalLatencyMs = timer.elapsed();

  // Add runtime metrics
  results.runtime = {
    mistral: getMistralMetrics(),
    rateLimit: getRateLimitStats(),
    uptime: process.uptime()
  };

  // Generate summary
  const dbOk = results.components.database?.status === 'healthy';
  const aiOk = results.components.mistral?.status === 'healthy';
  const dbMeetsTarget = results.components.database?.meetsTarget;
  const aiMeetsTarget = results.components.mistral?.meetsTarget;

  results.summary = {
    allHealthy: results.ok,
    allMeetTargets: dbMeetsTarget && aiMeetsTarget,
    recommendation: !results.ok 
      ? 'FIX CRITICAL ISSUES before proceeding'
      : (!dbMeetsTarget || !aiMeetsTarget)
        ? 'Some components are slow - monitor closely'
        : 'All systems GO ✅'
  };

  logger.info({
    event: 'HEALTH_CHECK_COMPLETE',
    ok: results.ok,
    totalMs: results.totalLatencyMs,
    dbLatencyMs: results.components.database?.latencyMs,
    aiLatencyMs: results.components.mistral?.latencyMs,
    dbMeetsTarget,
    aiMeetsTarget
  }, `${results.ok ? '✅' : '❌'} Health check complete in ${results.totalLatencyMs}ms`);

  // Log detailed summary for operators
  if (process.env.NODE_ENV !== 'production') {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('           ERYAI ENGINE PoC - HEALTH CHECK         ');
    console.log('═══════════════════════════════════════════════════');
    console.log(`Status:     ${results.ok ? '✅ HEALTHY' : '❌ UNHEALTHY'}`);
    console.log(`Database:   ${dbOk ? '✅' : '❌'} ${results.components.database?.latencyMs || 'N/A'}ms ${dbMeetsTarget ? '(meets target)' : '⚠️ SLOW'}`);
    console.log(`Mistral:    ${aiOk ? '✅' : '❌'} ${results.components.mistral?.latencyMs || 'N/A'}ms ${aiMeetsTarget ? '(meets target)' : '⚠️ SLOW'}`);
    console.log(`Total:      ${results.totalLatencyMs}ms`);
    console.log('───────────────────────────────────────────────────');
    console.log(`Recommendation: ${results.summary.recommendation}`);
    console.log('═══════════════════════════════════════════════════');
    console.log('');
  }

  return results;
}
