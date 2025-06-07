const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins for development
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for active calls
const activeCalls = new Map(); // code -> { hostSocketId, hostProfile, joiners: [] }
const socketProfiles = new Map(); // socketId -> profile info

const PORT = process.env.PORT || 3002;

// Utility function to generate 5-digit call codes
function generateCallCode() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`📞 New connection: ${socket.id}`);

  // Handle client profile registration
  socket.on('register-profile', (data) => {
    console.log(`👤 Profile registered: ${data.profile} (${socket.id})`);
    socketProfiles.set(socket.id, {
      profile: data.profile,
      nativeLanguage: data.nativeLanguage,
      targetLanguage: data.targetLanguage
    });
  });

  // Handle hosting a new call
  socket.on('host-call', (data) => {
    const code = generateCallCode();
    const profileInfo = socketProfiles.get(socket.id);
    
    activeCalls.set(code, {
      hostSocketId: socket.id,
      hostProfile: profileInfo?.profile || 'Unknown',
      hostLanguages: {
        native: profileInfo?.nativeLanguage || 'English',
        target: profileInfo?.targetLanguage || 'Spanish'
      },
      joiners: [],
      createdAt: Date.now()
    });

    console.log(`🏠 Call hosted: ${code} by ${profileInfo?.profile || socket.id}`);
    socket.emit('call-hosted', { 
      code,
      hostProfile: profileInfo?.profile || 'Unknown'
    });
  });

  // Handle joining an existing call
  socket.on('join-call', (data) => {
    const callInfo = activeCalls.get(data.code);
    const joinerProfile = socketProfiles.get(socket.id);
    
    if (callInfo) {
      // Add joiner to the call
      callInfo.joiners.push({
        socketId: socket.id,
        profile: joinerProfile?.profile || 'Unknown',
        joinedAt: Date.now()
      });

      console.log(`🤝 ${joinerProfile?.profile || socket.id} joining call ${data.code}`);
      
      // Notify host about the joiner
      socket.to(callInfo.hostSocketId).emit('call-join-request', {
        joinerSocketId: socket.id,
        joinerProfile: joinerProfile?.profile || 'Unknown',
        callCode: data.code
      });

      // Notify joiner that call was found
      socket.emit('call-found', {
        hostSocketId: callInfo.hostSocketId,
        hostProfile: callInfo.hostProfile,
        callCode: data.code
      });
    } else {
      console.log(`❌ Call not found: ${data.code}`);
      socket.emit('call-not-found', { code: data.code });
    }
  });

  // WebRTC signaling - Forward offer from joiner to host
  socket.on('webrtc-offer', (data) => {
    console.log(`📡 Forwarding offer from ${socket.id} to ${data.targetSocketId}`);
    socket.to(data.targetSocketId).emit('webrtc-offer', {
      offer: data.offer,
      callerSocketId: socket.id
    });
  });

  // WebRTC signaling - Forward answer from host to joiner
  socket.on('webrtc-answer', (data) => {
    console.log(`📡 Forwarding answer from ${socket.id} to ${data.targetSocketId}`);
    socket.to(data.targetSocketId).emit('webrtc-answer', {
      answer: data.answer,
      answererSocketId: socket.id
    });
  });

  // WebRTC signaling - Forward ICE candidates
  socket.on('webrtc-ice-candidate', (data) => {
    console.log(`🧊 Forwarding ICE candidate from ${socket.id} to ${data.targetSocketId}`);
    socket.to(data.targetSocketId).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      senderSocketId: socket.id
    });
  });

  // Handle call termination
  socket.on('end-call', (data) => {
    const profileInfo = socketProfiles.get(socket.id);
    console.log(`📞 Call ended by ${profileInfo?.profile || socket.id}`);
    
    // Find and clean up the call
    for (const [code, callInfo] of activeCalls.entries()) {
      if (callInfo.hostSocketId === socket.id) {
        // Host ended the call - notify all joiners
        callInfo.joiners.forEach(joiner => {
          socket.to(joiner.socketId).emit('call-ended', {
            reason: 'Host ended the call',
            endedBy: callInfo.hostProfile
          });
        });
        activeCalls.delete(code);
        console.log(`🗑️ Call ${code} deleted (host left)`);
        break;
      } else {
        // Check if joiner left
        const joinerIndex = callInfo.joiners.findIndex(j => j.socketId === socket.id);
        if (joinerIndex >= 0) {
          const joiner = callInfo.joiners[joinerIndex];
          callInfo.joiners.splice(joinerIndex, 1);
          
          // Notify host that joiner left
          socket.to(callInfo.hostSocketId).emit('joiner-left', {
            joinerProfile: joiner.profile,
            callCode: code
          });
          console.log(`👋 ${joiner.profile} left call ${code}`);
          break;
        }
      }
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const profileInfo = socketProfiles.get(socket.id);
    console.log(`❌ Disconnected: ${profileInfo?.profile || socket.id} (${socket.id})`);
    
    // Clean up calls and notify participants
    for (const [code, callInfo] of activeCalls.entries()) {
      if (callInfo.hostSocketId === socket.id) {
        // Host disconnected - end the call
        callInfo.joiners.forEach(joiner => {
          socket.to(joiner.socketId).emit('call-ended', {
            reason: 'Host disconnected',
            endedBy: callInfo.hostProfile
          });
        });
        activeCalls.delete(code);
        console.log(`🗑️ Call ${code} deleted (host disconnected)`);
      } else {
        // Check if joiner disconnected
        const joinerIndex = callInfo.joiners.findIndex(j => j.socketId === socket.id);
        if (joinerIndex >= 0) {
          const joiner = callInfo.joiners[joinerIndex];
          callInfo.joiners.splice(joinerIndex, 1);
          
          // Notify host
          socket.to(callInfo.hostSocketId).emit('joiner-left', {
            joinerProfile: joiner.profile,
            callCode: code
          });
          console.log(`👋 ${joiner.profile} disconnected from call ${code}`);
        }
      }
    }
    
    // Clean up profile info
    socketProfiles.delete(socket.id);
  });
});

// REST API endpoints for debugging/monitoring
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    activeCalls: activeCalls.size,
    connectedClients: socketProfiles.size
  });
});

app.get('/active-calls', (req, res) => {
  const calls = Array.from(activeCalls.entries()).map(([code, info]) => ({
    code,
    host: info.hostProfile,
    joiners: info.joiners.length,
    createdAt: new Date(info.createdAt).toISOString()
  }));
  
  res.json({ activeCalls: calls });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Polycast Signaling Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📞 Active calls: http://localhost:${PORT}/active-calls`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down signaling server...');
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
}); 