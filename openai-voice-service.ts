/**
 * OpenAI Realtime Voice Service - Python-Style Push-to-Talk
 * Based exactly on the working Python patterns
 */

export interface VoiceSessionConfig {
  voice: string;
  instructions: string;
  inputAudioFormat: string;
  outputAudioFormat: string;
}

interface VoiceMessage {
  type: string;
  event_id?: string;
  session?: any;
  item?: any;
  delta?: any;
  transcript?: string;
  audio?: string;
  error?: any;
}

export class OpenAIVoiceSession {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioProcessor: ScriptProcessorNode | AudioWorkletNode | null = null;
  private isRecording = false;  // Like spacebar_pressed in Python
  private isAIResponding = false;
  private lastAudioSendTime = 0;
  private audioBuffer: ArrayBuffer[] = []; // Accumulate audio chunks
  private responseTimeout: NodeJS.Timeout | null = null;
  private responseStartTime: number = 0;
  private justInterrupted: boolean = false; // Flag to prevent immediate response after interrupt
  private ignoreAudioUntil: number = 0; // Timestamp to ignore audio deltas after interrupt

  // Callbacks
  onTranscriptUpdate: (transcript: string, isComplete: boolean) => void = () => {};
  onUserTranscriptUpdate: (transcript: string) => void = () => {};
  onAudioData: (audioData: Float32Array) => void = () => {};
  onConnectionChange: (connected: boolean) => void = () => {};
  onRecordingStateChange: (isRecording: boolean) => void = () => {};
  onError: (error: string) => void = () => {};

