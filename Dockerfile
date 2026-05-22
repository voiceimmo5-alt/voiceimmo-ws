FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

# Copier le code source en dernier (pas de cache)
COPY server.js ./
COPY start.sh ./

RUN chmod +x /app/start.sh

EXPOSE 8080

CMD ["node", "/app/server.js"]
