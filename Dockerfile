FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the source
COPY . .

# Ensure uploads dir exists (real files live on the mounted volume)
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "server.js"]
