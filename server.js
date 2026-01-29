const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { ExpressPeerServer } = require('peer'); // ✅ Same Port Fix
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

// === 1. VOICE SERVER (ATTACHED TO HTTP SERVER) ===
// یہ اب الگ پورٹ پر نہیں، اسی 3000 پورٹ پر چلے گا تاکہ کنکشن فیل نہ ہو
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/myapp'
});
app.use('/peerjs', peerServer);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

// === 2. VIDEO STREAMING ===
app.get('/video/:filename', (req, res) => {
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

// === 3. ROOM LOGIC ===
let rooms = {};

io.on('connection', (socket) => {
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                admins: [socket.id], 
                users: [], 
                status: 'idle', 
                videoFilename: null, 
                currentTime: 0, 
                isPlaying: false,
                duration: 0 
            };
        }
        rooms[roomId].users.push(socket.id);
        
        // نئے بندے کو کرنٹ سرور ٹائم بھیجیں
        io.to(roomId).emit('update_room_data', rooms[roomId]);
        socket.emit('sync_immediate', { 
            time: rooms[roomId].currentTime, 
            isPlaying: rooms[roomId].isPlaying 
        });
    });

    // --- VOICE ID EXCHANGE ---
    socket.on('voice_ready', (data) => {
        socket.to(data.roomId).emit('user_voice_joined', data.peerId);
    });

    // --- ADMIN PROMOTION ---
    socket.on('promote_user', (data) => {
        const room = rooms[data.roomId];
        if(room && room.admins.includes(socket.id)) {
            if(!room.admins.includes(data.targetId)) {
                room.admins.push(data.targetId);
                io.to(data.roomId).emit('update_room_data', room);
            }
        }
    });

    // --- VIDEO INFO ---
    socket.on('get_video_info', async (data) => {
        const { roomId, url } = data;
        io.to(roomId).emit('processing_msg', "🔍 Fetching Formats...");
        try {
            const output = await youtubedl(url, {
                dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
                extractorArgs: "youtube:player_client=android",
            });
            socket.emit('show_quality_menu', { title: output.title, url: url, duration: output.duration });
        } catch (err) {
            socket.emit('error_msg', "❌ Link Error.");
        }
    });

    // --- START DOWNLOAD ---
    socket.on('start_download', async (data) => {
        const { roomId, url, quality, duration } = data;
        const room = rooms[roomId];
        if (room) {
            io.to(roomId).emit('processing_msg', `⬇️ Server Downloading...`);
            const filename = `${uuidv4()}.mp4`;
            const outputPath = path.join(DOWNLOAD_DIR, filename);
            let formatString = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;
            if (quality === 'audio') formatString = 'bestaudio/best';

            try {
                await youtubedl(url, {
                    output: outputPath, format: formatString, noCheckCertificates: true,
                    noWarnings: true, preferFreeFormats: true, forceIpv4: true,
                    extractorArgs: "youtube:player_client=android"
                });
                
                room.videoFilename = filename;
                room.status = 'ready';
                room.currentTime = 0;
                room.isPlaying = true; // Auto Play on Start
                room.duration = duration || 3600; // Default 1 hour if unknown
                
                io.to(roomId).emit('download_complete', { filename });
                io.to(roomId).emit('update_room_data', room);
            } catch (e) {
                console.error(e);
                io.to(roomId).emit('error_msg', "Download Failed.");
            }
        }
    });

    // --- ACTION HANDLERS ---
    socket.on('video_action', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) {
            if (data.type === 'play') room.isPlaying = true;
            if (data.type === 'pause') room.isPlaying = false;
            if (data.type === 'seek') room.currentTime = data.time;
            
            // Broadcast to everyone
            io.to(data.roomId).emit('perform_action', data);
        }
    });

    // Admin updates exact time (correction)
    socket.on('time_update', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) {
            room.currentTime = data.time; 
        }
    });

    socket.on('disconnect', () => {
        for (const r in rooms) {
            rooms[r].users = rooms[r].users.filter(u => u !== socket.id);
            io.to(r).emit('update_room_data', rooms[r]);
        }
    });
});

// === 🔥 THE LIVE STREAM ENGINE 🔥 ===
// یہ لوپ ہر سیکنڈ چلے گا اور ویڈیو کا ٹائم بڑھائے گا، چاہے براؤزر بند ہو
setInterval(() => {
    for (const roomId in rooms) {
        let room = rooms[roomId];
        // اگر پلے ہو رہا ہے اور ویڈیو موجود ہے
        if (room.status === 'ready' && room.isPlaying) {
            room.currentTime += 1; // 1 سیکنڈ آگے بڑھاؤ
        }
    }
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
