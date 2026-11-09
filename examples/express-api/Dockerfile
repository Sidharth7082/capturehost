FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

# The node image already ships an unprivileged `node` user.
USER node

EXPOSE 8080

CMD ["node", "server.js"]
