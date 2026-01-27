/**
 * Chat Engine - Multi-tenant AI Chat Orchestration
 * 
 * Med observerbarhet:
 * - Request ID tracking genom hela flödet
 * - Latency breakdown per steg
 * - Human-readable errors
 */

import { 
  getCustomerBySlug, 
  getCompanion,
  getOrCreateSession,
  saveMessage,
  getMessages,
  updateSession
} from './db.js';
import { callMistral, buildSystemPrompt } from './mistral.js';
import { analyzePromptSafety, getCustomerType, quickSafetyCheck } from './securityJudge.js';
import { createComponentLogger, createTimer, logError } from './logger.js';

const engineLogger = createComponentLogger('chatEngine');

/**
 * Get appropriate blocked response based on customer type
 */
function getBlockedResponse(customerType) {
  switch (customerType) {
    case 'eldercare':
      return 'Kjære deg, jeg forstår ikke helt hva du mener. Kan vi snakke om noe annet? Hvordan har du det i dag?';
    case 'restaurant':
      return 'Tyvärr kan jag inte hjälpa till med det. Kan jag hjälpa dig med en bokning eller information om vår meny istället?';
    case 'auto-shop':
      return 'Det kan jag tyvärr inte hjälpa till med. Vill du boka en tid eller har du frågor om våra tjänster?';
    default:
      return 'Jag kan tyvärr inte hjälpa till med det. Finns det något annat jag kan hjälpa dig med?';
  }
}

/**
 * Handle chat request
 */
