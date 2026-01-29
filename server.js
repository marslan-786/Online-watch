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

// === CONFIGURATION ===
const PORT = process.env.PORT || 3000;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Ensure download folder exists
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// === 1. VOICE CHAT SERVER (PeerJS) ===
// یہ ریلوے کے اسی پورٹ پر ایک الگ پاتھ '/peerjs' پر چلے گا
const peerServer = PeerServer({ port: 9000, path: '/myapp' });
app.use('/peerjs', peerServer);

// === 2. STATIC FILES ===
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR)); // Direct access just in case

// === 3. VIDEO STREAMING ENDPOINT (Advanced Range Requests) ===
app.get('/video/:filename', (req, res) => {
    const filePath = path.join(DOWNLOAD_DIR, req.params.filename);
    
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        // Resume download / Seek capability
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
        // First load
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
});

// === 4. WATCH PARTY LOGIC ===
let rooms = {};

io.on('connection', (socket) => {
    
    // Join Room
    socket.on('join_room', (roomId) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = { 
                admins: [socket.id],
                users: [],
                status: 'idle', // idle, downloading, ready
                videoFilename: null,
                currentTime: 0,
                isPlaying: false
            };
        }
        rooms[roomId].users.push(socket.id);
        
        // Send Full State
        io.to(roomId).emit('update_room_data', rooms[roomId]);
    });

    // START DOWNLOAD (Admin Only)
    socket.on('start_download', async (data) => {
        const { roomId, url } = data;
        const room = rooms[roomId];

        if (room && room.admins.includes(socket.id)) {
            room.status = 'downloading';
            io.to(roomId).emit('download_progress', { percent: 0, status: 'Starting...' });
            io.to(roomId).emit('update_room_data', room);

            const filename = `${uuidv4()}.mp4`;
            const outputPath = path.join(DOWNLOAD_DIR, filename);

            console.log(`Downloading: ${url} -> ${filename}`);

            try {
                // High Quality Download using Server CPU
                await youtubedl(url, {
                    output: outputPath,
                    format: 'best[ext=mp4]', // Force MP4 for best compatibility
                    noCheckCertificates: true,
                    noWarnings: true,
                    preferFreeFormats: true,
                    addHeader: ['referer:youtube.com', 'user-agent:googlebot']
                });

                // Download Complete
                room.status = 'ready';
                room.videoFilename = filename;
                io.to(roomId).emit('download_complete', { filename: filename });
                io.to(roomId).emit('update_room_data', room);

            } catch (error) {
                console.error("Download Failed:", error);
                room.status = 'idle';
                io.to(roomId).emit('error_msg', "Download failed! Check server logs.");
                io.to(roomId).emit('update_room_data', room);
            }
        }
    });

    // SYNC CONTROLS
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
    
    // ADMIN PROMOTE
    socket.on('promote_user', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) {
            if (!room.admins.includes(data.targetUserId)) {
                room.admins.push(data.targetUserId);
                io.to(data.roomId).emit('update_room_data', room);
            }
        }
    });

    // Voice ID Exchange
    socket.on('join_voice', (data) => {
        socket.to(data.roomId).emit('user_joined_voice', data.peerId);
    });

    socket.on('disconnect', () => {
        for (const rId in rooms) {
            let r = rooms[rId];
            r.users = r.users.filter(id => id !== socket.id);
            r.admins = r.admins.filter(id => id !== socket.id);
            io.to(rId).emit('update_room_data', r);
            if(r.users.length === 0) {
                // Optional: Delete video file to save space when room is empty
                if(r.videoFilename) {
                    try { fs.unlinkSync(path.join(DOWNLOAD_DIR, r.videoFilename)); } catch(e){}
                }
                delete rooms[rId];
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
