# Polycast AI Signaling Server

WebRTC signaling server for video calling between Polycast AI clients.

## Setup Instructions

### 1. Install Node.js
Make sure you have Node.js installed (version 16 or higher):
```bash
node --version
npm --version
```

If you don't have Node.js installed, download it from: https://nodejs.org/

### 2. Install Dependencies
Navigate to this directory and install the required packages:
```bash
cd signaling-server
npm install
```

### 3. Start the Server
```bash
# Development mode (auto-restart on changes)
npm run dev

# Production mode
npm start
```

The server will start on port 3002 by default.

## Features

- **Call Management**: 5-digit numerical call codes
- **Profile Tracking**: Links calls to Polycast profiles
- **WebRTC Signaling**: Handles offer/answer/ICE candidates
- **Multi-client Support**: Multiple joiners per call
- **Automatic Cleanup**: Handles disconnections gracefully

## API Endpoints

- `GET /health` - Server health check
- `GET /active-calls` - List of current active calls

## Socket.IO Events

### Client → Server
- `register-profile` - Register client profile info
- `host-call` - Create a new call and get a code
- `join-call` - Join an existing call with a code
- `webrtc-offer` - Send WebRTC offer
- `webrtc-answer` - Send WebRTC answer
- `webrtc-ice-candidate` - Send ICE candidate
- `end-call` - End the current call

### Server → Client
- `call-hosted` - Call successfully created
- `call-found` - Successfully found call to join
- `call-not-found` - Invalid call code
- `call-join-request` - Someone wants to join your call
- `webrtc-offer` - Received WebRTC offer
- `webrtc-answer` - Received WebRTC answer
- `webrtc-ice-candidate` - Received ICE candidate
- `call-ended` - Call was terminated
- `joiner-left` - Someone left your call

## Network Setup

For cross-device usage:
1. Find your computer's local IP address
2. Update the client code to connect to `http://YOUR_IP:3002`
3. Make sure both devices are on the same network

Example:
```javascript
const socket = io('http://192.168.1.100:3002');
``` 