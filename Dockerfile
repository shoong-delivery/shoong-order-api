FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma
RUN npm install
RUN npx prisma generate

COPY src ./src

EXPOSE 3001
CMD ["node", "src/index.js"]