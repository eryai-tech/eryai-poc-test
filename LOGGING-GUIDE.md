# 📊 Logg-Guide för EryAI Engine PoC

Denna guide hjälper dig förstå och använda loggarna för felsökning.

## 🔍 Var hittar jag loggarna?

### I Scaleway Console

1. Gå till **Scaleway Console** → **Serverless** → **Containers**
2. Klicka på din container (`eryai-engine-poc`)
3. Klicka på **Logs** fliken
4. Du ser nu live-loggar i JSON-format

### Filtrera loggar

I Scaleway kan du filtrera på:
- **Tidsperiod**: Senaste 15 min, 1 timme, 24 timmar
- **Sökord**: Skriv t.ex. `ERROR` eller ett `requestId`

---

## 📖 Förstå loggformatet

Varje loggrad är JSON med dessa fält:

```json
{
  "level": "INFO",
  "time": "2026-01-27T17:30:00.000Z",
  "service": "eryai-engine",
  "component": "chatEngine",
  "requestId": "a1b2c3d4",
  "event": "CHAT_SUCCESS",
  "msg": "◀ /api/chat 200 (823ms) TTFT=420ms"
}
```

### Viktiga fält

| Fält | Beskrivning |
|------|-------------|
| `level` | INFO, WARN, ERROR, FATAL |
| `requestId` | Unikt ID för att spåra en request genom systemet |
| `component` | Vilken del av systemet (server, database, mistral, chatEngine) |
| `event` | Vad som hände (REQUEST_START, CHAT_SUCCESS, etc.) |
| `msg` | Human-readable meddelande |

### Level-betydelser

| Level | Betydelse | Åtgärd |
|-------|-----------|--------|
| **INFO** | Normal operation | Ingen åtgärd |
| **WARN** | Något oväntat men inte kritiskt | Övervaka |
| **ERROR** | Något gick fel | Undersök |
| **FATAL** | Kritiskt systemfel | Åtgärda omedelbart |

---

## 🎯 Viktiga logg-events

### Lyckad chat

```
▶ POST /api/chat                    <- Request kommer in
→ Calling PostgreSQL               <- DB-anrop startar
← PostgreSQL responded in 25ms     <- DB-svar
→ Calling Mistral AI               <- AI-anrop startar
⚡ First token received in 420ms   <- TTFT!
← Mistral AI responded in 650ms    <- AI-svar
✅ Chat flow completed in 823ms    <- Klart!
◀ /api/chat 200 (823ms)           <- Response skickat
```

### Fel vid chat

```
▶ POST /api/chat
→ Calling Mistral AI
← Mistral AI responded in 150ms [FAILED]
❌ Mistral API rate limit reached
   hint: Too many requests sent to Mistral
   suggestedAction: Wait a moment and retry
◀ /api/chat 429
```

---

## 🔴 Vanliga fel och vad de betyder

### Database-fel

| Logg | Betydelse | Lösning |
|------|-----------|---------|
| `Database connection refused` | Kan inte nå databasen | Kolla DATABASE_URL, är DB:n igång? |
| `Database connection timeout` | DB svarar för långsamt | Kolla nätverket, är DB:n överbelastad? |
| `SSL required` | Saknar SSL i connection string | Lägg till `?sslmode=require` i DATABASE_URL |

### Mistral-fel

| Logg | Betydelse | Lösning |
|------|-----------|---------|
| `Mistral API rate limit reached` | För många anrop | Vänta 30 sek, överväg att uppgradera |
| `Mistral API authentication failed` | Fel API-nyckel | Kolla MISTRAL_API_KEY |
| `Mistral API temporarily unavailable` | Mistral har problem | Kolla status.mistral.ai |

---

## 📋 Hur du kopierar loggar till mig

### Steg 1: Identifiera problemet

1. Notera **när** felet inträffade (ungefärlig tid)
2. Notera **vad** du försökte göra (t.ex. "skickade chat till bella-italia")

### Steg 2: Hitta Request ID

I API-svaret finns alltid ett `X-Request-ID` header. Om du inte har det, leta i loggarna efter din tidpunkt.

### Steg 3: Filtrera i Scaleway

1. Sök på ditt `requestId` i logg-sökrutan
2. Eller filtrera på `ERROR` level

### Steg 4: Kopiera relevanta loggar

Klicka på "Export" eller markera och kopiera loggraderna. Inkludera:

1. **Hela request-flödet** (från REQUEST_START till REQUEST_END/ERROR)
2. **Alla ERROR-rader**
3. **Kontextloggar** (några rader före och efter felet)

### Steg 5: Skicka till mig

Klistra in loggarna och berätta:
- Vad försökte du göra?
- Vad förväntade du dig skulle hända?
- Vad hände istället?

---

## 📊 Metrics att övervaka

### I loggarna ser du dessa metrics:

```json
{
  "metrics": {
    "dbTime": 45,      // Total databastid (ms)
    "aiTime": 650,     // Mistral API tid (ms)
    "ttft": 420        // Time to First Token (ms)
  }
}
```

### Targets (grönt = bra, rött = problem)

| Metric | 🟢 Bra | 🟡 Varning | 🔴 Problem |
|--------|--------|------------|------------|
| **TTFT** | < 500ms | 500-1500ms | > 1500ms |
| **DB Time** | < 50ms | 50-100ms | > 100ms |
| **Total** | < 2000ms | 2000-3000ms | > 3000ms |

---

## 🚨 När ska du kontakta mig?

### Kontakta mig direkt om:

1. **Health check returnerar 500** (systemet är nere)
2. **Alla requests failar** (inte bara en)
3. **Latency är konsekvent > 3s** (systemet är för långsamt)
4. **ERROR-loggar med okänt fel** (något oväntat)

### Lös själv om:

1. **En enstaka request failar** → Försök igen
2. **Rate limit (429)** → Vänta 30 sek
3. **TTFT är högt en gång** → Kan vara cold start, försök igen

---

## 📝 Exempel på bra felrapport till mig

```
Hej Claude!

PROBLEM: Chat till bella-italia returnerar 500-fel

NÄR: 2026-01-27 kl 14:30 (ungefär)

VAD JAG GJORDE: Skickade "Jag vill boka bord" till bella-italia

FÖRVÄNTADE: Svar från Sofia

FICK: {"error": "Internal server error", "requestId": "a1b2c3d4"}

LOGGAR:
{"level":"INFO","time":"2026-01-27T14:30:01.123Z","requestId":"a1b2c3d4","event":"REQUEST_START","path":"/api/chat"}
{"level":"INFO","time":"2026-01-27T14:30:01.150Z","requestId":"a1b2c3d4","boundary":"OUTGOING","service":"PostgreSQL"}
{"level":"ERROR","time":"2026-01-27T14:30:01.200Z","requestId":"a1b2c3d4","error":{"message":"connection timeout"},"humanReadable":{"summary":"Database connection timeout","hint":"Database took too long to respond"}}
```

Med denna info kan jag snabbt se vad som gick fel och ge dig en lösning.

---

## 🔗 Snabblänkar

- **Scaleway Console**: https://console.scaleway.com/
- **Mistral Status**: https://status.mistral.ai/
- **Scaleway Status**: https://status.scaleway.com/

---

*Denna guide uppdaterades 2026-01-27*
