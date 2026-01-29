# 1. Base Image (Debian Bookworm has Python 3.11+)
FROM node:18-bookworm

# 2. Install System Dependencies (Python + FFmpeg)
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    ln -sf /usr/bin/python3 /usr/bin/python

# 3. 🔥 INSTALL YT-DLP (CRITICAL FIX)
# یہ لائن مسنگ تھی، اس لیے ENOENT ایرر آ رہا تھا
RUN pip3 install yt-dlp --break-system-packages

# 4. Work Directory
WORKDIR /app

# 5. Copy Package Files
COPY package*.json ./

# 6. Install Node Dependencies
RUN npm install

# 7. Copy Source Code
COPY . .

# 8. Create Downloads Folder (For Volume Mounting)
RUN mkdir -p /app/downloads

# 9. Expose Port
EXPOSE 3000

# 10. Start Command
CMD ["node", "server.js"]
