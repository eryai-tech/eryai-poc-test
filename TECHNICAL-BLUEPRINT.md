# EryAI Engine PoC - Technical Blueprint
## För validering innan deployment

**Datum:** 2026-01-27
**Version:** 1.0.0-poc
**Syfte:** Validera EU-Sovereign stack innan full migration från Vercel/Supabase/Gemini

---

## 1. ARKITEKTUR ÖVERSIKT

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ERYAI ENGINE PoC                                     │
│                    100% EU-Sovereign Stack 🇪🇺                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    SCALEWAY SERVERLESS CONTAINER                     │   │
│  │                         Region: Frankfurt 🇫🇷                         │   │
│  │                                                                       │   │
│  │   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐ │   │
│  │   │   server.js │───▶│ chatEngine  │───▶│     lib/mistral.js      │ │   │
│  │   │   (Router)  │    │   (Logic)   │    │   (Mistral AI Client)   │ │   │
│  │   └─────────────┘    └──────┬──────┘    └───────────┬─────────────┘ │   │
│  │                             │                       │               │   │
│  │                             ▼                       ▼               │   │
│  │                      ┌─────────────┐    ┌─────────────────────────┐ │   │
│  │                      │  lib/db.js  │    │    Mistral API 🇫🇷       │ │   │
│  │                      │ (PostgreSQL)│    │  mistral-small-latest   │ │   │
│  │                      └──────┬──────┘    └─────────────────────────┘ │   │
│  │                             │                                       │   │
│  └─────────────────────────────┼───────────────────────────────────────┘   │
│                                │                                           │
│                                ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │              SCALEWAY SERVERLESS SQL (PostgreSQL) 🇫🇷                │   │
│  │                       Region: Frankfurt                              │   │
│  │                                                                       │   │
│  │   customers ──┬── customer_ai_config                                 │   │
│  │               ├── customer_companions (Astrid/Ivar)                  │   │
│  │               └── chat_sessions ─── chat_messages                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. TECH STACK JÄMFÖRELSE

| Komponent | Nuvarande (US) | PoC (EU) | Ägare |
|-----------|----------------|----------|-------|
| **Hosting** | Vercel (US/AWS) | Scaleway Serverless Containers | 🇫🇷 Frankrike |
| **Database** | Supabase (US/AWS) | Scaleway Serverless SQL | 🇫🇷 Frankrike |
| **AI Model** | Google Gemini 2.0 Flash | Mistral Small | 🇫🇷 Frankrike |
| **Auth** | Supabase Auth + TOTP | (Ej i PoC - Better Auth planerat) | - |
| **Runtime** | Node.js (Vercel Functions) | Node.js 20 (Docker/Alpine) | - |

**CLOUD Act Status:** PoC har INGEN exponering mot US CLOUD Act.

---

## 3. API ENDPOINTS

### 3.1 GET /health

**Syfte:** Health check + auto-init schema + seed demo data

**Response 200:**
```json
{
  "ok": true,
  "timestamp": "2026-01-27T17:30:00.000Z",
  "requestId": "a1b2c3d4",
  "stack": "EU-Sovereign (Scaleway 🇫🇷 + Mistral 🇫🇷)",
  "version": "1.0.0-poc",
  "components": {
    "database": {
      "status": "healthy",
      "latencyMs": 25,
      "meetsTarget": true,
      "schemaInitialized": true
    },
    "mistral": {
      "status": "healthy",
      "latencyMs": 450,
      "model": "mistral-small-latest",
      "meetsTarget": true
    }
  },
  "targets": {
    "dbLatency": "< 50ms",
    "aiLatency": "< 1000ms",
    "ttft": "< 500ms"
  },
  "summary": {
    "allHealthy": true,
    "allMeetTargets": true,
    "recommendation": "All systems GO ✅"
  },
  "totalLatencyMs": 480
}
```

**Response 500:** Samma format men `ok: false` och feldetaljer.

### 3.2 GET /api/greeting?slug={slug}

**Syfte:** Hämta AI-greeting för kund (samma som nuvarande engine)

**Response:**
```json
{
  "greeting": "Ciao! 🍝 Välkommen till Bella Italia!",
  "aiName": "Sofia",
  "dbTime": 15
}
```

### 3.3 GET /api/messages?sessionId={uuid}

**Syfte:** Hämta meddelanden för session

**Response:**
```json
{
  "messages": [
    { "id": "uuid", "role": "user", "content": "Hej!", "sender_type": "user", "created_at": "..." },
    { "id": "uuid", "role": "assistant", "content": "Ciao!", "sender_type": "assistant", "created_at": "..." }
  ],
  "dbTime": 20
}
```

### 3.4 POST /api/chat

**Syfte:** Huvudchat endpoint (samma interface som nuvarande engine)

**Request:**
```json
{
  "slug": "bella-italia",
  "prompt": "Jag vill boka bord för 4 personer",
  "sessionId": "optional-uuid",
  "companion": "astrid",  // Optional, för ElderCare
  "history": []           // Optional, client-side history
}
```

