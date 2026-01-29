const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { PeerServer } = require('peer');
const path = require('path');
const fs = require('fs');
const youtubedl = require('yt-dlp-exec');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// PeerJS Server
const peerServer = PeerServer({ port: 9000, path: '/myapp' });
app.use('/peerjs', peerServer);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/video', express.static(DOWNLOAD_DIR));

// === VIDEO STREAMING (Range Requests) ===
app.get('/stream/:filename', (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// === WATCH PARTY LOGIC ===
let rooms = {};

io.on('connection', (socket) => {
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                admins: [socket.id], users: [], status: 'idle', 
                videoFilename: null, currentTime: 0, isPlaying: false 
            };
        }
        rooms[roomId].users.push(socket.id);
        io.to(roomId).emit('update_room_data', rooms[roomId]);
    });

    // STEP 1: Get Video Info (For Quality Menu)
    socket.on('get_video_info', async (data) => {
        const { roomId, url } = data;
        const room = rooms[roomId];
        
        if (room && room.admins.includes(socket.id)) {
            io.to(roomId).emit('processing_msg', "🔍 Fetching Formats...");
            
            try {
                // صرف میٹا ڈیٹا لائیں (ڈاؤنلوڈ نہیں)
                const output = await youtubedl(url, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    noCheckCertificates: true,
                    extractorArgs: "youtube:player_client=android", // Go File Logic
                });
                
                // کلائنٹ کو بتائیں کہ کوالٹی سلیکٹ کرو
                socket.emit('show_quality_menu', { 
                    title: output.title, 
                    thumbnail: output.thumbnail,
                    url: url 
                });

            } catch (err) {
                console.error(err);
                socket.emit('error_msg', "❌ Invalid Link or Security Block.");
            }
        }
    });

    // STEP 2: Start Download with Selected Quality
    socket.on('start_download', async (data) => {
        const { roomId, url, quality } = data; // quality e.g., '1080', '720', 'best'
        const room = rooms[roomId];

        if (room && room.admins.includes(socket.id)) {
            room.status = 'downloading';
            io.to(roomId).emit('update_room_data', room);
            io.to(roomId).emit('processing_msg', `⬇️ Downloading @ ${quality}p...`);

            const filename = `${uuidv4()}.mp4`;
            const outputPath = path.join(DOWNLOAD_DIR, filename);

            // فارمیٹ سٹرنگ بنائیں (Go Logic based)
            let formatString = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;
            if (quality === 'audio') formatString = 'bestaudio/best';

            try {
                await youtubedl(url, {
                    output: outputPath,
                    format: formatString,
                    noCheckCertificates: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                    addHeader: ['referer:youtube.com', 'user-agent:Mozilla/5.0'],
                    extractorArgs: "youtube:player_client=android", // The Magic Flag 🛡️
                    forceIpv4: true
                });

                room.status = 'ready';
                room.videoFilename = filename;
                io.to(roomId).emit('download_complete', { filename });
                io.to(roomId).emit('update_room_data', room);

            } catch (error) {
                console.error("DL Error:", error);
                room.status = 'idle';
                io.to(roomId).emit('error_msg', "❌ Download Failed (Server Error)");
                io.to(roomId).emit('update_room_data', room);
            }
        }
    });

    // SYNC & CONTROLS
    socket.on('video_action', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) {
            if (data.type === 'play') room.isPlaying = true;
            if (data.type === 'pause') room.isPlaying = false;
            if (data.type === 'seek') room.currentTime = data.time;
            socket.to(data.roomId).emit('perform_action', data);
        }
    });

    socket.on('time_update', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) room.currentTime = data.time;
    });

    socket.on('disconnect', () => {
        // Cleanup logic (same as before)
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
