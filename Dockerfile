# 1. Base Image (Debian Bookworm has Python 3.11+)
FROM node:18-bookworm

# 2. Install System Dependencies (FFmpeg is Must)
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    ln -sf /usr/bin/python3 /usr/bin/python

# 3. Work Directory
WORKDIR /app

# 4. Copy Package Files
COPY package*.json ./

# 5. Install Node Dependencies
RUN npm install

# 6. Copy Source Code
COPY . .

# 7. Create Downloads Folder (For Volume Mounting)
RUN mkdir -p /app/downloads

# 8. Expose Port
EXPOSE 3000

# 9. Start Command
CMD ["node", "server.js"]
