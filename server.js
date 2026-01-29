const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const youtubedl = require('yt-dlp-exec');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // 100MB buffer for audio chunks
});

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

app.use(express.json()); // To parse JSON bodies
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

// === 1. GLOBAL STATE (THE TRUTH) ===
let rooms = {};

// === 2. API ENDPOINTS (CONTROL CENTER) ===

// API: Get Room Status (For Injection)
app.get('/api/room/:roomId/status', (req, res) => {
    const { roomId } = req.params;
    if(rooms[roomId]) {
        res.json({ success: true, state: rooms[roomId] });
    } else {
        res.status(404).json({ success: false, error: "Room not found" });
    }
});

// API: Control Video (Play/Pause/Seek)
app.post('/api/room/:roomId/control', (req, res) => {
    const { roomId } = req.params;
    const { action, time, adminSecret } = req.body; // action: 'play'|'pause'|'seek'
    
    const room = rooms[roomId];
    if(!room) return res.status(404).json({ error: "No Room" });

    // Validate Admin (Simple check based on socket ID mapping or secret)
    // Here assuming the request comes from authorized frontend logic
    
    console.log(`[API CALL] Room: ${roomId} -> Action: ${action} @ ${time}`);

    if (action === 'play') {
        room.isPlaying = true;
        room.status = 'playing';
        io.to(roomId).emit('force_sync', { action: 'play', time: room.currentTime });
    } 
    else if (action === 'pause') {
        room.isPlaying = false;
        room.status = 'paused';
        io.to(roomId).emit('force_sync', { action: 'pause', time: room.currentTime });
    } 
    else if (action === 'seek') {
        room.currentTime = parseFloat(time);
        io.to(roomId).emit('force_sync', { action: 'seek', time: room.currentTime });
    }

    res.json({ success: true, newState: room });
});

// === 3. VIDEO STREAMING ===
app.get('/video/:filename', (req, res) => {
    // Standard Streaming Logic (Same as before)
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
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': chunksize, 'Content-Type': 'video/mp4' });
        file.pipe(res);
    } else {
        res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
        fs.createReadStream(filePath).pipe(res);
    }
});

// === 4. SOCKET LOGIC (CONNECTION & AUDIO) ===
io.on('connection', (socket) => {
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                admins: [socket.id], 
                users: [], 
                videoFilename: null, 
                currentTime: 0, 
                isPlaying: false,
                status: 'idle',
                duration: 0
            };
        } else {
            // Re-joining user? Just add to list
            if(!rooms[roomId].users.includes(socket.id)) rooms[roomId].users.push(socket.id);
        }

        // 🔥 INJECTION: Send exact server state immediately
        const room = rooms[roomId];
        socket.emit('inject_state', {
            time: room.currentTime,
            isPlaying: room.isPlaying,
            filename: room.videoFilename,
            isAdmin: room.admins.includes(socket.id)
        });
        
        io.to(roomId).emit('update_users', { count: room.users.length });
    });

    // --- 🎤 GLOBAL AUDIO RELAY (API STYLE) ---
    // Instead of P2P, we send audio chunks to server, server broadcasts to room
    socket.on('audio_stream', (data) => {
        // data = { roomId, audioChunk }
        // Broadcast to everyone in room EXCEPT sender
        socket.to(data.roomId).emit('global_voice', data.audioChunk);
    });

    // --- DOWNLOAD START ---
    socket.on('start_download', async (data) => {
        const room = rooms[data.roomId];
        if(!room) return;
        
        io.to(data.roomId).emit('status_msg', "⬇️ Server Downloading...");
        
        const filename = `${uuidv4()}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);
        let format = `bestvideo[height<=${data.quality}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;
        if (data.quality === 'audio') format = 'bestaudio/best';

        try {
            await youtubedl(data.url, {
                output: outputPath, format: format, noCheckCertificates: true,
                preferFreeFormats: true, extractorArgs: "youtube:player_client=android"
            });
            
            room.videoFilename = filename;
            room.currentTime = 0;
            room.isPlaying = true; // Auto start
            room.status = 'playing';
            room.duration = data.duration || 3600;

            io.to(data.roomId).emit('ready_to_play', { filename });
        } catch (e) {
            io.to(data.roomId).emit('status_msg', "❌ Download Error");
        }
    });

    // --- INFO FETCH ---
    socket.on('get_info', async (data) => {
        try {
            const out = await youtubedl(data.url, { dumpSingleJson: true, noWarnings: true });
            socket.emit('info_result', { title: out.title, url: data.url, duration: out.duration });
        } catch (e) { socket.emit('status_msg', "❌ Invalid Link"); }
    });

    socket.on('disconnect', () => {
        // Simple cleanup
    });
});

// === 🔥 MASTER CLOCK ENGINE 🔥 ===
// This runs regardless of who is connected. 
// It simulates the "Live Stream" progressing.
setInterval(() => {
    for (const id in rooms) {
        const room = rooms[id];
        if (room.status === 'playing' && room.videoFilename) {
            room.currentTime += 1;
            
            // Optional: Every 5 seconds, force sync via socket to correct drift
            if (Math.floor(room.currentTime) % 5 === 0) {
                 io.to(id).emit('clock_sync', { time: room.currentTime });
            }
        }
    }
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`API Server Active on ${PORT}`);
});
