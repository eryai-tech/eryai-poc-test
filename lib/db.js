/**
 * Database module for Scaleway Serverless SQL
 * 
 * Med observerbarhet:
 * - Boundary logs för varje DB-anrop
 * - Human-readable errors
 * - Latency tracking
 */

import postgres from 'postgres';
import { createComponentLogger, createTimer, boundaryLog, logError } from './logger.js';

const dbLogger = createComponentLogger('database');
let sql = null;

function getDb() {
  if (!sql) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not set - check environment variables');
    }
    
    dbLogger.info({ event: 'DB_INIT' }, '🔌 Initializing database connection pool');
    
    // Check if SSL should be disabled (local development)
    const useSSL = !DATABASE_URL.includes('sslmode=disable');
    
    sql = postgres(DATABASE_URL, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: useSSL ? 'require' : false,
      onnotice: (notice) => {
        dbLogger.debug({ event: 'DB_NOTICE', notice: notice.message }, `DB Notice: ${notice.message}`);
      }
    });
  }
  return sql;
}

// ============================================
// CUSTOMER QUERIES
// ============================================

export async function getCustomerBySlug(slug, requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'getCustomerBySlug' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { query: 'SELECT customer + ai_config', slug });

  try {
    const result = await db`
      SELECT 
        c.id,
        c.name,
        c.slug,
        c.organization_id,
        ai.ai_name,
        ai.greeting,
        ai.system_prompt,
        ai.knowledge_base,
        ai.companion_prompts
      FROM customers c
      LEFT JOIN customer_ai_config ai ON ai.customer_id = c.id
      WHERE c.slug = ${slug}
      LIMIT 1
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { 
      found: result.length > 0,
      slug 
    });

    return result[0] ? { ...result[0], dbTime: latencyMs } : null;
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'getCustomerBySlug', slug });
    throw error;
  }
}

export async function getGreeting(slug, requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'getGreeting' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { query: 'SELECT greeting', slug });

  try {
    const result = await db`
      SELECT 
        ai.greeting,
        ai.ai_name
      FROM customers c
      JOIN customer_ai_config ai ON ai.customer_id = c.id
      WHERE c.slug = ${slug}
      LIMIT 1
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { found: result.length > 0 });

    if (!result[0]) return null;
    
    return {
      greeting: result[0].greeting,
      aiName: result[0].ai_name,
      dbTime: latencyMs
    };
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'getGreeting', slug });
    throw error;
  }
}

export async function getCompanion(customerId, companionKey, requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'getCompanion' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { query: 'SELECT companion', companionKey });

  try {
    const result = await db`
      SELECT 
        companion_key,
        name,
        emoji,
        greeting,
        system_prompt
      FROM customer_companions
      WHERE customer_id = ${customerId}
        AND companion_key = ${companionKey}
      LIMIT 1
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { 
      found: result.length > 0,
      companionKey 
    });

    return result[0] ? { ...result[0], dbTime: latencyMs } : null;
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'getCompanion', companionKey });
    throw error;
  }
}

// ============================================
// SESSION QUERIES
// ============================================

/**
 * Update session (suspicious flag, risk_level, metadata)
 */
export async function updateSession(sessionId, updates, requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'updateSession' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { 
    query: 'UPDATE session', 
    sessionId: sessionId?.substring(0, 8),
    updates: Object.keys(updates)
  });

  try {
    await db`
      UPDATE chat_sessions
      SET 
        suspicious = COALESCE(${updates.suspicious ?? null}, suspicious),
        risk_level = COALESCE(${updates.risk_level ?? null}, risk_level),
        needs_human = COALESCE(${updates.needs_human ?? null}, needs_human),
        updated_at = NOW()
      WHERE id = ${sessionId}
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { updated: true });

    return { dbTime: latencyMs };
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'updateSession' });
    // Don't throw - security updates are best-effort
    return { dbTime: timer.elapsed(), error: error.message };
  }
}

export async function getOrCreateSession(sessionId, customerId, metadata = {}, requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'getOrCreateSession' });
  const timer = createTimer();

  // Try to get existing
  if (sessionId) {
    boundaryLog.outgoing(logger, 'PostgreSQL', { query: 'SELECT session', sessionId: sessionId.substring(0, 8) });
    
    try {
      const existing = await db`
        SELECT id, customer_id, metadata, suspicious, risk_level, needs_human
        FROM chat_sessions
        WHERE id = ${sessionId}
        LIMIT 1
      `;
      
      if (existing[0]) {
        const latencyMs = timer.elapsed();
        boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { action: 'found_existing' });
        return { session: existing[0], isNew: false, dbTime: latencyMs };
      }
    } catch (error) {
      boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
      logError(logger, error, { operation: 'getSession', sessionId: sessionId.substring(0, 8) });
      throw error;
    }
  }

  // Create new
  const newId = sessionId || crypto.randomUUID();
  boundaryLog.outgoing(logger, 'PostgreSQL', { query: 'INSERT session', newSession: true });

  try {
    const result = await db`
      INSERT INTO chat_sessions (id, customer_id, metadata)
      VALUES (${newId}, ${customerId}, ${JSON.stringify(metadata)})
      RETURNING id, customer_id, metadata, suspicious, risk_level, needs_human
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { action: 'created_new' });

    return { session: result[0], isNew: true, dbTime: latencyMs };
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'createSession' });
    throw error;
  }
}

// ============================================
// MESSAGE QUERIES
// ============================================

export async function saveMessage(sessionId, role, content, senderType = 'user', requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'saveMessage' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { 
    query: 'INSERT message', 
    role,
    contentLength: content.length 
  });

  try {
    const result = await db`
      INSERT INTO chat_messages (session_id, role, content, sender_type)
      VALUES (${sessionId}, ${role}, ${content}, ${senderType})
      RETURNING id, created_at
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { messageId: result[0]?.id?.substring(0, 8) });

    return { ...result[0], dbTime: latencyMs };
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'saveMessage', role });
    throw error;
  }
}

