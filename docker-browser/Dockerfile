# 1. Base Image: Use Node v20 running on Debian Linux (slim version)
FROM node:20-slim

# 2. Install Chromium and dependencies needed to run it on Linux
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    ffmpeg \
    xdotool \
    pulseaudio \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 3. Tell Puppeteer to use the system-installed Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 4. Set the working directory inside the container
WORKDIR /app

# 5. Copy package files first (helps with Docker build caching)
COPY package*.json ./

# 6. Install dependencies
RUN npm install puppeteer

# 7. Copy the rest of the application files (screenshot.js)
COPY . .

# 8. Command to run when the container starts
# --env-file=.env loads our .env config (mounted from host via volume)
CMD ["node", "--env-file=.env", "screenshot.js"]