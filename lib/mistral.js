/**
 * Mistral AI module - Ersätter Google Gemini
 * 
 * Med observerbarhet:
 * - Boundary logs för varje API-anrop
 * - TTFT (Time to First Token) mätning
 * - Human-readable errors
 */

import { Mistral } from '@mistralai/mistralai';
import { createComponentLogger, createTimer, boundaryLog, logError } from './logger.js';

const aiLogger = createComponentLogger('mistral');
let client = null;

// Metrics tracking
const metrics = {
  totalCalls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  rateLimitHits: 0,
  totalTokensUsed: 0
};

export function getMistralMetrics() {
  return { ...metrics };
}

function getClient() {
  if (!client) {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error('MISTRAL_API_KEY not set - check environment variables');
    }
    
    aiLogger.info({ event: 'MISTRAL_INIT' }, '🤖 Initializing Mistral AI client');
    client = new Mistral({ apiKey });
  }
  return client;
}

/**
 * Call Mistral AI with streaming for TTFT measurement
 */
export async function callMistral(systemPrompt, history, userMessage, options = {}, requestId) {
  const mistral = getClient();
  const logger = aiLogger.child({ requestId, operation: 'chat' });
  const timer = createTimer();
  let ttft = 0;

  const {
    temperature = 0.7,
    maxTokens = 500,
    model = 'mistral-small-latest'
  } = options;

  // Build messages array
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  // Add history
  if (history && Array.isArray(history)) {
    for (const msg of history) {
      let role = 'user';
      if (msg.role === 'assistant' || msg.sender_type === 'assistant') {
        role = 'assistant';
      } else if (msg.sender_type === 'human') {
        messages.push({
          role: 'user',
          content: `[PERSONALENS SVAR: "${msg.content}"]`
        });
        messages.push({
          role: 'assistant',
          content: 'Jag noterar att personalen har svarat.'
        });
        continue;
      }
      messages.push({ role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  // Log outgoing request
  boundaryLog.outgoing(logger, 'Mistral AI', {
    model,
    temperature,
    maxTokens,
    messageCount: messages.length,
    promptLength: userMessage.length,
    systemPromptLength: systemPrompt.length
  });

  metrics.totalCalls++;

  try {
    // Use streaming to measure TTFT
    const stream = await mistral.chat.stream({
      model,
      messages,
      temperature,
      maxTokens
    });

    let fullResponse = '';
    let chunkCount = 0;
    
    for await (const chunk of stream) {
      if (ttft === 0) {
        ttft = timer.elapsed();
        logger.info({
          event: 'TTFT',
          ttftMs: ttft,
          ttftSeconds: (ttft / 1000).toFixed(3)
        }, `⚡ First token received in ${ttft}ms`);
      }
      const content = chunk.data?.choices?.[0]?.delta?.content;
      if (content) {
        fullResponse += content;
        chunkCount++;
      }
    }

    const aiTime = timer.elapsed();

    // Estimate token counts (rough: ~4 chars per token for Nordic languages)
    const estimatedInputTokens = Math.ceil((systemPrompt.length + userMessage.length) / 4);
    const estimatedOutputTokens = Math.ceil(fullResponse.length / 4);
    const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
    
    // Estimate cost (Mistral Small: ~€0.2/1M input, ~€0.6/1M output)
    const estimatedCostEur = (estimatedInputTokens * 0.0000002) + (estimatedOutputTokens * 0.0000006);

    // Log incoming response with token metrics
    boundaryLog.incoming(logger, 'Mistral AI', aiTime, {
      ttftMs: ttft,
      responseLength: fullResponse.length,
      tokens: {
        estimatedInput: estimatedInputTokens,
        estimatedOutput: estimatedOutputTokens,
        estimatedTotal: estimatedTotalTokens,
        estimatedCostEur: estimatedCostEur.toFixed(6)
      },
      model
    });

    // Log cost warning if response is unusually long
    if (estimatedOutputTokens > 300) {
      logger.warn({
        event: 'LONG_RESPONSE',
        outputTokens: estimatedOutputTokens,
        responseLength: fullResponse.length
      }, `⚠️ Long AI response: ${estimatedOutputTokens} tokens - consider tuning maxTokens`);
    }

    // Update metrics
    metrics.successfulCalls++;
    metrics.totalTokensUsed += estimatedTotalTokens;

    return {
      response: fullResponse.trim(),
      ttft,
      aiTime,
      tokens: {
        input: estimatedInputTokens,
        output: estimatedOutputTokens,
        total: estimatedTotalTokens,
        costEur: estimatedCostEur
      }
    };
  } catch (error) {
    const aiTime = timer.elapsed();
    
    // Update failure metrics
    metrics.failedCalls++;
    
    // Log failed response
    boundaryLog.incoming(logger, 'Mistral AI', aiTime, { 
      success: false,
      errorStatus: error.status || error.statusCode
    });
    
    logError(logger, error, { 
      operation: 'chat',
      model,
      promptLength: userMessage.length
    });
    
    // Handle specific errors
    if (error.status === 429 || error.message?.includes('429')) {
      metrics.rateLimitHits++;
      throw new Error('RATE_LIMITED');
    }
    
    throw error;
  }
}

/**
 * Build chat contents with knowledge base
 */
export function buildSystemPrompt(basePrompt, knowledgeBase, greeting) {
  let prompt = basePrompt || 'Du är en hjälpsam AI-assistent.';
  
  if (knowledgeBase) {
    prompt += `\n\nKUNSKAPSBAS:\n${knowledgeBase}`;
  }
  
  if (greeting) {
    prompt += `\n\nDin hälsning är: "${greeting}"`;
  }
  
  return prompt;
}

/**
 * Test Mistral connection
 */
export async function testMistral(requestId) {
  const logger = aiLogger.child({ requestId, operation: 'healthCheck' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'Mistral AI', { query: 'health check', model: 'mistral-small-latest' });

  try {
    const mistral = getClient();
    const response = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        { role: 'user', content: 'Svara med exakt ett ord: Hej' }
      ],
      maxTokens: 10
    });

    const latency = timer.elapsed();
    const text = response.choices?.[0]?.message?.content || '';

    boundaryLog.incoming(logger, 'Mistral AI', latency, { 
      response: text.substring(0, 20),
      model: 'mistral-small-latest'
    });

    return {
      ok: true,
      response: text.trim(),
      latency,
      model: 'mistral-small-latest'
    };
  } catch (error) {
    boundaryLog.incoming(logger, 'Mistral AI', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'healthCheck' });
    
    return {
      ok: false,
      error: error.message,
      latency: timer.elapsed()
    };
  }
}
