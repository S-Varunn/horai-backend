FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Ensure data directory exists for WhatsApp auth credentials
RUN mkdir -p data/whatsapp_auth

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run migrations and start server
CMD ["npm", "run", "start:prod"]