export async function handleChat(params) {
  const { prompt, history, sessionId, customerId, slug, companion, isTestMode, requestId } = params;
  
  const logger = engineLogger.child({ requestId, slug, companion });
  const totalTimer = createTimer();
  
  let totalDbTime = 0;
  const metrics = {};
  const steps = [];

  logger.info({ 
    event: 'CHAT_FLOW_START',
    promptLength: prompt.length,
    hasHistory: !!history?.length,
    hasSessionId: !!sessionId
  }, '🚀 Starting chat flow');

  try {
    // ============================================
    // STEP 0: QUICK SAFETY CHECK (no API call)
    // ============================================
    const quickCheck = quickSafetyCheck(prompt);
    if (quickCheck.blocked) {
      logger.warn({
        event: 'QUICK_BLOCK',
        reason: quickCheck.reason
      }, `⛔ Quick safety check blocked message: ${quickCheck.reason}`);
      
      return {
        response: 'Jag kan tyvärr inte hjälpa till med det. Kan jag hjälpa dig med något annat?',
        sessionId: sessionId || 'blocked',
        blocked: true,
        riskLevel: 10,
        metrics: { totalTime: totalTimer.elapsed() }
      };
    }

    // ============================================
    // STEP 1: RESOLVE CUSTOMER
    // ============================================
    const step1Timer = createTimer();
    let customer;
    
    if (slug) {
      customer = await getCustomerBySlug(slug, requestId);
      if (!customer) {
        logger.warn({ event: 'CUSTOMER_NOT_FOUND', slug }, `Customer not found: ${slug}`);
        return { error: 'Customer not found', status: 404 };
      }
      totalDbTime += customer.dbTime || 0;
      steps.push({ step: 'getCustomer', latencyMs: step1Timer.elapsed() });
      
      logger.info({ 
        event: 'CUSTOMER_RESOLVED',
        customerId: customer.id?.substring(0, 8),
        customerName: customer.name,
        latencyMs: step1Timer.elapsed()
      }, `📍 Customer: ${customer.name}`);
    } else if (customerId) {
      return { error: 'customerId lookup not implemented, use slug', status: 400 };
    }

    // ============================================
    // STEP 2: GET AI CONFIG
    // ============================================
    const step2Timer = createTimer();
    let systemPrompt = customer.system_prompt;
    let greeting = customer.greeting;
    let aiName = customer.ai_name;

    if (companion) {
      const companionConfig = await getCompanion(customer.id, companion, requestId);
      
      if (companionConfig) {
        systemPrompt = companionConfig.system_prompt || systemPrompt;
        greeting = companionConfig.greeting || greeting;
        aiName = companionConfig.name || aiName;
        totalDbTime += companionConfig.dbTime || 0;
        
        logger.info({ 
          event: 'COMPANION_LOADED',
          companion,
          aiName,
          latencyMs: step2Timer.elapsed()
        }, `🎭 Companion loaded: ${aiName}`);
      } else {
        logger.warn({ 
          event: 'COMPANION_NOT_FOUND',
          companion 
        }, `Companion "${companion}" not found, using default`);
      }
    }
    steps.push({ step: 'getConfig', latencyMs: step2Timer.elapsed() });

    const fullSystemPrompt = buildSystemPrompt(
      systemPrompt,
      customer.knowledge_base,
      greeting
    );

    // ============================================
    // STEP 3: GET/CREATE SESSION
    // ============================================
    const step3Timer = createTimer();
    const sessionResult = await getOrCreateSession(sessionId, customer.id, {
      companion: companion || null,
      ai_name: aiName
    }, requestId);
    totalDbTime += sessionResult.dbTime || 0;
    steps.push({ step: 'getSession', latencyMs: step3Timer.elapsed() });
    
    const session = sessionResult.session;
    
    logger.info({ 
      event: 'SESSION_READY',
      sessionId: session.id?.substring(0, 8),
      isNew: sessionResult.isNew,
      latencyMs: step3Timer.elapsed()
    }, `💬 Session: ${session.id?.substring(0, 8)} (${sessionResult.isNew ? 'NEW' : 'EXISTING'})`);

    // ============================================
    // STEP 3.5: SECURITY JUDGE (AI-powered)
    // ============================================
    const securityTimer = createTimer();
    const customerType = getCustomerType(slug);
    
    logger.info({ event: 'SECURITY_CHECK_START', customerType }, '🔍 Running AI security analysis...');
    
    const securityResult = await analyzePromptSafety(prompt, {
      customerType,
      requestId
    });
    
    steps.push({ step: 'securityJudge', latencyMs: securityTimer.elapsed() });
    metrics.securityTime = securityTimer.elapsed();
    metrics.riskLevel = securityResult.riskLevel;

    // Handle suspicious messages
    if (securityResult.isSuspicious) {
      logger.warn({
        event: 'SUSPICIOUS_BLOCKED',
        riskLevel: securityResult.riskLevel,
        reason: securityResult.reason,
        sessionId: session.id?.substring(0, 8)
      }, `🚨 BLOCKED: Risk ${securityResult.riskLevel}/10 - ${securityResult.reason}`);

      // Update session with suspicious flag
      await updateSession(session.id, {
        suspicious: true,
        risk_level: securityResult.riskLevel,
        metadata: {
          ...session.metadata,
          suspicious_reason: securityResult.reason,
          blocked_at: new Date().toISOString()
        }
      }, requestId);

      // Return safe response
      return {
        response: getBlockedResponse(customerType),
        sessionId: session.id,
        blocked: true,
        suspicious: true,
        riskLevel: securityResult.riskLevel,
        metrics: {
          totalTime: totalTimer.elapsed(),
          securityTime: securityResult.analysisTime,
          dbTime: totalDbTime
        }
      };
    }

    // Log elevated risk (but allow)
    if (securityResult.riskLevel >= 4) {
      logger.info({
        event: 'ELEVATED_RISK_ALLOWED',
        riskLevel: securityResult.riskLevel,
        reason: securityResult.reason
      }, `⚠️ Elevated risk ${securityResult.riskLevel}/10 - allowing`);
      
      // Update session with risk level
      await updateSession(session.id, {
        risk_level: securityResult.riskLevel
      }, requestId);
    }

    // ============================================
    // STEP 4: LOAD HISTORY
    // ============================================
    const step4Timer = createTimer();
    let chatHistory = [];
    
    if (history && Array.isArray(history) && history.length > 0) {
      chatHistory = history;
      logger.debug({ event: 'USING_CLIENT_HISTORY', count: history.length }, `Using client history: ${history.length} messages`);
    } else if (!sessionResult.isNew) {
      const historyResult = await getMessages(session.id, requestId);
      chatHistory = historyResult.messages;
      totalDbTime += historyResult.dbTime || 0;
      logger.debug({ event: 'LOADED_DB_HISTORY', count: chatHistory.length }, `Loaded DB history: ${chatHistory.length} messages`);
    }
    steps.push({ step: 'loadHistory', latencyMs: step4Timer.elapsed() });

    // ============================================
    // STEP 5: SAVE USER MESSAGE
    // ============================================
    const step5Timer = createTimer();
    const userSaveResult = await saveMessage(session.id, 'user', prompt, 'user', requestId);
    totalDbTime += userSaveResult.dbTime || 0;
    steps.push({ step: 'saveUserMessage', latencyMs: step5Timer.elapsed() });

    // ============================================
    // STEP 6: CALL MISTRAL
    // ============================================
    logger.info({ event: 'CALLING_AI' }, '🤖 Calling Mistral AI...');
    
    const aiResult = await callMistral(fullSystemPrompt, chatHistory, prompt, {
      temperature: 0.7,
      maxTokens: 500,
      model: 'mistral-small-latest'
    }, requestId);

    metrics.aiTime = aiResult.aiTime;
    metrics.ttft = aiResult.ttft;
    steps.push({ step: 'callMistral', latencyMs: aiResult.aiTime });

    // ============================================
    // STEP 7: SAVE ASSISTANT RESPONSE
    // ============================================
    const step7Timer = createTimer();
    const assistantSaveResult = await saveMessage(
      session.id, 
      'assistant', 
      aiResult.response, 
      'assistant',
      requestId
    );
    totalDbTime += assistantSaveResult.dbTime || 0;
    steps.push({ step: 'saveAssistantMessage', latencyMs: step7Timer.elapsed() });

    metrics.dbTime = totalDbTime;

    // ============================================
    // COMPLETE
    // ============================================
    const totalTime = totalTimer.elapsed();
    
    logger.info({
      event: 'CHAT_FLOW_SUCCESS',
      totalMs: totalTime,
      metrics,
      steps,
      responseLength: aiResult.response.length
    }, `✅ Chat flow completed in ${totalTime}ms (TTFT: ${metrics.ttft}ms, DB: ${metrics.dbTime}ms)`);

    return {
      response: aiResult.response,
      sessionId: session.id,
      metrics
    };

  } catch (error) {
    const totalTime = totalTimer.elapsed();
    
    logError(logger, error, {
      event: 'CHAT_FLOW_ERROR',
      totalMs: totalTime,
      stepsCompleted: steps.length,
      lastStep: steps[steps.length - 1]?.step
    });
    
    if (error.message === 'RATE_LIMITED') {
      return { 
        error: 'AI service temporarily unavailable. Please wait a moment and try again.',
        status: 429 
      };
    }
    
    return { 
      error: error.message,
      status: 500 
    };
  }
}
