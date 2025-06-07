/**
 * Simple proxy server for OpenAI Realtime API
 * This allows us to add the required beta headers that can't be added directly in browser WebSocket connections
 */
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import OpenAI from 'openai';
import multer from 'multer';
import fs from 'fs';

// Load environment variables from .env.local
dotenv.config({ path: '.env.local' });

// Verify API key is loaded
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY not found in .env.local file');
    process.exit(1);
} else {
    console.log('✓ OpenAI API key loaded successfully');
    console.log('API key starts with:', apiKey.substring(0, 10) + '...');
}

// Setup __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;

// Create Express app
const app = express();

// Configure middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static('public'));

// Add file upload handling for Whisper transcription
const upload = multer({ 
    dest: 'uploads/',
    limits: {
        fileSize: 25 * 1024 * 1024 // 25MB limit for Whisper API
    }
});

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Add Whisper transcription endpoint
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    try {
        console.log('📤 Received transcription request');
        const audioFile = req.file;
        const language = req.body.language; // Don't default to 'en' anymore
        
        if (!audioFile) {
            return res.status(400).json({ error: 'No audio file provided' });
        }
        
        console.log(`🎵 Processing audio file: ${audioFile.originalname}, size: ${audioFile.size} bytes`);
        console.log(`📋 File details - mimetype: ${audioFile.mimetype}, encoding: ${audioFile.encoding}`);
        
        // Create OpenAI client
        const openai = new OpenAI({ apiKey });
        
        // Transcribe using OpenAI client
        if (language) {
            console.log(`🚀 Sending to OpenAI Whisper API with language: ${language}`);
        } else {
            console.log(`🚀 Sending to OpenAI Whisper API with automatic language detection`);
        }
        
        // Ensure the file has the correct WebM extension for OpenAI
        const originalPath = audioFile.path;
        const webmPath = originalPath + '.webm';
        
        // Rename the file to have .webm extension
        fs.renameSync(originalPath, webmPath);
        
        const transcriptionParams = {
            file: fs.createReadStream(webmPath),
            model: "whisper-1",
            temperature: 0.1, // Slightly higher than 0 but still conservative to reduce hallucinations
            response_format: "verbose_json", // Get detailed response including probabilities
            condition_on_previous_text: false // Prevent carrying over context that might cause hallucinations
        };
        
        // Only add language if specified, otherwise let Whisper auto-detect
        if (language) {
            transcriptionParams.language = language;
        }
        
        const transcription = await openai.audio.transcriptions.create(transcriptionParams);
        
        console.log('📊 Transcription details:');
        console.log(`  Text: "${transcription.text}"`);
        console.log(`  Language: ${transcription.language || 'auto-detected'}`);
        
        // Filter out likely hallucinations using probability thresholds
        let finalText = transcription.text;
        let isFiltered = false;
        
        if (transcription.segments) {
            console.log(`  Segments: ${transcription.segments.length}`);
            
            // Check each segment for hallucination indicators
            const filteredSegments = transcription.segments.filter(segment => {
                const noSpeechProb = segment.no_speech_prob || 0;
                const avgLogProb = segment.avg_logprob || 0;
                
                console.log(`    Segment: "${segment.text}" | no_speech_prob: ${noSpeechProb.toFixed(3)} | avg_logprob: ${avgLogProb.toFixed(3)}`);
                
                // Filter out segments with high no_speech_prob or very low avg_logprob
                if (noSpeechProb > 0.6) {
                    console.log(`    ❌ Filtered segment (high no_speech_prob: ${noSpeechProb.toFixed(3)}): "${segment.text}"`);
                    return false;
                }
                
                if (avgLogProb < -1.0) {
                    console.log(`    ❌ Filtered segment (low avg_logprob: ${avgLogProb.toFixed(3)}): "${segment.text}"`);
                    return false;
                }
                
                // Also filter common hallucination phrases
                const text = segment.text.toLowerCase().trim();
                const commonHallucinations = [
                    'thank you for watching',
                    'thanks for watching',
                    'subscribe to my channel',
                    'like and subscribe',
                    'please subscribe',
                    'don\'t forget to subscribe',
                    '감사합니다', // Korean "thank you"
                    'ありがとうございます', // Japanese "thank you"
                    '謝謝', // Chinese "thank you"
                ];
                
                if (commonHallucinations.some(phrase => text.includes(phrase))) {
                    console.log(`    ❌ Filtered common hallucination: "${segment.text}"`);
                    return false;
                }
                
                return true;
            });
            
            // If we filtered out segments, reconstruct the text
            if (filteredSegments.length !== transcription.segments.length) {
                finalText = filteredSegments.map(seg => seg.text).join('').trim();
                isFiltered = true;
                console.log(`  🧹 Filtered ${transcription.segments.length - filteredSegments.length} segments`);
                console.log(`  Final text: "${finalText}"`);
            }
        }
        
        // If the final text is empty or too short after filtering, consider it noise
        if (!finalText || finalText.trim().length < 3) {
            console.log('  🔇 Final text too short after filtering, treating as noise');
            finalText = '';
        }
        
        console.log(`✅ Transcription ${isFiltered ? '(filtered)' : '(unfiltered)'}: "${finalText}"`);
        
        // Clean up uploaded file (with new name)
        fs.unlinkSync(webmPath);
        
        // Return transcription
        res.json({ text: finalText });
        
    } catch (error) {
        console.error('❌ Transcription error:', error);
        
        // Clean up file if it exists (try both original and renamed)
        if (req.file && req.file.path) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (cleanupError) {
                // File might have been renamed, try the webm version
                try {
                    fs.unlinkSync(req.file.path + '.webm');
                } catch (cleanupError2) {
                    console.error('Error cleaning up files:', cleanupError, cleanupError2);
                }
            }
        }
        
        res.status(500).json({ 
            error: 'Transcription failed', 
            details: error.message 
        });
    }
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('Client connected');
    
    // Create connection to OpenAI
    // Note: Node.js WebSocket allows headers directly, unlike browser WebSocket
    const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01`, {
        headers: {
            'openai-beta': 'realtime=v1',
            'Authorization': `Bearer ${apiKey}`
        }
    });
    
    console.log('Attempting to connect to OpenAI...');

    // Handle messages from client
    ws.on('message', (message) => {
        if (openaiWs.readyState === WebSocket.OPEN) {
            // Convert Buffer to string if necessary before sending to OpenAI
            const messageStr = Buffer.isBuffer(message) ? message.toString('utf8') : message;
            console.log('Forwarding message to OpenAI:', typeof messageStr);
            openaiWs.send(messageStr);
        }
    });

    // Add connection event handlers for OpenAI WebSocket
    openaiWs.on('open', () => {
        console.log('Successfully connected to OpenAI Realtime API');
    });

    // Handle messages from OpenAI
    openaiWs.on('message', (message) => {
        console.log('Received message from OpenAI, type:', typeof message, 'isBuffer:', Buffer.isBuffer(message), 'length:', message.length);
        
        if (ws.readyState === WebSocket.OPEN) {
            // Ensure we're sending text, not binary data
            if (Buffer.isBuffer(message)) {
                // Convert Buffer to string
                const messageStr = message.toString('utf8');
                console.log('Converting buffer to string, first 100 chars:', messageStr.substring(0, 100));
                ws.send(messageStr);
            } else {
                // Already a string
                console.log('Sending string message, first 100 chars:', message.substring(0, 100));
                ws.send(message);
            }
        }
    });

    // Handle close events
    ws.on('close', (code, reason) => {
        console.log(`Client connection closed: ${code} - ${reason}`);
        if (openaiWs.readyState === WebSocket.OPEN || 
            openaiWs.readyState === WebSocket.CONNECTING) {
            openaiWs.close();
        }
    });

    openaiWs.on('close', (code, reason) => {
        console.log(`OpenAI connection closed: ${code} - ${reason}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(code, 'OpenAI connection closed: ' + reason);
        }
    });

    // Handle errors
    openaiWs.on('error', (error) => {
        console.error('OpenAI WebSocket error:', error);
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Error in OpenAI connection');
        }
    });

    ws.on('error', (error) => {
        console.error('Client WebSocket error:', error);
        if (openaiWs.readyState === WebSocket.OPEN || 
            openaiWs.readyState === WebSocket.CONNECTING) {
            openaiWs.close(1011, 'Error in client connection');
        }
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
