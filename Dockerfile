FROM node:20-alpine

WORKDIR /app

# Install cloudflared
RUN wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -O /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "start-with-tunnel.js"]
