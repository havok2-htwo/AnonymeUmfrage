# Anonyme Umfrage – Container-Image
#
# Das Image enthält genau die Dateien des Repositorys (siehe .dockerignore), damit der Abgleich mit dem
# Git-Tag auf GitHub „identisch“ ergeben kann. Bauen deshalb immer aus einem sauberen Checkout des Tags:
#
#   git clone https://github.com/havok2-htwo/AnonymeUmfrage && cd AnonymeUmfrage
#   git checkout v<version>
#   docker compose up -d --build

FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Abhängigkeiten zuerst (eigene Schicht), exakt nach package-lock.json mit Integritätsprüfung
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Anwendung: alle Dateien des Repositorys
COPY . .

RUN mkdir -p /data && chown node:node /data

USER node

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server.js"]
