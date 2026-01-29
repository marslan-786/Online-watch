const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Railway Port Configuration
const PORT = process.env.PORT || 3000;

// Public folder ko serve karo
app.use(express.static(path.join(__dirname, 'public')));

// Rooms Data Storage
// Structure: { roomId: { admins: ['socketId1', 'socketId2'], users: [], ... } }
let rooms = {};

io.on('connection', (socket) => {
    
    // Join Room
    socket.on('join_room', (roomId) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            // Room nahi hai to banao, pehla banda Admin hoga
            rooms[roomId] = { 
                admins: [socket.id], // Array for multiple admins
                users: [],
                currentTime: 0,
                isPlaying: false,
                videoUrl: null,
                videoType: 'direct'
            };
        }

        // User list mein add karo
        rooms[roomId].users.push(socket.id);
        
        // Naye banday ko current video state bhejo
        const room = rooms[roomId];
        socket.emit('sync_initial', {
            time: room.currentTime,
            isPlaying: room.isPlaying,
            videoUrl: room.videoUrl,
            videoType: room.videoType
        });

        // Sabko user list update bhejo
        io.to(roomId).emit('update_room_data', room);
    });

    // Admin promotes another user
    socket.on('promote_user', (data) => {
        const { roomId, targetUserId } = data;
        const room = rooms[roomId];

        // Check: Kya request bhejne wala khud Admin hai?
        if (room && room.admins.includes(socket.id)) {
            // Check: Kya target banda pehle se admin to nahi?
            if (!room.admins.includes(targetUserId)) {
                room.admins.push(targetUserId); // Naye banday ko bhi admin list mein daal do
                io.to(roomId).emit('update_room_data', room); // Sabko bata do
                io.to(roomId).emit('notification', `User updated to Admin!`);
            }
        }
    });

    // Video Controls (Only Admins)
    socket.on('video_action', (data) => {
        const room = rooms[data.roomId];
        // Security Check: Kya action lenay wala admin list mein hai?
        if (room && room.admins.includes(socket.id)) {
            
            if (data.type === 'play') room.isPlaying = true;
            if (data.type === 'pause') room.isPlaying = false;
            if (data.type === 'seek') room.currentTime = data.time;
            if (data.type === 'change') {
                room.videoUrl = data.url;
                room.videoType = data.videoType;
            }

            // Sabko sync karo (sender ke ilawa, taake loop na banay)
            socket.to(data.roomId).emit('perform_action', data);
        }
    });

    // Sync Timer (Har waqt time save karo taake koi naya aye to wo wahi se shuru kare)
    socket.on('time_update', (data) => {
        const room = rooms[data.roomId];
        if (room && room.admins.includes(socket.id)) {
            room.currentTime = data.time;
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            let room = rooms[roomId];
            // Remove user from list
            room.users = room.users.filter(id => id !== socket.id);
            // Remove from admin list if present
            room.admins = room.admins.filter(id => id !== socket.id);

            // Agar room khali ho gaya to delete kar do memory bachane k liye
            if (room.users.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('update_room_data', room);
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
