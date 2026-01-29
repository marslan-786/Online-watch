const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process'); // 🔥 Native Command Runner
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 
});

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

// === GLOBAL ROOMS ===
let rooms = {};

// === API CONTROLLER ===
app.post('/api/room/:roomId/control', (req, res) => {
    const { roomId } = req.params;
    const { action, time } = req.body;
    const room = rooms[roomId];
    if(!room) return res.status(404).json({ error: "No Room" });

    if (action === 'play') { room.isPlaying = true; io.to(roomId).emit('force_sync', { action: 'play', time: room.currentTime }); } 
    else if (action === 'pause') { room.isPlaying = false; io.to(roomId).emit('force_sync', { action: 'pause', time: room.currentTime }); } 
    else if (action === 'seek') { room.currentTime = parseFloat(time); io.to(roomId).emit('force_sync', { action: 'seek', time: room.currentTime }); }

    res.json({ success: true });
});

// === SOCKET LOGIC ===
io.on('connection', (socket) => {
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { admins: [socket.id], users: [], videoFilename: null, currentTime: 0, isPlaying: false, status: 'idle' };
        } else {
            if(!rooms[roomId].users.includes(socket.id)) rooms[roomId].users.push(socket.id);
        }
        
        // Inject State
        const room = rooms[roomId];
        socket.emit('inject_state', {
            time: room.currentTime,
            isPlaying: room.isPlaying,
            filename: room.videoFilename,
            isAdmin: room.admins.includes(socket.id)
        });
    });

    // --- 🎤 AUDIO STREAM ---
    socket.on('audio_stream', (data) => socket.to(data.roomId).emit('global_voice', data.audioChunk));

    // --- 🔍 GET INFO (Native Spawn) ---
    socket.on('get_info', (data) => {
        console.log(`[INFO START] Fetching metadata: ${data.url}`);
        
        // Using python directly for raw output
        const yt = spawn('yt-dlp', [
            data.url, 
            '--dump-single-json', 
            '--no-warnings', 
            '--force-ipv4', // 🔥 Force IPv4 to prevent hanging
            '--extractor-args', 'youtube:player_client=android'
        ]);

        let rawData = '';
        let errorData = '';

        yt.stdout.on('data', (chunk) => rawData += chunk);
        yt.stderr.on('data', (chunk) => {
            errorData += chunk;
            console.log(`[YT LOG]: ${chunk}`); // Hard Print Logs
        });

        yt.on('close', (code) => {
            if (code === 0) {
                try {
                    const info = JSON.parse(rawData);
                    console.log(`[INFO SUCCESS] Found: ${info.title}`);
                    socket.emit('info_result', { title: info.title, url: data.url, duration: info.duration });
                } catch (e) {
                    console.error("[JSON PARSE ERROR]", e);
                    socket.emit('status_msg', "❌ Error parsing metadata");
                }
            } else {
                console.error(`[INFO FAIL] Exit Code: ${code}`);
                socket.emit('status_msg', "❌ Failed to fetch video info. Check logs.");
            }
        });
    });

    // --- ⬇️ DOWNLOAD (Progress Bar Logic) ---
    socket.on('start_download', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;

        const filename = `${uuidv4()}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);
        
        // Format Logic
        let format = `bestvideo[height<=${data.quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${data.quality}][ext=mp4]/best`;
        if (data.quality === 'audio') format = 'bestaudio/best';

        console.log(`[DOWNLOAD START] ${data.url} -> ${filename}`);

        const yt = spawn('yt-dlp', [
            data.url,
            '-f', format,
            '-o', outputPath,
            '--force-ipv4',  // 🔥 Critical for Railway
            '--newline',     // 🔥 Critical for Progress Bar Parsing
            '--no-warnings',
            '--extractor-args', 'youtube:player_client=android' // 🔥 Anti-Block
        ]);

        yt.stdout.on('data', (chunk) => {
            const line = chunk.toString();
            // console.log(`[YT OUT]: ${line}`); // Uncomment for EXTREME logging

            // Parse Percentage: "[download]  45.5% of 100MiB"
            const match = line.match(/\[download\]\s+(\d+\.\d+)%/);
            if (match && match[1]) {
                const percent = parseFloat(match[1]);
                // Emit progress to Room
                io.to(data.roomId).emit('download_progress', { percent: percent });
            }
        });

        yt.stderr.on('data', (chunk) => {
            console.error(`[YT ERROR/LOG]: ${chunk.toString()}`); // Hard print errors
        });

        yt.on('close', (code) => {
            if (code === 0) {
                console.log(`[DOWNLOAD COMPLETE] File: ${filename}`);
                room.videoFilename = filename;
                room.currentTime = 0;
                room.isPlaying = true;
                room.status = 'playing';
                
                io.to(data.roomId).emit('download_complete', { filename });
            } else {
                console.error(`[DOWNLOAD FAILED] Code: ${code}`);
                io.to(data.roomId).emit('status_msg', "❌ Download Failed. Check Server Console.");
            }
        });
    });
});

// Clock Sync
setInterval(() => {
    for (const id in rooms) {
        const room = rooms[id];
        if (room.status === 'playing' && room.videoFilename) {
            room.currentTime += 1;
            if (Math.floor(room.currentTime) % 5 === 0) io.to(id).emit('clock_sync', { time: room.currentTime });
        }
    }
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Server Running on ${PORT}`);
});