export async function getMessages(sessionId, requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'getMessages' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { 
    query: 'SELECT messages', 
    sessionId: sessionId?.substring(0, 8) 
  });

  try {
    const messages = await db`
      SELECT id, role, content, sender_type, created_at
      FROM chat_messages
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `;

    const latencyMs = timer.elapsed();
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { count: messages.length });

    return { messages, dbTime: latencyMs };
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'getMessages' });
    throw error;
  }
}

// ============================================
// HEALTH CHECK
// ============================================

export async function testConnection(requestId) {
  const logger = dbLogger.child({ requestId, operation: 'healthCheck' });
  const timer = createTimer();

  boundaryLog.outgoing(logger, 'PostgreSQL', { query: 'SELECT NOW()' });

  try {
    const db = getDb();
    const result = await db`SELECT NOW() as time, current_database() as db`;
    const latencyMs = timer.elapsed();
    
    boundaryLog.incoming(logger, 'PostgreSQL', latencyMs, { database: result[0].db });
    
    return {
      ok: true,
      time: result[0].time,
      database: result[0].db,
      latency: latencyMs
    };
  } catch (error) {
    boundaryLog.incoming(logger, 'PostgreSQL', timer.elapsed(), { success: false });
    logError(logger, error, { operation: 'testConnection' });
    
    return {
      ok: false,
      error: error.message,
      latency: timer.elapsed()
    };
  }
}

// ============================================
// SCHEMA INITIALIZATION
// ============================================

