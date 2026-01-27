# EryAI Engine PoC - EU-Sovereign Stack

**Proof-of-Concept för att validera Scaleway + Mistral innan full migration från Vercel + Supabase + Gemini.**

**Status: VALIDERAD ✅** (Gemini GO 2026-01-27)

## 🎯 Vad validerar vi?

| Funktion | Nuvarande | PoC |
|----------|-----------|-----|
| Hosting | Vercel (US) | Scaleway Serverless Containers (FR) 🇫🇷 |
| Database | Supabase (US) | Scaleway Serverless SQL (FR) 🇫🇷 |
| AI | Google Gemini (US) | Mistral (FR) 🇫🇷 |

**100% EU-ägd infrastruktur. Ingen US CLOUD Act exponering.**

---

## 🚀 Snabbstart (Lokal utveckling)

### Med Docker Compose (rekommenderat)

```bash
# 1. Kopiera och konfigurera miljövariabler
cp .env.example .env
# Fyll i MISTRAL_API_KEY i .env

# 2. Starta allt
docker-compose up

# 3. Testa (i ny terminal)
curl http://localhost:8080/health

# 4. Öppna test-console.html i browser
open test-console.html
```

### Utan Docker

```bash
# Kräver: Node 20+, PostgreSQL, Mistral API-nyckel

npm install
cp .env.example .env
# Fyll i DATABASE_URL och MISTRAL_API_KEY

npm run dev  # Startar med pino-pretty för läsbar output
```

---

## 📦 Vad ingår?

Multi-tenant engine som speglar nuvarande eryai-engine:

| Endpoint | Beskrivning |
|----------|-------------|
| `GET /health` | Health check + schema init |
| `GET /api/greeting?slug=` | Hämta greeting för kund |
| `GET /api/messages?sessionId=` | Hämta meddelanden |
| `POST /api/chat` | Chat med AI |

### Demo-kunder (seedas automatiskt)

| Slug | AI | Typ |
|------|----|----|
| `bella-italia` | Sofia 🍝 | Restaurang |
| `anderssons-verkstad` | Marcus 🔧 | Verkstad |
| `eldercare-pilot` | Astrid 👵 / Ivar 👴 | ElderCare (Mimre) |

## 🚀 Deployment

### Steg 1: Skapa Scaleway-konto

1. Gå till https://www.scaleway.com/
2. Skapa konto
3. Skapa projekt: "EryAI-Sovereign"

### Steg 2: Skapa Serverless SQL Database

1. Console → Serverless → SQL Databases → Create
2. Region: **Frankfurt (fr-fra)** 
3. Namn: `eryai-poc`
4. Kopiera connection string

### Steg 3: Skaffa Mistral API-nyckel

1. https://console.mistral.ai/
2. Skapa konto
3. API Keys → Create
4. Kopiera nyckeln

### Steg 4: Skapa Container Registry

1. Console → Container Registry → Create Namespace
2. Namn: `eryai`
3. Region: Frankfurt

### Steg 5: Bygg och pusha Docker image

```bash
# Logga in i Scaleway Registry
docker login rg.fr-par.scw.cloud/eryai -u nologin --password-stdin <<< $(scw iam api-key get YOUR_API_KEY_ID -o json | jq -r .secret_key)

# Bygg
docker build -t eryai-engine-poc .

# Tagga
docker tag eryai-engine-poc rg.fr-par.scw.cloud/eryai/eryai-engine-poc:latest

# Pusha
docker push rg.fr-par.scw.cloud/eryai/eryai-engine-poc:latest
```

### Steg 6: Deploya Serverless Container

1. Console → Serverless → Containers → Create
2. Namespace: `eryai`
3. Image: `rg.fr-par.scw.cloud/eryai/eryai-engine-poc:latest`
4. Environment Variables:
   - `DATABASE_URL`: din connection string
   - `MISTRAL_API_KEY`: din API-nyckel
5. Resources: 256 MB RAM, 0.1 vCPU
6. Scaling: Min 0, Max 1 (för PoC)

### Steg 7: Testa

