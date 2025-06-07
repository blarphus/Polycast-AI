// Example backend endpoint for Whisper transcription
// This would go in your backend server (Express, Next.js API route, etc.)

// If using Express:
/*
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' });

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const audioFile = req.file;
    const language = req.body.language || 'en';
    
    // Create form data for OpenAI Whisper API
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioFile.path));
    formData.append('model', 'whisper-1');
    formData.append('language', language);
    
    // Call OpenAI Whisper API
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders()
        }
      }
    );
    
    // Clean up uploaded file
    fs.unlinkSync(audioFile.path);
    
    // Return transcription
    res.json({ text: response.data.text });
    
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: 'Transcription failed' });
  }
});
*/

// If using Next.js API Routes:
/*
import { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable();
  
  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: 'Form parsing failed' });
    }

    try {
      const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
      const language = Array.isArray(fields.language) ? fields.language[0] : fields.language || 'en';

      // Create form data for OpenAI
      const formData = new FormData();
      formData.append('file', fs.createReadStream(audioFile.filepath));
      formData.append('model', 'whisper-1');
      formData.append('language', language);

      // Call OpenAI Whisper API
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData as any,
      });

      const data = await response.json();
      
      // Clean up
      fs.unlinkSync(audioFile.filepath);

      res.status(200).json({ text: data.text });
    } catch (error) {
      console.error('Transcription error:', error);
      res.status(500).json({ error: 'Transcription failed' });
    }
  });
}
*/

// For development/testing, you can use a mock endpoint:
export async function mockTranscribeEndpoint(audioBlob: Blob): Promise<{ text: string }> {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Return mock transcription
  const mockResponses = [
    "Hello, this is a test transcription",
    "The quick brown fox jumps over the lazy dog",
    "Testing the video mode transcription",
    "This is working great!",
  ];
  
  const randomResponse = mockResponses[Math.floor(Math.random() * mockResponses.length)];
  
  return { text: randomResponse };
} 