**Response:**
```json
{
  "response": "Ciao! Vad roligt att du vill boka hos oss! För vilket datum och tid önskar du bordet?",
  "sessionId": "uuid",
  "_metrics": {
    "totalTime": 823,
    "dbTime": 45,
    "aiTime": 650,
    "ttft": 420
  }
}
```

**Response Headers:**
```
X-Request-ID: a1b2c3d4
X-Total-Time-Ms: 823
X-DB-Time-Ms: 45
X-AI-Time-Ms: 650
X-TTFT-Ms: 420
```

---

## 4. DATABASE SCHEMA

```sql
-- Samma struktur som nuvarande Supabase

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  organization_id UUID,
  plan VARCHAR(50) DEFAULT 'starter',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE customer_ai_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  ai_name VARCHAR(100) DEFAULT 'AI Assistant',
  greeting TEXT,
  system_prompt TEXT,
  knowledge_base TEXT,
  companion_prompts JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id)
);

CREATE TABLE customer_companions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  companion_key VARCHAR(50) NOT NULL,     -- 'astrid', 'ivar'
  name VARCHAR(100) NOT NULL,
  emoji VARCHAR(10),
  greeting TEXT,
  system_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, companion_key)
);

CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  metadata JSONB DEFAULT '{}',
  suspicious BOOLEAN DEFAULT FALSE,
  risk_level INTEGER DEFAULT 0,
  needs_human BOOLEAN DEFAULT FALSE,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,              -- 'user', 'assistant'
  content TEXT NOT NULL,
  sender_type VARCHAR(20) DEFAULT 'user', -- 'user', 'assistant', 'human'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_customers_slug ON customers(slug);
CREATE INDEX idx_sessions_customer ON chat_sessions(customer_id);
CREATE INDEX idx_messages_session ON chat_messages(session_id, created_at);
```

**Skillnad från Supabase:** Ingen Row Level Security (RLS) - hanteras i applikationslager istället.

---

## 5. DEMO DATA (Auto-seeded)

| Slug | AI Name | Typ | Companions |
|------|---------|-----|------------|
| `bella-italia` | Sofia 🍝 | Restaurang | - |
| `anderssons-verkstad` | Marcus 🔧 | Verkstad | - |
| `eldercare-pilot` | Astrid 👵 | ElderCare | astrid, ivar |

---

## 6. OBSERVERBARHET

### 6.1 Loggformat (pino/JSON)

```json
{
  "level": "INFO",
  "time": "2026-01-27T17:30:00.000Z",
  "service": "eryai-engine",
  "version": "1.0.0-poc",
  "env": "production",
  "component": "chatEngine",
  "requestId": "a1b2c3d4",
  "event": "CHAT_SUCCESS",
  "metrics": {
    "dbTime": 45,
    "aiTime": 650,
    "ttft": 420
  },
  "msg": "✅ Chat flow completed in 823ms"
}
```

### 6.2 Boundary Logs

Varje externt anrop loggas med OUTGOING/INCOMING:

```
→ Calling PostgreSQL          (boundary: OUTGOING, service: PostgreSQL)
← PostgreSQL responded in 25ms (boundary: INCOMING, latencyMs: 25)

→ Calling Mistral AI          (boundary: OUTGOING, service: Mistral AI)
⚡ First token in 420ms       (event: TTFT)
← Mistral AI responded in 650ms (boundary: INCOMING, latencyMs: 650)
```

### 6.3 Error Format

```json
{
  "level": "ERROR",
  "error": {
    "message": "connection timeout",
    "name": "Error",
    "code": "ETIMEDOUT"
  },
  "humanReadable": {
    "summary": "Database connection timeout",
    "hint": "Database took too long to respond",
    "suggestedAction": "Check network connectivity and database health"
  }
}
```

---

## 7. FILSTRUKTUR

```
eryai-engine-poc/
├── server.js              # HTTP router + rate limiting (150 lines)
├── docker-compose.yml     # Lokal dev med PostgreSQL
├── package.json           # Dependencies: pino, postgres, @mistralai/mistralai
├── Dockerfile             # Node 20 Alpine
├── .env.example           # Environment template
├── .dockerignore
├── README.md              # Deployment guide
├── LOGGING-GUIDE.md       # Eric's manual for reading logs
├── test-console.html      # Browser test UI
└── lib/
    ├── logger.js          # Pino setup + helpers (150 lines)
    ├── db.js              # PostgreSQL queries (400 lines)
    ├── mistral.js         # Mistral AI client + token counting (200 lines)
    ├── chatEngine.js      # Chat orchestration + security (280 lines)
    ├── health.js          # Health check (140 lines)
    ├── rateLimit.js       # In-memory rate limiter (100 lines)
    └── securityJudge.js   # AI-powered threat detection (220 lines)
```

**Total:** ~1640 rader kod (exkl. test-console.html)

---

## 8. DEPLOYMENT PLAN

### Steg 1: Skapa resurser
1. Scaleway konto + projekt "EryAI-Sovereign"
2. Serverless SQL Database (Frankfurt)
3. Container Registry namespace
4. Mistral API-nyckel