```bash
# Health check (initierar schema + seedar demo-data)
curl https://YOUR-CONTAINER.functions.fnc.fr-par.scw.cloud/health

# Chat med Bella Italia
curl -X POST https://YOUR-CONTAINER.functions.fnc.fr-par.scw.cloud/api/chat \
  -H "Content-Type: application/json" \
  -d '{"slug": "bella-italia", "prompt": "Hej! Jag vill boka bord för 4 personer"}'

# Chat med ElderCare (Astrid)
curl -X POST https://YOUR-CONTAINER.functions.fnc.fr-par.scw.cloud/api/chat \
  -H "Content-Type: application/json" \
  -d '{"slug": "eldercare-pilot", "companion": "astrid", "prompt": "Hei Astrid!"}'
```

## 🧪 Lokal utveckling

```bash
# Med Docker Compose (inkluderar lokal PostgreSQL)
docker-compose up

# Eller manuellt
cp .env.example .env
npm install
npm run dev
```

---

## 🔥 Keep Warm (undvik cold starts)

Scaleway Serverless Containers med min-scale=0 kan ha 1-3 sekunders cold start. För bättre UX:

### Gratis alternativ: Cron-ping

Använd en gratis cron-tjänst för att pinga `/health` var 5:e minut under kontorstid:

1. Gå till https://cron-job.org/ (gratis)
2. Skapa ny cron job:
   - URL: `https://YOUR-CONTAINER-URL/health`
   - Schedule: `*/5 6-22 * * *` (var 5:e min, 06:00-22:00)
3. Done! Containern hålls varm för ~0 kr extra

### Betalt alternativ: min-scale=1

I Scaleway Console → Container → Edit → Scaling → Min instances: 1

Kostnad: ~50-100 kr/mån (alltid igång)

---

## ⛔ Rate Limiting

PoC:en har inbyggd rate limiting för att skydda Mistral-budgeten:

- **10 requests per 30 sekunder** per IP
- Headers i response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`
- Vid limit: HTTP 429 med `Retry-After` header

---

## 📊 Token & Kostnadsloggning

Varje chat loggar estimerad tokenanvändning och kostnad:

```json
{
  "tokens": {
    "estimatedInput": 250,
    "estimatedOutput": 80,
    "estimatedTotal": 330,
    "estimatedCostEur": "0.000098"
  }
}
```

Mistral Small priser (~Jan 2026):
- Input: €0.2 / 1M tokens
- Output: €0.6 / 1M tokens

---

## 📊 PoC Metrics

| Metric | Target | Red Flag |
|--------|--------|----------|
| **TTFT** | < 500ms | > 1500ms |
| **Total latency** | < 2000ms | > 3000ms |
| **DB latency** | < 50ms | > 100ms |
| **Cold start** | < 5s | > 10s |

## ✅ Go/No-Go Kriterier

### GO om:
- [ ] TTFT < 500ms konsekvent
- [ ] Total latency < 2s
- [ ] DB latency < 50ms
- [ ] Mistral svenska/norska är naturlig
- [ ] Kostnad ~0 kr för PoC

### NO-GO om:
- [ ] TTFT > 1.5s konsekvent
- [ ] Cold starts > 10s
- [ ] Mistral är märkbart sämre än Gemini
- [ ] Deployment är för komplex

## 🔜 Efter GO

1. **Migrera eryai-engine** - Ersätt Gemini med Mistral
2. **Migrera databas** - Exportera Supabase → Scaleway SQL
3. **Implementera Better Auth** - Ersätt Supabase Auth
4. **Migrera frontends** - Scaleway Static/Container
5. **DNS** - Peka eryai.tech och mimreappen.no till Scaleway

## 📁 Filstruktur

```
eryai-poc/
├── server.js           # HTTP server med routing
├── lib/
│   ├── chatEngine.js   # Chat orchestration
│   ├── db.js           # PostgreSQL queries
│   ├── mistral.js      # Mistral AI client
│   └── health.js       # Health check + init
├── Dockerfile          # Container build
├── package.json
├── test-console.html   # Browser test UI
└── README.md
```

---

**EryAI** - AI-driven kundtjänst för Norden 🇸🇪🇳🇴🇩🇰

*Powered by EU-Sovereign infrastructure* 🇪🇺
