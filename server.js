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

// Ensure download folder exists
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// === 1. VOICE SERVER SETUP (Self Hosted) ===
// یہ لائن بہت اہم ہے، اس سے آپ کا اپنا مفت وائس سرور چلے گا
const peerServer = PeerServer({ port: 9000, path: '/myapp' });
app.use('/peerjs', peerServer);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

// === 2. VIDEO STREAMING LOGIC ===
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

// === 3. MAIN SOCKET LOGIC ===
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

    // --- 🔥 VOICE CHAT FIX (یہ لائن پہلے مسنگ تھی) ---
    // جب ایک یوزر مائیک آن کرے گا، وہ اپنی ID بھیجے گا، سرور باقی سب کو وہ ID دے گا
    socket.on('voice_ready', (data) => {
        socket.to(data.roomId).emit('user_voice_joined', data.peerId);
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
            socket.emit('show_quality_menu', { title: output.title, url: url });
        } catch (err) {
            socket.emit('error_msg', "❌ Invalid Link or Blocked.");
        }
    });

    // --- DOWNLOAD ---
    socket.on('start_download', async (data) => {
        const { roomId, url, quality } = data;
        const room = rooms[roomId];
        if (room) {
            io.to(roomId).emit('processing_msg', `⬇️ Downloading @ ${quality}p...`);
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
                io.to(roomId).emit('download_complete', { filename });
                io.to(roomId).emit('update_room_data', room);
            } catch (e) {
                console.error(e);
                io.to(roomId).emit('error_msg', "Download Failed.");
            }
        }
    });

    // --- SYNC ---
    socket.on('video_action', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) {
            socket.to(data.roomId).emit('perform_action', data);
        }
    });

    socket.on('time_update', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) room.currentTime = data.time;
    });

    socket.on('disconnect', () => {
        // Cleanup logic if needed
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
