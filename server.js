const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
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

// Startup Check
exec('yt-dlp --version', (err, stdout) => {
    if(err) console.error("❌ yt-dlp Missing! Update Dockerfile.");
    else console.log(`✅ yt-dlp Verified: ${stdout.trim()}`);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

let rooms = {};

// === API CONTROL ===
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

// === SOCKET ===
io.on('connection', (socket) => {
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) rooms[roomId] = { admins: [socket.id], users: [], videoFilename: null, currentTime: 0, isPlaying: false, status: 'idle' };
        else if(!rooms[roomId].users.includes(socket.id)) rooms[roomId].users.push(socket.id);
        
        const room = rooms[roomId];
        socket.emit('inject_state', {
            time: room.currentTime,
            isPlaying: room.isPlaying,
            filename: room.videoFilename,
            isAdmin: room.admins.includes(socket.id)
        });
    });

    socket.on('audio_stream', (data) => socket.to(data.roomId).emit('global_voice', data.audioChunk));

    // --- INFO FETCH ---
    socket.on('get_info', (data) => {
        console.log(`[INFO] Checking: ${data.url}`);
        const yt = spawn('yt-dlp', [
            data.url, '--dump-single-json', '--no-warnings', '--force-ipv4', 
            '--extractor-args', 'youtube:player_client=android'
        ]);
        let rawData = '';
        yt.stdout.on('data', c => rawData += c);
        yt.on('close', c => {
            if(c===0) {
                try {
                    const info = JSON.parse(rawData);
                    console.log(`[INFO OK] ${info.title}`);
                    socket.emit('info_result', { title: info.title, url: data.url });
                } catch(e) { socket.emit('status_msg', "❌ Parse Error"); }
            } else socket.emit('status_msg', "❌ Link Failed");
        });
    });

    // --- 🔥 ROBUST DOWNLOAD LOGIC ---
    socket.on('start_download', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;

        const filename = `${uuidv4()}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);
        
        // Format String
        let format = `bestvideo[height<=${data.quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${data.quality}][ext=mp4]/best`;
        if (data.quality === 'audio') format = 'bestaudio/best';

        console.log(`[DL START] ${data.url} [${data.quality}p]`);

        const yt = spawn('yt-dlp', [
            data.url,
            '-f', format,
            '-o', outputPath,
            '--force-ipv4',
            '--newline',     // ہر اپڈیٹ نئی لائن پر
            '--no-colors',   // رنگ ختم کریں تاکہ Regex آسانی سے پڑھے
            '--no-warnings',
            '--extractor-args', 'youtube:player_client=android'
        ]);

        yt.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            
            // 🔥 DEBUG LOG (تاکہ ریلوے کنسول میں نظر آئے)
            console.log(`[YT RAW] ${text.trim()}`);

            // Split lines to handle fast buffering
            const lines = text.split('\n');
            for (const line of lines) {
                // Regex: Matches "45%" or "45.5%"
                const match = line.match(/(\d+(\.\d+)?)%/);
                if (match && match[1]) {
                    const percent = parseFloat(match[1]);
                    // صرف تب بھیجیں جب فیصد تبدیل ہو تاکہ ساکٹ سپیم نہ ہو
                    io.to(data.roomId).emit('download_progress', { percent });
                }
            }
        });

        yt.stderr.on('data', c => console.error(`[YT ERR] ${c}`));

        yt.on('close', (code) => {
            if (code === 0) {
                console.log(`[DL DONE] ${filename}`);
                room.videoFilename = filename;
                room.currentTime = 0;
                room.isPlaying = true;
                room.status = 'playing';
                io.to(data.roomId).emit('download_complete', { filename });
            } else {
                console.error(`[DL FAIL] Exit Code: ${code}`);
                io.to(data.roomId).emit('status_msg', "❌ Download Failed");
            }
        });
    });
});

setInterval(() => {
    for (const id in rooms) {
        const r = rooms[id];
        if (r.status === 'playing' && r.videoFilename) {
            r.currentTime += 1;
            if (Math.floor(r.currentTime) % 5 === 0) io.to(id).emit('clock_sync', { time: r.currentTime });
        }
    }
}, 1000);

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 API Server on ${PORT}`));
