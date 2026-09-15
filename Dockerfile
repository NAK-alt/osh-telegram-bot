FROM node:20-alpine

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
