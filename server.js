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
console.log("🛠️ STARTING SERVER WITH FULL DEBUG LOGGING...");
exec('yt-dlp --version', (err, stdout) => {
    if(err) console.error("❌ yt-dlp CRITICAL ERROR: Not Found!");
    else console.log(`✅ yt-dlp Binary Found: ${stdout.trim()}`);
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
        console.log(`[INFO REQ] URL: ${data.url}`);
        
        // Using spawn here too for logs
        const yt = spawn('yt-dlp', [
            data.url, '--dump-single-json', 
            '--no-warnings', '--force-ipv4', 
            '--extractor-args', 'youtube:player_client=android'
        ]);

        let rawData = '';
        yt.stdout.on('data', c => rawData += c);
        yt.stderr.on('data', c => console.log(`[YT-INFO STDERR]: ${c.toString()}`)); // Print stderr

        yt.on('close', c => {
            if(c===0) {
                try {
                    const info = JSON.parse(rawData);
                    console.log(`[INFO OK] Title: ${info.title}`);
                    socket.emit('info_result', { title: info.title, url: data.url });
                } catch(e) { 
                    console.error("[JSON PARSE FAIL]", e);
                    socket.emit('status_msg', "❌ JSON Parse Error"); 
                }
            } else {
                console.error(`[INFO FAIL] Exit Code: ${c}`);
                socket.emit('status_msg', "❌ Link Failed");
            }
        });
    });

    // --- 🔥 RAW DEBUG DOWNLOAD ---
    socket.on('start_download', (data) => {
        const room = rooms[data.roomId];
        if(!room) return;

        const filename = `${uuidv4()}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);
        
        let format = `bestvideo[height<=${data.quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${data.quality}][ext=mp4]/best`;
        if (data.quality === 'audio') format = 'bestaudio/best';

        console.log(`🚀 [LAUNCHING YT-DLP]`);
        console.log(`   URL: ${data.url}`);
        console.log(`   Quality: ${data.quality}`);
        console.log(`   Output: ${outputPath}`);

        const yt = spawn('yt-dlp', [
            data.url,
            '-f', format,
            '-o', outputPath,
            '--force-ipv4',
            '--newline',     // Line breaks enable
            '--verbose',     // 🔥 PRINT EVERYTHING (Request/Response headers etc)
            '--no-colors',   // Colors remove for clean logs
            '--extractor-args', 'youtube:player_client=android'
        ]);

        // 🔥 RAW STDOUT PRINTER
        yt.stdout.on('data', (chunk) => {
            const line = chunk.toString().trim();
            
            // 1. PRINT RAW LOG TO SERVER CONSOLE
            if(line) console.log(`[YT STDOUT] ${line}`);

            // 2. PARSE PROGRESS FOR UI (Still needed for frontend)
            // Regex for: "[download]  45.5% of 100MiB at 5.00MiB/s ETA 00:05"
            const match = line.match(/(\d{1,3}(\.\d+)?)%/);
            if (match && match[1]) {
                const percent = parseFloat(match[1]);
                io.to(data.roomId).emit('download_progress', { percent });
            }
        });

        // 🔥 RAW STDERR PRINTER (Errors/Warnings/Debug Info)
        yt.stderr.on('data', (chunk) => {
            const line = chunk.toString().trim();
            if(line) console.error(`[YT STDERR] ${line}`);
        });

        yt.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ [DOWNLOAD FINISHED] File: ${filename}`);
                room.videoFilename = filename;
                room.currentTime = 0;
                room.isPlaying = true;
                room.status = 'playing';
                io.to(data.roomId).emit('download_complete', { filename });
            } else {
                console.error(`❌ [DOWNLOAD CRASHED] Exit Code: ${code}`);
                io.to(data.roomId).emit('status_msg', `❌ Download Failed (Code ${code})`);
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

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 DEBUG SERVER READY ON ${PORT}`));
