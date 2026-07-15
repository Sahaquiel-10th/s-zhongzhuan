FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 4173
CMD ["sh", "-c", "npm run db:migrate && npm start"]
