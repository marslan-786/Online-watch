const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { ExpressPeerServer } = require('peer');
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

// PeerJS Server (Same Port)
const peerServer = ExpressPeerServer(server, { debug: true, path: '/myapp' });
app.use('/peerjs', peerServer);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(DOWNLOAD_DIR));

// Video Streaming Route
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

// === ROOM LOGIC ===
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
                peerIds: [] // 🔥 Store Voice IDs
            };
        }
        rooms[roomId].users.push(socket.id);
        
        // نئے یوزر کو فوراً کرنٹ ٹائم پر بھیجیں
        socket.emit('sync_immediate', { 
            time: rooms[roomId].currentTime, 
            isPlaying: rooms[roomId].isPlaying,
            filename: rooms[roomId].videoFilename
        });

        // یوزر کو روم کا ڈیٹا بھیجیں
        io.to(roomId).emit('update_room_data', rooms[roomId]);
    });

    // --- 🔥 VOICE MESH NETWORK LOGIC ---
    socket.on('join_voice', (data) => {
        const room = rooms[data.roomId];
        if(room) {
            // 1. نئے یوزر کو پرانے لوگوں کی لسٹ بھیجیں تاکہ وہ سب کو کال کرے
            socket.emit('all_voice_users', room.peerIds);
            
            // 2. اس نئے یوزر کی ID لسٹ میں ڈالیں
            if(!room.peerIds.includes(data.peerId)) {
                room.peerIds.push(data.peerId);
            }

            // 3. دوسروں کو بتائیں کہ نیا بندہ آیا ہے (تاکہ وہ بھی کنیکٹ ہو سکیں)
            socket.to(data.roomId).emit('user_joined_voice', data.peerId);
        }
    });

    // --- VIDEO LOGIC ---
    socket.on('get_video_info', async (data) => {
        try {
            io.to(data.roomId).emit('processing_msg', "🔍 Checking URL...");
            const output = await youtubedl(data.url, {
                dumpSingleJson: true, noWarnings: true, noCheckCertificates: true,
                extractorArgs: "youtube:player_client=android",
            });
            socket.emit('show_quality_menu', { title: output.title, url: data.url });
        } catch (err) { socket.emit('error_msg', "Link Failed."); }
    });

    socket.on('start_download', async (data) => {
        const room = rooms[data.roomId];
        if (room) {
            io.to(data.roomId).emit('processing_msg', `⬇️ Server Downloading...`);
            const filename = `${uuidv4()}.mp4`;
            const outputPath = path.join(DOWNLOAD_DIR, filename);
            let formatString = `bestvideo[height<=${data.quality}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;
            if (data.quality === 'audio') formatString = 'bestaudio/best';

            try {
                await youtubedl(data.url, {
                    output: outputPath, format: formatString, noCheckCertificates: true,
                    noWarnings: true, preferFreeFormats: true, forceIpv4: true,
                    extractorArgs: "youtube:player_client=android"
                });
                
                room.videoFilename = filename;
                room.status = 'ready';
                room.currentTime = 0;
                room.isPlaying = true;
                
                io.to(data.roomId).emit('download_complete', { filename });
                io.to(data.roomId).emit('update_room_data', room);
            } catch (e) { io.to(data.roomId).emit('error_msg', "Download Failed."); }
        }
    });

    socket.on('time_update', (data) => {
        if(rooms[data.roomId]) rooms[data.roomId].currentTime = data.time;
    });

    socket.on('disconnect', () => {
        for (const r in rooms) {
            rooms[r].users = rooms[r].users.filter(u => u !== socket.id);
            // ریموو وائس ID اگر بندہ چلا جائے
            // (Client side handle करेगा PeerJS close event, Server only updates list)
            io.to(r).emit('update_room_data', rooms[r]);
        }
    });
});

// 🔥 SERVER CLOCK (Background Play)
setInterval(() => {
    for (const roomId in rooms) {
        let room = rooms[roomId];
        if (room.status === 'ready' && room.isPlaying) {
            room.currentTime += 1;
        }
    }
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
