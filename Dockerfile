FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]
