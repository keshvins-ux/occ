# ============================================================
# OCC ERP — Docker Container
# Runs: API server + sync cron jobs + Postgres client
#
# Build:  docker build -t occ .
# Run:    docker run --env-file .env -p 3000:3000 occ
# ============================================================

FROM node:20-alpine

WORKDIR /app

# Install cron and PostgreSQL client
RUN apk add --no-cache dcron postgresql-client curl

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --production 2>/dev/null || npm install --production

# Copy application code
COPY api/ ./api/
COPY src/ ./src/
COPY server/ ./server/
COPY public/ ./public/
COPY vercel.json ./

# Copy sync scripts
COPY server/sync-all.js ./sync/sync-all.js
COPY server/sync-lines.js ./sync/sync-lines.js

# Setup crontab for sync jobs
RUN echo "*/10 * * * * cd /app/sync && /usr/local/bin/node sync-all.js >> /var/log/occ-sync.log 2>&1" > /etc/crontabs/root && \
    echo "5,15,25,35,45,55 * * * * cd /app/sync && /usr/local/bin/node sync-lines.js >> /var/log/occ-sync-lines.log 2>&1" >> /etc/crontabs/root

# Create log files
RUN touch /var/log/occ-sync.log /var/log/occ-sync-lines.log

# Expose API port
EXPOSE 3000

# Start cron + API server
CMD crond -b && npm start
