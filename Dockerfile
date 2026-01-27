# EryAI Engine PoC - Dockerfile för Scaleway Serverless Containers
# 
# Optimerad för:
# - Minimal image size (Alpine)
# - Snabb cold start
# - EU-Sovereign Stack

FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production

# Copy application code
COPY . .

# Expose port (Scaleway uses PORT env var, default 8080)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start server
CMD ["node", "server.js"]