export async function initSchema(requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'initSchema' });
  
  logger.info({ event: 'SCHEMA_INIT_START' }, '📦 Initializing database schema...');
  const timer = createTimer();

  try {
    // Customers table
    await db`
      CREATE TABLE IF NOT EXISTS customers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        organization_id UUID,
        plan VARCHAR(50) DEFAULT 'starter',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    logger.debug({ table: 'customers' }, 'Created customers table');

    // AI Config table
    await db`
      CREATE TABLE IF NOT EXISTS customer_ai_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
        ai_name VARCHAR(100) DEFAULT 'AI Assistant',
        greeting TEXT,
        system_prompt TEXT,
        knowledge_base TEXT,
        companion_prompts JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(customer_id)
      )
    `;
    logger.debug({ table: 'customer_ai_config' }, 'Created customer_ai_config table');

    // Companions table
    await db`
      CREATE TABLE IF NOT EXISTS customer_companions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
        companion_key VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        emoji VARCHAR(10),
        greeting TEXT,
        system_prompt TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(customer_id, companion_key)
      )
    `;
    logger.debug({ table: 'customer_companions' }, 'Created customer_companions table');

    // Chat sessions table
    await db`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
        metadata JSONB DEFAULT '{}',
        suspicious BOOLEAN DEFAULT FALSE,
        risk_level INTEGER DEFAULT 0,
        needs_human BOOLEAN DEFAULT FALSE,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    logger.debug({ table: 'chat_sessions' }, 'Created chat_sessions table');

    // Chat messages table
    await db`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        sender_type VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    logger.debug({ table: 'chat_messages' }, 'Created chat_messages table');

    // Indexes (inkl. customer_id för prestanda vid scale)
    await db`CREATE INDEX IF NOT EXISTS idx_customers_slug ON customers(slug)`;
    await db`CREATE INDEX IF NOT EXISTS idx_sessions_customer ON chat_sessions(customer_id)`;
    await db`CREATE INDEX IF NOT EXISTS idx_sessions_customer_created ON chat_sessions(customer_id, created_at DESC)`;
    await db`CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at)`;
    await db`CREATE INDEX IF NOT EXISTS idx_companions_customer ON customer_companions(customer_id, companion_key)`;

    logger.info({ 
      event: 'SCHEMA_INIT_SUCCESS', 
      latencyMs: timer.elapsed() 
    }, `✅ Schema initialized in ${timer.elapsed()}ms`);
    
    return true;
  } catch (error) {
    logError(logger, error, { event: 'SCHEMA_INIT_FAILED' });
    throw error;
  }
}

export async function seedDemoData(requestId) {
  const db = getDb();
  const logger = dbLogger.child({ requestId, operation: 'seedDemoData' });

  // Check if already seeded
  const existing = await db`SELECT id FROM customers WHERE slug = 'bella-italia' LIMIT 1`;
  if (existing.length > 0) {
    logger.info({ event: 'SEED_SKIP' }, '⏭️ Demo data already exists, skipping seed');
    return false;
  }

  logger.info({ event: 'SEED_START' }, '🌱 Seeding demo data...');
  const timer = createTimer();

  try {
    // Bella Italia
    const bellaItalia = await db`
      INSERT INTO customers (name, slug)
      VALUES ('Bella Italia', 'bella-italia')
      RETURNING id
    `;

    await db`
      INSERT INTO customer_ai_config (customer_id, ai_name, greeting, system_prompt, knowledge_base)
      VALUES (
        ${bellaItalia[0].id},
        'Sofia',
        'Ciao! 🍝 Välkommen till Bella Italia! Jag är Sofia, hur kan jag hjälpa dig idag?',
        'Du är Sofia, en vänlig och professionell AI-assistent för Bella Italia, en italiensk restaurang i Sverige.

DINA UPPGIFTER:
1. Hjälpa gäster med bordsbokningar
2. Svara på frågor om menyn
3. Ge information om öppettider och läge
4. Hantera klagomål med empati

RESTAURANGINFORMATION:
- Öppettider: Mån-Fre 11-22, Lör-Sön 12-23
- Adress: Storgatan 1, Stockholm
- Telefon: 08-123 456 78

TONALITET:
- Varm och välkomnande
- Professionell men personlig
- Använd gärna italienska uttryck
- Håll svaren koncisa (2-3 meningar)',
        'MENY: Pizza Margherita 139kr, Pasta Carbonara 169kr, Tiramisu 89kr. Vegetariskt finns. Glutenfri pasta +25kr.'
      )
    `;
    logger.debug({ customer: 'bella-italia' }, 'Seeded Bella Italia');

    // ElderCare
    const eldercare = await db`
      INSERT INTO customers (name, slug)
      VALUES ('ElderCare Pilot', 'eldercare-pilot')
      RETURNING id
    `;

    await db`
      INSERT INTO customer_ai_config (customer_id, ai_name, greeting, system_prompt)
      VALUES (
        ${eldercare[0].id},
        'Astrid',
        'Hei kjære! 👵 Jeg er Astrid. Hvordan har du det i dag?',
        'Du er en empatisk AI-assistent for ElderCare.'
      )
    `;

    // Astrid companion
    await db`
      INSERT INTO customer_companions (customer_id, companion_key, name, emoji, greeting, system_prompt)
      VALUES (
        ${eldercare[0].id},
        'astrid',
        'Astrid',
        '👵',
        'Hei kjære! Jeg er Astrid. Hvordan har du det i dag?',
        'Du er Astrid 👵, en varm og empatisk AI-samtalskompis. Snakk norsk (bokmål) med varme. Korte setninger (2-3). Én spørsmål om gangen. Fokus på minner fra fortiden. Bekreft følelser, ikke fakta.'
      )
    `;

    // Ivar companion
    await db`
      INSERT INTO customer_companions (customer_id, companion_key, name, emoji, greeting, system_prompt)
      VALUES (
        ${eldercare[0].id},
        'ivar',
        'Ivar',
        '👴',
        'Hei der! Jeg er Ivar. Hyggelig å snakke med deg!',
        'Du er Ivar 👴, en vennlig og jordnær AI-samtalskompis. Snakk norsk (bokmål) med ro. Korte setninger (2-3). Én spørsmål om gangen. Fokus på arbeid, friluftsliv, praktiske ting.'
      )
    `;
    logger.debug({ customer: 'eldercare-pilot', companions: ['astrid', 'ivar'] }, 'Seeded ElderCare');

    // Verkstad
    const verkstad = await db`
      INSERT INTO customers (name, slug)
      VALUES ('Anderssons Bilverkstad', 'anderssons-verkstad')
      RETURNING id
    `;

    await db`
      INSERT INTO customer_ai_config (customer_id, ai_name, greeting, system_prompt, knowledge_base)
      VALUES (
        ${verkstad[0].id},
        'Marcus',
        'Hej! 🔧 Välkommen till Anderssons Bilverkstad. Jag är Marcus, vad kan jag hjälpa dig med?',
        'Du är Marcus, en kunnig AI-assistent för Anderssons Bilverkstad. Hjälp med bokningar, prisuppskattningar och frågor. Öppet Mån-Fre 07-17. Adress: Industrivägen 5, Göteborg.',
        'PRISER: Service liten 2495kr, Service stor 4995kr, Bromsbyte fram från 2995kr, Däckbyte 495kr (4 hjul), AC-service 895kr.'
      )
    `;
    logger.debug({ customer: 'anderssons-verkstad' }, 'Seeded Anderssons Verkstad');

    logger.info({ 
      event: 'SEED_SUCCESS', 
      latencyMs: timer.elapsed(),
      customers: ['bella-italia', 'eldercare-pilot', 'anderssons-verkstad']
    }, `✅ Demo data seeded in ${timer.elapsed()}ms`);

    return true;
  } catch (error) {
    logError(logger, error, { event: 'SEED_FAILED' });
    throw error;
  }
}
