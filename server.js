const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// Startup Check
console.log("🛠️ SERVER STARTING...");
exec('yt-dlp --version', (err, stdout) => {
    if(err) console.error("❌ yt-dlp ERROR: Not found! Check Dockerfile.");
    else console.log(`✅ yt-dlp Verified: ${stdout.trim()}`);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

let rooms = {};

// === API CONTROL (No Admin Check) ===
app.post('/api/room/:roomId/control', (req, res) => {
    const { roomId } = req.params;
    const { action, time } = req.body;
    
    // Auto-create if missing (Crash Proof)
    if(!rooms[roomId]) {
        rooms[roomId] = { videoFilename: null, currentTime: time || 0, isPlaying: false, status: 'idle' };
    }
    const room = rooms[roomId];

    // 🔥 ہر کوئی کنٹرول کر سکتا ہے
    if (action === 'play') { 
        room.isPlaying = true; 
        room.status = 'playing'; // Ensure status matches
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

    res.json({ success: true });
});

// === SOCKET LOGIC ===
io.on('connection', (socket) => {
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { videoFilename: null, currentTime: 0, isPlaying: false, status: 'idle' };
            console.log(`[NEW ROOM] ${roomId}`);
        }
        
        const room = rooms[roomId];
        
        // 🔥 INJECTION: جیسے ہی بندہ آئے، اسے بتاؤ ویڈیو کہاں ہے اور کیا کر رہی ہے
        socket.emit('inject_state', {
            time: room.currentTime,
            isPlaying: room.isPlaying, // اگر یہ True ہے تو فرنٹ اینڈ فوراً پلے کرے گا
            filename: room.videoFilename
        });
    });

    socket.on('audio_stream', (data) => socket.to(data.roomId).emit('global_voice', data.audioChunk));

    // --- 🔍 SMART INFO FETCH ---
    socket.on('get_info', (data) => {
        console.log(`[CHECK URL] ${data.url}`);
        
        // 1. اگر YouTube ہے تو مینیو دکھاؤ
        if (data.url.includes('youtube.com') || data.url.includes('youtu.be')) {
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
                        socket.emit('info_result', { title: info.title, url: data.url, type: 'youtube' });
                    } catch(e) { socket.emit('status_msg', "❌ Parse Error"); }
                } else socket.emit('status_msg', "❌ Link Failed");
            });
        } 
        // 2. اگر ڈائریکٹ لنک یا کوئی اور سائٹ ہے تو آٹو ڈاؤن لوڈ کرو
        else {
            console.log("⚡ Direct/Other Link Detected. Skipping Menu...");
            // خود ہی 'start_download' کو ٹریگر کر دو (Best Quality پر)
            // ہم ساکٹ کے ذریعے کلائنٹ کو بتاتے ہیں کہ ڈاؤنلوڈ شروع کرو
            socket.emit('auto_download_start', { url: data.url, quality: 'best' });
        }
    });

    // --- ⬇️ DOWNLOAD ---
    socket.on('start_download', (data) => {
        // روم ریکوری
        if(!rooms[data.roomId]) {
            rooms[data.roomId] = { videoFilename: null, currentTime: 0, isPlaying: false, status: 'idle' };
            socket.join(data.roomId);
        }
        const room = rooms[data.roomId];

        const filename = `${uuidv4()}.mp4`;
        const outputPath = path.join(DOWNLOAD_DIR, filename);
        
        // Quality Logic
        let format = 'best'; // Default for Direct Links
        if (data.quality !== 'best' && data.quality !== 'audio') {
            format = `bestvideo[height<=${data.quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${data.quality}][ext=mp4]/best`;
        } else if (data.quality === 'audio') {
            format = 'bestaudio/best';
        }

        console.log(`🚀 [DL START] ${data.url} | Q: ${data.quality}`);

        const yt = spawn('yt-dlp', [
            data.url, '-f', format, '-o', outputPath,
            '--force-ipv4', '--newline', '--verbose', '--no-colors',
            '--extractor-args', 'youtube:player_client=android'
        ]);

        yt.stdout.on('data', (chunk) => {
            const line = chunk.toString();
            const match = line.match(/(\d{1,3}(\.\d+)?)%/);
            if (match && match[1]) {
                io.to(data.roomId).emit('download_progress', { percent: parseFloat(match[1]) });
            }
        });

        yt.stderr.on('data', c => console.error(`[YT] ${c}`));

        yt.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ [DONE] ${filename}`);
                room.videoFilename = filename;
                room.currentTime = 0;
                room.isPlaying = true; // Auto Play
                room.status = 'playing'; // Server starts counting
                io.to(data.roomId).emit('download_complete', { filename });
            } else {
                io.to(data.roomId).emit('status_msg', "❌ Download Failed");
            }
        });
    });
});

// 🔥 SERVER LIVE CLOCK (BACKGROUND PLAY ENGINE)
setInterval(() => {
    for (const id in rooms) {
        const r = rooms[id];
        // اگر روم کا سٹیٹس 'playing' ہے تو وقت بڑھتا رہے گا
        // چاہے کوئی کنیکٹ ہو یا نہ ہو
        if (r.status === 'playing' && r.videoFilename) {
            r.currentTime += 1;
            
            // ہر 5 سیکنڈ بعد سب کو زبردستی ٹائم بتاؤ تاکہ کوئی پیچھے نہ رہے
            if (Math.floor(r.currentTime) % 5 === 0) {
                 io.to(id).emit('clock_sync', { time: r.currentTime });
            }
        }
    }
}, 1000);

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 API Server on ${PORT}`));
