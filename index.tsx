/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import { OpenAIVoiceSession } from './openai-voice-service.js';
import './visual-3d';
import type { GdmLiveAudioVisuals3D } from './visual-3d';
import { 
  fetchWordDetailsFromApi, 
  fetchWordFrequencyFromApi, 
  fetchExampleSentencesFromApi, 
  fetchEvaluationFromApi 
} from './gemini-api-service';
import { MicVAD, utils } from '@ricky0123/vad-web';
import { io, Socket } from 'socket.io-client';

const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

interface WordPopupData {
  word: string;
  sentence: string;
  translation: string;
  definition: string;
  partOfSpeech: string;
  lemmatizedWord?: string; // The infinitive/singular form
  displayWord?: string; // The properly formatted word with articles
  x: number;
  y: number;
  targetWidth: number;
}

export interface TranscriptMessage {
  speaker: 'user' | 'model';
  text: string;
  id: string;
}

interface DictionaryEntry {
  word: string; // Original cased word for display (in Target Language)
  translation: string; // To Native Language
  definition: string; // In Native Language
  partOfSpeech: string; // Relative to Target Language
  sentenceContext: string; // In Target Language
  frequency: number | null;
  rank: number | null; // Frequency rank (1 = most common)
  dateAdded: number;
}

export interface FlashcardExampleSentence {
  english: string; // Stores Target Language sentence
  portugueseTranslation: string; // Stores Native Language translation
}

interface Flashcard {
  id: string; // e.g., "wordkey_flashcard"
  originalWordKey: string; // lowercase, trimmed word (in Target Language)
  dictionaryEntry: DictionaryEntry;
  exampleSentences: FlashcardExampleSentence[];
  status: 'new' | 'learning' | 'review'; // Anki-style status
  correctCount: number; // Number of times answered correctly
  incorrectCount: number; // Number of times answered incorrectly
  interval: number; // Days until next review
  easeFactor: number; // Anki ease factor (default 2.5)
  dueDate: number; // Timestamp when card is due for review
  lastReviewed: number; // Timestamp of last review
  learningStep: number; // For learning cards: 0=1min, 1=10min, 2=graduated
}

export interface EvaluationSuggestion {
  category: string; // In Target Language
  description: string; // In Native Language
}

export interface EvaluationData {
  improvementAreas: EvaluationSuggestion[]; // Renamed from suggestions
  cefrLevel: string;
}


const SUPPORTED_LANGUAGES = ['English', 'Spanish', 'Portuguese'];
const PROFILES = ['Joshua', 'Cat', 'Dog', 'Mouse', 'Lizard'];