  async connect(config: VoiceSessionConfig): Promise<void> {
    try {
      // Store config for later use
      this.config = config;
      
      // Connect to the OpenAI proxy via Vite's proxy
      const currentHost = window.location.host;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${currentHost}/openai-proxy`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('Connected to OpenAI Realtime API proxy');
        this.isConnected = true;
        
        // Wait for session.created before sending config
        this.onConnectionChange(true);
        this.initializeAudio().catch(console.error);
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('Error parsing JSON message:', error);
          }
        }
      };

      this.ws.onclose = () => {
        console.log('Disconnected from OpenAI Realtime API');
        this.isConnected = false;
        this.cleanup();
        this.onConnectionChange(false);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.onError('Connection error');
      };

    } catch (error) {
      console.error('Failed to connect:', error);
      this.onError('Failed to connect to OpenAI');
    }
  }

  private async initializeAudio(): Promise<void> {
    try {
      this.audioContext = new AudioContext({ sampleRate: 24000 });
      
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      console.log('🎤 Microphone access granted');
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Use ScriptProcessorNode for simpler, more reliable audio capture
      const bufferSize = 4096;
      const scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      this.audioProcessor = scriptProcessor;
      
      scriptProcessor.onaudioprocess = (event) => {
        // Python-style: accumulate audio while recording, send only on release
        if (this.isRecording && !this.isAIResponding) {
          const inputData = event.inputBuffer.getChannelData(0);
          
          // Check for actual audio content
          let hasAudio = false;
          for (let i = 0; i < inputData.length; i++) {
            if (Math.abs(inputData[i]) > 0.005) {
              hasAudio = true;
              break;
            }
          }
          
          if (hasAudio) {
            // Accumulate audio instead of sending immediately
            const pcm16 = this.float32ToPCM16(inputData);
            this.audioBuffer.push(pcm16);
            
            // Only log first chunk to avoid console spam
            if (this.audioBuffer.length === 1) {
              console.log('🎤 Recording and capturing audio...');
            }
          }
        }
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(this.audioContext.destination);
      console.log('✅ Audio initialized');
      
    } catch (error) {
      console.error('❌ Failed to initialize audio:', error);
      throw error;
    }
  }

  private float32ToPCM16(float32Array: Float32Array): ArrayBuffer {
    const pcm16 = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(pcm16);
    
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      const int16Value = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(i * 2, Math.round(int16Value), true);
    }
    
    return pcm16;
  }

  private pcm16ToFloat32(pcm16: ArrayBuffer): Float32Array {
    const view = new DataView(pcm16);
    const float32 = new Float32Array(pcm16.byteLength / 2);
    for (let i = 0; i < float32.length; i++) {
      const int16 = view.getInt16(i * 2, true);
      float32[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
    }
    return float32;
  }

  private config: VoiceSessionConfig | null = null;

  private handleMessage(message: VoiceMessage): void {
    const eventType = message.type;
    
    // Filter out transcript deltas for cleaner logs
    if (!['response.audio_transcript.delta'].includes(eventType)) {
      console.log('Received message:', eventType);
    }
    
    switch (eventType) {
      case 'session.created':
        console.log('✅ Session created, now sending configuration...');
        if (this.config) {
          // Send session config AFTER session is created
          const sessionConfig = {
            type: 'session.update',
            session: {
              modalities: ['audio', 'text'],
              instructions: this.config.instructions,
              voice: this.config.voice,
              input_audio_format: this.config.inputAudioFormat,
              output_audio_format: this.config.outputAudioFormat,
              // EXPLICITLY set turn_detection to null to disable automatic responses
              turn_detection: null,
              // Enable input transcription so we can see what user said
              input_audio_transcription: {
                model: 'whisper-1'
              }
            }
          };
          
          console.log('📤 Sending session config:', JSON.stringify(sessionConfig, null, 2));
          this.sendMessage(sessionConfig);
        }
        break;

      case 'session.updated':
        console.log('✅ Session updated successfully - manual control enabled');
        break;

      case 'response.audio.delta':
        // Ignore audio deltas completely after interrupt to let cancel take effect
        if (Date.now() < this.ignoreAudioUntil) {
          console.log('🔇 Ignoring audio delta after interrupt');
          break;
        }
        
        if (!this.isAIResponding) {
          console.log('🤖 AI started speaking');
          this.isAIResponding = true;
        }
        
        if (message.delta) {
          try {
            const audioData = this.base64ToArrayBuffer(message.delta);
            const float32Audio = this.pcm16ToFloat32(audioData);
            this.onAudioData(float32Audio);
          } catch (error) {
            console.error('Error processing audio delta:', error);
          }
        }
        break;

      case 'response.audio.done':
        // Ignore audio.done messages during interrupt period
        if (Date.now() < this.ignoreAudioUntil) {
          console.log('🔇 Ignoring audio.done after interrupt');
          break;
        }
        
        console.log('🔵 AI finished speaking');
        this.isAIResponding = false;
        break;

      case 'response.created':
        console.log('🤖 Response generation started...');
        this.responseStartTime = Date.now();
        
        // Set a timeout to detect if response gets stuck
        this.responseTimeout = setTimeout(() => {
          console.error('⚠️ Response timeout detected! No content received within 15 seconds.');
          console.log('🔄 Attempting to recover...');
          this.handleStuckResponse();
        }, 15000); // 15 second timeout
        break;

      case 'response.output_item.added':
        // Clear timeout since we got actual response content
        if (this.responseTimeout) {
          clearTimeout(this.responseTimeout);
          this.responseTimeout = null;
        }
        break;

      case 'response.done':
        console.log('🔵 Response complete');
        this.isAIResponding = false;
        this.justInterrupted = false; // Reset interrupt flag on successful completion
        this.ignoreAudioUntil = 0; // Reset audio ignore flag
        
        // Clear timeout since response completed
        if (this.responseTimeout) {
          clearTimeout(this.responseTimeout);
          this.responseTimeout = null;
        }
        break;

      case 'response.audio_transcript.delta':
        // Ignore transcript deltas during interrupt period
        if (Date.now() < this.ignoreAudioUntil) {
          console.log('🔇 Ignoring transcript delta after interrupt');
          break;
        }
        
        if (message.delta) {
          this.onTranscriptUpdate(message.delta, false);
        }
        break;

      case 'response.audio_transcript.done':
        // Ignore transcript done during interrupt period
        if (Date.now() < this.ignoreAudioUntil) {
          console.log('🔇 Ignoring transcript done after interrupt');
          break;
        }
        
        if (message.transcript) {
          console.log('🤖 =================== AI SAID ===================');
          console.log('🤖 AI Response:', message.transcript);
          console.log('🤖 ===============================================');
          this.onTranscriptUpdate(message.transcript, true);
        }
        break;

      case 'input_audio_buffer.committed':
        console.log('✅ Audio buffer committed - user speech captured');
        break;

      case 'input_audio_buffer.cleared':
        console.log('🗑️ Audio buffer cleared - ready for new speech');
        break;

      case 'input_audio_buffer.speech_started':
        console.log('🚨 WARNING: input_audio_buffer.speech_started detected!');
        console.log('🚨 This means turn detection is STILL ACTIVE despite setting it to null!');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('🚨 WARNING: input_audio_buffer.speech_stopped detected!');
        console.log('🚨 Turn detection is causing automatic responses!');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (message.transcript) {
          console.log('👤 ================= USER SAID =================');
          console.log('👤 User Speech:', message.transcript);
          console.log('👤 ==========================================');
          this.onUserTranscriptUpdate(message.transcript);
        }
        break;

      case 'conversation.item.input_audio_transcription.failed':
        console.log('❌ User speech transcription failed');
        break;

      case 'error':
        console.error('OpenAI error:', message.error);
        this.onError(message.error?.message || 'Unknown error');
        break;

      default:
        // Ignore speech_started/speech_stopped - we control manually
        break;
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // PYTHON-STYLE METHODS - spacebar press/release
  startRecording(): void {
    if (!this.isConnected) {
      console.warn('Cannot start recording, not connected');
      return;
    }
    
    console.log('🎤 SPACEBAR PRESSED - Push-to-talk ACTIVE');
    
    // Python step 1: Clear audio buffer
    this.sendMessage({
      type: 'input_audio_buffer.clear'
    });
    
    // Clear our local audio accumulation buffer
    this.audioBuffer = [];
    
    // Python step 2: Start accepting/accumulating audio
    this.isRecording = true;
    this.onRecordingStateChange(true);
    this.isAIResponding = false;
    this.lastAudioSendTime = 0;
  }

  stopRecording(): void {
    if (!this.isRecording) {
      return;
    }
    
    console.log('🎤 SPACEBAR RELEASED - Processing accumulated audio');
    this.isRecording = false;
    this.onRecordingStateChange(false);
    
    if (this.justInterrupted) {
      // After an interrupt, we need to wait for the system to stabilize
      console.log('🔄 Just interrupted AI - waiting for system to stabilize before sending new audio');
      this.justInterrupted = false;
      
      // Give a short delay to let the interrupt settle, then send the new audio
      setTimeout(() => {
        this.processAccumulatedAudio();
      }, 500); // 500ms delay to let interrupt complete
      
    } else {
      // Normal case - send audio immediately
      this.processAccumulatedAudio();
    }
  }

  private processAccumulatedAudio(): void {
    if (this.isConnected && !this.isAIResponding && this.audioBuffer.length > 0) {
      console.log('📤 Processing and sending accumulated audio...');
      
      // Immediately add placeholder for user speech to maintain conversation order
      this.onUserTranscriptUpdate("Processing your speech...");
      
      // Send all accumulated audio at once
      console.log(`📤 Sending ${this.audioBuffer.length} accumulated audio chunks`);
      
      for (const audioChunk of this.audioBuffer) {
        const base64Audio = this.arrayBufferToBase64(audioChunk);
        this.sendMessage({
          type: 'input_audio_buffer.append',
          audio: base64Audio
        });
      }
      
      // Python step 1: Commit the audio buffer
      this.sendMessage({
        type: 'input_audio_buffer.commit'
      });
      
      // Python step 2: Manually create response
      this.sendMessage({
        type: 'response.create'
      });
      
      // Clear the buffer after sending
      this.audioBuffer = [];
    } else if (this.audioBuffer.length === 0) {
      console.log('⚠️ No audio accumulated to send');
    } else if (this.isAIResponding) {
      console.log('⚠️ AI still responding, not sending new audio');
    }
  }

  interruptAI(): void {
    if (this.isConnected && this.isAIResponding) {
      console.log('🛑 Interrupting AI response');
      
      // Set flag to ignore incoming audio for 2 seconds to let cancel take effect
      this.ignoreAudioUntil = Date.now() + 2000;
      
      // Clear any existing timeout
      if (this.responseTimeout) {
        clearTimeout(this.responseTimeout);
        this.responseTimeout = null;
      }
      
      // Send multiple cancel commands to be sure
      this.sendMessage({
        type: 'response.cancel'
      });
      
      // Wait a bit then send another cancel in case the first was missed
      setTimeout(() => {
        if (this.isAIResponding) {
          console.log('🔄 Sending backup cancel command');
          this.sendMessage({
            type: 'response.cancel'
          });
        }
      }, 100);
      
      // Reset AI state immediately
      this.isAIResponding = false;
      this.justInterrupted = true;
      
      // Clear the audio buffer and start fresh recording
      this.sendMessage({
        type: 'input_audio_buffer.clear'
      });
      
      // Start recording for new user input
      this.isRecording = true;
      this.onRecordingStateChange(true);
      this.audioBuffer = [];
      
      console.log('✅ Interrupt complete, recording new input...');
    }
  }

  private handleStuckResponse(): void {
    console.log('🔧 Handling stuck response...');
    
    // Clear the timeout
    if (this.responseTimeout) {
      clearTimeout(this.responseTimeout);
      this.responseTimeout = null;
    }
    
    // Reset AI state
    this.isAIResponding = false;
    this.justInterrupted = false; // Reset interrupt flag during recovery
    this.ignoreAudioUntil = 0; // Reset audio ignore flag
    
    // Try to cancel any stuck response
    this.sendMessage({
      type: 'response.cancel'
    });
    
    // Clear audio buffer to start fresh
    this.sendMessage({
      type: 'input_audio_buffer.clear'
    });
    
    // Notify user of the issue
    this.onError('Response timed out. Please try speaking again.');
    
    console.log('✅ Recovery attempt completed. Ready for new input.');
  }

  private cleanup(): void {
    this.isRecording = false;
    this.onRecordingStateChange(false);
    this.isAIResponding = false;
    this.justInterrupted = false;
    this.ignoreAudioUntil = 0;
    
    // Clear any pending timeout
    if (this.responseTimeout) {
      clearTimeout(this.responseTimeout);
      this.responseTimeout = null;
    }
    
    if (this.audioProcessor) {
      this.audioProcessor.disconnect();
      this.audioProcessor = null;
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.cleanup();
  }

  get connected(): boolean {
    return this.isConnected;
  }
}