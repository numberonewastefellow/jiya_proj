FROM node:20-alpine

WORKDIR /app

COPY fraud-service/package*.json ./
RUN npm install --omit=dev

COPY fraud-service ./fraud-service
COPY server/models ./server/models

EXPOSE 5002

CMD ["node", "fraud-service/fraudServer.js"]