@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() transcriptHistory: TranscriptMessage[] = [];
  @state() aiTranscriptHistory: TranscriptMessage[] = [];
  @state() videoTranscriptHistory: TranscriptMessage[] = [];
  @state() transcriptFontSize = 26;

  @state() popupData: WordPopupData | null = null;
  @state() isPopupLoading = false;
  @state() popupError: string | null = null;
  
  @state() dictionaryEntries = new Map<string, DictionaryEntry>();
  @state() isFetchingFrequencyFor: string | null = null; // Kept for UI loading state on button
  @state() isFetchingSentencesFor: string | null = null; // Kept for UI loading state on button


  @state() userInterimTranscript = ''; 
  private finalUserTranscript = ''; 

  @state() private isModelSpeaking = false;
  @state() private isSpeechRecognitionActive = false;
  @state() private isModelAudioTurnComplete = true;

  @state() activeTab: 'transcript' | 'dictionary' | 'flashcards' | 'evaluate' = 'transcript';
  @state() expandedDictionaryWords = new Set<string>();
  @state() dictionarySearchTerm = '';
  @state() dictionarySortOrder: 'frequency_desc' | 'frequency_asc' | 'alphabetical' | 'alphabetical_reverse' | 'date_added_desc' | 'date_added_asc' = 'frequency_desc';

  @state() flashcards: Flashcard[] = [];
  @state() flashcardQueue: string[] = [];
  @state() currentFlashcardQueueIndex = 0;
  @state() flashcardIntervals = new Map<string, number>();
  @state() flashcardFlipState = new Map<string, boolean>();
  @state() flashcardAnimationState: 'idle' | 'sliding-left' | 'sliding-right' | 'entering-left' | 'entering-right' = 'idle';
  
  // TTS preloading state
  private preloadedUtterances = new Map<string, SpeechSynthesisUtterance>();
  private currentPreloadingCardId: string | null = null;
  
  // Word form tracking for blue highlighting
  private knownWordForms = new Set<string>(); // All conjugated/inflected forms

  @state() nativeLanguage: string = SUPPORTED_LANGUAGES[0]; // Default, will be overwritten by profile
  @state() targetLanguage: string = SUPPORTED_LANGUAGES[2]; // Default, will be overwritten by profile
  @state() appState: 'languageSelection' | 'conversation' = 'languageSelection';
  @state() currentProfile: string;
  private readonly profiles: string[] = PROFILES;


  @state() private rightPanelWidth: number;
  @state() private isDraggingPanel = false;
  private dragStartX = 0;
  private initialRightPanelWidth = 0;

  private readonly minRightPanelWidth = 320;
  private readonly minLeftPanelWidth = 250;
  private readonly dividerWidth = 5;

  @state() evaluationResult: EvaluationData | null = null;
  @state() isEvaluating: boolean = false;
  @state() evaluationError: string | null = null;

  @state() private isInitializingSession = false;
  @state() private isDiagnosticSessionActive = false;

  // Video mode state
  @state() leftPanelMode: 'ai' | 'video' = 'ai';
  @state() videoStream: MediaStream | null = null;
  @state() isVideoLoading = false;
  @state() videoLayout: 'vertical' | 'horizontal' | 'pip' = 'vertical';
  @state() pipPosition = { x: 20, y: 20 }; // Position for draggable PiP
  @state() isDraggingPip = false;

  // Video speech recognition state
  @state() videoInterimTranscript = '';
  @state() isVideoSpeechActive = false;
  @state() isVideoMicMuted = false; // Unmuted by default
  @state() videoConnectionStatus = 'disconnected'; // Track connection status
  @state() selectedVideoLanguage = 'auto'; // Language selection for video mode
  private videoSpeechRecognition: any | null = null;
  private videoVoiceSession: OpenAIVoiceSession | null = null;

  // Video Whisper recording state
  private videoMediaRecorder: MediaRecorder | null = null;
  private videoAudioChunks: Blob[] = [];
  private videoAudioStream: MediaStream | null = null;
  private videoSilenceTimer: number | null = null;
  private videoRecordingActive = false;

  // Voice Activity Detection for video mode
  private videoAudioContext: AudioContext | null = null;
  private videoAnalyser: AnalyserNode | null = null;
  private videoSilenceDetector: number | null = null;
  private videoSpeechDetected = false;
  private videoRmsHistory: number[] = [];
  private videoBaselineRMS: number | null = null;
  private videoSpeechFrames = 0;
  private videoSilenceFrames = 0;
  private videoStoppedForSpeechCompletion = false; // Track if we stopped due to speech completion
  
  // VAD Constants
  private readonly VIDEO_FRAME_MS = 100;
  private readonly VIDEO_GAP_MS = 500;            // flush after 500ms silence (reduced from 600ms)
  private readonly VIDEO_MIN_SPEECH_MS = 250;     // need 250ms > thresh to mark as speech
  private readonly VIDEO_MARGIN_DB = 6;           // threshold = noise + 6dB
  
  // Track current placeholder for replacement
  private currentVideoPlaceholderId: string | null = null;
  
  // Better tracking for multiple concurrent placeholders
  private pendingVideoPlaceholders = new Map<string, string>(); // Maps MediaRecorder session ID to placeholder ID
  
  // Map to track active recording sessions and their placeholders
  private activeVideoSessions = new Map<string, {
    placeholderId: string;
    mediaRecorder: MediaRecorder | null;
    timestamp: number;
  }>();

  // WebRTC VAD for pre-filtering audio
  private micVAD: any = null; // MicVAD instance
  private isVADInitialized = false;
  private vadSpeechTimer: number | null = null; // Timer for speech end detection
  
  // Pending speech chunks for accumulated sending
  private pendingSpeechChunks: Blob[] = [];

  // Video calling state
  @state() callCode: string | null = null;
  @state() isHostingCall = false;
  @state() isJoiningCall = false;
  @state() callStatus: 'idle' | 'hosting' | 'joining' | 'connected' | 'error' = 'idle';
  @state() callError: string | null = null;
  @state() remoteVideoStream: MediaStream | null = null;
  @state() joinCodeInput = '';
  
  // Socket.IO and WebRTC
  private signalingSocket: Socket | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteSocketId: string | null = null; // Store the remote peer's socket ID
  
  // WebRTC configuration
  private readonly rtcConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };


  private openAIVoiceSession: OpenAIVoiceSession | null = null;
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  private speechRecognition: any | null = null;
  private boundHandlePanelDragMove = this.handlePanelDragMove.bind(this);
  private boundHandlePanelDragEnd = this.handlePanelDragEnd.bind(this);
  private boundHandleKeyDown = this.handleKeyDown.bind(this);
  private boundHandleKeyUp = this.handleKeyUp.bind(this);
  private isSpacebarPressed = false;

  // Video mode methods
  private async startWebcam() {
    if (this.videoStream) return;
    
    this.isVideoLoading = true;
    this.status = 'Starting camera...';
    
    try {
      // First check if we have permission
      const permissions = await navigator.permissions.query({ name: 'camera' as PermissionName });
      console.log('Camera permission status:', permissions.state);
      
      // Try with more basic constraints first
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          facingMode: 'user'
        }, 
        audio: false 
      });
      
      this.videoStream = stream;
      this.isVideoLoading = false;
      this.status = 'Camera started successfully';
      
      // Trigger a re-render and then set up the video
      await this.requestUpdate();
      await this.updateComplete;
      
      // Set up the video element - handle both regular and PiP modes
      let videoElement = this.shadowRoot?.querySelector('#webcam-video') as HTMLVideoElement;
      
      // If regular video element not found, try PiP video element
      if (!videoElement) {
        videoElement = this.shadowRoot?.querySelector('#webcam-video-pip') as HTMLVideoElement;
      }
      
      if (videoElement) {
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
          videoElement.play().catch(console.error);
        };
        console.log('✅ Video element set up successfully');
      } else {
        console.warn('⚠️ Video element not found in DOM');
      }
    } catch (error: any) {
      console.error('❌ Error accessing webcam:', error);
      this.isVideoLoading = false;
      
      let errorMessage = 'Camera error: ';
      if (error.name === 'NotReadableError') {
        errorMessage += 'Camera is already in use by another application. Please close other apps using the camera and try again.';
      } else if (error.name === 'NotAllowedError') {
        errorMessage += 'Camera access denied. Please allow camera access and refresh the page.';
      } else if (error.name === 'NotFoundError') {
        errorMessage += 'No camera found. Please connect a camera and try again.';
      } else if (error.name === 'OverconstrainedError') {
        errorMessage += 'Camera constraints not supported. Trying with basic settings...';
        // Try again with minimal constraints
        setTimeout(() => this.tryBasicCamera(), 1000);
        return;
      } else {
        errorMessage += error.message || 'Unknown camera error';
      }
      
      this.status = errorMessage;
    }
  }

  private async tryBasicCamera() {
    try {
      console.log('🔄 Trying basic camera settings...');
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: true, 
        audio: false 
      });
      
      this.videoStream = stream;
      this.isVideoLoading = false;
      this.status = 'Camera started with basic settings';
      
      await this.requestUpdate();
      await this.updateComplete;
      
      const videoElement = this.shadowRoot?.querySelector('#webcam-video') as HTMLVideoElement;
      if (videoElement) {
        videoElement.srcObject = stream;
        videoElement.onloadedmetadata = () => {
          videoElement.play().catch(console.error);
        };
      }
    } catch (error: any) {
      console.error('❌ Basic camera also failed:', error);
      this.status = `Camera unavailable: ${error.message}`;
    }
  }

  private stopWebcam() {
    if (this.videoStream) {
      this.videoStream.getTracks().forEach(track => track.stop());
      this.videoStream = null;
      this.status = 'Camera stopped';
      this.requestUpdate();
    }
  }

  private handleModeSwitch(mode: 'ai' | 'video') {
    if (this.leftPanelMode === mode) return; // No change needed
    
    // Save current transcript to appropriate history
    if (this.leftPanelMode === 'ai') {
      this.aiTranscriptHistory = [...this.transcriptHistory];
    } else if (this.leftPanelMode === 'video') {
      // Save video transcripts during session, just don't persist to localStorage
      this.videoTranscriptHistory = [...this.transcriptHistory];
    }
    
    // Switch mode
    this.leftPanelMode = mode;
    
    // Load appropriate transcript history
    if (mode === 'ai') {
      this.transcriptHistory = [...this.aiTranscriptHistory];
    } else {
      // Load existing video transcript history from this session
      this.transcriptHistory = [...this.videoTranscriptHistory];
    }
    
    // Stop current activities and clean up
    if (mode === 'ai') {
      this.stopWebcam();
      this.stopVideoSpeechRecognition();
    } else {
      this.stopRecording();
      this.startWebcam();
      // Start speech recognition automatically if mic is unmuted
      if (!this.isVideoMicMuted) {
        // Add a small delay to ensure webcam is started first
        setTimeout(() => {
          this.initVideoSpeechRecognition();
        }, 500);
      }
    }
    
    this.saveProfileData();
    this.requestUpdate();
  }

  private handleVideoLayoutChange(layout: 'vertical' | 'horizontal' | 'pip') {
    this.videoLayout = layout;
    this.requestUpdate();
  }

  private handlePipDragStart(e: MouseEvent) {
    if (this.videoLayout !== 'pip') return;
    
    e.preventDefault();
    this.isDraggingPip = true;
    
    const pipElement = e.target as HTMLElement;
    const containerElement = this.shadowRoot?.querySelector('.video-container') as HTMLElement;
    if (!containerElement) return;
    
    const containerRect = containerElement.getBoundingClientRect();
    const pipRect = pipElement.getBoundingClientRect();
    
    // Calculate offset from mouse to top-left of PiP element
    const offsetX = e.clientX - pipRect.left;
    const offsetY = e.clientY - pipRect.top;
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!this.isDraggingPip) return;
      
      // Calculate new position relative to container
      const newX = moveEvent.clientX - containerRect.left - offsetX;
      const newY = moveEvent.clientY - containerRect.top - offsetY;
      
      // Constrain to container bounds (with PiP size consideration)
      const pipWidth = 200; // PiP width
      const pipHeight = 150; // PiP height
      const maxX = containerRect.width - pipWidth;
      const maxY = containerRect.height - pipHeight;
      
      this.pipPosition = {
        x: Math.max(0, Math.min(maxX, newX)),
        y: Math.max(0, Math.min(maxY, newY))
      };
      this.requestUpdate();
    };
    
    const handleMouseUp = () => {
      if (this.isDraggingPip) {
        // Snap to nearest corner
        this.snapToNearestCorner();
        this.isDraggingPip = false;
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      this.requestUpdate();
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    this.requestUpdate();
  }

  private snapToNearestCorner() {
    const containerElement = this.shadowRoot?.querySelector('.video-container') as HTMLElement;
    if (!containerElement) return;
    
    const containerRect = containerElement.getBoundingClientRect();
    const pipWidth = 200;
    const pipHeight = 150;
    const margin = 20; // Distance from edges
    
    // Calculate container dimensions
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    // Current PiP center position
    const pipCenterX = this.pipPosition.x + pipWidth / 2;
    const pipCenterY = this.pipPosition.y + pipHeight / 2;
    
    // Define corner positions (with margin from edges)
    const corners = [
      { x: margin, y: margin, name: 'top-left' }, // Top-left
      { x: containerWidth - pipWidth - margin, y: margin, name: 'top-right' }, // Top-right
      { x: margin, y: containerHeight - pipHeight - margin, name: 'bottom-left' }, // Bottom-left
      { x: containerWidth - pipWidth - margin, y: containerHeight - pipHeight - margin, name: 'bottom-right' } // Bottom-right
    ];
    
    // Find nearest corner
    let nearestCorner = corners[0];
    let minDistance = Infinity;
    
    corners.forEach(corner => {
      const cornerCenterX = corner.x + pipWidth / 2;
      const cornerCenterY = corner.y + pipHeight / 2;
      const distance = Math.sqrt(
        Math.pow(pipCenterX - cornerCenterX, 2) + 
        Math.pow(pipCenterY - cornerCenterY, 2)
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestCorner = corner;
      }
    });
    
    // Animate to nearest corner
    this.animatePipToPosition(nearestCorner.x, nearestCorner.y);
  }

  private animatePipToPosition(targetX: number, targetY: number) {
    const startX = this.pipPosition.x;
    const startY = this.pipPosition.y;
    const startTime = performance.now();
    const duration = 300; // Animation duration in ms
    
    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Easing function (ease-out)
      const easeOut = 1 - Math.pow(1 - progress, 3);
      
      this.pipPosition = {
        x: startX + (targetX - startX) * easeOut,
        y: startY + (targetY - startY) * easeOut
      };
      
      this.requestUpdate();
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    
    requestAnimationFrame(animate);
  }

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background-color: #1a1423; /* Consistent background */
      color: #e0e0e0;
    }

    .language-selection-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 20px;
      box-sizing: border-box;
      background-color: #1a1423; 
      text-align: center;
    }
    .language-selection-screen h2 {
      color: #bca0dc; 
      margin-bottom: 30px;
      font-size: 1.8em;
    }
    .language-selection-group {
      margin-bottom: 20px;
      width: 100%;
      max-width: 400px;
    }
    .language-selection-group label {
      display: block;
      margin-bottom: 8px;
      color: #a093c4; 
      font-size: 1em;
    }
    .language-selection-group select {
      width: 100%;
      padding: 12px 15px;
      background-color: #2a2139; 
      color: #e0e0e0;
      border: 1px solid #3c3152; 
      border-radius: 6px;
      font-size: 1em;
      cursor: pointer;
    }
    .language-selection-screen .start-button {
      padding: 12px 30px;
      font-size: 1.1em;
      font-weight: bold;
      color: white;
      background-color: #8a5cf5; 
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s ease;
      margin-top: 20px;
    }
    .language-selection-screen .start-button:hover {
      background-color: #794ee2; 
    }


    .app-container {
      display: flex;
      width: 100%;
      height: 100%;
      position: relative; /* For loading overlay */
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(26, 20, 35, 0.9); /* Dark, semi-transparent */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 2000; /* High z-index to cover content */
      color: #e0e0e0;
      text-align: center;
      font-size: 1.1em;
    }

    .loading-spinner {
      border: 5px solid #3c3152; /* Darker part of spinner */
      border-top: 5px solid #8a5cf5; /* Purple accent */
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin-bottom: 20px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }


    .left-panel {
      /* flex: 1; Provided by inline style now */
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    /* Mode selector styles */
    .mode-selector {
      display: flex;
      background-color: #2a2139;
      border-bottom: 1px solid #3c3152;
      margin: 0;
      flex-shrink: 0;
      position: relative;
      z-index: 10;
      height: auto;
      min-height: 60px;
    }

    .mode-tab {
      flex: 1;
      padding: 12px 20px;
      background-color: transparent;
      border: none;
      color: #a093c4;
      font-size: 0.95em;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      border-bottom: 3px solid transparent;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 50px;
    }

    .mode-tab:hover {
      color: #bca0dc;
      background-color: rgba(138, 92, 245, 0.1);
    }

    .mode-tab.active {
      color: #e0e0e0;
      background-color: rgba(138, 92, 245, 0.15);
      border-bottom-color: #8a5cf5;
    }

    /* Video mode styles */
    .video-interface {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 20px;
      background: linear-gradient(135deg, #1a1423 0%, #2a2139 100%);
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }

    /* Layout selector */
    .video-layout-selector {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 100;
      display: flex;
      gap: 5px;
      background: rgba(0, 0, 0, 0.7);
      padding: 8px;
      border-radius: 8px;
      backdrop-filter: blur(4px);
    }

    .layout-option {
      width: 32px;
      height: 24px;
      background: rgba(255, 255, 255, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
      cursor: pointer;
      position: relative;
      transition: all 0.2s ease;
    }

    .layout-option:hover {
      background: rgba(255, 255, 255, 0.3);
      border-color: rgba(255, 255, 255, 0.5);
    }

    .layout-option.active {
      background: rgba(138, 92, 245, 0.6);
      border-color: #8a5cf5;
    }

    /* Layout option visual indicators */
    .layout-option.vertical::before {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      right: 2px;
      height: 8px;
      background: currentColor;
      opacity: 0.7;
    }
    .layout-option.vertical::after {
      content: '';
      position: absolute;
      bottom: 2px;
      left: 2px;
      right: 2px;
      height: 8px;
      background: currentColor;
      opacity: 0.7;
    }

    .layout-option.horizontal::before,
    .layout-option.horizontal::after {
      content: '';
      position: absolute;
      top: 2px;
      bottom: 2px;
      width: 12px;
      background: currentColor;
      opacity: 0.7;
    }
    .layout-option.horizontal::before { left: 2px; }
    .layout-option.horizontal::after { right: 2px; }

    .layout-option.pip::before {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      right: 2px;
      bottom: 2px;
      background: currentColor;
      opacity: 0.4;
    }
    .layout-option.pip::after {
      content: '';
      position: absolute;
      top: 2px;
      right: 2px;
      width: 10px;
      height: 8px;
      background: currentColor;
      opacity: 0.9;
    }

    /* Video container layouts */
    .video-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      min-height: 0;
    }

    .video-container.horizontal {
      flex-direction: row;
      gap: 10px;
    }

    .video-container.vertical {
      flex-direction: column;
      gap: 10px;
    }

    .video-container.pip {
      flex-direction: column;
    }

    .video-screen {
      border-radius: 12px;
      overflow: hidden;
      position: relative;
      border: 2px solid #3c3152;
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Horizontal layout */
    .video-container.horizontal .video-screen {
      flex: 1;
      height: 100%;
      max-height: 600px;
      aspect-ratio: 4/3;
      max-width: calc(50% - 5px);
    }

    /* Vertical layout */
    .video-container.vertical .video-screen {
      flex: 1;
      width: 100%;
      max-width: 600px;
      aspect-ratio: 4/3;
      max-height: calc(50% - 5px);
    }

    /* Picture-in-Picture layout */
    .video-container.pip .video-screen.main {
      width: 100%;
      height: 100%;
      max-width: 100%;
      max-height: 100%;
      aspect-ratio: 4/3;
    }

    .video-container.pip .video-screen.pip-overlay {
      position: absolute;
      width: 200px;
      height: 150px;
      aspect-ratio: 4/3;
      z-index: 50;
      cursor: move;
      border: 3px solid #8a5cf5;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      user-select: none;
    }

    .video-container.pip .video-screen.pip-overlay:hover {
      border-color: #bca0dc;
      box-shadow: 0 6px 25px rgba(138, 92, 245, 0.4);
    }

    .video-screen.dragging {
      opacity: 0.9;
      border-color: #bca0dc !important;
      box-shadow: 0 8px 30px rgba(138, 92, 245, 0.6) !important;
      transition: none; /* Disable transitions while dragging */
    }

    /* Video subtitle overlay */
    .video-subtitle-overlay {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(to top, rgba(0, 0, 0, 0.8) 0%, rgba(0, 0, 0, 0.6) 50%, transparent 100%);
      color: white;
      padding: 15px 20px;
      text-align: center;
      font-size: 1.1em;
      font-weight: 500;
      line-height: 1.4;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
      border-radius: 0 0 12px 12px;
      z-index: 10;
      min-height: 60px;
      display: flex;
      align-items: flex-end;
      justify-content: center;
    }

    .video-subtitle-text {
      background: rgba(0, 0, 0, 0.7);
      padding: 8px 12px;
      border-radius: 6px;
      backdrop-filter: blur(4px);
      max-width: 90%;
      word-wrap: break-word;
    }

    .video-subtitle-overlay.interim {
      opacity: 0.8;
    }

    .video-subtitle-overlay.interim .video-subtitle-text {
      background: rgba(138, 92, 245, 0.7);
      color: #ffffff;
    }

    /* Hide subtitles in PiP mode */
    .video-container.pip .pip-overlay .video-subtitle-overlay {
      display: none;
    }

    .waiting-screen {
      background: linear-gradient(45deg, #1a1a1a 0%, #2a2a2a 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #888;
      font-size: 1.1em;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .webcam-screen {
      background: #000;
      position: relative;
    }

    .webcam-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1); /* Mirror the video */
    }

    .video-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #8a5cf5;
      font-size: 0.9em;
      gap: 8px;
      width: 100%;
      height: 100%;
    }

    .video-loading .loading-spinner {
      width: 20px;
      height: 20px;
      border-width: 2px;
    }

    .video-controls {
      display: flex;
      justify-content: center;
      gap: 10px;
      padding: 10px 0;
      flex-shrink: 0;
      height: auto;
      min-height: 60px;
    }

    .video-control-btn {
      padding: 8px 16px;
      background-color: #3c3152;
      color: #e0e0e0;
      border: 1px solid #4a3f63;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9em;
      transition: all 0.2s ease;
    }

    .video-control-btn:hover {
      background-color: #4a3f63;
      border-color: #8a5cf5;
    }

    .video-control-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .video-control-btn.active {
      background-color: #8a5cf5;
      border-color: #8a5cf5;
    }

    .panel-divider {
      width: 5px; /* Matches this.dividerWidth */
      background-color: #3c3152; /* Existing border color */
      cursor: col-resize;
      flex-shrink: 0;
      z-index: 5; /* Ensure it's above panel content if needed */
    }


    .right-panel {
      /* width and flex-shrink provided by inline style */
      /* border-left: 1px solid #3c3152;  Removed, divider handles this */
      background-color: #2a2139;
      color: #e0e0e0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden; /* Prevent content from overflowing during resize */
    }
    
    .tabs {
      display: flex;
      background-color: #2a2139; 
      border-bottom: 1px solid #3c3152;
      padding: 0px 15px; 
      padding-top: 10px; 
      flex-shrink: 0; /* Prevent tabs from shrinking */
    }

    .tab-button {
      padding: 10px 15px; 
      cursor: pointer;
      border: none;
      background-color: transparent;
      color: #8a80a5; 
      font-size: 0.95em; 
      font-weight: 500;
      border-bottom: 3px solid transparent;
      /* margin-right: 10px; /* Let flexbox handle spacing or use gap on .tabs */
      transition: color 0.2s ease, border-color 0.2s ease;
      flex-grow: 1; /* Added */
      flex-basis: 0;  /* Added */
      text-align: center; /* Added */
    }
    .tab-button:not(:last-child) {
        margin-right: 5px; /* Restore some spacing if desired */
    }


    .tab-button:hover {
      color: #bca0dc;
    }

    .tab-button.active {
      color: #e0e0e0; 
      border-bottom-color: #8a5cf5; 
    }
    
    .tab-button.dictionary-tab-btn.active { border-bottom-color: #e53e3e; } 
    .tab-button.flashcards-tab-btn.active { border-bottom-color: #3b82f6; } 
    .tab-button.evaluate-tab-btn.active,
    .tab-button.evaluate-tab-btn:hover {
      border-bottom-color: #28a745; /* Green */
    }
    .tab-button.evaluate-tab-btn:hover:not(.active) {
      color: #a7e0b4; /* Lighter green for hover if not active */
    }
    .tab-button:disabled {
      color: #5a4f73;
      cursor: not-allowed;
      border-bottom-color: transparent;
    }
    .tab-button:disabled:hover {
      color: #5a4f73; /* Keep hover color same as disabled */
    }


    .tab-content {
      flex-grow: 1;
      overflow-y: auto; /* Allows content within tab to scroll */
      display: flex; 
      flex-direction: column; 
    }
    
    .transcript-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      flex-shrink: 0;
      border-bottom: 1px solid #3c3152;
      background-color: #231c31; 
    }

    .transcript-title {
      font-size: 1.1em;
      color: #bca0dc;
      text-transform: uppercase;
      font-weight: 500;
    }
    .transcript-title.diagnostic {
      color: #f97316; /* Orange for diagnostic */
    }


    .font-controls {
      display: flex;
      gap: 8px;
    }

    .font-size-button {
      background-color: #3c3152;
      color: #e0e0e0;
      border: 1px solid #4a3f63;
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 1em;
      font-weight: bold;
      cursor: pointer;
      line-height: 1;
    }
    .font-size-button:hover {
      background-color: #4a3f63;
    }

    .transcript-messages-container, .dictionary-content, .flashcards-content, .evaluate-content {
      flex-grow: 1;
      overflow-y: auto;
      padding: 20px; 
    }
    .flashcards-content {
        display: flex;
        flex-direction: column; 
        align-items: center;
        justify-content: center;
        color: #8a80a5;
        font-size: 1.1em;
    }


    .transcript-messages-container::-webkit-scrollbar, 
    .dictionary-content::-webkit-scrollbar,
    .flashcards-content::-webkit-scrollbar,
    .evaluate-content::-webkit-scrollbar {
      width: 8px;
    }
    .transcript-messages-container::-webkit-scrollbar-track,
    .dictionary-content::-webkit-scrollbar-track,
    .flashcards-content::-webkit-scrollbar-track,
    .evaluate-content::-webkit-scrollbar-track {
      background: #2a2139;
    }
    .transcript-messages-container::-webkit-scrollbar-thumb,
    .dictionary-content::-webkit-scrollbar-thumb,
    .flashcards-content::-webkit-scrollbar-thumb,
    .evaluate-content::-webkit-scrollbar-thumb {
      background-color: #4a3f63;
      border-radius: 4px;
      border: 2px solid #2a2139;
    }

    .transcript-messages {
      display: flex;
      flex-direction: column;
      gap: 0px; 
    }

    .transcript-message {
      background-color: #3c3152; 
      padding: 8px 12px;
      line-height: 1.5;
      color: #e0e0e0; 
      word-wrap: break-word;
      margin-top: 0; 
      margin-bottom: 0;
      border-radius: 10px; 
    }

    .transcript-message[data-speaker="user"] + .transcript-message[data-speaker="model"],
    .transcript-message[data-speaker="model"] + .transcript-message[data-speaker="user"] {
      margin-top: 8px;
    }

    .transcript-message.user {
      background-color: #34495e; 
      color: #ecf0f1; 
    }

    .transcript-message.latest {
      background-color: #ffffff; 
    }
    .transcript-message.latest:not(.user) { 
        color: #3cb371; 
    }
     .transcript-message.latest.user { 
        color: #2c3e50; 
    }


    .clickable-word {
      cursor: pointer;
      text-decoration: underline;
      text-decoration-color: #a093c4; 
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
      padding-bottom: 1px;
    }

    .transcript-message.user .clickable-word {
        text-decoration-color: #7f8c8d; 
    }
    
    .clickable-word:hover {
      color: #ffffff;
      text-decoration-color: #ffffff;
      background-color: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
    }

    .transcript-message.latest:not(.user) .clickable-word:hover { 
      color: #3cb371; 
      text-decoration-color: #3cb371;
      background-color: rgba(0, 0, 0, 0.05); 
    }

    .transcript-message.latest.user .clickable-word:hover { 
      color: #000000; 
      text-decoration-color: #000000;
      background-color: rgba(0, 0, 0, 0.05); 
    }

    .clickable-word.known-word {
      color: #60a5fa; /* blue-400 */
      text-decoration-color: #93c5fd; /* blue-300 */
    }
    .clickable-word.known-word:hover {
      color: #3b82f6; /* blue-500 */
      background-color: rgba(59, 130, 246, 0.1);
      text-decoration-color: #3b82f6;
    }
    .transcript-message.latest:not(.user) .clickable-word.known-word { 
      color: #2563eb; /* blue-600 */
      text-decoration-color: #60a5fa; /* blue-400 */
    }
    .transcript-message.latest:not(.user) .clickable-word.known-word:hover {
      color: #1d4ed8; /* blue-700 */
      text-decoration-color: #1d4ed8;
      background-color: rgba(29, 78, 216, 0.15);
    }
    .transcript-message.latest.user .clickable-word.known-word { 
      color: #005A9C; /* Darker, custom blue for user's latest message */
      text-decoration-color: #3182CE;
    }
    .transcript-message.latest.user .clickable-word.known-word:hover {
      color: #003D6B;
      text-decoration-color: #003D6B;
      background-color: rgba(0, 61, 107, 0.1);
    }


    .popup-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: transparent; 
      z-index: 999;
    }

    .word-popup {
      position: fixed;
      background-color: #2a2139;
      border: 1px solid #3c3152;
      border-radius: 8px;
      padding: 15px 20px;
      z-index: 1000;
      min-width: 250px;
      max-width: 380px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.2);
      color: #e0e0e0;
      font-size: 14px;
      line-height: 1.5;
      transform: translateX(-50%);
    }
    
    .word-popup-header {
      display: flex;
      align-items: center; 
      gap: 8px; 
      margin-bottom: 2px; 
    }

    .popup-selected-word {
      color: #3cb371;
      font-size: 1.4em; 
      font-weight: 600;
    }
    
    .dictionary-toggle-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      background-color: #4a3f63; 
      color: #e0e0e0; 
      transition: background-color 0.2s ease, color 0.2s ease;
      flex-shrink: 0; 
    }
    /* .dictionary-toggle-btn .loader defined with .loading-spinner animation */


    .dictionary-toggle-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    .dictionary-toggle-btn:hover:not(:disabled) {
      background-color: #5a4f73; 
    }

    .dictionary-toggle-btn.added {
      background-color: #3cb371; 
      color: #ffffff; 
    }

    .dictionary-toggle-btn.added:hover:not(:disabled) {
      background-color: #36a065; 
    }
    .dictionary-toggle-btn:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }


    .popup-part-of-speech {
      color: #3cb371; 
      font-size: 0.9em; 
      display: block; 
      margin-bottom: 12px; 
    }

    .popup-label {
      color: #bca0dc;
      text-transform: uppercase;
      font-size: 0.8em; 
      font-weight: 600;
      display: block;
      margin-bottom: 3px;
    }

    .popup-content-text {
      color: #e0e0e0;
      font-size: 1em; 
      margin-bottom: 10px;
      display: block;
      white-space: pre-wrap; 
    }
    .popup-content-text:last-child {
        margin-bottom: 0;
    }


    .popup-close-btn {
      position: absolute;
      top: 10px;
      right: 12px;
      background: none;
      border: none;
      color: #bca0dc;
      font-size: 1.6em;
      font-weight: bold;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .popup-close-btn:hover {
      color: #ffffff;
    }
    .word-popup .error-message {
      color: #ff7b7b;
      font-weight: 500;
    }
    .word-popup .loading-message {
      color: #a093c4;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 5vh;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;

        &:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button:disabled {
        /* display: none;  -- let's keep it visible but styled as disabled */
        opacity: 0.5;
        cursor: not-allowed;
        background: rgba(255, 255, 255, 0.05); /* Darker disabled background */
      }

      /* Record button specific styles */
      #recordButton.recording {
        animation: pulse 1.5s infinite;
        background: rgba(255, 0, 0, 0.2);
        border-color: rgba(255, 0, 0, 0.4);
      }

      #recordButton.not-recording:hover:not(:disabled) {
        background: rgba(200, 0, 0, 0.2);
        border-color: rgba(200, 0, 0, 0.4);
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(255, 0, 0, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(255, 0, 0, 0); }
        100% { box-shadow: 0 0 0 0 rgba(255, 0, 0, 0); }
      }
    }

    #status {
      position: absolute;
      bottom: 1vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      font-family: sans-serif;
      text-shadow: 1px 1px 2px black;
      font-size: 0.9em;
    }

    gdm-live-audio-visuals-3d {
      flex-grow: 1;
      width: 100%;
      height: 100%;
      display: block;
    }

    /* Dictionary Tab Styles */
    .dictionary-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 0 10px 0; 
      margin-bottom: 10px;
      border-bottom: 1px solid #3c3152;
      flex-wrap: wrap; 
      flex-shrink: 0; /* Prevent controls from shrinking */
    }

    .search-bar input {
      background-color: #3c3152;
      color: #e0e0e0;
      border: 1px solid #4a3f63;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 0.9em;
      width: 250px; 
    }
    .search-bar input::placeholder {
      color: #8a80a5;
    }
    .search-bar { margin-right: auto; }


    .dictionary-word-count {
      font-size: 0.9em;
      color: #8a80a5;
      margin-left: 10px; 
      margin-right: 10px;
    }

    .dictionary-options { display: flex; align-items: center; gap: 10px; }

    .sort-by-select, .dictionary-action-button {
      background-color: #3c3152;
      color: #e0e0e0;
      border: 1px solid #4a3f63;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 0.9em;
      cursor: pointer;
    }
    .sort-by-select { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23e0e0e0' stroke='%23e0e0e0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 10px center; background-size: 1em; padding-right: 2.5em;}

    .dictionary-action-button .icon {
      margin-right: 6px;
    }
    
    .dictionary-list {
      display: flex;
      flex-direction: column;
      gap: 8px; 
    }

    .dictionary-entry {
      background-color: #3c3152;
      border-radius: 6px;
      border: 1px solid #4a3f63;
      padding: 10px 15px;
      cursor: pointer;
    }

    .dictionary-entry-summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .dictionary-entry-word {
      color: #3cb371; 
      font-weight: 600;
      font-size: 1.1em;
    }
    
    .frequency-dots { display: flex; gap: 3px; }
    .frequency-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }

    .expand-arrow { color: #8a80a5; font-size: 1.2em; transition: transform 0.2s ease; }
    .dictionary-entry.expanded .expand-arrow { transform: rotate(90deg); }

    .dictionary-entry-details {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #4a3f63;
      font-size: 0.9em;
      line-height: 1.6;
    }
    .dictionary-entry-details .popup-label { font-size: 0.85em; margin-bottom: 2px;}
    .dictionary-entry-details .popup-content-text { font-size: 0.95em; margin-bottom: 8px;}
    .dictionary-entry-details .popup-part-of-speech { font-size: 0.85em; margin-bottom: 8px;}

    .delete-dictionary-entry-btn {
      background: none;
      border: none;
      color: #bca0dc;
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      width: 24px;
      height: 24px;
      transition: background-color 0.2s, color 0.2s;
    }
    .delete-dictionary-entry-btn:hover {
      color: #ff7b7b;
      background-color: rgba(255, 123, 123, 0.1);
    }
    .delete-dictionary-entry-btn svg {
      width: 18px;
      height: 18px;
    }


    /* Flashcard Styles */
    .flashcard-viewer {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px; 
        width: 100%; 
    }
    .flashcard-scene {
      width: 100%; 
      aspect-ratio: 4 / 3; 
      max-width: 480px; 
      perspective: 1000px;
      margin-bottom: 10px;
      overflow: visible; /* Allow animations to show fully */
      position: relative;
    }
    .flashcard-container {
      width: 100%;
      height: 100%;
      position: relative;
      transform-style: preserve-3d;
      transition: transform 0.7s cubic-bezier(0.4, 0.0, 0.2, 1);
      cursor: pointer;
    }
    .flashcard-container.flipped {
      transform: rotateY(180deg);
    }
    
    /* Animation states for card transitions */
    .flashcard-container.sliding-left {
      animation: slideOutLeft 0.3s cubic-bezier(0.4, 0.0, 0.6, 1) forwards;
    }
    .flashcard-container.sliding-right {
      animation: slideOutRight 0.3s cubic-bezier(0.4, 0.0, 0.6, 1) forwards;
    }
    .flashcard-container.entering-left {
      animation: slideInFromLeft 0.3s cubic-bezier(0.4, 0.0, 0.6, 1) forwards;
    }
    .flashcard-container.entering-right {
      animation: slideInFromRight 0.3s cubic-bezier(0.4, 0.0, 0.6, 1) forwards;
    }
    
    @keyframes slideOutLeft {
      0% { transform: translateX(0); opacity: 1; }
      100% { transform: translateX(-100%); opacity: 0; }
    }
    @keyframes slideOutRight {
      0% { transform: translateX(0); opacity: 1; }
      100% { transform: translateX(100%); opacity: 0; }
    }
    @keyframes slideInFromLeft {
      0% { transform: translateX(-100%); opacity: 0; }
      100% { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideInFromRight {
      0% { transform: translateX(100%); opacity: 0; }
      100% { transform: translateX(0); opacity: 1; }
    }
    .flashcard {
      position: absolute;
      width: 100%;
      height: 100%;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden; 
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center; 
      border: 1px solid #4a3f63;
      border-radius: 12px; 
      background-color: #3c3152;
      padding: 20px; 
      box-sizing: border-box;
      text-align: center;
      font-size: 1.1em; 
      overflow-y: auto; 
    }
    .card-front {
      color: white; 
    }
    .card-front .portuguese-translation { 
      font-style: italic;
      color: #cccccc; 
      font-size: 0.9em;
      margin-top: 10px;
    }
    .card-back {
      transform: rotateY(180deg);
      justify-content: space-between; 
    }
    .card-back .highlighted-word {
      color: #ffd700; 
      font-weight: bold;
    }
    .flashcard-content-area {
      flex-grow: 1; 
      display: flex;
      flex-direction: column; 
      align-items: center; 
      justify-content: center; 
      width: 100%;
      overflow-y: auto; 
      padding-bottom: 10px; 
      line-height: 1.5;
    }
     .flashcard-content-area p { margin: 0; } 

    .flashcard-interval {
      font-size: 0.8em;
      color: #bca0dc;
      margin-top: auto; 
      padding-top: 5px; 
    }
    .flashcard-tts-button {
      position: absolute;
      top: 10px;
      right: 10px;
      background: rgba(138, 92, 245, 0.8);
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      color: white;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s, transform 0.1s;
      font-size: 18px;
      backdrop-filter: blur(4px);
    }
    .flashcard-tts-button:hover {
      background: rgba(138, 92, 245, 1);
      transform: scale(1.05);
    }
    .flashcard-tts-button:active {
      transform: scale(0.95);
    }
    .flashcard-actions {
      display: flex;
      gap: 12px; 
      width: 100%;
      padding-top: 15px; 
      flex-shrink: 0; 
    }
    .flashcard-actions button {
      flex-grow: 1;
      padding: 10px 0; 
      border: none;
      border-radius: 6px;
      color: white;
      font-weight: bold;
      font-size: 0.9em;
      cursor: pointer;
      transition: background-color 0.2s, transform 0.1s;
    }
    .flashcard-actions button:hover { transform: translateY(-1px); }
    .flashcard-actions button:active { transform: translateY(0px); }
    .flashcard-actions .incorrect-btn { 
      background-color: #ef4444; 
    }
    .flashcard-actions .incorrect-btn:hover { 
      background-color: #dc2626; 
    }
    .flashcard-actions .correct-btn { 
      background-color: #22c55e; 
    }
    .flashcard-actions .correct-btn:hover { 
      background-color: #16a34a; 
    }

    .flashcard-nav {
      display: flex;
      justify-content: center;
      align-items: center;
      color: #bca0dc;
      width: 100%; 
      margin-top: 10px;
    }
    .flashcard-nav button {
      background: none;
      border: none;
      color: #bca0dc;
      font-size: 1.8em; 
      cursor: pointer;
      padding: 5px 15px; 
      transition: color 0.2s;
    }
    .flashcard-nav button:hover:not(:disabled) { color: #e0e0e0; }
    .flashcard-nav button:disabled { color: #5a4f73; cursor: default; }
    .card-count { 
      margin: 0 20px; 
      font-size: 0.95em; 
      font-weight: 600;
      text-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .no-flashcards-message {
        text-align: center;
        padding: 20px;
        font-size: 1em;
        color: #8a80a5;
    }
    .flashcard-due-info {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .due-today {
      background: rgba(34, 197, 94, 0.8); /* Green for due today */
    }
    .overdue {
      background: rgba(239, 68, 68, 0.8); /* Red for overdue */
    }
    .calendar-view {
      margin-top: 20px;
      padding: 15px;
      background: rgba(60, 49, 82, 0.3);
      border-radius: 8px;
      border: 1px solid #4a3f63;
    }
    .calendar-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      color: #bca0dc;
      font-weight: 600;
    }
    .calendar-entry {
      padding: 8px 0;
      border-bottom: 1px solid rgba(74, 63, 99, 0.3);
      font-size: 0.9em;
    }
    .calendar-entry:last-child {
      border-bottom: none;
    }
    .calendar-date {
      color: #3cb371;
      font-weight: 500;
    }
    .calendar-word {
      color: #e0e0e0;
      margin-left: 10px;
    }

    /* Evaluate Tab Styles */
    .evaluate-content {
      display: flex;
      flex-direction: column;
      gap: 15px;
      align-items: flex-start;
    }
    .evaluate-content h3, .evaluate-content h4 {
      color: #bca0dc;
      margin-top: 10px;
      margin-bottom: 5px;
    }
     .evaluate-content h3:first-child {
      margin-top: 0;
    }
    .evaluate-content p {
      margin-bottom: 10px;
      line-height: 1.6;
      color: #c0b8d8; /* Slightly lighter for better readability */
    }
    .evaluate-button {
      background-color: #8a5cf5;
      color: white;
      border: none;
      padding: 10px 15px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 1em;
      transition: background-color 0.2s ease;
    }
    .evaluate-button:hover:not(:disabled) {
      background-color: #794ee2;
    }
    .evaluate-button:disabled {
      background-color: #5a4f73;
      cursor: not-allowed;
    }
    .suggestion-item {
      background-color: #3c3152;
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 15px;
      border: 1px solid #4a3f63;
      width: 100%; /* Make suggestions take full width */
      box-sizing: border-box;
    }
    .suggestion-item p {
      margin: 8px 0;
      color: #e0e0e0;
    }
    .suggestion-item strong {
      color: #bca0dc;
    }
    .evaluation-cefr-level {
      font-size: 1.3em;
      font-weight: bold;
      color: #3cb371; /* Green for positive result */
      margin-top: 5px;
    }
    .evaluation-error-message {
      color: #ff7b7b; /* Red for error */
      font-weight: 500;
    }

    .video-language-select {
      padding: 8px 12px;
      background-color: #3c3152;
      color: #e0e0e0;
      border: 1px solid #4a3f63;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9em;
      transition: all 0.2s ease;
      margin-right: 10px;
    }

    .video-language-select:hover {
      background-color: #4a3f63;
      border-color: #8a5cf5;
    }

    .video-language-select:focus {
      outline: none;
      border-color: #8a5cf5;
      box-shadow: 0 0 0 2px rgba(138, 92, 245, 0.2);
    }

    /* Video Calling Styles */
    .video-call-container {
      position: relative;
      width: 100%;
      height: 100%;
      background: #1a1625;
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .remote-video-container {
      flex: 1;
      position: relative;
      background: #2a2438;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .remote-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #2a2438;
    }

    .video-placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #2a2438 0%, #3c3152 100%);
    }

    .remote-placeholder {
      color: #a093c4;
    }

    .placeholder-content {
      text-align: center;
      padding: 2rem;
    }

    .call-status {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }

    .call-code-display {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      padding: 1rem;
      background: rgba(138, 92, 245, 0.1);
      border: 2px solid #8a5cf5;
      border-radius: 12px;
      animation: pulse-glow 2s infinite;
    }

    .call-code-label {
      font-size: 0.9rem;
      color: #bca0dc;
      margin-bottom: 0.25rem;
    }

    .call-code-value {
      font-size: 2rem;
      font-weight: bold;
      color: #8a5cf5;
      font-family: 'Courier New', monospace;
      letter-spacing: 0.2em;
      text-shadow: 0 0 10px rgba(138, 92, 245, 0.5);
    }

    .waiting-text, .connecting-text, .no-call-text {
      font-size: 1.1rem;
      color: #8a80a5;
      text-align: center;
    }

    .local-video-container {
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 200px;
      height: 150px;
      border-radius: 12px;
      overflow: hidden;
      border: 2px solid #8a5cf5;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      background: #2a2438;
    }

    .local-video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #2a2438;
    }

    .local-video-placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #3c3152;
      color: #8a80a5;
      font-size: 0.9rem;
    }

    .video-label {
      position: absolute;
      bottom: 8px;
      left: 8px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }

    .remote-label {
      bottom: 20px;
      left: 20px;
      background: rgba(138, 92, 245, 0.9);
    }

    .local-label {
      bottom: 4px;
      left: 4px;
      background: rgba(0, 0, 0, 0.8);
    }

    .video-call-subtitle-overlay {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      max-width: 80%;
      background: rgba(0, 0, 0, 0.8);
      border-radius: 8px;
      padding: 12px 16px;
      backdrop-filter: blur(8px);
      z-index: 10;
    }

    .video-call-subtitle-text {
      color: white;
      font-size: 1.1rem;
      text-align: center;
      font-weight: 500;
      text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.7);
    }

    @keyframes pulse-glow {
      0%, 100% {
        box-shadow: 0 0 5px rgba(138, 92, 245, 0.3);
      }
      50% {
        box-shadow: 0 0 20px rgba(138, 92, 245, 0.6);
      }
    }

    /* Responsive adjustments for video calling */
    @media (max-width: 768px) {
      .local-video-container {
        width: 120px;
        height: 90px;
        bottom: 15px;
        right: 15px;
      }
      
      .call-code-value {
        font-size: 1.5rem;
      }
      
      .video-call-subtitle-overlay {
        max-width: 90%;
        bottom: 15px;
      }
    }
  `;

  constructor() {
    super();
    this.currentProfile = localStorage.getItem('lastActiveProfile') || this.profiles[0];
    
    let initialWidth = parseInt(localStorage.getItem('rightPanelWidth') || '600', 10);
    initialWidth = Math.max(this.minRightPanelWidth, initialWidth); 
    this.rightPanelWidth = initialWidth;

    this.boundHandlePanelDragMove = this.handlePanelDragMove.bind(this);
    this.boundHandlePanelDragEnd = this.handlePanelDragEnd.bind(this);
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleKeyUp = this.handleKeyUp.bind(this);
  }

  private getProfileKey(key: string): string {
    return `${this.currentProfile}_${key}`;
  }

  private loadProfileData() {
    this.nativeLanguage = localStorage.getItem(this.getProfileKey('nativeLanguage')) || SUPPORTED_LANGUAGES[0];
    this.targetLanguage = localStorage.getItem(this.getProfileKey('targetLanguage')) || SUPPORTED_LANGUAGES[2];

    const storedDict = localStorage.getItem(this.getProfileKey('dictionaryEntries'));
    this.dictionaryEntries = storedDict ? new Map(JSON.parse(storedDict)) : new Map();

    const storedFlashcards = localStorage.getItem(this.getProfileKey('flashcards'));
    this.flashcards = storedFlashcards ? JSON.parse(storedFlashcards).map((card: any) => ({
      ...card,
      status: card.status === 'practiced' ? 'review' : (card.status || 'new'), // Convert old 'practiced' to 'review'
      correctCount: card.correctCount || 0,
      incorrectCount: card.incorrectCount || 0,
      interval: card.interval || 0,
      easeFactor: card.easeFactor || 2.5,
      dueDate: card.dueDate || Date.now(),
      lastReviewed: card.lastReviewed || 0,
      learningStep: card.learningStep || 0,
    })) : [];

    const storedIntervals = localStorage.getItem(this.getProfileKey('flashcardIntervals'));
    this.flashcardIntervals = storedIntervals ? new Map(JSON.parse(storedIntervals)) : new Map();
    
    const storedWordForms = localStorage.getItem(this.getProfileKey('knownWordForms'));
    this.knownWordForms = storedWordForms ? new Set(JSON.parse(storedWordForms)) : new Set();
    
    // Load separate transcripts
    const storedAiTranscript = localStorage.getItem(this.getProfileKey('aiTranscriptHistory'));
    this.aiTranscriptHistory = storedAiTranscript ? JSON.parse(storedAiTranscript) : [];
    
    // Video transcripts should not persist between sessions - always start fresh
    this.videoTranscriptHistory = [];
    
    // Set the current transcript based on current mode
    if (this.leftPanelMode === 'ai') {
      this.transcriptHistory = [...this.aiTranscriptHistory];
    } else {
      this.transcriptHistory = [...this.videoTranscriptHistory];
    }
    
    this.flashcardFlipState.clear(); // Reset flip state on profile load
    this.sortAndInitializeFlashcardQueue();
    this.requestUpdate();
  }

  private saveProfileData() {
    localStorage.setItem(this.getProfileKey('nativeLanguage'), this.nativeLanguage);
    localStorage.setItem(this.getProfileKey('targetLanguage'), this.targetLanguage);
    localStorage.setItem(this.getProfileKey('dictionaryEntries'), JSON.stringify(Array.from(this.dictionaryEntries.entries())));
    localStorage.setItem(this.getProfileKey('flashcards'), JSON.stringify(this.flashcards));
    localStorage.setItem(this.getProfileKey('flashcardIntervals'), JSON.stringify(Array.from(this.flashcardIntervals.entries())));
    localStorage.setItem(this.getProfileKey('knownWordForms'), JSON.stringify(Array.from(this.knownWordForms)));
    localStorage.setItem(this.getProfileKey('aiTranscriptHistory'), JSON.stringify(this.aiTranscriptHistory));
    // Note: videoTranscriptHistory is intentionally not saved - video sessions should start fresh
  }

  private handleProfileChange(e: Event) {
    this.currentProfile = (e.target as HTMLSelectElement).value;
    localStorage.setItem('lastActiveProfile', this.currentProfile);
    this.loadProfileData();
  }


  private handleInitialNativeLanguageChange(e: Event) {
    this.nativeLanguage = (e.target as HTMLSelectElement).value;
    this.saveProfileData();
    this.requestUpdate('nativeLanguage'); 
  }

  private handleInitialTargetLanguageChange(e: Event) {
    this.targetLanguage = (e.target as HTMLSelectElement).value;
    this.saveProfileData();
    this.requestUpdate('targetLanguage');
  }
  
  private async handleStartConversation() {
    this.initAudio(); 
    
    this.transcriptHistory = [];
    this.userInterimTranscript = '';
    this.finalUserTranscript = '';
    this.closePopup();
    this.isModelSpeaking = false;
    this.isModelAudioTurnComplete = true;
    this.evaluationResult = null;
    this.isEvaluating = false;
    this.evaluationError = null;
    this.dictionarySearchTerm = '';
    this.expandedDictionaryWords.clear();

    this.appState = 'conversation';
    await this.requestUpdate(); 

    await this.initClient();
    
    // Preload core vocabulary for the target language
    import('./gemini-api-service.js').then(module => {
      module.preloadTargetLanguage(this.targetLanguage.toLowerCase())
        .then(() => console.log(`✅ Core vocabulary preloaded for ${this.targetLanguage}`))
        .catch(err => console.warn(`⚠️ Failed to preload vocabulary: ${err}`));
    }); 
    
    // Speech recognition is optional - OpenAI handles the voice processing
    if (this.openAIVoiceSession && this.openAIVoiceSession.connected) {
        try {
          this.initSpeechRecognition(); 
        } catch (error) {
          console.warn('Speech recognition not available, but OpenAI voice will still work:', error);
          // Don't fail - the app can work without browser speech recognition
        }
    }
  }


  private mapLanguageToBcp47(languageName: string): string {
    switch (languageName.toLowerCase()) {
      case 'english':
        return 'en-US';
      case 'spanish':
        return 'es-ES'; 
      case 'portuguese':
        return 'pt-BR';
      default:
        return 'en-US'; 
    }
  }


  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private initSpeechRecognition() {
    if (!SpeechRecognitionAPI) {
      this.error = "Speech Recognition API not supported by this browser.";
      this.speechRecognition = null; 
      return;
    }
    if (this.speechRecognition) { 
        try { this.speechRecognition.abort(); } catch(e) { /* ignore */ }
    }
    this.speechRecognition = new SpeechRecognitionAPI();
    this.speechRecognition.continuous = true; 
    this.speechRecognition.interimResults = true; 
    this.speechRecognition.lang = this.mapLanguageToBcp47(this.targetLanguage);


    this.speechRecognition.onstart = () => {
      this.isSpeechRecognitionActive = true;
    };
    
    this.speechRecognition.onresult = (event: any) => { 
      if (!this.isSpeechRecognitionActive) return; 

      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          this.finalUserTranscript += transcriptPart + ' ';
          const finalSegment = transcriptPart.trim();
          if (finalSegment) {
            this.transcriptHistory = [
              ...this.transcriptHistory,
              { speaker: 'user', text: finalSegment, id: `user-${crypto.randomUUID()}` }
            ];
            this.status = `You: ${finalSegment}`;
          }
        } else {
          interimTranscript += transcriptPart;
        }
      }
      this.userInterimTranscript = interimTranscript;
    };

    this.speechRecognition.onend = () => {
      this.isSpeechRecognitionActive = false;
      this.finalUserTranscript = ''; 
      this.userInterimTranscript = '';
    };

    this.speechRecognition.onerror = (event: any) => { 
      this.isSpeechRecognitionActive = false; 
      console.error('Speech recognition error', event);
      let errorMsg = `Speech error: ${event.error}`;
      if (event.error === 'no-speech') {
        errorMsg = "No speech detected. Please try again.";
      } else if (event.error === 'audio-capture') {
        errorMsg = "Audio capture error. Check microphone permissions.";
      } else if (event.error === 'not-allowed') {
        errorMsg = "Microphone access denied. Please allow access.";
      } else if (event.error === 'language-not-supported') {
        errorMsg = `Target language (${this.targetLanguage}) not supported by speech recognition. Try English.`;
      }
      this.error = errorMsg;
    };
  }

  private startUserSpeechRecognition() {
    if (this.speechRecognition && this.isRecording && !this.isSpeechRecognitionActive && !this.isModelSpeaking) {
      try {
        this.speechRecognition.lang = this.mapLanguageToBcp47(this.targetLanguage); 
        this.finalUserTranscript = '';
        this.userInterimTranscript = '';
        this.speechRecognition.start();
      } catch (e: any) {
        console.error("Error starting speech recognition:", e);
         if (e.name === 'InvalidStateError' && this.isSpeechRecognitionActive) {
           // Already started, benign
        } else if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
           this.error = "Microphone access denied or speech recognition blocked by browser.";
        } else {
           this.error = `Speech recognition start error: ${e.message}`;
        }
      }
    }
  }

  private stopUserSpeechRecognition() {
    if (this.speechRecognition && this.isSpeechRecognitionActive) {
      try {
        this.speechRecognition.stop();
      } catch (e) {
        console.warn("Error stopping speech recognition (might be benign):", e);
      }
    }
  }

  private async initClient() {
    if (this.openAIVoiceSession) {
        try { this.openAIVoiceSession.disconnect(); } catch (e) { /* ignore */ }
        this.openAIVoiceSession = null as any;
    }
    try {
      this.outputNode.connect(this.outputAudioContext.destination);
      await this.initSession(); 
    } catch (e: any) {
      this.isInitializingSession = false; 
      this.requestUpdate('isInitializingSession');
      console.error("Failed to initialize OpenAI voice session:", e);
      this.error = `Client Init Error (Session): ${e.message}. Ensure API_KEY is valid and configured.`;
      this.openAIVoiceSession = null as any; 
    }
  }



  private getRegularSystemInstruction(): string {
    return `I am a language learner who speaks ${this.nativeLanguage} and is trying to learn ${this.targetLanguage}. Please conduct our conversation primarily in ${this.targetLanguage}. When I ask for definitions or translations, provide definitions in ${this.nativeLanguage} and translations from ${this.targetLanguage} to ${this.nativeLanguage}.`;
  }

  private getDiagnosticSystemInstruction(): string {
    let baseInstruction = `
Full Prompt for VoiceTutor Diagnostic (Audio-Only, Structured, 3 Phases)
You are an AI language tutor conducting a 15-minute spoken diagnostic session in ${this.targetLanguage} with a student whose native language is ${this.nativeLanguage}. This session is divided into three phases, each designed to evaluate specific language skills. You will speak and listen only—no visual input or written instructions are available. You are testing productive grammar, vocabulary, and listening comprehension. You must lead the session completely. Do not ask what the student wants to do. If the student struggles, you may rephrase or simplify, but you must stay in control and move through the phases.
First, be friendly and greet the student in ${this.nativeLanguage}. Ask the student (in a few qustions) why they want to learn ${this.targetLanguage}, their level of proficiency in ${this.targetLanguage}, their level of proficiency in ${this.nativeLanguage}, and what they think they need to work on.

🔸 Phase 1: Controlled Translation (5 minutes)
Objective: Elicit precise sentence production in ${this.targetLanguage} using grammatical forms and vocabulary across categories.

Speak in ${this.nativeLanguage}. One phrase at a time. The student must translate aloud into ${this.targetLanguage}.

Instructions (in ${this.nativeLanguage}):
PHASE_1_INSTRUCTION_PLACEHOLDER

Categories & Sample Items (escalating, examples are in Spanish, adapt if Native Language is different, keeping the grammatical concept):
Present Simple + Subjects
"Yo tengo un perro."
"Mi hermana va a la escuela."
"Nosotros vivimos en una casa grande."
Negation & Questions
"No me gusta el café."
"¿Tú hablas inglés?"
"¿Qué haces los fines de semana?"
Past and Future Tense
"Ayer fui al mercado."
"Ella estudió por tres horas."
"Voy a visitar a mi abuela mañana."
Modal Verbs
"Puedes usar mi teléfono."
"Debemos hacer la tarea."
"Ellos no pueden venir hoy."
Descriptions & Comparisons
"Mi madre es más alta que mi padre."
"La comida está deliciosa."
"Esta película es mejor que la otra."
Conditionals & Hypotheticals
"Si llueve, me quedaré en casa."
"Si tuviera más tiempo, viajaría a México."
"Si ves a Juan, dile que llamé."

🔸 Phase 2: Conceptual Production (5 minutes)
Objective: Check grammar awareness and conceptual understanding using ${this.nativeLanguage} prompts, but require student to answer in ${this.targetLanguage}. This forces them to retrieve forms flexibly.

Still speak in ${this.nativeLanguage}. Ask open-ended questions about grammar or meaning. Student must respond in ${this.targetLanguage}.

Instructions (in ${this.nativeLanguage}):
PHASE_2_INSTRUCTION_PLACEHOLDER

Categories & Sample Prompts (examples are in Spanish, adapt if Native Language is different):
Past Tense Recall
"¿Qué hiciste ayer por la tarde?"
"Dime tres cosas que hiciste la semana pasada."
Modal Function / Obligation
"¿Qué deberíamos hacer cuando estamos enfermos?"
"¿Qué puedes hacer tú que otras personas no pueden?"
Por vs. Para / Prepositions (language-specific, this is a Spanish example)
"Dame un ejemplo de una situación para 'por' y otra para 'para'."
"¿Cuándo se usa 'a' y cuándo 'en'?"
Reflexives / Daily Routine
"Descríbeme tu rutina diaria usando verbos reflexivos."
Conditionals (first and second)
"¿Qué harías si no tuvieras que trabajar mañana?"
"¿Qué vas a hacer si llueve este fin de semana?"

🔸 Phase 3: Target-Language Immersion (5 minutes)
Objective: Evaluate comprehension and free production under real-time ${this.targetLanguage} pressure. No more native language. Questions are longer, abstract, or multi-part.

Speak only in ${this.targetLanguage}. Ask more advanced and cognitively demanding questions. The student must answer in full ${this.targetLanguage} sentences.

Instructions (in ${this.targetLanguage}):
"Now I will ask you questions only in ${this.targetLanguage}. Please answer fully."

Categories & Sample Prompts:
Narrative Listening
"Yesterday, I went to the store and forgot my wallet. I had to go back home, get it, and return. What happened in the story?"
Reasoning & Opinions
"Do you think students should have homework every day? Why or why not?"
"Which is better: living in a big city or a small town? Explain."
Hypothetical / Second Conditional
"If you could visit any country in the world, where would you go and why?"
Instructions & Sequences
"Tell me how to cook your favorite meal, step by step."
Comparative Reasoning
"Compare two people you know. Who is more patient? Who is funnier?"
Abstract Expression
"Why is it important to learn ${this.targetLanguage}?"
"What does being a good friend mean to you?"

🔸 Wrap-Up
In ${this.targetLanguage}:
"Thank you. That's the end of our session. I understand your level now and will use your answers to create a learning plan just for you. See you next time."
    `.trim();

    let phase1Instruction: string;
    let phase2Instruction: string;

    if (this.nativeLanguage === 'English') {
      phase1Instruction = `"I will say phrases. Please translate them aloud into ${this.targetLanguage}. We'll start with easy phrases, then they will become more difficult."`;
      phase2Instruction = `"Now I will ask you questions. The questions are in English, but your answers must be in ${this.targetLanguage}."`;
    } else if (this.nativeLanguage === 'Portuguese') {
      phase1Instruction = `"Vou dizer algumas frases. Por favor, traduza-as em voz alta para ${this.targetLanguage}. Começaremos com frases fáceis, depois ficarão mais difíceis."`;
      phase2Instruction = `"Agora vou fazer-lhe algumas perguntas. As perguntas estão em Português, mas as suas respostas devem estar em ${this.targetLanguage}."`;
    } else { 
      phase1Instruction = `"Voy a decir frases. Por favor tradúcelas en voz alta al ${this.targetLanguage}. Comenzamos con frases fáciles. Luego serán más difíciles."`;
      phase2Instruction = `"Ahora voy a hacerte preguntas. Las preguntas están en español, pero tus respuestas deben estar en ${this.targetLanguage}."`;
    }

    let instructionText = baseInstruction
      .replace('PHASE_1_INSTRUCTION_PLACEHOLDER', phase1Instruction)
      .replace('PHASE_2_INSTRUCTION_PLACEHOLDER', phase2Instruction);
    
    return instructionText;
  }

  private markDiagnosticAsCompleted() {
    if (!this.isDiagnosticSessionActive) return;

    localStorage.setItem(this.getProfileKey('diagnosticCompleted'), 'true');
    this.isDiagnosticSessionActive = false;
    this.requestUpdate('isDiagnosticSessionActive');
    this.status = 'Diagnostic session completed! You can now have regular conversations.';
  }


  private async initSession() {
    const diagnosticKey = this.getProfileKey('diagnosticCompleted');
    const diagnosticCompleted = localStorage.getItem(diagnosticKey) === 'true';
    this.isDiagnosticSessionActive = !diagnosticCompleted; 

    this.isInitializingSession = true; 
    this.openAIVoiceSession = null as any; 
    this.requestUpdate(); 

    let systemInstructionText: string;

    if (this.isDiagnosticSessionActive) {
      systemInstructionText = this.getDiagnosticSystemInstruction();
      this.status = `Starting diagnostic session for ${this.currentProfile}...`;
    } else {
      systemInstructionText = this.getRegularSystemInstruction();
      this.status = `Initializing session for ${this.currentProfile}...`;
    }

    try {
      // Initialize OpenAI Voice Session
      this.openAIVoiceSession = new OpenAIVoiceSession();
      
      // Set up event handlers - SIMPLIFIED: Only handle complete AI transcripts
      this.openAIVoiceSession.onTranscriptUpdate = (transcript, isComplete) => {
        if (isComplete && transcript && transcript.trim()) {
          console.log('📝 Adding AI transcript to history:', transcript);
          this.transcriptHistory = [
            ...this.transcriptHistory,
            { speaker: 'model', text: transcript.trim(), id: `model-${crypto.randomUUID()}` }
          ];

          if (this.isDiagnosticSessionActive) {
            const lowerText = transcript.toLowerCase();
            if (lowerText.includes("end of our session") || lowerText.includes("see you next time")) {
              this.markDiagnosticAsCompleted();
            }
          }
          
          this.requestUpdate(); // Trigger UI update
        }
      };

      // NEW: Handle user speech transcriptions
      this.openAIVoiceSession.onUserTranscriptUpdate = (transcript) => {
        if (transcript && transcript.trim()) {
          console.log('📝 Adding/updating user transcript in history:', transcript);
          
          // Find the most recent user placeholder that needs to be replaced
          // (might not be the last message if AI responded already)
          let placeholderIndex = -1;
          for (let i = this.transcriptHistory.length - 1; i >= 0; i--) {
            const message = this.transcriptHistory[i];
            if (message.speaker === 'user' && message.text === "Processing your speech...") {
              placeholderIndex = i;
              break;
            }
          }
          
          if (placeholderIndex !== -1) {
            // Replace the placeholder with the real transcript
            const updatedHistory = [...this.transcriptHistory];
            updatedHistory[placeholderIndex] = {
              speaker: 'user', 
              text: transcript.trim(), 
              id: updatedHistory[placeholderIndex].id
            };
            this.transcriptHistory = updatedHistory;
            console.log(`✅ Replaced placeholder at index ${placeholderIndex} with real transcript`);
          } else {
            // No placeholder found, add new user transcript
            this.transcriptHistory = [
              ...this.transcriptHistory,
              { speaker: 'user', text: transcript.trim(), id: `user-${crypto.randomUUID()}` }
            ];
            console.log('➕ Added new user transcript (no placeholder found)');
          }
          this.requestUpdate(); // Trigger UI update
        }
      };

      this.openAIVoiceSession.onAudioData = (audioData) => {
        // Stop any user audio capture immediately when AI starts speaking
        if (!this.isModelSpeaking) {
          this.isModelSpeaking = true;
          this.isModelAudioTurnComplete = false;
          this.stopUserSpeechRecognition();
          
          // Stop audio capture in the OpenAI service
          if (this.openAIVoiceSession && this.isRecording) {
            this.openAIVoiceSession.stopRecording();
            this.isRecording = false; // Stop recording when AI responds
          }
          
          // Update status to show AI is responding
          this.status = '🤖 AI is speaking...';
          
          // Clear any queued audio to prevent overlaps
          this.sources.forEach(source => {
            source.stop();
            source.disconnect();
          });
          this.sources.clear();
          this.nextStartTime = this.outputAudioContext.currentTime;
        }

        // Create an audio buffer from the received data
        const audioBuffer = this.outputAudioContext.createBuffer(1, audioData.length, 24000);
        audioBuffer.getChannelData(0).set(audioData);
        
        // Schedule audio playback properly to prevent overlapping
        const source = this.outputAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.outputNode);
        
        source.addEventListener('ended', () => {
          this.sources.delete(source);
          if (this.sources.size === 0) {
            this.isModelSpeaking = false;
            this.isModelAudioTurnComplete = true;
            this.status = 'Click the record button to continue the conversation.';
          }
        });
        
        // Schedule to start at the correct time to prevent overlap
        const startTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
        source.start(startTime);
        this.nextStartTime = startTime + audioBuffer.duration;
        this.sources.add(source);
      };

      this.openAIVoiceSession.onConnectionChange = (connected) => {
        if (connected) {
          this.isInitializingSession = false;
          this.requestUpdate('isInitializingSession');
          if (this.isDiagnosticSessionActive) {
            this.status = `Diagnostic session ready. Click record or hold SPACEBAR to start.`;
          } else {
            this.status = 'Ready! Click record or hold SPACEBAR to talk.';
          }
        } else {
          console.log("Session closed");
          this.status = "Session closed.";
          this.isInitializingSession = false;
          this.isRecording = false; // Stop recording if session closes
          this.requestUpdate('isInitializingSession');
        }
      };

      this.openAIVoiceSession.onRecordingStateChange = (isRecording) => {
        this.isRecording = isRecording;
        this.requestUpdate();
      };

      this.openAIVoiceSession.onError = (error) => {
        console.error("Session error:", error);
        this.error = `Session error: ${error || 'Unknown error'}`;
        this.isInitializingSession = false;
        this.requestUpdate('isInitializingSession');
      };

      // Connect to OpenAI Voice API
      await this.openAIVoiceSession.connect({
        voice: 'ash', // Choose from 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'sage', 'ash'
        instructions: systemInstructionText,
        inputAudioFormat: 'pcm16',
        outputAudioFormat: 'pcm16'
        // NOTE: NO turn_detection - we control everything manually like Python
      });
      
    } catch (e: any) {
      this.isInitializingSession = false;
      this.requestUpdate('isInitializingSession');
      console.error("Failed to initialize session:", e);
      this.error = `Failed to initialize session: ${e.message}`;
      this.openAIVoiceSession = null as any; 
    }
  }

  private async startRecording() {
    if (this.isRecording) return;

    if (!this.openAIVoiceSession || !this.openAIVoiceSession.connected) {
      this.error = "Session not initialized. Please try again or refresh the page.";
      return;
    }
    
    console.log('🎤 Starting recording - resuming audio contexts...');
    
    // Ensure audio contexts are active
    if (this.inputAudioContext.state === 'suspended') {
      await this.inputAudioContext.resume();
      console.log('✅ Input audio context resumed');
    }
    if (this.outputAudioContext.state === 'suspended') {
      await this.outputAudioContext.resume();
      console.log('✅ Output audio context resumed');
    }
    
    this.status = 'Starting recording...';
    
    try {
      // Start recording through the OpenAI voice service - PYTHON STYLE
      this.openAIVoiceSession.startRecording();
      
      this.isRecording = true; 
      this.status = '🔴 Recording... Speak now. Release SPACEBAR or click stop when done.';
      this.error = ''; // Clear any previous errors
      
      console.log('✅ Recording started successfully');
      
      // Start browser speech recognition for display purposes only
      this.startUserSpeechRecognition();
      
    } catch (err: any) {
      console.error('❌ Error starting recording:', err);
      this.error = `Error: ${err.message}`;
      this.stopRecording(); 
    }
  }

  private stopRecording() {
    // Let the voice service handle its own recording state
    this.isRecording = false; 
    this.status = 'Processing... Please wait for AI response.';
    
    // Stop recording and trigger AI response - PYTHON STYLE
    if (this.openAIVoiceSession) {
      this.openAIVoiceSession.stopRecording();
    }
  }

  private async reset() {
    this.stopRecording(); 
    if (this.openAIVoiceSession) {
        try { this.openAIVoiceSession.disconnect(); } catch (e) { /* ignore */ }
        this.openAIVoiceSession = null as any;
    }

    this.transcriptHistory = [];
    this.userInterimTranscript = '';
    this.finalUserTranscript = '';
    this.closePopup();
    this.isModelSpeaking = false;
    this.isModelAudioTurnComplete = true;
    this.evaluationResult = null;
    this.isEvaluating = false;
    this.evaluationError = null;
    this.dictionarySearchTerm = '';
    this.expandedDictionaryWords.clear();

    await this.initClient(); 

    if (this.speechRecognition && this.openAIVoiceSession && this.openAIVoiceSession.connected) { 
        try { this.speechRecognition.abort(); } catch(e) {/*ignore*/}
        this.initSpeechRecognition(); 
    }
    
    this.requestUpdate(); 
  }

  private handlePanelDragStart(e: MouseEvent) {
    this.isDraggingPanel = true;
    this.dragStartX = e.clientX;
    this.initialRightPanelWidth = this.rightPanelWidth;
    document.addEventListener('mousemove', this.boundHandlePanelDragMove);
    document.addEventListener('mouseup', this.boundHandlePanelDragEnd);
    document.body.style.userSelect = 'none'; 
    document.body.style.cursor = 'col-resize';
  }

  private handlePanelDragMove(e: MouseEvent) {
    if (!this.isDraggingPanel) return;
    e.preventDefault();

    const deltaX = e.clientX - this.dragStartX;
    let newWidth = this.initialRightPanelWidth - deltaX;

    const appContainer = this.shadowRoot!.querySelector('.app-container') as HTMLElement;
    if (!appContainer) return;
    const totalWidth = appContainer.clientWidth;
    
    const maxRightWidth = totalWidth - this.minLeftPanelWidth - this.dividerWidth;
    
    newWidth = Math.max(this.minRightPanelWidth, newWidth); 
    newWidth = Math.min(newWidth, maxRightWidth);     

    this.rightPanelWidth = newWidth;
  }

  private handlePanelDragEnd() {
    if (!this.isDraggingPanel) return;
    this.isDraggingPanel = false;
    document.removeEventListener('mousemove', this.boundHandlePanelDragMove);
    document.removeEventListener('mouseup', this.boundHandlePanelDragEnd);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    localStorage.setItem('rightPanelWidth', this.rightPanelWidth.toString());

    const visualizer = this.shadowRoot?.querySelector('gdm-live-audio-visuals-3d') as GdmLiveAudioVisuals3D | null;
    if (visualizer && typeof visualizer.triggerResize === 'function') {
      visualizer.triggerResize();
    }
  }


  protected firstUpdated() {
    this.loadProfileData(); 

    if (this.shadowRoot) {
      const hostElement = this.shadowRoot.host as HTMLElement;
      hostElement.style.setProperty('--transcript-font-size', `${this.transcriptFontSize}px`);
       const appContainer = this.shadowRoot!.querySelector('.app-container') as HTMLElement;
      if (appContainer) {
        const totalWidth = appContainer.clientWidth;
        const maxInitialRightWidth = totalWidth - this.minLeftPanelWidth - this.dividerWidth;
        let validatedWidth = Math.min(this.rightPanelWidth, maxInitialRightWidth);
        validatedWidth = Math.max(validatedWidth, this.minRightPanelWidth);
        if (this.rightPanelWidth !== validatedWidth) {
            this.rightPanelWidth = validatedWidth;
            localStorage.setItem('rightPanelWidth', this.rightPanelWidth.toString());
        }
      }
    }
  }

  protected updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    
    // Set up video element when video stream becomes available OR when layout changes
    if ((changedProperties.has('videoStream') && this.videoStream) || 
        (changedProperties.has('videoLayout') && this.videoStream)) {
      
      // Wait for DOM to update then set up video
      setTimeout(() => {
        let videoElement = this.shadowRoot?.querySelector('#webcam-video') as HTMLVideoElement;
        
        // If regular video element not found, try PiP video element
        if (!videoElement) {
          videoElement = this.shadowRoot?.querySelector('#webcam-video-pip') as HTMLVideoElement;
        }
        
        if (videoElement && this.videoStream && !videoElement.srcObject) {
          videoElement.srcObject = this.videoStream;
          videoElement.onloadedmetadata = () => {
            videoElement.play().catch(console.error);
          };
          console.log('✅ Video element updated for layout change');
        }
      }, 100);
    }

    if (changedProperties.has('transcriptHistory') && this.activeTab === 'transcript') {
      const container = this.shadowRoot?.getElementById('transcriptMessagesContainer');
      if (container) {
        if (!this.popupData) { 
            container.scrollTop = container.scrollHeight;
        }
      }
    }
    if (changedProperties.has('transcriptFontSize') && this.shadowRoot) {
        (this.shadowRoot.host as HTMLElement).style.setProperty('--transcript-font-size', `${this.transcriptFontSize}px`);
    }
    if (changedProperties.has('dictionaryEntries') || changedProperties.has('dictionarySearchTerm') && this.activeTab === 'dictionary') {
        this.requestUpdate(); 
    }
    if (changedProperties.has('activeTab') && this.activeTab === 'flashcards') {
      this.sortAndInitializeFlashcardQueue();
    }
  }

  private increaseFontSize() {
    const MAX_FONT_SIZE = 48;
    if (this.transcriptFontSize < MAX_FONT_SIZE) this.transcriptFontSize += 2;
  }

  private decreaseFontSize() {
    const MIN_FONT_SIZE = 12;
    if (this.transcriptFontSize > MIN_FONT_SIZE) this.transcriptFontSize -= 2;
  }

  private async handleWordClick(event: MouseEvent, word: string, sentence: string) {
    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();

    let popupX = rect.left + rect.width / 2;
    let popupY = rect.bottom + 8;
    const estimatedPopupWidth = 300; 
    const estimatedPopupHeight = 200;

    if (popupX + estimatedPopupWidth / 2 > window.innerWidth) {
        popupX = window.innerWidth - estimatedPopupWidth / 2 - 10; 
    }
    if (popupX - estimatedPopupWidth / 2 < 0) {
        popupX = estimatedPopupWidth / 2 + 10;
    }
    if (popupY + estimatedPopupHeight > window.innerHeight) {
        popupY = rect.top - estimatedPopupHeight - 8; 
    }

    this.popupData = {
      word, 
      sentence, 
      translation: '', 
      definition: '', 
      partOfSpeech: '', 
      x: popupX,
      y: popupY,
      targetWidth: rect.width,
    };
    this.isPopupLoading = true;
    this.popupError = null;

    const details = await fetchWordDetailsFromApi(word, sentence, this.targetLanguage, this.nativeLanguage);
    
    if (this.popupData) { // Check if popup is still open
      // Fix: Use type guard to correctly handle WordDetails | WordDetailsError union type
      if ('error' in details) { // Type guard for WordDetailsError
        const errorMessage = details.error || `Failed to load details for "${word}".`;
        console.error(`Error fetching word details for "${word}": ${errorMessage}`);
        this.popupError = errorMessage;
        this.popupData = {
          ...this.popupData,
          translation: 'Error',
          definition: 'Could not fetch details.',
          partOfSpeech: 'Error',
          lemmatizedWord: word,
          displayWord: word,
        };
      } else { // It's WordDetails
        this.popupData = {
          ...this.popupData,
          partOfSpeech: details.partOfSpeech || 'N/A',
          translation: details.translation || 'N/A',
          definition: details.definition || 'N/A',
          lemmatizedWord: details.lemmatizedWord || word,
          displayWord: details.displayWord || word,
        };
      }
    }
    this.isPopupLoading = false;
  }

  private closePopup() {
    this.popupData = null;
    this.isPopupLoading = false;
    this.popupError = null;
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async handleToggleDictionary(wordData: WordPopupData) {
    // Use the lemmatized word for the dictionary key and API calls
    const lemmatizedWord = (wordData as any).lemmatizedWord || wordData.word;
    const displayWord = (wordData as any).displayWord || wordData.word; 
    const wordKey = lemmatizedWord.toLowerCase().trim();

    if (this.dictionaryEntries.has(wordKey)) {
      await this.handleDeleteDictionaryEntry(wordKey); 
    } else {
      const optimisticEntry: DictionaryEntry = {
        word: displayWord, // Use the properly formatted word for display
        translation: wordData.translation,
        definition: wordData.definition,
        partOfSpeech: wordData.partOfSpeech,
        sentenceContext: wordData.sentence,
        frequency: null,
        rank: null,
        dateAdded: Date.now(),
      };
      this.dictionaryEntries.set(wordKey, optimisticEntry);
      this.dictionaryEntries = new Map(this.dictionaryEntries);

      this.isFetchingFrequencyFor = displayWord;
      this.isFetchingSentencesFor = displayWord;
      this.popupError = null;
      this.requestUpdate(); 

      try {
        // Fetch all word forms for comprehensive highlighting
        const wordForms = await this.fetchWordForms(lemmatizedWord, wordData.partOfSpeech, this.targetLanguage);
        console.log(`📝 Adding ${wordForms.length} forms to known words:`, wordForms);
        
        // Add all forms to the known words set
        wordForms.forEach(form => {
          console.log(`➕ Adding form "${form}" to knownWordForms`);
          this.knownWordForms.add(form);
        });
        
        console.log(`🎯 Total known word forms after adding "${lemmatizedWord}":`, this.knownWordForms.size);
        
        // Use lemmatized word for frequency lookup to get more accurate results
        const frequencyResult = await fetchWordFrequencyFromApi(lemmatizedWord, this.targetLanguage);
        // Fix: Use type guard for WordFrequencyResult | WordFrequencyError
        let frequency: number | null = null;
        let rank: number | null = null;
        if (!('error' in frequencyResult)) { // It's WordFrequencyResult
            frequency = frequencyResult.frequency;
            rank = frequencyResult.rank || null;
        } else {
            console.warn(`Failed to fetch frequency for "${lemmatizedWord}": ${frequencyResult.error}`);
            // frequency and rank remain null, which is an acceptable state for DictionaryEntry
        }
        
        // Use lemmatized word for example sentences
        const sentencesResult = await fetchExampleSentencesFromApi(
          lemmatizedWord,
          wordData.sentence,
          wordData.definition,
          wordData.partOfSpeech,
          this.targetLanguage,
          this.nativeLanguage
        );
        // Fix: Use type guard for ExampleSentencesResult | ExampleSentencesError
        let exampleSentences: FlashcardExampleSentence[] = [];
        if (!('error' in sentencesResult)) { // It's ExampleSentencesResult
            exampleSentences = sentencesResult.sentences || [];
        } else {
            console.warn(`Error fetching example sentences for "${lemmatizedWord}": ${sentencesResult.error}`);
            // exampleSentences will remain [], and the logic below will handle it
        }
        
        this.isFetchingFrequencyFor = null;
        this.isFetchingSentencesFor = null;

        if (exampleSentences.length === 0) {
          this.popupError = "Could not generate usable example sentences. Word not added.";
          this.dictionaryEntries.delete(wordKey);
          this.dictionaryEntries = new Map(this.dictionaryEntries);
          this.requestUpdate();
          return;
        }

        const finalEntry: DictionaryEntry = { ...optimisticEntry, frequency, rank };
        this.dictionaryEntries.set(wordKey, finalEntry);

        const flashcardId = `${wordKey}_flashcard`;
        const newFlashcard: Flashcard = {
          id: flashcardId,
          originalWordKey: wordKey,
          dictionaryEntry: finalEntry,
          exampleSentences: exampleSentences,
          status: 'new',
          correctCount: 0,
          incorrectCount: 0,
          interval: 0,
          easeFactor: 2.5,
          dueDate: Date.now(), // New cards are due immediately
          lastReviewed: 0,
          learningStep: 0,
        };
        this.flashcards = [...this.flashcards, newFlashcard];
        this.flashcardIntervals.set(flashcardId, 1);
        this.flashcardFlipState.set(flashcardId, false);
        
        this.dictionaryEntries = new Map(this.dictionaryEntries);
        this.sortAndInitializeFlashcardQueue();
        this.saveProfileData(); 
        this.requestUpdate();

      } catch (error) {
        console.error("Error adding word to dictionary:", error);
        this.popupError = "An error occurred while adding the word. Please try again.";
        this.dictionaryEntries.delete(wordKey);
        this.dictionaryEntries = new Map(this.dictionaryEntries);
        this.isFetchingFrequencyFor = null;
        this.isFetchingSentencesFor = null;
        this.requestUpdate();
      }
    }
  }

  private async handleDeleteDictionaryEntry(wordKey: string) {
    if (this.dictionaryEntries.has(wordKey)) {
      const entry = this.dictionaryEntries.get(wordKey);
      
      // Remove all word forms from the known words set
      if (entry) {
        const wordForms = await this.fetchWordForms(entry.word, entry.partOfSpeech, this.targetLanguage);
        wordForms.forEach(form => this.knownWordForms.delete(form));
        console.log(`🗑️ Removed ${wordForms.length} forms from known words:`, wordForms);
      }
      
      this.dictionaryEntries.delete(wordKey);
      this.expandedDictionaryWords.delete(wordKey);

      const flashcardIdToRemove = `${wordKey}_flashcard`;
      this.flashcards = this.flashcards.filter(fc => fc.id !== flashcardIdToRemove);
      this.flashcardIntervals.delete(flashcardIdToRemove);
      this.flashcardFlipState.delete(flashcardIdToRemove);

      this.dictionaryEntries = new Map(this.dictionaryEntries); 
      this.saveProfileData();
      this.sortAndInitializeFlashcardQueue();
      this.requestUpdate();
      
      if (this.popupData && this.popupData.word.toLowerCase().trim() === wordKey) {
        this.closePopup();
      }
    }
  }

  private sortAndInitializeFlashcardQueue() {
    // Only show cards that are due for review
    const cardsToShow = this.getCardsToShow();
    
    this.flashcardQueue = cardsToShow
      .sort((a, b) => {
        // Sort by due date first (overdue cards first)
        if (a.dueDate !== b.dueDate) return a.dueDate - b.dueDate;
        
        // Then by status priority (new > learning > review)
        const statusPriority = { new: 0, learning: 1, review: 2 };
        const priorityA = statusPriority[a.status];
        const priorityB = statusPriority[b.status];
        if (priorityA !== priorityB) return priorityA - priorityB;
        
        // Then by frequency (more frequent words first)
        const freqA = a.dictionaryEntry.frequency ?? 0; 
        const freqB = b.dictionaryEntry.frequency ?? 0;
        if (freqB !== freqA) return freqB - freqA; 

        return a.dictionaryEntry.dateAdded - b.dictionaryEntry.dateAdded; 
      })
      .map(fc => fc.id);

    this.flashcardQueue.forEach(id => this.flashcardFlipState.set(id, false));
    
    if (this.currentFlashcardQueueIndex >= this.flashcardQueue.length) {
        this.currentFlashcardQueueIndex = Math.max(0, this.flashcardQueue.length - 1);
    }
    if (this.flashcardQueue.length > 0 && this.currentFlashcardQueueIndex < 0) {
        this.currentFlashcardQueueIndex = 0;
    }
    if (this.flashcardQueue.length === 0) {
        this.currentFlashcardQueueIndex = 0;
    }
    
    // Preload audio for current card
    if (this.flashcardQueue.length > 0) {
      const currentCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
      if (currentCardId) {
        this.preloadFlashcardAudio(currentCardId);
      }
    }
    
    this.requestUpdate('flashcardQueue'); 
  }

  private handleFlashcardFlip(cardId?: string) {
    if (!cardId) return;
    
    const wasFlipped = this.flashcardFlipState.get(cardId) || false;
    const willBeFlipped = !wasFlipped;
    
    this.flashcardFlipState.set(cardId, willBeFlipped);
    this.requestUpdate('flashcardFlipState');
    
    // Auto-play audio when flipping to the back (answer side)
    if (willBeFlipped) {
      // Small delay to let the flip animation start, then play audio
      setTimeout(() => {
        const card = this.flashcards.find(fc => fc.id === cardId);
        if (card && card.exampleSentences && card.exampleSentences.length > 0) {
          const currentInterval = this.flashcardIntervals.get(cardId) || 1;
          const sentenceIndex = (currentInterval - 1) % card.exampleSentences.length;
          const currentExample = card.exampleSentences[sentenceIndex];
          
          if (currentExample?.english) {
            this.speakFlashcardText(currentExample.english, true); // Use preloaded audio
          }
        }
      }, 300); // Delay matches the flip animation duration
    }
  }

  private handleFlashcardAnswer(cardId: string, isCorrect: boolean) {
    if (!cardId) return;
    
    // Update card status and stats
    const card = this.flashcards.find(fc => fc.id === cardId);
    if (card) {
      if (isCorrect) {
        card.correctCount++;
        // Anki-style spaced repetition logic will be implemented here
        this.updateCardWithAnkiLogic(card, true);
      } else {
        card.incorrectCount++;
        this.updateCardWithAnkiLogic(card, false);
      }
    }
    
    // Update interval
    let interval = this.flashcardIntervals.get(cardId) || 1;
    if (isCorrect) {
        interval++;
    } else {
        interval = Math.max(1, interval - 1);
    }
    this.flashcardIntervals.set(cardId, interval);
    this.flashcardFlipState.set(cardId, false); 

    // Animate card sliding out to the right (correct) or left (incorrect)
    this.flashcardAnimationState = isCorrect ? 'sliding-right' : 'sliding-left';
    this.requestUpdate();
    
    // After animation, handle card queue management
    setTimeout(() => {
      const cardIndexInQueue = this.flashcardQueue.indexOf(cardId);
      const card = this.flashcards.find(fc => fc.id === cardId);
      
      if (cardIndexInQueue > -1) {
        // Check if card is done for today (due date is in the future)
        const now = Date.now();
        if (card && card.dueDate > now) {
          // Card is done for today - remove from queue completely
          this.flashcardQueue.splice(cardIndexInQueue, 1);
          
          // Adjust current index if needed
          if (this.currentFlashcardQueueIndex >= this.flashcardQueue.length) {
            this.currentFlashcardQueueIndex = Math.max(0, this.flashcardQueue.length - 1);
          }
        } else {
          // Card is still due - move to end of queue
          this.flashcardQueue.splice(cardIndexInQueue, 1);
          this.flashcardQueue.push(cardId);
          
          if (this.currentFlashcardQueueIndex >= this.flashcardQueue.length) {
            this.currentFlashcardQueueIndex = 0; 
          }
        }
      }
      
      // Animate new card entering from opposite side
      this.flashcardAnimationState = isCorrect ? 'entering-left' : 'entering-right';
      
      if (this.flashcardQueue.length > 0) {
          const nextCardIdToShow = this.flashcardQueue[this.currentFlashcardQueueIndex];
          this.flashcardFlipState.set(nextCardIdToShow, false);
          // Preload audio for the next card
          this.preloadFlashcardAudio(nextCardIdToShow);
      }
      
      this.requestUpdate();
      
      // Reset animation state
      setTimeout(() => {
        this.flashcardAnimationState = 'idle';
        this.requestUpdate();
      }, 300);
      
    }, 300); // Wait for slide out animation
    
    this.saveProfileData();
  }

  private getFlashcardStatusCounts() {
    const counts = {
      new: 0,
      learning: 0,
      review: 0
    };
    
    for (const card of this.flashcards) {
      counts[card.status]++;
    }
    
    return counts;
  }

  private speakFlashcardText(textContent: any, usePreloaded: boolean = false) {
    if (!('speechSynthesis' in window)) {
      console.warn('Text-to-speech not supported in this browser');
      return;
    }

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    // Extract plain text from HTML content
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = String(textContent);
    const plainText = tempDiv.textContent || tempDiv.innerText || '';

    if (!plainText.trim()) {
      console.warn('No text content to speak');
      return;
    }

    let utterance: SpeechSynthesisUtterance;
    
    // Use preloaded utterance if available and requested
    const currentCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
    if (usePreloaded && currentCardId && this.preloadedUtterances.has(currentCardId)) {
      utterance = this.preloadedUtterances.get(currentCardId)!;
      console.log(`🔊 Using preloaded utterance for instant playback`);
    } else {
      // Create new utterance
      utterance = new SpeechSynthesisUtterance(plainText);
      
      // Set language based on target language
      const speechLang = this.mapLanguageToSpeechCode(this.targetLanguage);
      utterance.lang = speechLang;
      
      // Configure speech settings
      utterance.rate = 0.8; // Slightly slower for language learning
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
    }

    // Speak the text
    window.speechSynthesis.speak(utterance);
    
    console.log(`🔊 Speaking "${plainText}" in ${this.mapLanguageToSpeechCode(this.targetLanguage)}`);
  }

  private preloadFlashcardAudio(cardId: string) {
    if (!('speechSynthesis' in window)) {
      return;
    }

    // Don't preload the same card twice
    if (this.currentPreloadingCardId === cardId) {
      return;
    }

    const card = this.flashcards.find(fc => fc.id === cardId);
    if (!card || !card.exampleSentences || card.exampleSentences.length === 0) {
      return;
    }

    const currentInterval = this.flashcardIntervals.get(cardId) || 1;
    const sentenceIndex = (currentInterval - 1) % card.exampleSentences.length;
    const currentExample = card.exampleSentences[sentenceIndex];
    
    if (!currentExample?.english) {
      return;
    }

    // Extract plain text
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = String(currentExample.english);
    const plainText = tempDiv.textContent || tempDiv.innerText || '';

    if (!plainText.trim()) {
      return;
    }

    // Create and configure utterance
    const utterance = new SpeechSynthesisUtterance(plainText);
    const speechLang = this.mapLanguageToSpeechCode(this.targetLanguage);
    utterance.lang = speechLang;
    utterance.rate = 0.8;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Store preloaded utterance
    this.preloadedUtterances.set(cardId, utterance);
    this.currentPreloadingCardId = cardId;

    console.log(`🎯 Preloaded TTS for card: ${cardId} - "${plainText}"`);
  }

  private mapLanguageToSpeechCode(languageName: string): string {
    switch (languageName.toLowerCase()) {
      case 'english':
        return 'en-US';
      case 'spanish':
        return 'es-ES';
      case 'portuguese':
        return 'pt-BR';
      default:
        return 'en-US';
    }
  }

  private updateCardWithAnkiLogic(card: Flashcard, isCorrect: boolean) {
    const now = Date.now();
    card.lastReviewed = now;

    if (card.status === 'new') {
      if (isCorrect) {
        card.learningStep++;
        if (card.learningStep >= 2) {
          // Graduate to review with 1 day interval
          card.status = 'review';
          card.interval = 1;
          card.dueDate = now + (1 * 24 * 60 * 60 * 1000); // 1 day from now
        } else {
          // Stay in learning, next step
          card.status = 'learning';
          const learningIntervals = [1, 10]; // 1 minute, 10 minutes
          card.dueDate = now + (learningIntervals[card.learningStep - 1] * 60 * 1000);
        }
      } else {
        // Reset learning steps
        card.learningStep = 0;
        card.dueDate = now + (1 * 60 * 1000); // 1 minute from now
      }
    } else if (card.status === 'learning') {
      if (isCorrect) {
        card.learningStep++;
        if (card.learningStep >= 2) {
          // Graduate to review
          card.status = 'review';
          card.interval = 1;
          card.dueDate = now + (1 * 24 * 60 * 60 * 1000); // 1 day from now
        } else {
          // Continue learning
          const learningIntervals = [1, 10]; // 1 minute, 10 minutes
          card.dueDate = now + (learningIntervals[card.learningStep - 1] * 60 * 1000);
        }
      } else {
        // Reset to beginning of learning
        card.learningStep = 0;
        card.dueDate = now + (1 * 60 * 1000); // 1 minute from now
      }
         } else if (card.status === 'review') {
       if (isCorrect) {
         // Increase interval using ease factor
         if (card.interval === 0) {
           card.interval = 1;
         } else if (card.interval === 1) {
           card.interval = 6; // Second review interval
         } else {
           card.interval = Math.round(card.interval * card.easeFactor);
         }
         card.dueDate = now + (card.interval * 24 * 60 * 60 * 1000);
       } else {
         // Reset to learning
         card.status = 'learning';
         card.learningStep = 0;
         card.interval = 0;
         card.dueDate = now + (1 * 60 * 1000); // 1 minute from now
       }
     }
     
     console.log(`🎯 Updated card "${card.dictionaryEntry.word}": status=${card.status}, interval=${card.interval}, dueDate=${new Date(card.dueDate).toLocaleString()}, isCorrect=${isCorrect}`);
   }

  private getCardsToShow(): Flashcard[] {
    const now = Date.now();
    return this.flashcards.filter(card => card.dueDate <= now);
  }

  private getDaysUntilDue(dueDate: number): number {
    const now = Date.now();
    const diffMs = dueDate - now;
    return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  }

  private formatDueDate(dueDate: number): string {
    const now = Date.now();
    const diffMs = dueDate - now;
    const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    
    if (diffDays < 0) {
      return `${Math.abs(diffDays)} days overdue`;
    } else if (diffDays === 0) {
      return 'Due today';
    } else if (diffDays === 1) {
      return 'Due tomorrow';
    } else {
      return `Due in ${diffDays} days`;
    }
  }

  private getDueStatus(dueDate: number): 'due-today' | 'overdue' | 'future' {
    const now = Date.now();
    const diffDays = Math.ceil((dueDate - now) / (24 * 60 * 60 * 1000));
    
    if (diffDays < 0) return 'overdue';
    if (diffDays === 0) return 'due-today';
    return 'future';
  }

  private getUpcomingReviews(): Array<{dateString: string, words: string[]}> {
    const now = Date.now();
    const futureCards = this.flashcards.filter(card => card.dueDate > now);
    
    // Group cards by due date
    const groupedByDate = new Map<string, string[]>();
    
    futureCards.forEach(card => {
      const date = new Date(card.dueDate);
      const dateString = date.toLocaleDateString();
      
      if (!groupedByDate.has(dateString)) {
        groupedByDate.set(dateString, []);
      }
      groupedByDate.get(dateString)!.push(card.dictionaryEntry.word);
    });
    
    // Convert to array and sort by date
    const reviews = Array.from(groupedByDate.entries())
      .map(([dateString, words]) => ({ dateString, words }))
      .sort((a, b) => new Date(a.dateString).getTime() - new Date(b.dateString).getTime())
      .slice(0, 7); // Show next 7 days
    
    return reviews;
  }

  private isWordKnown(word: string): boolean {
    const normalizedWord = word.toLowerCase().trim();
    
    // First check if the word itself is in the dictionary
    if (this.dictionaryEntries.has(normalizedWord)) {
      return true;
    }
    
    // Check if any conjugated/inflected form of this word is known
    if (this.knownWordForms.has(normalizedWord)) {
      return true;
    }
    
    return false;
  }

  private async fetchWordForms(word: string, partOfSpeech: string, language: string): Promise<string[]> {
    console.log(`🔍 fetchWordForms called for "${word}", partOfSpeech: "${partOfSpeech}", language: "${language}"`);
    
    // Only fetch forms for verbs, as they have the most variations
    if (!partOfSpeech.toLowerCase().includes('verb') && !partOfSpeech.toLowerCase().includes('verbo')) {
      console.log(`📝 "${word}" is not a verb, returning base form only`);
      return [word.toLowerCase().trim()];
    }
    
    // For Spanish, use our comprehensive conjugation database
    if (language.toLowerCase() === 'spanish') {
      return await this.fetchSpanishVerbForms(word);
    }
    
    // For other languages, return just the base form
    console.log(`📝 Language "${language}" not supported for conjugation lookup, returning base form only`);
    return [word.toLowerCase().trim()];
  }

  private async fetchSpanishVerbForms(word: string): Promise<string[]> {
    const baseWord = word.toLowerCase().trim();
    console.log(`🔍 Fetching Spanish verb forms for "${baseWord}"`);
    
    try {
      // Determine which letter file to load
      const firstLetter = baseWord[0];
      const fileName = `./Conjugations/Spanish/by-letter/${firstLetter}.json`;
      
      console.log(`📁 Loading conjugation file: ${fileName}`);
      
      // Fetch the conjugation file for this letter
      const response = await fetch(fileName);
      if (!response.ok) {
        console.warn(`⚠️ Could not load conjugation file ${fileName}: ${response.status}`);
        return [baseWord]; // Return just the base word if file not found
      }
      
      const conjugationData = await response.json();
      const allForms = new Set<string>();
      
      // Add the base word itself
      allForms.add(baseWord);
      
      // Find all conjugated forms that belong to this infinitive
      for (const [conjugatedForm, entries] of Object.entries(conjugationData)) {
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry.infinitive && entry.infinitive.toLowerCase() === baseWord) {
              // Only add the conjugated form if it's not an auxiliary verb FROM A DIFFERENT VERB
              const formToCheck = conjugatedForm.toLowerCase();
              if (!this.isAuxiliaryFromDifferentVerb(formToCheck, baseWord)) {
                allForms.add(formToCheck);
              }
              break; // Found a match for this conjugated form
            }
          }
        }
      }
      
      const formsArray = Array.from(allForms);
      console.log(`✅ Found ${formsArray.length} Spanish verb forms for "${baseWord}":`, formsArray.slice(0, 10));
      
      return formsArray;
      
    } catch (error) {
      console.error(`❌ Error fetching Spanish verb forms for "${baseWord}":`, error);
      return [baseWord]; // Return just the base word on error
    }
  }

  private isAuxiliaryFromDifferentVerb(word: string, targetVerb: string): boolean {
    // If we're looking for "ser", don't filter out ser's own conjugations
    // If we're looking for "haber", don't filter out haber's own conjugations
    // Only filter out auxiliary verbs from OTHER verbs
    
    const targetInfinitive = targetVerb.toLowerCase();
    
    // If the target verb itself is an auxiliary verb, allow all its forms
    if (['ser', 'estar', 'haber'].includes(targetInfinitive)) {
      return false; // Don't filter anything when looking for auxiliary verbs themselves
    }
    
    // For non-auxiliary verbs, filter out auxiliary forms from other verbs
    return this.isAuxiliaryOrPronoun(word);
  }

  private isAuxiliaryOrPronoun(word: string): boolean {
    const auxiliariesAndPronouns = [
      // Pronouns
      'me', 'te', 'se', 'nos', 'os', 'le', 'la', 'lo', 'les', 'las', 'los',
      // All forms of HABER (to have - auxiliary)
      'he', 'has', 'ha', 'hemos', 'habéis', 'han',
      'había', 'habías', 'habíamos', 'habíais', 'habían', 
      'habré', 'habrás', 'habrá', 'habremos', 'habréis', 'habrán',
      'haya', 'hayas', 'hayamos', 'hayáis', 'hayan',
      'hubiera', 'hubieras', 'hubiéramos', 'hubierais', 'hubieran',
      'hubiese', 'hubieses', 'hubiésemos', 'hubieseis', 'hubiesen',
      'hubiere', 'hubieres', 'hubiéremos', 'hubiereis', 'hubieren',
      'hube', 'hubiste', 'hubo', 'hubimos', 'hubisteis', 'hubieron',
      'habría', 'habrías', 'habríamos', 'habríais', 'habrían',
      // All forms of SER (to be - auxiliary)
      'soy', 'eres', 'es', 'somos', 'sois', 'son',
      'era', 'eras', 'éramos', 'erais', 'eran',
      'seré', 'serás', 'será', 'seremos', 'seréis', 'serán',
      'sea', 'seas', 'seamos', 'seáis', 'sean',
      'fuera', 'fueras', 'fuéramos', 'fuerais', 'fueran',
      'fuese', 'fueses', 'fuésemos', 'fueseis', 'fuesen',
      'fuere', 'fueres', 'fuéremos', 'fuereis', 'fueren',
      'fui', 'fuiste', 'fue', 'fuimos', 'fuisteis', 'fueron',
      'sería', 'serías', 'seríamos', 'seríais', 'serían',
      // All forms of ESTAR (to be - auxiliary)
      'estoy', 'estás', 'está', 'estamos', 'estáis', 'están',
      'estaba', 'estabas', 'estábamos', 'estabais', 'estaban',
      'estaré', 'estarás', 'estará', 'estaremos', 'estaréis', 'estarán',
      'esté', 'estés', 'estemos', 'estéis', 'estén',
      'estuviera', 'estuvieras', 'estuviéramos', 'estuvierais', 'estuvieran',
      'estuviese', 'estuvieses', 'estuviésemos', 'estuvieseis', 'estuviesen',
      'estuviere', 'estuvieres', 'estuviéremos', 'estuviereis', 'estuvieren',
      'estuve', 'estuviste', 'estuvo', 'estuvimos', 'estuvisteis', 'estuvieron',
      'estaría', 'estarías', 'estaríamos', 'estaríais', 'estarían'
    ];
    
    return auxiliariesAndPronouns.includes(word.toLowerCase());
  }

  private containsVerbStem(wordPart: string, baseVerb: string): boolean {
    // Extract the stem of the base verb (remove -ar, -er, -ir endings)
    let stem = baseVerb;
    if (baseVerb.endsWith('ar') || baseVerb.endsWith('er') || baseVerb.endsWith('ir')) {
      stem = baseVerb.slice(0, -2);
    }
    
    // For very short stems, be more strict
    if (stem.length < 3) {
      return wordPart.startsWith(stem) && wordPart.length >= stem.length + 1;
    }
    
    // Check if the word part contains the stem (handles stem changes)
    // For example: poner -> stem "pon", should match "puesto", "puse", etc.
    // Handle common stem changes
    if (stem.length >= 3) {
      const stemStart = stem.slice(0, -1); // Remove last letter to handle stem changes
      return wordPart.includes(stemStart) || wordPart.startsWith(stem);
    }
    
    return wordPart.includes(stem);
  }



  private calculateNextDueDateIfCorrect(card: Flashcard): string {
    const now = Date.now();
    let nextDueDate: number;

    if (card.status === 'new') {
      const nextLearningStep = card.learningStep + 1;
      if (nextLearningStep >= 2) {
        // Would graduate to review with 1 day interval
        nextDueDate = now + (1 * 24 * 60 * 60 * 1000);
      } else {
        // Would stay in learning
        const learningIntervals = [1, 10]; // 1 minute, 10 minutes
        nextDueDate = now + (learningIntervals[nextLearningStep - 1] * 60 * 1000);
      }
    } else if (card.status === 'learning') {
      const nextLearningStep = card.learningStep + 1;
      if (nextLearningStep >= 2) {
        // Would graduate to review
        nextDueDate = now + (1 * 24 * 60 * 60 * 1000);
      } else {
        // Would continue learning
        const learningIntervals = [1, 10]; // 1 minute, 10 minutes
        nextDueDate = now + (learningIntervals[nextLearningStep - 1] * 60 * 1000);
      }
    } else if (card.status === 'review') {
      // Calculate next review interval
      let nextInterval: number;
      if (card.interval === 0) {
        nextInterval = 1;
      } else if (card.interval === 1) {
        nextInterval = 6;
      } else {
        nextInterval = Math.round(card.interval * card.easeFactor);
      }
      nextDueDate = now + (nextInterval * 24 * 60 * 60 * 1000);
    } else {
      nextDueDate = now;
    }

    return this.formatDueDate(nextDueDate);
  }

  private navigateFlashcard(direction: 'next' | 'prev') {
    if (this.flashcardQueue.length === 0) return;

    const currentCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
    if (currentCardId) { 
        this.flashcardFlipState.set(currentCardId, false);
    }

    // Animate current card sliding out
    this.flashcardAnimationState = direction === 'next' ? 'sliding-left' : 'sliding-right';
    this.requestUpdate();
    
    setTimeout(() => {
      if (direction === 'next') {
          this.currentFlashcardQueueIndex = (this.currentFlashcardQueueIndex + 1) % this.flashcardQueue.length;
      } else {
          this.currentFlashcardQueueIndex = (this.currentFlashcardQueueIndex - 1 + this.flashcardQueue.length) % this.flashcardQueue.length;
      }
      
      // Animate new card entering from opposite side
      this.flashcardAnimationState = direction === 'next' ? 'entering-right' : 'entering-left';
      
      const newCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
      if (newCardId) {
          this.flashcardFlipState.set(newCardId, false);
          // Preload audio for the new card
          this.preloadFlashcardAudio(newCardId);
      }
      this.requestUpdate();
      
      // Reset animation state
      setTimeout(() => {
        this.flashcardAnimationState = 'idle';
        this.requestUpdate();
      }, 300);
      
    }, 300); // Wait for slide out animation
  }


  private renderMessageWithClickableWords(messageText: string) {
    const parts = messageText.split(/(\s+|[,.;!?:]+(?=\s|$)|(?<=\w)[,.;!?:]+)/g).filter(part => part);

    return parts.map((part) => {
      const trimmedPart = part.trim();
      const wordForApiMatch = trimmedPart.match(/^[\W]*([\w'-]+)[\W]*$/);
      const wordForApi = wordForApiMatch ? wordForApiMatch[1] : "";

      if (wordForApi === '') { 
        return part; 
      }
      
      const wordKey = wordForApi.toLowerCase().trim();
      const isKnown = this.isWordKnown(wordKey);
      const wordClass = `clickable-word ${isKnown ? 'known-word' : ''}`;

      return html`<span
        class="${wordClass}"
        @click=${(e: MouseEvent) => this.handleWordClick(e, wordForApi, messageText)}
        @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') this.handleWordClick(e as unknown as MouseEvent, wordForApi, messageText);}}
        role="button"
        tabindex="0"
        aria-description="${isKnown ? `Known word: ${wordForApi}. Click to see details.` : `Clickable word: ${wordForApi}. Click to see details.`}"
      >${part}</span>`; 
    });
  }

  private calculateFrequencyFromRank(rank: number | null, totalWords: number): number {
    if (!rank || totalWords <= 0) return 1;
    
    // Calculate percentile from rank (lower rank = higher percentile)
    const percentile = (totalWords - rank + 1) / totalWords;
    
    // Distribution: 5:4:3:2:1 = 1:2:4:8:16 (out of 31 parts)
    // Frequency 5 (most common): top 3.23% (1/31)
    // Frequency 4: next 6.45% (2/31) - top 9.68%
    // Frequency 3: next 12.90% (4/31) - top 22.58%
    // Frequency 2: next 25.81% (8/31) - top 48.39%
    // Frequency 1: remaining 51.61% (16/31)
    
    if (percentile >= 0.9677) {    // Top 3.23%
      return 5; // Very common/basic
    } else if (percentile >= 0.9032) {  // Top 9.68%
      return 4; // Common
    } else if (percentile >= 0.7742) {  // Top 22.58%
      return 3; // Neutral
    } else if (percentile >= 0.4839) {  // Top 48.39%
      return 2; // Uncommon
    } else {                        // Bottom 51.61%
      return 1; // Rare
    }
  }

  private renderFrequencyInfo(frequency: number | null, rank: number | null) {
    // Use rank-based calculation if we have rank data, otherwise fall back to frequency
    let displayFrequency: number;
    
    // Total words by language from metadata
    const totalWordsByLanguage: Record<string, number> = {
      'Spanish': 341461,
      'English': 319938,
      'Portuguese': 267444
    };
    
    const totalWords = totalWordsByLanguage[this.targetLanguage] || 341461;
    
    if (rank !== null && rank > 0) {
      displayFrequency = this.calculateFrequencyFromRank(rank, totalWords);
    } else if (frequency !== null && frequency >= 1 && frequency <= 5) {
      displayFrequency = frequency;
    } else {
      return html`<span style="color: #8a80a5; font-size: 12px;">N/A</span>`;
    }
    
    let color = '#22C55E'; 
    if (displayFrequency === 1) color = '#EF4444'; 
    else if (displayFrequency === 2) color = '#F97316'; 
    else if (displayFrequency === 3) color = '#FACC15'; 
    else if (displayFrequency === 4) color = '#84CC16'; 

    const rankText = rank ? `#${rank.toLocaleString()}` : '';
    
    return html`
      <div style="display: flex; flex-direction: column; align-items: center; gap: 2px;">
        <div class="frequency-dots" aria-label="Frequency: ${displayFrequency} out of 5">
          ${Array(displayFrequency).fill(0).map(() => html`<div class="frequency-dot" style="background-color: ${color};"></div>`)}
        </div>
        ${rank ? html`<div style="color: #666; font-size: 10px; font-weight: 600;">${rankText}</div>` : ''}
      </div>
    `;
  }

  private toggleDictionaryWordExpansion(wordKey: string) {
    if (this.expandedDictionaryWords.has(wordKey)) {
      this.expandedDictionaryWords.delete(wordKey);
    } else {
      this.expandedDictionaryWords.add(wordKey);
    }
    this.requestUpdate('expandedDictionaryWords');
  }

  private getDynamicFlashcardContent(card: Flashcard | undefined, interval: number) {
    if (!card || !card.exampleSentences || card.exampleSentences.length === 0) {
      return { front: 'Error: No sentence data for this card.', back: 'Error: No sentence data for this card.' };
    }

    const sentenceIndex = (interval - 1) % card.exampleSentences.length;
    const currentExample = card.exampleSentences[sentenceIndex]; 
    const targetWord = card.dictionaryEntry.word; 

    const blankedSentence = currentExample.english.replace(
      new RegExp(this.escapeRegExp(targetWord), 'gi'), '_______'
    );
    
    const frontHTML = html`
        <p>${blankedSentence}</p>
        <p class="portuguese-translation">${currentExample.portugueseTranslation}</p>
    `;

    const parts = currentExample.english.split(new RegExp(`(${this.escapeRegExp(targetWord)})`, 'gi'));
    const backHTML = html`${parts.map(part => 
        part.toLowerCase() === targetWord.toLowerCase() 
        ? html`<span class="highlighted-word">${part}</span>` 
        : part
    )}`;

    return { front: frontHTML, back: backHTML };
  }

  private async handleEvaluateTranscript() {
    this.isEvaluating = true;
    this.evaluationResult = null;
    this.evaluationError = null;
    this.requestUpdate();

    if (this.transcriptHistory.length === 0) {
      this.evaluationError = "Transcript is empty. Please have a conversation first.";
      this.isEvaluating = false;
      this.requestUpdate();
      return;
    }
    
    const result = await fetchEvaluationFromApi(this.transcriptHistory, this.targetLanguage, this.nativeLanguage);

    // Fix: Use type guard for EvaluationResult | EvaluationError
    if (result && 'error' in result) { // Type guard for EvaluationError
        const errorMessage = result.error || "Failed to evaluate transcript.";
        console.error("Error evaluating transcript:", errorMessage);
        this.evaluationError = errorMessage;
        this.evaluationResult = null; 
    } else if (result && 'evaluation' in result) { // It's EvaluationResult
        this.evaluationResult = result.evaluation;
        this.evaluationError = null;
    } else {
        // Should not happen if API service always returns an object from the union
        const errorMessage = "Failed to evaluate transcript. API returned no data.";
        console.error(errorMessage);
        this.evaluationError = errorMessage;
        this.evaluationResult = null;
    }
    
    this.isEvaluating = false;
    this.requestUpdate();
  }

  private renderLanguageSelectionScreen() {
    return html`
      <div class="language-selection-screen">
        <h2>Setup Your Learning Session</h2>
        <div class="language-selection-group">
          <label for="profile-select">Choose Profile:</label>
          <select id="profile-select" .value=${this.currentProfile} @change=${this.handleProfileChange}>
            ${this.profiles.map(profile => html`<option value=${profile}>${profile}</option>`)}
          </select>
        </div>
        <div class="language-selection-group">
          <label for="initial-native-lang-select">Your Native Language:</label>
          <select id="initial-native-lang-select" .value=${this.nativeLanguage} @change=${this.handleInitialNativeLanguageChange}>
            ${SUPPORTED_LANGUAGES.map(lang => html`<option value=${lang}>${lang}</option>`)}
          </select>
        </div>
        <div class="language-selection-group">
          <label for="initial-target-lang-select">Language You're Learning:</label>
          <select id="initial-target-lang-select" .value=${this.targetLanguage} @change=${this.handleInitialTargetLanguageChange}>
            ${SUPPORTED_LANGUAGES.map(lang => html`<option value=${lang}>${lang}</option>`)}
          </select>
        </div>
        <button class="start-button" @click=${this.handleStartConversation}>Start Conversation</button>
      </div>
    `;
  }

  private renderMainApplication() {
    const hostElement = this.shadowRoot?.host;
    if (hostElement) {
      (hostElement as HTMLElement).style.setProperty('--transcript-font-size', `${this.transcriptFontSize}px`);
    }

    const isWordInPopupDictionary = this.popupData ? 
      this.dictionaryEntries.has((this.popupData.lemmatizedWord || this.popupData.word).toLowerCase().trim()) : false;
    const isFetchingCurrentPopupWordEnrichments = this.popupData ? (this.isFetchingFrequencyFor === this.popupData.word || this.isFetchingSentencesFor === this.popupData.word) : false;
    
    const dictionaryButtonDisabledState = 
        (this.isPopupLoading && (!this.popupData || !this.popupData.definition)) || 
        isFetchingCurrentPopupWordEnrichments;

    const filteredDictionaryEntries = Array.from(this.dictionaryEntries.values()).filter(entry => 
      entry.word.toLowerCase().includes(this.dictionarySearchTerm.toLowerCase()) 
    ).sort((a, b) => {
      switch (this.dictionarySortOrder) {
        case 'frequency_desc': // Most frequent first (default)
          // Handle null frequencies - put them last
          if (a.frequency === null && b.frequency === null) return 0;
          if (a.frequency === null) return 1;
          if (b.frequency === null) return -1;
          if (a.frequency !== b.frequency) return b.frequency - a.frequency;
          // If frequencies are equal, sort by rank (lower rank = more common)
          if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
          return a.word.localeCompare(b.word); // Final fallback: alphabetical
          
        case 'frequency_asc': // Least frequent first
          if (a.frequency === null && b.frequency === null) return 0;
          if (a.frequency === null) return 1;
          if (b.frequency === null) return -1;
          if (a.frequency !== b.frequency) return a.frequency - b.frequency;
          // If frequencies are equal, sort by rank (higher rank = less common)
          if (a.rank !== null && b.rank !== null) return b.rank - a.rank;
          return a.word.localeCompare(b.word);
          
        case 'alphabetical': // A-Z
          return a.word.localeCompare(b.word);
          
        case 'alphabetical_reverse': // Z-A
          return b.word.localeCompare(a.word);
          
        case 'date_added_desc': // Most recent first
          return b.dateAdded - a.dateAdded;
          
        case 'date_added_asc': // Oldest first
          return a.dateAdded - b.dateAdded;
          
        default:
          return a.word.localeCompare(b.word);
      }
    });

    const transcriptButtonClasses = `tab-button ${this.activeTab === 'transcript' ? 'active' : ''}`;
    const dictionaryButtonClasses = `tab-button dictionary-tab-btn ${this.activeTab === 'dictionary' ? 'active' : ''}`;
    const flashcardsButtonClasses = `tab-button flashcards-tab-btn ${this.activeTab === 'flashcards' ? 'active' : ''}`;
    const evaluateButtonClasses = `tab-button evaluate-tab-btn ${this.activeTab === 'evaluate' ? 'active' : ''}`;


    const currentCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
    const currentFlashcard = this.flashcards.find(fc => fc.id === currentCardId);
    const isFlipped = currentCardId ? this.flashcardFlipState.get(currentCardId) === true : false;
    const currentInterval = currentCardId ? this.flashcardIntervals.get(currentCardId) || 1 : 1;
    const { front: flashcardFrontContent, back: flashcardBackContent } = this.getDynamicFlashcardContent(currentFlashcard, currentInterval);
    
    return html`
      <div class="app-container">
        ${this.isInitializingSession ? html`
          <div class="loading-overlay" role="alert" aria-live="assertive">
            <div class="loading-spinner"></div>
            <p>${this.isDiagnosticSessionActive ?
              `Loading Diagnostic Test for ${this.currentProfile}...` :
              `Initializing session with ${this.currentProfile}...`
            }</p>
          </div>
        ` : ''}

        <div class="left-panel" style="flex: 1 1 auto; min-width: ${this.minLeftPanelWidth}px;">
          <!-- Mode Selector -->
          <div class="mode-selector">
            <button 
              class="mode-tab ${this.leftPanelMode === 'ai' ? 'active' : ''}"
              @click=${() => this.handleModeSwitch('ai')}
              aria-pressed="${this.leftPanelMode === 'ai'}"
            >
              🤖 AI Mode
            </button>
            <button 
              class="mode-tab ${this.leftPanelMode === 'video' ? 'active' : ''}"
              @click=${() => this.handleModeSwitch('video')}
              aria-pressed="${this.leftPanelMode === 'video'}"
            >
              📹 Video Mode
            </button>
          </div>

          ${this.leftPanelMode === 'ai' ? html`
            <!-- AI Mode Interface -->
            <div class="controls">
              <button 
                id="recordButton" 
                @click=${this.isRecording ? this.stopRecording : this.startRecording} 
                ?disabled=${!this.openAIVoiceSession || this.isInitializingSession || this.isModelSpeaking} 
                class="${this.isRecording ? 'recording' : 'not-recording'}"
                aria-label="${this.isRecording ? 'Stop Recording' : 'Start Recording'}">
                ${this.isRecording ? html`
                  <svg viewBox="0 0 100 100" width="40px" height="40px" fill="#ffffff" xmlns="http://www.w3.org/2000/svg">
                    <rect x="15" y="15" width="70" height="70" rx="10" />
                  </svg>
                ` : html`
                  <svg viewBox="0 0 100 100" width="40px" height="40px" fill="#c80000" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="50" cy="50" r="45" />
                  </svg>
                `}
              </button>
            </div>
            <div id="status" role="status" aria-live="polite"> ${this.error || this.status} </div>
            <gdm-live-audio-visuals-3d .inputNode=${this.inputNode} .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
          ` : html`
            <!-- Video Mode Interface -->
            <div class="video-interface">
              <!-- Layout Selector -->
              <div class="video-layout-selector">
                <button 
                  class="layout-option vertical ${this.videoLayout === 'vertical' ? 'active' : ''}"
                  @click=${() => this.handleVideoLayoutChange('vertical')}
                  title="Vertical layout"
                ></button>
                <button 
                  class="layout-option horizontal ${this.videoLayout === 'horizontal' ? 'active' : ''}"
                  @click=${() => this.handleVideoLayoutChange('horizontal')}
                  title="Side by side"
                ></button>
                <button 
                  class="layout-option pip ${this.videoLayout === 'pip' ? 'active' : ''}"
                  @click=${() => this.handleVideoLayoutChange('pip')}
                  title="Picture-in-picture"
                ></button>
              </div>

              <!-- Video Container -->
              <div class="video-container ${this.videoLayout}">
                ${this.renderVideoScreens()}
              </div>
              
              <!-- Video Controls -->
              <div class="video-controls">
                <select 
                  class="video-language-select"
                  .value=${this.selectedVideoLanguage}
                  @change=${(e: Event) => this.selectedVideoLanguage = (e.target as HTMLSelectElement).value}
                  title="Select language for speech recognition"
                >
                  <option value="auto">🌐 Auto-detect</option>
                  <option value="en">🇺🇸 English</option>
                  <option value="es">🇪🇸 Spanish</option>
                  <option value="pt">🇵🇹 Portuguese</option>
                  <option value="fr">🇫🇷 French</option>
                  <option value="de">🇩🇪 German</option>
                  <option value="it">🇮🇹 Italian</option>
                  <option value="ja">🇯🇵 Japanese</option>
                  <option value="ko">🇰🇷 Korean</option>
                  <option value="zh">🇨🇳 Chinese</option>
                </select>
                
                <button 
                  class="video-control-btn ${this.videoStream ? 'active' : ''}"
                  @click=${this.videoStream ? () => this.stopWebcam() : () => this.startWebcam()}
                  ?disabled=${this.isVideoLoading}
                >
                  ${this.videoStream ? '📹 Stop Camera' : '📷 Start Camera'}
                </button>
                <button 
                  class="video-control-btn ${!this.isVideoMicMuted ? 'active' : ''}"
                  @click=${this.toggleVideoMic}
                  title="${this.isVideoMicMuted ? 'Unmute microphone for subtitles' : 'Mute microphone (disable subtitles)'}"
                >
                  ${this.isVideoMicMuted ? '🔇 Mic Off' : 
                    this.videoConnectionStatus === 'connecting' ? '⏳ Connecting...' :
                    this.videoConnectionStatus === 'connected' ? '🎤 Mic On' :
                    this.videoConnectionStatus === 'error' ? '❌ Mic Error' : '🎤 Mic On'}
                </button>
                
                <!-- Video Calling Controls -->
                <div class="video-calling-section">
                  ${this.callStatus === 'idle' ? html`
                    <button 
                      class="video-control-btn host-call-btn"
                      @click=${this.handleHostCall}
                      ?disabled=${this.isHostingCall}
                    >
                      📞 Host Call
                    </button>
                    
                    <div class="join-call-group">
                      <input 
                        type="text" 
                        class="join-code-input"
                        placeholder="Enter 5-digit code"
                        maxlength="5"
                        .value=${this.joinCodeInput}
                        @input=${(e: Event) => this.joinCodeInput = (e.target as HTMLInputElement).value}
                        ?disabled=${this.isJoiningCall}
                      />
                      <button 
                        class="video-control-btn join-call-btn"
                        @click=${this.handleJoinCall}
                        ?disabled=${this.isJoiningCall || this.joinCodeInput.length !== 5}
                      >
                        ${this.isJoiningCall ? '⏳ Joining...' : '🤝 Join Call'}
                      </button>
                    </div>
                  ` : html`
                    <div class="call-status-display">
                      ${this.callStatus === 'hosting' ? html`
                        <div class="call-info">
                          <span class="call-code">Code: ${this.callCode}</span>
                          <span class="call-status">Waiting for someone to join...</span>
                        </div>
                      ` : this.callStatus === 'joining' ? html`
                        <div class="call-info">
                          <span class="call-status">Connecting to call...</span>
                        </div>
                      ` : this.callStatus === 'connected' ? html`
                        <div class="call-info">
                          <span class="call-status">🟢 Connected!</span>
                        </div>
                      ` : this.callStatus === 'error' ? html`
                        <div class="call-info error">
                          <span class="call-status">❌ ${this.callError}</span>
                        </div>
                      ` : ''}
                      
                      <button 
                        class="video-control-btn end-call-btn"
                        @click=${this.handleEndCall}
                      >
                        📞 End Call
                      </button>
                    </div>
                  `}
                </div>
              </div>
            </div>
          `}
        </div>
        <div class="panel-divider" @mousedown=${this.handlePanelDragStart}></div>
        <div class="right-panel" style="width: ${this.rightPanelWidth}px; flex-shrink: 0;">
          <div class="tabs">
            <button 
              class="${transcriptButtonClasses}" 
              @click=${() => this.activeTab = 'transcript'}
              aria-pressed="${this.activeTab === 'transcript'}"
              aria-controls="transcript-content">Transcript</button>
            <button 
              class="${dictionaryButtonClasses}" 
              @click=${() => this.activeTab = 'dictionary'}
              aria-pressed="${this.activeTab === 'dictionary'}"
              aria-controls="dictionary-content">Dictionary (${this.currentProfile})</button>
            <button 
              class="${flashcardsButtonClasses}" 
              @click=${() => this.activeTab = 'flashcards'}
              aria-pressed="${this.activeTab === 'flashcards'}"
              aria-controls="flashcards-content">Flashcards (${this.currentProfile})</button>
            <button
              class="${evaluateButtonClasses}"
              @click=${() => {
                if (this.isDiagnosticSessionActive) {
                  this.evaluationError = "Evaluation is available after the initial diagnostic session.";
                  this.activeTab = 'evaluate'; 
                  this.requestUpdate('activeTab', 'evaluationError');
                } else {
                  this.evaluationError = null; 
                  this.activeTab = 'evaluate';
                }
              }}
              aria-pressed="${this.activeTab === 'evaluate'}"
              aria-controls="evaluate-content"
              ?disabled=${this.isInitializingSession}
              title="${this.isDiagnosticSessionActive ? 'Evaluation available after diagnostic' : 'Evaluate conversation'}">
              Evaluate
            </button>
          </div>

          ${this.activeTab === 'transcript' ? html`
            <div class="transcript-header" id="transcript-content" role="tabpanel" aria-labelledby="transcript-tab-button">
              <span class="transcript-title ${this.isDiagnosticSessionActive ? 'diagnostic' : ''}">
                ${this.isDiagnosticSessionActive ? 'DIAGNOSTIC SESSION' : `${this.leftPanelMode.toUpperCase()} TRANSCRIPT (${this.currentProfile} | ${this.targetLanguage})`}
              </span>
              <div class="font-controls">
                <button class="font-size-button" @click=${this.decreaseFontSize} aria-label="Decrease font size">-</button>
                <button class="font-size-button" @click=${this.increaseFontSize} aria-label="Increase font size">+</button>
              </div>
            </div>
            <div class="transcript-messages-container" id="transcriptMessagesContainer">
              <div class="transcript-messages">
                ${this.transcriptHistory.map((msg, index, arr) => html`
                  <p class="transcript-message ${msg.speaker === 'user' ? 'user' : ''} ${index === arr.length - 1 ? 'latest' : ''}"
                     style="font-size: var(--transcript-font-size, ${this.transcriptFontSize}px);"
                     data-speaker="${msg.speaker}">
                    ${this.renderMessageWithClickableWords(msg.text)}
                  </p>
                `)}
              </div>
              <p id="word-interaction-desc" class="sr-only">Click on a word to see its translation and definition. Known words are highlighted in blue.</p>
            </div>
          ` : ''}

          ${this.activeTab === 'dictionary' ? html`
            <div class="dictionary-content" id="dictionary-content" role="tabpanel" aria-labelledby="dictionary-tab-button">
              <div class="dictionary-controls">
                <div class="search-bar">
                  <input 
                    type="search" 
                    placeholder="Search words... (Press '/' to focus)" 
                    .value=${this.dictionarySearchTerm}
                    @input=${(e: Event) => this.dictionarySearchTerm = (e.target as HTMLInputElement).value}
                    aria-label="Search dictionary words"
                  />
                </div>
                 <span class="dictionary-word-count">${filteredDictionaryEntries.length} word${filteredDictionaryEntries.length !== 1 ? 's' : ''}</span>
                <div class="dictionary-options">
                   <select class="sort-by-select" .value=${this.dictionarySortOrder} @change=${(e: Event) => this.dictionarySortOrder = (e.target as HTMLSelectElement).value as any} aria-label="Sort dictionary words by">
                        <option value="frequency_desc">Frequency (Most Common First)</option>
                        <option value="frequency_asc">Frequency (Least Common First)</option>
                        <option value="alphabetical">Alphabetical (A-Z)</option>
                        <option value="alphabetical_reverse">Alphabetical (Z-A)</option>
                        <option value="date_added_desc">Date Added (Newest First)</option>
                        <option value="date_added_asc">Date Added (Oldest First)</option>
                    </select>
                    <button class="dictionary-action-button" title="Frequency Guide (Coming Soon)" disabled>
                        <span class="icon">ℹ️</span> Frequency Guide
                    </button>
                </div>
              </div>
              <div class="dictionary-list">
                ${filteredDictionaryEntries.length > 0 ? filteredDictionaryEntries.map(entry => {
                  const entryWordKey = entry.word.toLowerCase().trim();
                  return html`
                  <div 
                    class="dictionary-entry ${this.expandedDictionaryWords.has(entryWordKey) ? 'expanded' : ''}"
                    @click=${() => this.toggleDictionaryWordExpansion(entryWordKey)}
                    tabindex="0"
                    role="button"
                    aria-expanded="${this.expandedDictionaryWords.has(entryWordKey)}"
                    aria-controls="details-${entryWordKey}"
                    @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') this.toggleDictionaryWordExpansion(entryWordKey);}}
                  >
                    <div class="dictionary-entry-summary">
                      <span class="dictionary-entry-word">${entry.word}</span>
                      <div style="display: flex; align-items: center; gap: 10px;">
                        ${this.renderFrequencyInfo(entry.frequency, entry.rank)}
                        <button 
                          class="delete-dictionary-entry-btn"
                          @click=${async (e: Event) => { e.stopPropagation(); await this.handleDeleteDictionaryEntry(entryWordKey); }}
                          title="Delete '${entry.word}' from dictionary"
                          aria-label="Delete ${entry.word} from dictionary for profile ${this.currentProfile}"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 21q-.825 0-1.412-.587T5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413T17 21zM17 6H7v13h10zM9 17h2V8H9zm4 0h2V8h-2z"></path></svg>
                        </button>
                        <span class="expand-arrow">${this.expandedDictionaryWords.has(entryWordKey) ? '▼' : '▶'}</span>
                      </div>
                    </div>
                    ${this.expandedDictionaryWords.has(entryWordKey) ? html`
                      <div class="dictionary-entry-details" id="details-${entryWordKey}">
                        ${entry.partOfSpeech && entry.partOfSpeech !== 'N/A' ? html`<div class="popup-part-of-speech">${entry.partOfSpeech}</div>` : ''}
                        ${entry.translation && entry.translation !== 'N/A' ? html`
                            <div><span class="popup-label">Translation (to ${this.nativeLanguage})</span><span class="popup-content-text">${entry.translation}</span></div>` : ''}
                        ${entry.definition && entry.definition !== 'N/A' ? html`
                            <div><span class="popup-label">Definition (in ${this.nativeLanguage})</span><span class="popup-content-text">${entry.definition}</span></div>` : ''}
                        ${entry.sentenceContext ? html`
                            <div><span class="popup-label">Original Context (in ${this.targetLanguage})</span><span class="popup-content-text"><em>"${entry.sentenceContext}"</em></span></div>` : ''}
                      </div>
                    ` : ''}
                  </div>
                `}) : html`<p style="text-align:center; color: #8a80a5; margin-top: 20px;">No words in dictionary${this.dictionarySearchTerm ? ' match your search' : ''}. Add words from the transcript!</p>`}
              </div>
            </div>
          ` : ''}

          ${this.activeTab === 'flashcards' ? html`
            <div class="flashcards-content" id="flashcards-content" role="tabpanel" aria-labelledby="flashcards-tab-button">
              ${this.flashcardQueue.length === 0 ? html`
                <p class="no-flashcards-message">Add words to your dictionary (${this.currentProfile}) to generate flashcards!</p>
              ` : html`
                <div class="flashcard-viewer">
                  <div class="flashcard-scene" @click=${() => this.handleFlashcardFlip(currentCardId)} role="button" tabindex="0" aria-label="Flip card. Front: ${this.targetLanguage} sentence with blank. Back: Full ${this.targetLanguage} sentence.">
                    <div class="flashcard-container ${isFlipped ? 'flipped' : ''} ${this.flashcardAnimationState !== 'idle' ? this.flashcardAnimationState : ''}">
                      <div class="flashcard card-front">
                        ${currentFlashcard ? html`
                          <div class="flashcard-due-info ${this.getDueStatus(currentFlashcard.dueDate)}">
                            📅 ${this.formatDueDate(currentFlashcard.dueDate)}
                          </div>
                        ` : ''}
                        <div class="flashcard-content-area" lang="${this.mapLanguageToBcp47(this.targetLanguage)}">${flashcardFrontContent}</div>
                      </div>
                      <div class="flashcard card-back">
                        <button 
                          class="flashcard-tts-button" 
                          @click=${(e: Event) => { 
                            e.stopPropagation(); 
                            this.speakFlashcardText(currentFlashcard?.exampleSentences?.[((currentInterval - 1) % (currentFlashcard?.exampleSentences?.length || 1))]?.english || '', true);
                          }}
                          title="Listen to pronunciation in ${this.targetLanguage}"
                          aria-label="Speak sentence in ${this.targetLanguage}">
                          🔊
                        </button>
                        <div class="flashcard-content-area" lang="${this.mapLanguageToBcp47(this.targetLanguage)}">${flashcardBackContent}</div>
                        <div class="flashcard-interval">Interval: ${currentInterval}</div>
                        <div class="flashcard-actions">
                          <button class="incorrect-btn" @click=${(e: Event) => { e.stopPropagation(); this.handleFlashcardAnswer(currentCardId!, false); }} aria-label="Mark as incorrect">Incorrect</button>
                          <button 
                            class="correct-btn" 
                            @click=${(e: Event) => { e.stopPropagation(); this.handleFlashcardAnswer(currentCardId!, true); }} 
                            aria-label="Mark as correct"
                            title="${currentFlashcard ? `Next review: ${this.calculateNextDueDateIfCorrect(currentFlashcard)}` : 'Mark as correct'}">
                            Correct
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="flashcard-nav">
                    <button @click=${() => this.navigateFlashcard('prev')} ?disabled=${this.flashcardQueue.length <= 1} aria-label="Previous card">◄</button>
                    <span class="card-count">
                      ${(() => {
                        const counts = this.getFlashcardStatusCounts();
                        return html`<span style="color: #60a5fa;">${counts.new}</span> + <span style="color: #f97316;">${counts.learning}</span> + <span style="color: #22c55e;">${counts.review}</span>`;
                      })()}
                    </span>
                    <button @click=${() => this.navigateFlashcard('next')} ?disabled=${this.flashcardQueue.length <= 1} aria-label="Next card">►</button>
                  </div>
                  
                  ${this.flashcards.length > 0 ? html`
                    <div class="calendar-view">
                      <div class="calendar-header">
                        📅 Upcoming Reviews
                      </div>
                      ${this.getUpcomingReviews().map(review => html`
                        <div class="calendar-entry">
                          <span class="calendar-date">${review.dateString}</span>
                          <span class="calendar-word">${review.words.join(', ')}</span>
                        </div>
                      `)}
                      ${this.getUpcomingReviews().length === 0 ? html`
                        <div class="calendar-entry">All reviews complete for now! 🎉</div>
                      ` : ''}
                    </div>
                  ` : ''}
                </div>
              `}
            </div>
          ` : ''}

          ${this.activeTab === 'evaluate' ? html`
            <div class="evaluate-content" id="evaluate-content" role="tabpanel" aria-labelledby="evaluate-tab-button">
              ${this.isDiagnosticSessionActive ? html`
                <h3>Diagnostic Session Active</h3>
                <p>The "Evaluate" feature will be available after you complete the initial diagnostic session for ${this.currentProfile}.</p>
                <p>Please continue the diagnostic with the AI tutor.</p>
              ` : html`
                <h3>Evaluate Your ${this.targetLanguage} (${this.currentProfile})</h3>
                ${this.isEvaluating ? html`
                  <p>Evaluating transcript...</p>
                ` : this.evaluationError ? html`
                  <p class="evaluation-error-message">Error: ${this.evaluationError}</p>
                  <button class="evaluate-button" @click=${this.handleEvaluateTranscript}>Try Again</button>
                ` : this.evaluationResult ? html`
                  <h4>General Areas for Improvement</h4>
                  ${this.evaluationResult.improvementAreas.length > 0 ? this.evaluationResult.improvementAreas.map(area => html`
                    <div class="suggestion-item">
                      <p><strong>Category (in ${this.targetLanguage}):</strong> ${area.category}</p>
                      <p><strong>Focus (in ${this.nativeLanguage}):</strong> ${area.description}</p>
                    </div>
                  `) : html`<p>Great job! No broad areas for improvement identified in this transcript.</p>`}

                  <h4>Overall Performance (CEFR Level)</h4>
                  <p class="evaluation-cefr-level">${this.evaluationResult.cefrLevel}</p>
                  <button class="evaluate-button" @click=${this.handleEvaluateTranscript} ?disabled=${this.isEvaluating}>
                    ${this.isEvaluating ? 'Re-evaluating...' : 'Re-evaluate Transcript'}
                  </button>
                ` : html`
                  <p>Get feedback on your conversation performance. This will send the current transcript to an AI for evaluation based on broad categories.</p>
                  <button class="evaluate-button" @click=${this.handleEvaluateTranscript} ?disabled=${this.isEvaluating || this.transcriptHistory.length === 0} title="${this.transcriptHistory.length === 0 ? 'Have a conversation first' : 'Upload transcript'}">
                    ${this.isEvaluating ? 'Evaluating...' : 'Upload Transcript for Evaluation'}
                  </button>
                `}
              `}
            </div>
          ` : ''}

        </div>
      </div>

      ${this.popupData ? html`
        <div class="popup-overlay" @click=${this.closePopup} role="presentation"></div>
        <div class="word-popup"
             style="top: ${this.popupData.y}px; left: ${this.popupData.x}px;"
             role="dialog" aria-labelledby="popup-selected-word-title" aria-describedby="popup-details" aria-modal="true" aria-live="assertive">
          <button @click=${this.closePopup} class="popup-close-btn" aria-label="Close word details popup">&times;</button>
          
          <div class="word-popup-header">
            <span id="popup-selected-word-title" class="popup-selected-word">${this.popupData.displayWord || this.popupData.word}</span>
            <button
              class="dictionary-toggle-btn ${isWordInPopupDictionary ? 'added' : ''}"
              @click=${() => this.handleToggleDictionary(this.popupData!)}
              title="${isWordInPopupDictionary ? 'Remove from Dictionary' : 'Add to Dictionary'}"
              aria-label="${isWordInPopupDictionary ? 'Remove ' + (this.popupData.displayWord || this.popupData.word) + ' from Dictionary (' + this.currentProfile + ')' : 'Add ' + (this.popupData.displayWord || this.popupData.word) + ' to Dictionary (' + this.currentProfile + ')'}"
              aria-pressed="${isWordInPopupDictionary ? 'true' : 'false'}"
              ?disabled=${dictionaryButtonDisabledState}
            >
              ${isWordInPopupDictionary ?
                html`<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>` :
                (this.isPopupLoading && (!this.popupData || !this.popupData.definition)) ? 
                  html`<div class="loading-spinner" style="width:14px; height:14px; border-width:2px;"></div>` :
                  html`<svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>`
              }
            </button>
          </div>

          ${!this.isPopupLoading && this.popupData.partOfSpeech && this.popupData.partOfSpeech !== 'N/A' ? html`
            <div class="popup-part-of-speech">${this.popupData.partOfSpeech} (in ${this.targetLanguage})</div>
          ` : ''}

          <div id="popup-details">
            ${this.isPopupLoading && !this.popupData.definition ? html`<p class="loading-message">Loading details...</p>` : ''}
            ${this.popupError && !this.isPopupLoading ? html`<p class="error-message">${this.popupError}</p>` : ''}
            
            ${!this.isPopupLoading && !this.popupError && this.popupData.translation && this.popupData.translation !== 'N/A' ? html`
              <div>
                <span class="popup-label">Translation (to ${this.nativeLanguage})</span>
                <span class="popup-content-text">${this.popupData.translation}</span>
              </div>
            ` : ''}
            
            ${!this.isPopupLoading && !this.popupError && this.popupData.definition && this.popupData.definition !== 'N/A' ? html`
              <div>
                <span class="popup-label">Definition (in ${this.nativeLanguage})</span>
                <span class="popup-content-text">${this.popupData.definition}</span>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}
    `;
  }

  render() {
    if (this.appState === 'languageSelection') {
      return this.renderLanguageSelectionScreen();
    } else { 
      return this.renderMainApplication();
    }
  }

  private handleKeyDown(event: KeyboardEvent) {
    // Spacebar push-to-talk like Python implementation
    if (event.code === 'Space' && !this.isSpacebarPressed) {
      // Prevent default spacebar behavior (scrolling)
      event.preventDefault();
      this.isSpacebarPressed = true;
      
      console.log('🎤 ================ SPACEBAR PRESSED ================');
      console.log('🎤 Push-to-talk ACTIVATED - Should start recording');
      
      if (this.openAIVoiceSession && this.openAIVoiceSession.connected) {
        if (this.isModelSpeaking) {
          // Interrupt AI like Python version
          console.log('🛑 AI is speaking - sending interrupt command');
          this.openAIVoiceSession.interruptAI();
          // Update local state immediately - the voice service will handle recording
          this.isModelSpeaking = false;
          this.status = '🔴 Recording... Speak now. Release SPACEBAR when done.';
          // Note: Don't set this.isRecording = true here, let the voice service handle it
        } else if (!this.isRecording) {
          console.log('🎤 Starting recording session...');
          this.startRecording();
        } else {
          console.log('⚠️ Already recording, ignoring spacebar press');
        }
      } else {
        console.log('❌ Voice session not connected');
      }
    }
  }

  private handleKeyUp(event: KeyboardEvent) {
    // Spacebar release - stop recording and trigger response
    if (event.code === 'Space' && this.isSpacebarPressed) {
      event.preventDefault();
      this.isSpacebarPressed = false;
      
      console.log('🎤 ================ SPACEBAR RELEASED ================');
      console.log('🎤 Push-to-talk DEACTIVATED - Should commit and create response');
      
      if (this.openAIVoiceSession) {
        // Always call stopRecording - let the voice service decide if it should process
        console.log('🎤 Stopping recording and triggering AI response...');
        this.stopRecording();
      } else {
        console.log('❌ Voice session not connected');
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    
    // Add keyboard event listeners for spacebar push-to-talk
    document.addEventListener('keydown', this.boundHandleKeyDown);
    document.addEventListener('keyup', this.boundHandleKeyUp);
    
    // Add mouse event listeners for panel dragging
    document.addEventListener('mousemove', this.boundHandlePanelDragMove);
    document.addEventListener('mouseup', this.boundHandlePanelDragEnd);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    
    // Remove keyboard event listeners
    document.removeEventListener('keydown', this.boundHandleKeyDown);
    document.removeEventListener('keyup', this.boundHandleKeyUp);
    
    // Remove mouse event listeners  
    document.removeEventListener('mousemove', this.boundHandlePanelDragMove);
    document.removeEventListener('mouseup', this.boundHandlePanelDragEnd);
    
    // Cleanup session and audio
    if (this.openAIVoiceSession) {
      this.openAIVoiceSession.disconnect();
    }

    // Cleanup video stream and speech recognition
    this.stopWebcam();
    this.stopVideoSpeechRecognition();
  }

  private renderVideoScreens() {
    const waitingScreen = html`
      <div class="video-screen waiting-screen">
        <div class="waiting-content">
          <div class="ai-visual-placeholder">
            <gdm-live-audio-visuals-3d .inputNode=${this.inputNode} .outputNode=${this.outputNode}></gdm-live-audio-visuals-3D>
          </div>
        </div>
      </div>
    `;

    const renderWebcamWithSubtitles = (isPip: boolean = false) => html`
      ${this.isVideoLoading ? html`
        <div class="video-loading">
          <div class="loading-spinner"></div>
          <span>Starting camera...</span>
        </div>
      ` : this.videoStream ? html`
        <video 
          id="${isPip ? 'webcam-video-pip' : 'webcam-video'}" 
          class="webcam-video" 
          autoplay 
          muted 
          playsinline
        ></video>
        ${this.leftPanelMode === 'video' && this.videoInterimTranscript && !isPip ? html`
          <div class="video-subtitle-overlay interim">
            <div class="video-subtitle-text">${this.videoInterimTranscript}</div>
          </div>
        ` : ''}
      ` : html`
        <div class="video-loading">
          <span>Camera not available</span>
        </div>
      `}
    `;

    // Video calling displays
    const renderVideoCall = () => html`
      <div class="video-call-container">
        <!-- Remote video (main display) -->
        <div class="remote-video-container">
          ${this.remoteVideoStream ? html`
            <video 
              id="remote-video" 
              class="remote-video" 
              autoplay 
              playsinline
            ></video>
            <div class="video-label remote-label">Remote User</div>
          ` : html`
            <div class="video-placeholder remote-placeholder">
              <div class="placeholder-content">
                ${this.callStatus === 'hosting' ? html`
                  <div class="call-status">
                    <div class="call-code-display">
                      <span class="call-code-label">Share this code:</span>
                      <span class="call-code-value">${this.callCode}</span>
                    </div>
                    <div class="waiting-text">Waiting for someone to join...</div>
                  </div>
                ` : this.callStatus === 'joining' ? html`
                  <div class="call-status">
                    <div class="connecting-text">Connecting to call...</div>
                  </div>
                ` : this.callStatus === 'connected' ? html`
                  <div class="call-status">
                    <div class="connecting-text">Establishing video connection...</div>
                  </div>
                ` : html`
                  <div class="no-call-text">No active call</div>
                `}
              </div>
            </div>
          `}
        </div>
        
        <!-- Local video (picture-in-picture style) -->
        <div class="local-video-container">
          ${this.localStream ? html`
            <video 
              id="local-video" 
              class="local-video" 
              autoplay 
              muted 
              playsinline
            ></video>
            <div class="video-label local-label">You</div>
          ` : this.videoStream ? html`
            <video 
              id="local-video-fallback" 
              class="local-video" 
              autoplay 
              muted 
              playsinline
            ></video>
            <div class="video-label local-label">You</div>
          ` : html`
            <div class="local-video-placeholder">
              <span>Camera off</span>
            </div>
          `}
        </div>
        
        <!-- Video call subtitles -->
        ${this.videoInterimTranscript ? html`
          <div class="video-call-subtitle-overlay">
            <div class="video-call-subtitle-text">${this.videoInterimTranscript}</div>
          </div>
        ` : ''}
      </div>
    `;

    const webcamScreen = html`
      <div class="video-screen ${this.videoLayout === 'pip' ? 'main' : ''} webcam-screen">
        ${this.callStatus !== 'idle' ? renderVideoCall() : renderWebcamWithSubtitles(false)}
      </div>
    `;

    if (this.videoLayout === 'pip') {
      // Waiting screen is main, webcam is PiP (no subtitles in PiP)
      return html`
        ${waitingScreen}
        <div 
          class="video-screen pip-overlay webcam-screen ${this.isDraggingPip ? 'dragging' : ''}"
          style="left: ${this.pipPosition.x}px; top: ${this.pipPosition.y}px;"
          @mousedown=${this.handlePipDragStart}
        >
          ${this.callStatus !== 'idle' ? renderVideoCall() : renderWebcamWithSubtitles(true)}
        </div>
      `;
    } else {
      // Regular layouts (horizontal, vertical)
      return html`
        ${waitingScreen}
        ${webcamScreen}
      `;
    }
  }

  private async initVideoSpeechRecognition() {
    if (this.isVideoMicMuted) {
      console.log('🎙️ [VIDEO] Skipping speech recognition - mic is muted');
      return;
    }
    
    console.log('🎙️ [VIDEO] ========== INITIALIZING WebRTC VAD SPEECH RECOGNITION ==========');
    
    try {
      // Initialize WebRTC VAD
      await this.initWebRTCVAD();
      
      this.videoConnectionStatus = 'connected';
      this.isVideoSpeechActive = true;
      
    } catch (error) {
      console.error('🎙️ [VIDEO] Error initializing VAD speech recognition:', error);
      this.videoConnectionStatus = 'error';
      this.isVideoSpeechActive = false;
    }
    
    console.log('🎙️ [VIDEO] ========== WebRTC VAD SPEECH RECOGNITION INITIALIZED ==========');
  }

  private async initWebRTCVAD() {
    if (this.isVADInitialized) {
      console.log('🎙️ [VIDEO] VAD already initialized');
      return;
    }
    
    try {
      console.log('🎙️ [VIDEO] Initializing WebRTC VAD...');
      
      // Initialize the VAD
      this.micVAD = await MicVAD.new({
        onSpeechStart: () => {
          console.log('🎙️ [VIDEO] WebRTC VAD: Speech started');
          
          // Create a new placeholder for this speech segment
          const placeholderId = `video-speech-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const placeholderMessage: TranscriptMessage = {
            speaker: 'user',
            text: 'Recording audio...',
            id: placeholderId
          };
          
          this.transcriptHistory = [...this.transcriptHistory, placeholderMessage];
          this.videoTranscriptHistory = [...this.videoTranscriptHistory, placeholderMessage];
          this.currentVideoPlaceholderId = placeholderId;
          this.requestUpdate();
        },
        
        onSpeechEnd: (audio: Float32Array) => {
          console.log('🎙️ [VIDEO] WebRTC VAD: Speech ended, audio length:', audio.length);
          
          // Get the placeholder ID for this specific speech segment
          const speechPlaceholderId = this.currentVideoPlaceholderId;
          
          if (!speechPlaceholderId) {
            console.log('🎙️ [VIDEO] No placeholder ID for this speech segment, skipping');
            return;
          }
          
          // Update placeholder to processing state
          this.updatePlaceholderText(speechPlaceholderId, 'Processing your speech...');
          
          // Convert Float32Array to Blob and send immediately
          const audioBlob = this.convertFloat32ArrayToBlob(audio);
          
          // Send this speech segment directly to Whisper
          this.sendVideoAudioToWhisper(audioBlob, undefined, speechPlaceholderId);
          
          // Clear the placeholder ID since we've sent this segment
          this.currentVideoPlaceholderId = null;
        },
        
        onVADMisfire: () => {
          console.log('🎙️ [VIDEO] WebRTC VAD: Misfire (false positive speech detection)');
          
          // Remove the placeholder as it was a false positive
          if (this.currentVideoPlaceholderId) {
            this.removePlaceholderById(this.currentVideoPlaceholderId);
            this.currentVideoPlaceholderId = null;
          }
        },
        
        // Sensitivity settings
        positiveSpeechThreshold: 0.5, // Lower = more sensitive to speech
        negativeSpeechThreshold: 0.35, // Higher = less likely to stop speech detection
        minSpeechFrames: 3, // Minimum frames before considering it speech
        
        // Prevent very short speech segments
        preSpeechPadFrames: 1,
        redemptionFrames: 6, // ~180ms silence detection (6 frames × ~30ms/frame = ~180ms)
      });
      
      console.log('🎙️ [VIDEO] WebRTC VAD initialized successfully');
      this.isVADInitialized = true;
      
      
      // Start VAD
      this.micVAD.start();
      console.log('🎙️ [VIDEO] WebRTC VAD started');
      
    } catch (error) {
      console.error('🎙️ [VIDEO] Error initializing WebRTC VAD:', error);
      throw error;
    }
  }
  
  private convertFloat32ArrayToBlob(float32Array: Float32Array): Blob {
    // Convert Float32Array to WAV blob
    const length = float32Array.length;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    // RIFF chunk descriptor
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, 'WAVE');
    
    // FMT sub-chunk
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); // Sample rate
    view.setUint32(28, 32000, true); // Byte rate
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    
    // Data sub-chunk
    writeString(36, 'data');
    view.setUint32(40, length * 2, true);
    
    // Convert float samples to 16-bit PCM
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
  }
  
  private sendAccumulatedSpeechToWhisper() {
    if (this.pendingSpeechChunks.length === 0) {
      console.log('🎙️ [VIDEO] No speech chunks to send');
      
      // Remove placeholder if no speech was detected
      if (this.currentVideoPlaceholderId) {
        this.removePlaceholderById(this.currentVideoPlaceholderId);
        this.currentVideoPlaceholderId = null;
      }
      return;
    }
    
    console.log(`🎙️ [VIDEO] Sending ${this.pendingSpeechChunks.length} accumulated speech chunks to Whisper`);
    
    // Combine all speech chunks into one blob
    const combinedBlob = new Blob(this.pendingSpeechChunks, { type: 'audio/wav' });
    
    // Send to Whisper with current placeholder ID
    this.sendVideoAudioToWhisper(combinedBlob, undefined, this.currentVideoPlaceholderId || undefined);
    
    // Clear the accumulated chunks
    this.pendingSpeechChunks = [];
    this.currentVideoPlaceholderId = null;
  }

  private removePlaceholderById(placeholderId: string) {
    console.log(`🗑️ [VIDEO] Removing placeholder: ${placeholderId}`);
    
    // Remove from both transcript arrays
    this.transcriptHistory = this.transcriptHistory.filter(msg => msg.id !== placeholderId);
    this.videoTranscriptHistory = this.videoTranscriptHistory.filter(msg => msg.id !== placeholderId);
    
    this.requestUpdate();
  }
  
  private updatePlaceholderText(placeholderId: string, newText: string) {
    console.log(`🔄 [VIDEO] Updating placeholder ${placeholderId} to: "${newText}"`);
    
    // Update in both transcript arrays
    this.transcriptHistory = this.transcriptHistory.map(msg => 
      msg.id === placeholderId ? { ...msg, text: newText } : msg
    );
    this.videoTranscriptHistory = this.videoTranscriptHistory.map(msg => 
      msg.id === placeholderId ? { ...msg, text: newText } : msg
    );
    
    this.requestUpdate();
  }

  private async sendVideoAudioToWhisper(audioBlob: Blob, sessionId?: string, placeholderId?: string) {
    try {
      console.log('🎯 [VIDEO] Sending audio to Whisper API...', audioBlob.size, 'bytes', sessionId ? `session: ${sessionId}` : '');
      
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.webm');
      
      // Add language parameter if not set to auto-detect
      if (this.selectedVideoLanguage !== 'auto') {
        formData.append('language', this.selectedVideoLanguage);
        console.log('🌐 [VIDEO] Using specified language:', this.selectedVideoLanguage);
      } else {
        console.log('🌐 [VIDEO] Using automatic language detection');
      }
      
      const response = await fetch('http://localhost:3001/api/transcribe', {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }
      
      const data = await response.json();
      const transcribedText = data.text?.trim();
      
      if (transcribedText) {
        console.log('✅ [VIDEO] Transcription received:', transcribedText);
        
        // Use the passed placeholder ID, with fallbacks
        const targetPlaceholderId = placeholderId || this.currentVideoPlaceholderId;
        
        if (targetPlaceholderId) {
          // Find the specific placeholder message to replace using stored ID
          let placeholderIndex = -1;
          for (let i = this.transcriptHistory.length - 1; i >= 0; i--) {
            const message = this.transcriptHistory[i];
            if (message.id === targetPlaceholderId) {
              placeholderIndex = i;
              break;
            }
          }
          
          if (placeholderIndex !== -1) {
            // Create the final transcript message
            const transcriptMessage: TranscriptMessage = {
              speaker: 'user',
              text: transcribedText,
              id: `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };
            
            // Replace specific placeholder in both arrays
            const updatedTranscriptHistory = [...this.transcriptHistory];
            const updatedVideoTranscriptHistory = [...this.videoTranscriptHistory];
            
            updatedTranscriptHistory[placeholderIndex] = transcriptMessage;
            updatedVideoTranscriptHistory[placeholderIndex] = transcriptMessage;
            
            this.transcriptHistory = updatedTranscriptHistory;
            this.videoTranscriptHistory = updatedVideoTranscriptHistory;
            
            console.log(`✅ [VIDEO] Replaced placeholder ${targetPlaceholderId} with transcription (session: ${sessionId})`);
          } else {
            console.log(`⚠️ [VIDEO] Placeholder ${targetPlaceholderId} not found, adding new transcript`);
            // Add new transcript if placeholder not found
            const transcriptMessage: TranscriptMessage = {
              speaker: 'user',
              text: transcribedText,
              id: `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
            };
            
            this.transcriptHistory = [...this.transcriptHistory, transcriptMessage];
            this.videoTranscriptHistory = [...this.videoTranscriptHistory, transcriptMessage];
          }
        } else {
          console.log('⚠️ [VIDEO] No placeholder ID provided, adding new transcript');
          // Add new transcript if no placeholder ID
          const transcriptMessage: TranscriptMessage = {
            speaker: 'user',
            text: transcribedText,
            id: `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          };
          
          this.transcriptHistory = [...this.transcriptHistory, transcriptMessage];
          this.videoTranscriptHistory = [...this.videoTranscriptHistory, transcriptMessage];
        }
        
        // Clean up session tracking
        if (sessionId) {
          this.activeVideoSessions.delete(sessionId);
          console.log(`🗑️ [VIDEO] Cleaned up session ${sessionId} after successful transcription`);
        }
        
        // Clear the current placeholder ID if it matches
        if (targetPlaceholderId === this.currentVideoPlaceholderId) {
          this.currentVideoPlaceholderId = null;
        }
        
        // Update UI
        this.requestUpdate();
        
        // Auto-scroll to bottom of transcript
        setTimeout(() => {
          const transcriptContainer = this.shadowRoot?.querySelector('.transcript-messages-container');
          if (transcriptContainer) {
            transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
          }
        }, 100);
      } else {
        console.log('🔕 [VIDEO] Empty transcription received - removing placeholder');
        
        // Use the passed placeholder ID, or fall back to currentVideoPlaceholderId
        const targetPlaceholderId = placeholderId || this.currentVideoPlaceholderId;
        if (targetPlaceholderId) {
          this.removePlaceholderById(targetPlaceholderId);
        }
        
        // Clean up session tracking
        if (sessionId) {
          this.activeVideoSessions.delete(sessionId);
          console.log(`🗑️ [VIDEO] Cleaned up session ${sessionId} after empty transcription`);
        }
        
        // Clear the placeholder ID if it matches the one we just processed
        if (targetPlaceholderId === this.currentVideoPlaceholderId) {
          this.currentVideoPlaceholderId = null;
        }
      }
      
    } catch (error) {
      console.error('❌ [VIDEO] Transcription error:', error);
      
      // Use the passed placeholder ID, or fall back to currentVideoPlaceholderId
      const targetPlaceholderId = placeholderId || this.currentVideoPlaceholderId;
      if (targetPlaceholderId) {
        this.removePlaceholderById(targetPlaceholderId);
      }
      
      // Clean up session tracking
      if (sessionId) {
        this.activeVideoSessions.delete(sessionId);
        console.log(`🗑️ [VIDEO] Cleaned up session ${sessionId} after transcription error`);
      }
      
      // Clear the placeholder ID if it matches the one we just processed
      if (targetPlaceholderId === this.currentVideoPlaceholderId) {
        this.currentVideoPlaceholderId = null;
      }
      
      this.videoInterimTranscript = `Error: ${error instanceof Error ? error.message : String(error)}`;
      setTimeout(() => {
        this.videoInterimTranscript = '';
        this.requestUpdate();
      }, 3000);
    }
  }

  private stopVideoSpeechRecognition() {
    console.log('🎙️ [VIDEO] ========== STOPPING VIDEO SPEECH RECOGNITION ==========');
    
    this.videoRecordingActive = false;
    
    // Stop WebRTC VAD
    if (this.micVAD) {
      try {
        this.micVAD.pause();
        console.log('🎙️ [VIDEO] WebRTC VAD stopped');
      } catch (error) {
        console.error('🎙️ [VIDEO] Error stopping WebRTC VAD:', error);
      }
    }
    
    // Clear VAD timers
    if (this.vadSpeechTimer) {
      clearTimeout(this.vadSpeechTimer);
      this.vadSpeechTimer = null;
      console.log('🎙️ [VIDEO] VAD speech timer cleared');
    }

    // Stop old VAD detector (if any still running)
    if (this.videoSilenceDetector) {
      clearInterval(this.videoSilenceDetector);
      this.videoSilenceDetector = null;
      console.log('🎙️ [VIDEO] Old VAD detector stopped');
    }

    // Stop MediaRecorder (if any still running)
    if (this.videoMediaRecorder && this.videoMediaRecorder.state === 'recording') {
      try {
        this.videoMediaRecorder.stop();
        console.log('🎙️ [VIDEO] MediaRecorder stopped');
      } catch (error) {
        console.error('🎙️ [VIDEO] Error stopping MediaRecorder:', error);
      }
    }
    this.videoMediaRecorder = null;

    // Clean up audio context (if any)
    if (this.videoAudioContext) {
      try {
        this.videoAudioContext.close();
        console.log('🎙️ [VIDEO] Audio context closed');
      } catch (error) {
        console.error('🎙️ [VIDEO] Error closing audio context:', error);
      }
    }
    this.videoAudioContext = null;
    this.videoAnalyser = null;

    // Stop audio stream (if any)
    if (this.videoAudioStream) {
      this.videoAudioStream.getTracks().forEach(track => {
        track.stop();
        console.log('🎙️ [VIDEO] Audio track stopped:', track.label);
      });
      this.videoAudioStream = null;
    }

    // Reset all VAD state
    this.videoSpeechDetected = false;
    this.videoBaselineRMS = null;
    this.videoRmsHistory = [];
    this.videoSpeechFrames = 0;
    this.videoSilenceFrames = 0;
    this.videoAudioChunks = [];
    this.currentVideoPlaceholderId = null;
    this.pendingSpeechChunks = [];
    
    // Clean up all active sessions and their placeholders
    for (const [sessionId, session] of this.activeVideoSessions) {
      if (session.placeholderId) {
        this.removePlaceholderById(session.placeholderId);
      }
    }
    this.activeVideoSessions.clear();
    console.log('🗑️ [VIDEO] Cleaned up all active sessions');

    // Clear any remaining timers
    if (this.videoSilenceTimer) {
      clearTimeout(this.videoSilenceTimer);
      this.videoSilenceTimer = null;
    }

    // Reset UI state
    this.isVideoSpeechActive = false;
    this.videoInterimTranscript = '';
    this.videoConnectionStatus = 'disconnected';
    
    console.log('🎙️ [VIDEO] ========== VIDEO SPEECH RECOGNITION STOPPED ==========');
  }

  private cleanVideoTranscript(rawTranscript: string) {
    // Find the most recent "Processing:" message and replace it
    const updatedHistory = [...this.transcriptHistory];
    for (let i = updatedHistory.length - 1; i >= 0; i--) {
      if (updatedHistory[i].speaker === 'user' && updatedHistory[i].text.startsWith('Processing:')) {
        // Simple cleaning for now - you can integrate with AI later
        const cleaned = rawTranscript.charAt(0).toUpperCase() + rawTranscript.slice(1).toLowerCase();
        updatedHistory[i] = {
          ...updatedHistory[i],
          text: cleaned
        };
        break;
      }
    }
    this.transcriptHistory = updatedHistory;
    
    // Save to video transcript history
    this.videoTranscriptHistory = [...this.transcriptHistory];
    this.saveProfileData();
    this.requestUpdate();
  }

  private toggleVideoMic() {
    console.log('🎙️ [VIDEO] ========== MIC TOGGLE CLICKED ==========');
    console.log('🎙️ [VIDEO] Currently muted:', this.isVideoMicMuted);
    console.log('🎙️ [VIDEO] Current connection status:', this.videoConnectionStatus);
    console.log('🎙️ [VIDEO] Video session exists:', !!this.videoVoiceSession);
    
    this.isVideoMicMuted = !this.isVideoMicMuted;
    console.log('🎙️ [VIDEO] New muted state:', this.isVideoMicMuted);
    
    if (this.isVideoMicMuted) {
      console.log('🔇 [VIDEO] Muting mic - stopping speech recognition');
      this.stopVideoSpeechRecognition();
    } else {
      console.log('🎤 [VIDEO] Unmuting mic - starting speech recognition');
      this.initVideoSpeechRecognition();
    }
    
    this.requestUpdate();
    console.log('🎙️ [VIDEO] ========== MIC TOGGLE COMPLETE ==========');
  }

  // Voice Activity Detection helper functions
  private rawRMS(arr: Uint8Array): number {
    const sum = arr.reduce((s, v) => {
      const f = (v - 128) / 128;
      return s + f * f;
    }, 0);
    return Math.sqrt(sum / arr.length);
  }

  private average(arr: number[]): number {
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  private async calibrateVideoNoiseFloor(analyser: AnalyserNode): Promise<number> {
    return new Promise((resolve) => {
      const samples: number[] = [];
      const dataArray = new Uint8Array(analyser.fftSize);
      
      const calibrationInterval = setInterval(() => {
        analyser.getByteTimeDomainData(dataArray);
        samples.push(this.rawRMS(dataArray));
        
        if (samples.length >= 750 / this.VIDEO_FRAME_MS) {
          clearInterval(calibrationInterval);
          const baseline = this.average(samples);
          console.log(`Video noise floor calibrated: ${baseline.toFixed(4)}`);
          resolve(baseline);
        }
      }, this.VIDEO_FRAME_MS);
    });
  }

  // Video calling handler methods
  private async handleHostCall() {
    if (this.callStatus !== 'idle') return;
    
    this.isHostingCall = true;
    this.callStatus = 'hosting';
    this.callError = null;
    
    try {
      // Connect to signaling server if not already connected
      if (!this.signalingSocket) {
        await this.connectToSignalingServer();
      }
      
      // Register profile with signaling server
      this.signalingSocket?.emit('register-profile', {
        profile: this.currentProfile,
        nativeLanguage: this.nativeLanguage,
        targetLanguage: this.targetLanguage
      });
      
      // Request to host a call
      this.signalingSocket?.emit('host-call', {});
      
    } catch (error) {
      console.error('❌ Error hosting call:', error);
      this.callStatus = 'error';
      this.callError = `Failed to host call: ${error instanceof Error ? error.message : String(error)}`;
      this.isHostingCall = false;
    }
    
    this.requestUpdate();
  }
  
  private async handleJoinCall() {
    if (this.callStatus !== 'idle' || this.joinCodeInput.length !== 5) return;
    
    this.isJoiningCall = true;
    this.callStatus = 'joining';
    this.callError = null;
    
    try {
      // Connect to signaling server if not already connected
      if (!this.signalingSocket) {
        await this.connectToSignalingServer();
      }
      
      // Register profile with signaling server
      this.signalingSocket?.emit('register-profile', {
        profile: this.currentProfile,
        nativeLanguage: this.nativeLanguage,
        targetLanguage: this.targetLanguage
      });
      
      // Request to join a call
      this.signalingSocket?.emit('join-call', {
        code: this.joinCodeInput
      });
      
    } catch (error) {
      console.error('❌ Error joining call:', error);
      this.callStatus = 'error';
      this.callError = `Failed to join call: ${error instanceof Error ? error.message : String(error)}`;
      this.isJoiningCall = false;
    }
    
    this.requestUpdate();
  }
  
  private handleEndCall() {
    console.log('🔚 Ending call');
    
    // Clean up WebRTC
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    
    // Clean up local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    
    // Clean up remote stream
    this.remoteVideoStream = null;
    
    // Clean up call state
    this.callStatus = 'idle';
    this.callCode = null;
    this.isHostingCall = false;
    this.isJoiningCall = false;
    this.callError = null;
    this.joinCodeInput = '';
    this.remoteSocketId = null; // Clear remote socket ID
    
    // Notify signaling server
    if (this.signalingSocket?.connected) {
      this.signalingSocket.emit('end-call');
    }
    
    this.requestUpdate();
  }
  
  private async connectToSignalingServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Connect through the /signaling proxy to avoid mixed content issues
        // This routes through the same HTTPS ngrok tunnel as the frontend
        this.signalingSocket = io('/signaling', {
          transports: ['polling'], // Force polling transport initially
          forceNew: true,
          timeout: 10000
        });
        
        this.signalingSocket.on('connect', () => {
          console.log('📞 Connected to signaling server via proxy');
          console.log('🔗 Socket ID:', this.signalingSocket?.id);
          console.log('🚀 Transport:', this.signalingSocket?.io.engine.transport.name);
          resolve();
        });
        
        this.signalingSocket.on('disconnect', (reason) => {
          console.log('📞 Disconnected from signaling server:', reason);
        });
        
        this.signalingSocket.on('connect_error', (error) => {
          console.error('❌ Signaling server connection error:', error);
          console.error('❌ Error details:', {
            message: error.message,
            stack: error.stack,
            ...error
          });
          reject(error);
        });
        
        // Handle signaling events
        this.setupSignalingEventHandlers();
        
      } catch (error) {
        console.error('❌ Socket.IO setup error:', error);
        reject(error);
      }
    });
  }
  
  private setupSignalingEventHandlers() {
    if (!this.signalingSocket) return;

    // Call successfully hosted
    this.signalingSocket.on('call-hosted', (data: any) => {
      console.log(`🏠 Call hosted with code: ${data.code}`);
      this.callCode = data.code;
      this.callStatus = 'hosting';
      this.isHostingCall = true;
      this.requestUpdate();
    });

    // Call found when joining
    this.signalingSocket.on('call-found', (data: any) => {
      console.log(`🤝 Found call, connecting...`);
      this.callStatus = 'joining';
      this.remoteSocketId = data.hostSocketId; // Store host socket ID
      this.requestUpdate();
      
      // Set up WebRTC as joiner
      this.setupWebRTCConnection(false);
    });

    // Someone is joining your hosted call
    this.signalingSocket.on('call-join-request', (data: any) => {
      console.log(`🤝 Someone is joining your call: ${data.joinerProfile}`);
      this.remoteSocketId = data.joinerSocketId; // Store joiner socket ID
      this.requestUpdate();
      
      // Set up WebRTC as host (if not already set up)
      if (!this.peerConnection) {
        this.setupWebRTCConnection(true);
      }
    });

    // Call not found
    this.signalingSocket.on('call-not-found', (data: any) => {
      console.log(`❌ Call not found: ${data.code}`);
      this.callStatus = 'error';
      this.callError = `Call ${data.code} not found`;
      this.requestUpdate();
    });

    // WebRTC offer received (for host)
    this.signalingSocket.on('webrtc-offer', (data: any) => {
      console.log(`📡 Received WebRTC offer from: ${data.callerSocketId}`);
      this.remoteSocketId = data.callerSocketId; // Update remote socket ID
      this.handleWebRTCOffer(data.offer, data.callerSocketId);
    });

    // WebRTC answer received (for joiner)
    this.signalingSocket.on('webrtc-answer', (data: any) => {
      console.log(`📡 Received WebRTC answer from: ${data.answererSocketId}`);
      this.handleWebRTCAnswer(data.answer);
    });

    // ICE candidate received
    this.signalingSocket.on('webrtc-ice-candidate', (data: any) => {
      console.log(`🧊 Received ICE candidate from: ${data.senderSocketId}`);
      this.handleICECandidate(data.candidate);
    });

    // Call ended by remote peer
    this.signalingSocket.on('call-ended', (data: any) => {
      console.log(`📞 Call ended: ${data.reason}`);
      this.handleEndCall();
    });

    // Joiner left the call
    this.signalingSocket.on('joiner-left', (data: any) => {
      console.log(`👋 ${data.joinerProfile} left the call`);
      this.handleEndCall();
    });
  }
  
  private async setupWebRTCConnection(isHost: boolean) {
    console.log(`🔗 Setting up WebRTC connection (${isHost ? 'host' : 'joiner'})`);
    
    try {
      // Create RTCPeerConnection
      this.peerConnection = new RTCPeerConnection(this.rtcConfiguration);
      
      // Set up event handlers
      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate && this.remoteSocketId) {
          console.log('🧊 Sending ICE candidate');
          this.signalingSocket?.emit('webrtc-ice-candidate', {
            candidate: event.candidate,
            targetSocketId: this.remoteSocketId
          });
        }
      };
      
      this.peerConnection.ontrack = (event) => {
        console.log('📹 Received remote video stream');
        this.remoteVideoStream = event.streams[0];
        this.callStatus = 'connected';
        this.requestUpdate();
        
        // Set up remote video element
        this.updateComplete.then(() => {
          const remoteVideo = this.shadowRoot?.querySelector('#remote-video') as HTMLVideoElement;
          if (remoteVideo) {
            remoteVideo.srcObject = this.remoteVideoStream;
          }
        });
      };
      
      this.peerConnection.onconnectionstatechange = () => {
        console.log('🔗 Connection state:', this.peerConnection?.connectionState);
        if (this.peerConnection?.connectionState === 'connected') {
          console.log('✅ WebRTC connection established');
          this.callStatus = 'connected';
        } else if (this.peerConnection?.connectionState === 'disconnected' || 
                   this.peerConnection?.connectionState === 'failed') {
          console.log('❌ WebRTC connection lost');
          this.handleEndCall();
        }
        this.requestUpdate();
      };
      
      // Get local media stream (video + audio)
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          facingMode: 'user'
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      // Add local stream to peer connection
      this.localStream.getTracks().forEach(track => {
        this.peerConnection?.addTrack(track, this.localStream!);
      });
      
      // Set up local video display
      this.updateComplete.then(() => {
        const localVideo = this.shadowRoot?.querySelector('#local-video') as HTMLVideoElement;
        if (localVideo) {
          localVideo.srcObject = this.localStream;
          localVideo.muted = true; // Mute local audio to prevent feedback
        }
      });
      
      // If joiner, create and send offer
      if (!isHost) {
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        
        console.log('📡 Sending offer to host');
        this.signalingSocket?.emit('webrtc-offer', {
          offer: offer,
          targetSocketId: this.remoteSocketId
        });
      }
      
    } catch (error) {
      console.error('❌ Error setting up WebRTC:', error);
      this.callStatus = 'error';
      this.callError = `WebRTC setup failed: ${error instanceof Error ? error.message : String(error)}`;
      this.requestUpdate();
    }
  }
  
  private async handleWebRTCOffer(offer: any, callerSocketId: string) {
    console.log('📡 Handling WebRTC offer from:', callerSocketId);
    
    try {
      if (!this.peerConnection) {
        console.log('🔗 Creating peer connection for incoming offer');
        await this.setupWebRTCConnection(true); // Set up as host
      }
      
      // Set remote description (the offer)
      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Create and send answer
      const answer = await this.peerConnection!.createAnswer();
      await this.peerConnection!.setLocalDescription(answer);
      
      console.log('📡 Sending answer to joiner');
      this.signalingSocket?.emit('webrtc-answer', {
        answer: answer,
        targetSocketId: callerSocketId
      });
      
    } catch (error) {
      console.error('❌ Error handling WebRTC offer:', error);
      this.callStatus = 'error';
      this.callError = `Failed to handle offer: ${error instanceof Error ? error.message : String(error)}`;
      this.requestUpdate();
    }
  }
  
  private async handleWebRTCAnswer(answer: any) {
    console.log('📡 Handling WebRTC answer');
    
    try {
      if (!this.peerConnection) {
        throw new Error('No peer connection available');
      }
      
      // Set remote description (the answer)
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('✅ WebRTC answer processed');
      
    } catch (error) {
      console.error('❌ Error handling WebRTC answer:', error);
      this.callStatus = 'error';
      this.callError = `Failed to handle answer: ${error instanceof Error ? error.message : String(error)}`;
      this.requestUpdate();
    }
  }
  
  private async handleICECandidate(candidate: any) {
    console.log('🧊 Handling ICE candidate');
    
    try {
      if (!this.peerConnection) {
        console.warn('⚠️ No peer connection available for ICE candidate');
        return;
      }
      
      // Add ICE candidate to peer connection
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('✅ ICE candidate added');
      
    } catch (error) {
      console.error('❌ Error handling ICE candidate:', error);
      // ICE candidate errors are usually non-fatal, so don't change call status
    }
  }
}
