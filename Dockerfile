FROM node:20-alpine

# Set timezone to Asia/Phnom_Penh (UTC+7)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Phnom_Penh

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure upload folders exist
RUN mkdir -p uploads/equipment uploads/qr-codes backups

ENV NODE_ENV=production

# Run the Telegram bot
CMD ["node", "telegramBot/bot.js"]