### Steg 2: Build & Deploy
```bash
docker build -t eryai-engine-poc .
docker tag eryai-engine-poc rg.fr-par.scw.cloud/eryai/eryai-engine-poc:latest
docker push rg.fr-par.scw.cloud/eryai/eryai-engine-poc:latest
```

### Steg 3: Konfigurera Container
- Image: `rg.fr-par.scw.cloud/eryai/eryai-engine-poc:latest`
- Memory: 256 MB
- Min scale: 0 (PoC), 1 (produktion)
- Max scale: 1 (PoC)
- Env vars: DATABASE_URL, MISTRAL_API_KEY, LOG_LEVEL=info

### Steg 4: Validera
```bash
# Health check (initierar schema)
curl https://YOUR-URL/health

# Test chat
curl -X POST https://YOUR-URL/api/chat \
  -H "Content-Type: application/json" \
  -d '{"slug":"bella-italia","prompt":"Hej!"}'
```

---

## 9. SUCCESS CRITERIA (Go/No-Go)

### ✅ GO om:

| Metric | Target | Mätning |
|--------|--------|---------|
| TTFT | < 500ms | Konsekvent över 10 requests |
| Total latency | < 2000ms | Genomsnitt |
| DB latency | < 50ms | Genomsnitt |
| Cold start | < 5s | Första request efter idle |
| Mistral kvalitet | ≥ Gemini | Subjektiv bedömning sv/no |
| Kostnad | ~0 kr | Under PoC |

### ❌ NO-GO om:

| Metric | Threshold |
|--------|-----------|
| TTFT | > 1500ms konsekvent |
| Total latency | > 3000ms |
| Cold start | > 10s |
| Mistral kvalitet | Märkbart sämre än Gemini |
| Deployment | För komplex för Eric |

---

## 10. KÄNDA BEGRÄNSNINGAR I PoC

| Funktion | Status | Plan för produktion |
|----------|--------|---------------------|
| Auth | ❌ Ej implementerat | Better Auth |
| RLS | ❌ Ej implementerat | Application-level auth |
| Rate limiting | ✅ Implementerat | 10 req/30s per IP |
| **Security Judge** | ✅ Implementerat | AI-baserad hotdetektion |
| Push notifications | ❌ Ej implementerat | Behålls som idag |
| Email | ❌ Ej implementerat | Resend (eller Tipimail för Mimre) |
| Superadmin alerts | ❌ Ej implementerat | Email vid suspicious |

---

## 10.5 SECURITY JUDGE (AI-powered)

### Arkitektur

```
User message →
  quickSafetyCheck() (regex, 0ms) →
    analyzePromptSafety() (Mistral Small) →
      riskLevel 1-10 →
        7-10: Block + flag session
        4-6: Log but allow  
        1-3: Allow silently
```

### Features

| Feature | Implementation |
|---------|----------------|
| **Språkagnostisk** | Fungerar på alla språk (sv/no/en/tr...) |
| **Context-aware** | ElderCare mer tolerant för förvirrade |
| **Risk-baserad** | Graduerad 1-10 istället för binär |
| **Quick filter** | Regex för uppenbara attacker (0ms) |
| **Fail-safe** | Vid AI-fel → tillåt meddelandet |

### Detekterar

1. **Prompt injection** - "ignore previous instructions"
2. **Data exfiltration** - API keys, passwords, system prompts
3. **Jailbreaking** - Roleplay, hypotheticals, encoding tricks
4. **Social engineering** - Fake admin, urgency tactics

### Kostnad

- ~€0.001 per analys med Mistral Small
- ~€0.50/kund/månad vid normal användning

### Blocked Responses (per customer type)

| Type | Response |
|------|----------|
| eldercare | "Kjære deg, jeg forstår ikke helt..." (norska, mjukt) |
| restaurant | "Tyvärr kan jag inte hjälpa..." (svenska, professionellt) |
| auto-shop | "Det kan jag tyvärr inte..." (svenska, sakligt) |

---

## 11. FRÅGOR TILL GEMINI

1. **Arkitektur:** Ser strukturen sund ut för en multi-tenant SaaS?

2. **Scaleway val:** 
   - Serverless Containers vs Kapsule (K8s)?
   - Serverless SQL vs Managed PostgreSQL?

3. **Mistral integration:**
   - Är `mistral-small-latest` rätt modell för kundtjänst-chat?
   - Streaming för TTFT - korrekt approach?

4. **Observerbarhet:**
   - Räcker pino JSON-logs för Scaleway Cockpit?
   - Saknas någon kritisk metric?

5. **Cold starts:**
   - Min-scale 0 för PoC - risk för dålig UX?
   - Rekommendation för "keep warm" strategi?

6. **Security:**
   - Utan RLS - är application-level auth tillräckligt?
   - Bör vi lägga till rate limiting i PoC?

7. **Migration path:**
   - Ser du några blockers för full migration efter GO?
   - Rekommendationer för databasmigration Supabase → Scaleway?

---

**Väntar på Geminis validering innan deployment.**

*Genererad av Claude, Lead Engineer för EryAI*
