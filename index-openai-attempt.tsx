/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session } from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';
import type { GdmLiveAudioVisuals3D } from './visual-3d';
import { 
  fetchWordDetailsFromApi, 
  fetchWordFrequencyFromApi, 
  fetchExampleSentencesFromApi, 
  fetchEvaluationFromApi 
} from './gemini-api-service';
import {OpenAIVoiceSession, VoiceSessionConfig} from './openai-voice-service';


interface WordPopupData {
  word: string;
  sentence: string;
  translation: string;
  definition: string;
  partOfSpeech: string;
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
}

export interface EvaluationSuggestion {
  category: string; // In Target Language
  description: string; // In Native Language
}

export interface EvaluationData {
  improvementAreas: EvaluationSuggestion[]; // Renamed from suggestions
  cefrLevel: string;
}


const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const SUPPORTED_LANGUAGES = ['English', 'Spanish', 'Portuguese'];
const PROFILES = ['Joshua', 'Cat', 'Dog', 'Mouse', 'Lizard'];


@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() transcriptHistory: TranscriptMessage[] = [];
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
  @state() dictionarySortOrder: 'alphabetical' | 'frequency_asc' | 'frequency_desc' | 'date_added' = 'alphabetical';

  @state() flashcards: Flashcard[] = [];
  @state() flashcardQueue: string[] = [];
  @state() currentFlashcardQueueIndex = 0;
  @state() flashcardIntervals = new Map<string, number>();
  @state() flashcardFlipState = new Map<string, boolean>();

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

  // OpenAI Voice Session instead of Gemini
  private openaiVoiceSession: OpenAIVoiceSession | null = null;
  private client: GoogleGenAI; // Keep for API service calls (dictionary, evaluation)
  
  // Audio contexts for visualization
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();

  private speechRecognition: any | null = null;
  private boundHandlePanelDragMove: (e: MouseEvent) => void;
  private boundHandlePanelDragEnd: (e: MouseEvent) => void;

  // ... [CSS styles remain the same as in original] ...
  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background-color: #1a1423;
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
      position: relative;
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(26, 20, 35, 0.9);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 2000;
      color: #e0e0e0;
      text-align: center;
      font-size: 1.1em;
    }

    .loading-spinner {
      border: 5px solid #3c3152;
      border-top: 5px solid #8a5cf5;
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
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .panel-divider {
      width: 5px;
      background-color: #3c3152;
      cursor: col-resize;
      flex-shrink: 0;
      z-index: 5;
    }

    .right-panel {
      background-color: #2a2139;
      color: #e0e0e0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      display: flex;
      flex-direction: column;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }
    
    .tabs {
      display: flex;
      background-color: #2a2139; 
      border-bottom: 1px solid #3c3152;
      padding: 0px 15px; 
      padding-top: 10px; 
      flex-shrink: 0;
    }

    .tab {
      padding: 8px 16px;
      margin-right: 2px;
      background-color: #3c3152;
      border: none;
      border-radius: 4px 4px 0 0;
      color: #a093c4;
      cursor: pointer;
      font-size: 0.9em;
      transition: background-color 0.2s, color 0.2s;
    }

    .tab.active {
      background-color: #4a4063;
      color: #e0e0e0;
    }

    .tab:hover:not(.active) {
      background-color: #45395a;
      color: #c4b5e0;
    }

    .tab-content {
      flex: 1;
      padding: 15px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .controls {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 15px;
      padding: 20px;
      background-color: #2a2139;
      border-top: 1px solid #3c3152;
      flex-shrink: 0;
    }

    .mic-button {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      border: none;
      background-color: #8a5cf5;
      color: white;
      font-size: 24px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .mic-button:hover {
      background-color: #794ee2;
      transform: scale(1.05);
    }

    .mic-button.recording {
      background-color: #e74c3c;
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(231, 76, 60, 0); }
      100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); }
    }

    .reset-button {
      padding: 10px 20px;
      background-color: #5a4b6b;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
      transition: background-color 0.2s;
    }

    .reset-button:hover {
      background-color: #6b5b7a;
    }

    .status {
      text-align: center;
      color: #a093c4;
      font-size: 0.9em;
      margin-bottom: 10px;
      min-height: 1.2em;
    }

    .error {
      color: #ff6b6b;
      font-weight: bold;
    }

    /* Transcript styles */
    .transcript-container {
      flex: 1;
      overflow-y: auto;
      padding: 10px 0;
    }

    .transcript-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 15px;
      padding-bottom: 10px;
      border-bottom: 1px solid #3c3152;
    }

    .font-size-control {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .font-size-control label {
      color: #a093c4;
      font-size: 0.9em;
    }

    .font-size-control input {
      width: 60px;
      padding: 4px 8px;
      background-color: #3c3152;
      border: 1px solid #4a4063;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 0.9em;
    }

    .transcript-message {
      margin-bottom: 15px;
      padding: 12px;
      border-radius: 8px;
      line-height: 1.5;
    }

    .transcript-message.user {
      background-color: #3c3152;
      margin-left: 20px;
    }

    .transcript-message.model {
      background-color: #2d2442;
      margin-right: 20px;
    }

    .speaker-label {
      font-weight: bold;
      margin-bottom: 5px;
      text-transform: uppercase;
      font-size: 0.8em;
      opacity: 0.8;
    }

    .user .speaker-label {
      color: #8a5cf5;
    }

    .model .speaker-label {
      color: #5fb3d4;
    }

    .message-text {
      cursor: pointer;
    }

    .message-text span.word {
      padding: 1px 2px;
      margin: 0 1px;
      border-radius: 2px;
      transition: background-color 0.2s;
    }

    .message-text span.word:hover {
      background-color: rgba(138, 92, 245, 0.3);
    }

    .interim-transcript {
      color: #a093c4;
      font-style: italic;
      margin-top: 8px;
      opacity: 0.7;
    }

    /* Popup styles */
    .word-popup {
      position: fixed;
      background-color: #2a2139;
      border: 2px solid #8a5cf5;
      border-radius: 8px;
      padding: 15px;
      max-width: 300px;
      z-index: 1000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }

    .popup-word {
      font-size: 1.2em;
      font-weight: bold;
      color: #8a5cf5;
      margin-bottom: 8px;
    }

    .popup-translation {
      color: #5fb3d4;
      font-weight: bold;
      margin-bottom: 8px;
    }

    .popup-definition {
      color: #e0e0e0;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    .popup-part-of-speech {
      color: #a093c4;
      font-style: italic;
      font-size: 0.9em;
      margin-bottom: 12px;
    }

    .popup-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .popup-button {
      padding: 6px 12px;
      background-color: #3c3152;
      color: #e0e0e0;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
      transition: background-color 0.2s;
    }

    .popup-button:hover {
      background-color: #4a4063;
    }

    .popup-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .popup-close {
      position: absolute;
      top: 5px;
      right: 10px;
      background: none;
      border: none;
      color: #a093c4;
      cursor: pointer;
      font-size: 1.2em;
      font-weight: bold;
    }

    .popup-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #a093c4;
    }

    .popup-error {
      color: #ff6b6b;
      font-size: 0.9em;
    }

    /* Dictionary styles */
    .dictionary-controls {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }

    .dictionary-search {
      flex: 1;
      min-width: 200px;
      padding: 8px 12px;
      background-color: #3c3152;
      border: 1px solid #4a4063;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 0.9em;
    }

    .dictionary-sort {
      padding: 8px 12px;
      background-color: #3c3152;
      border: 1px solid #4a4063;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 0.9em;
      cursor: pointer;
    }

    .dictionary-entry {
      background-color: #3c3152;
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .dictionary-header {
      padding: 12px 15px;
      cursor: pointer;
      transition: background-color 0.2s;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .dictionary-header:hover {
      background-color: #4a4063;
    }

    .dictionary-word {
      font-weight: bold;
      color: #8a5cf5;
      font-size: 1.1em;
    }

    .dictionary-translation {
      color: #5fb3d4;
      margin-top: 2px;
    }

    .dictionary-meta {
      color: #a093c4;
      font-size: 0.8em;
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .frequency-indicator {
      display: inline-flex;
      gap: 2px;
    }

    .frequency-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: #4a4063;
    }

    .frequency-dot.filled {
      background-color: #8a5cf5;
    }

    .dictionary-details {
      padding: 0 15px 15px 15px;
      border-top: 1px solid #4a4063;
    }

    .dictionary-definition {
      color: #e0e0e0;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    .dictionary-context {
      color: #a093c4;
      font-style: italic;
      font-size: 0.9em;
      margin-bottom: 12px;
    }

    .dictionary-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* Flashcard styles */
    .flashcard-queue-info {
      background-color: #3c3152;
      padding: 10px 15px;
      border-radius: 6px;
      margin-bottom: 15px;
      text-align: center;
      color: #a093c4;
    }

    .flashcard {
      background-color: #3c3152;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 15px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      perspective: 1000px;
      min-height: 150px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .flashcard:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 15px rgba(138, 92, 245, 0.3);
    }

    .flashcard-word {
      font-size: 1.5em;
      font-weight: bold;
      color: #8a5cf5;
      text-align: center;
      margin-bottom: 15px;
    }

    .flashcard-translation {
      font-size: 1.2em;
      color: #5fb3d4;
      text-align: center;
      margin-bottom: 10px;
    }

    .flashcard-definition {
      color: #e0e0e0;
      text-align: center;
      line-height: 1.4;
      margin-bottom: 15px;
    }

    .flashcard-sentences {
      color: #a093c4;
      font-size: 0.9em;
    }

    .flashcard-sentence {
      margin-bottom: 8px;
      padding: 8px;
      background-color: #2a2139;
      border-radius: 4px;
    }

    .flashcard-controls {
      display: flex;
      gap: 10px;
      justify-content: center;
      margin-top: 15px;
    }

    .flashcard-button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
      transition: background-color 0.2s;
    }

    .flashcard-easy {
      background-color: #27ae60;
      color: white;
    }

    .flashcard-hard {
      background-color: #e74c3c;
      color: white;
    }

    .flashcard-again {
      background-color: #f39c12;
      color: white;
    }

    /* Evaluation styles */
    .evaluation-section {
      margin-bottom: 20px;
    }

    .evaluation-button {
      width: 100%;
      padding: 12px 20px;
      background-color: #8a5cf5;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 1em;
      transition: background-color 0.2s;
      margin-bottom: 15px;
    }

    .evaluation-button:hover {
      background-color: #794ee2;
    }

    .evaluation-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .evaluation-result {
      background-color: #3c3152;
      border-radius: 6px;
      padding: 15px;
    }

    .cefr-level {
      font-size: 1.2em;
      font-weight: bold;
      color: #8a5cf5;
      text-align: center;
      margin-bottom: 15px;
    }

    .improvement-areas {
      color: #e0e0e0;
    }

    .improvement-area {
      margin-bottom: 12px;
      padding: 10px;
      background-color: #2a2139;
      border-radius: 4px;
    }

    .improvement-category {
      font-weight: bold;
      color: #5fb3d4;
      margin-bottom: 5px;
    }

    .improvement-description {
      color: #a093c4;
      font-size: 0.9em;
      line-height: 1.4;
    }

    .evaluation-error {
      color: #ff6b6b;
      text-align: center;
      padding: 10px;
      background-color: rgba(255, 107, 107, 0.1);
      border-radius: 4px;
    }
  `;

  constructor() {
    super();
    this.currentProfile = this.profiles[0];
    
    // Set initial panel width
    this.rightPanelWidth = Math.min(600, Math.max(this.minRightPanelWidth, window.innerWidth * 0.4));
    
    // Bind event handlers
    this.boundHandlePanelDragMove = this.handlePanelDragMove.bind(this);
    this.boundHandlePanelDragEnd = this.handlePanelDragEnd.bind(this);
    
    // Initialize client for API service calls (keep Gemini for dictionary, etc.)
    this.initClient();
  }

  connectedCallback() {
    super.connectedCallback();
    this.loadSettings();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cleanup();
  }

  private cleanup() {
    if (this.openaiVoiceSession) {
      this.openaiVoiceSession.disconnect();
      this.openaiVoiceSession = null;
    }
    
    if (this.speechRecognition) {
      try { this.speechRecognition.abort(); } catch(e) {}
      this.speechRecognition = null;
    }
    
    document.removeEventListener('mousemove', this.boundHandlePanelDragMove);
    document.removeEventListener('mouseup', this.boundHandlePanelDragEnd);
  }

  private async initClient() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      this.updateError('GEMINI_API_KEY not found in environment');
      return;
    }
    
    try {
      this.client = new GoogleGenAI({apiKey});
    } catch (e: any) {
      console.error('Failed to initialize Gemini client:', e);
      this.updateError('Failed to initialize API client');
    }
  }

  private async initOpenAIVoiceSession() {
    this.isInitializingSession = true;
    this.requestUpdate();

    const instructions = this.isDiagnosticSessionActive 
      ? this.getDiagnosticSystemInstruction()
      : this.getRegularSystemInstruction();

    this.updateStatus(`Initializing ${this.isDiagnosticSessionActive ? 'diagnostic' : 'conversation'} session...`);

    try {
      this.openaiVoiceSession = new OpenAIVoiceSession();
      
      // Set up event handlers
      this.openaiVoiceSession.onTranscriptUpdate = (transcript: string, isComplete: boolean) => {
        if (isComplete) {
          // Add complete transcript to history
          if (transcript.trim()) {
            this.transcriptHistory = [
              ...this.transcriptHistory,
              { speaker: 'model', text: transcript.trim(), id: `model-${crypto.randomUUID()}` }
            ];
          }
        }
        // You could update a live transcript display here if needed
      };

      this.openaiVoiceSession.onAudioData = (audioData: Float32Array) => {
        // Send audio data to visualization
        if (this.outputNode && this.outputNode.context) {
          const audioBuffer = this.outputNode.context.createBuffer(1, audioData.length, 24000);
          audioBuffer.getChannelData(0).set(audioData);
          const source = this.outputNode.context.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(this.outputNode);
          source.start();
        }
      };

      this.openaiVoiceSession.onError = (error: string) => {
        this.updateError(`OpenAI Voice Error: ${error}`);
        this.isInitializingSession = false;
        this.requestUpdate();
      };

      this.openaiVoiceSession.onConnectionChange = (connected: boolean) => {
        if (connected) {
          this.isInitializingSession = false;
          this.updateStatus(this.isDiagnosticSessionActive 
            ? `Diagnostic session started with ${this.currentProfile}. Please follow the tutor's instructions.`
            : 'Conversation session opened.');
        } else {
          this.updateStatus('Session disconnected');
        }
        this.requestUpdate();
      };

      const config: VoiceSessionConfig = {
        voice: 'nova', // You can make this configurable based on profile
        instructions: instructions,
        inputAudioFormat: 'pcm16',
        outputAudioFormat: 'pcm16',
        turnDetection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200
        }
      };

      await this.openaiVoiceSession.connect(config);

    } catch (e: any) {
      this.isInitializingSession = false;
      this.requestUpdate();
      console.error("Failed to initialize OpenAI voice session:", e);
      this.updateError(`Failed to initialize session: ${e.message}`);
    }
  }

  private getDiagnosticSystemInstruction(): string {
    return `You are an AI language tutor conducting a diagnostic conversation to assess the user's ${this.targetLanguage} proficiency level (CEFR: A1, A2, B1, B2, C1, C2).

Your student is a native ${this.nativeLanguage} speaker learning ${this.targetLanguage}. Your goal is to:

1. Have a natural, engaging conversation entirely in ${this.targetLanguage}
2. Gradually increase difficulty to find their true level
3. Ask follow-up questions that reveal grammar, vocabulary, and fluency
4. Take notes on their mistakes and strengths
5. After 3-5 minutes, politely end with: "Thank you. That's the end of our session. I understand your level now and will use your answers to create a learning plan just for you. See you next time."

Start with: "Hello! I'm your ${this.targetLanguage} tutor. Let's have a conversation to see your current level. Tell me about yourself - where are you from and what do you like to do?"

Guidelines:
- Speak naturally, don't sound robotic
- Encourage them when they do well
- Gently correct major errors by restating correctly
- Ask increasingly complex questions based on their responses
- Note their CEFR level internally for the final assessment`;
  }

  private getRegularSystemInstruction(): string {
    return `You are ${this.currentProfile}, an AI language conversation partner helping a ${this.nativeLanguage} speaker practice ${this.targetLanguage}.

Your personality:
${this.getProfilePersonality()}

Guidelines:
- Always speak in ${this.targetLanguage}
- Have natural, engaging conversations
- Gently correct mistakes by restating correctly
- Ask follow-up questions to keep conversations flowing
- Use vocabulary appropriate for their level
- Be encouraging and supportive
- Show interest in their thoughts and experiences
- Vary your conversation topics to keep things interesting

Remember: You're having a real conversation, not giving a language lesson. Be natural and personable while helping them improve their ${this.targetLanguage}.`;
  }

  private getProfilePersonality(): string {
    switch (this.currentProfile) {
      case 'Joshua':
        return 'You are curious, analytical, and love discussing technology, science, and philosophy. You ask thoughtful questions and enjoy deep conversations.';
      case 'Cat':
        return 'You are playful, independent, and a bit mysterious. You enjoy talking about comfortable spaces, food, and observing the world around you.';
      case 'Dog':
        return 'You are enthusiastic, loyal, and always excited to chat! You love talking about adventures, friends, food, and playing.';
      case 'Mouse':
        return 'You are quick-witted, resourceful, and detail-oriented. You enjoy discussing clever solutions, hidden places, and small pleasures in life.';
      case 'Lizard':
        return 'You are calm, observant, and patient. You like talking about warm places, watching and waiting, and ancient wisdom.';
      default:
        return 'You are friendly and helpful, adapting your conversation style to match the user\'s interests.';
    }
  }

  private startRecording() {
    if (!this.openaiVoiceSession || !this.openaiVoiceSession.connected) {
      this.updateError("Session not initialized. Please reset or ensure the session started correctly.");
      return;
    }
    
    this.inputAudioContext.resume();
    this.outputAudioContext.resume();
    this.isRecording = true;
    this.updateStatus('🔴 Recording... OpenAI Voice Mode active.');
  }

  private stopRecording() {
    this.isRecording = false;
    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private async reset() {
    this.stopRecording();
    
    if (this.openaiVoiceSession) {
      this.openaiVoiceSession.disconnect();
      this.openaiVoiceSession = null;
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
    
    this.requestUpdate();
  }

  // All other methods remain the same (popup handling, dictionary, flashcards, etc.)
  // ... [Rest of the class methods would continue here] ...

  protected render() {
    if (this.appState === 'languageSelection') {
      return this.renderLanguageSelection();
    }

    return html`
      <div class="app-container">
        ${this.isInitializingSession ? this.renderLoadingOverlay() : ''}
        
        <div class="left-panel" style="flex: 1 1 ${window.innerWidth - this.rightPanelWidth - this.dividerWidth}px; min-width: ${this.minLeftPanelWidth}px;">
          <gdm-live-audio-visuals-3d .inputNode=${this.inputNode} .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
          
          <div class="controls">
            <button class="mic-button ${this.isRecording ? 'recording' : ''}" 
                    @click=${this.toggleRecording}
                    ?disabled=${this.isInitializingSession}>
              ${this.isRecording ? '⏹️' : '🎤'}
            </button>
            <button class="reset-button" @click=${this.reset} ?disabled=${this.isInitializingSession}>
              Reset
            </button>
          </div>
          
          <div class="status ${this.error ? 'error' : ''}">
            ${this.error || this.status}
          </div>
        </div>

        <div class="panel-divider" @mousedown=${this.handlePanelDragStart}></div>

        <div class="right-panel" style="width: ${this.rightPanelWidth}px; flex-shrink: 0;">
          ${this.renderTabs()}
          ${this.renderTabContent()}
        </div>

        ${this.popupData ? this.renderPopup() : ''}
      </div>
    `;
  }

  private renderLanguageSelection() {
    return html`
      <div class="language-selection-screen">
        <h2>🌍 Welcome to Polycast AI</h2>
        
        <div class="language-selection-group">
          <label for="profile-select">Choose your conversation partner:</label>
          <select id="profile-select" .value=${this.currentProfile} 
                  @change=${(e: Event) => {
                    this.currentProfile = (e.target as HTMLSelectElement).value;
                    this.updateLanguagesForProfile();
                  }}>
            ${this.profiles.map(profile => 
              html`<option value=${profile}>${profile}</option>`
            )}
          </select>
        </div>

        <div class="language-selection-group">
          <label for="native-language-select">Your native language:</label>
          <select id="native-language-select" .value=${this.nativeLanguage} 
                  @change=${(e: Event) => this.nativeLanguage = (e.target as HTMLSelectElement).value}>
            ${SUPPORTED_LANGUAGES.map(lang => 
              html`<option value=${lang}>${lang}</option>`
            )}
          </select>
        </div>

        <div class="language-selection-group">
          <label for="target-language-select">Language you want to practice:</label>
          <select id="target-language-select" .value=${this.targetLanguage} 
                  @change=${(e: Event) => this.targetLanguage = (e.target as HTMLSelectElement).value}>
            ${SUPPORTED_LANGUAGES.filter(lang => lang !== this.nativeLanguage).map(lang => 
              html`<option value=${lang}>${lang}</option>`
            )}
          </select>
        </div>

        <button class="start-button" @click=${this.startConversation}>
          Start Conversation
        </button>
      </div>
    `;
  }

  private renderLoadingOverlay() {
    return html`
      <div class="loading-overlay">
        <div class="loading-spinner"></div>
        <div>Initializing OpenAI Voice Session...</div>
        <div style="font-size: 0.9em; margin-top: 10px; opacity: 0.8;">
          Setting up real-time voice conversation
        </div>
      </div>
    `;
  }

  private renderTabs() {
    return html`
      <div class="tabs">
        <button class="tab ${this.activeTab === 'transcript' ? 'active' : ''}" 
                @click=${() => this.activeTab = 'transcript'}>
          Transcript
        </button>
        <button class="tab ${this.activeTab === 'dictionary' ? 'active' : ''}" 
                @click=${() => this.activeTab = 'dictionary'}>
          Dictionary
        </button>
        <button class="tab ${this.activeTab === 'flashcards' ? 'active' : ''}" 
                @click=${() => this.activeTab = 'flashcards'}>
          Flashcards
        </button>
        <button class="tab ${this.activeTab === 'evaluate' ? 'active' : ''}" 
                @click=${() => this.activeTab = 'evaluate'}>
          Evaluate
        </button>
      </div>
    `;
  }

  private renderTabContent() {
    return html`
      <div class="tab-content">
        ${this.activeTab === 'transcript' ? this.renderTranscriptTab() : ''}
        ${this.activeTab === 'dictionary' ? this.renderDictionaryTab() : ''}
        ${this.activeTab === 'flashcards' ? this.renderFlashcardsTab() : ''}
        ${this.activeTab === 'evaluate' ? this.renderEvaluateTab() : ''}
      </div>
    `;
  }

  private renderTranscriptTab() {
    return html`
      <div class="transcript-container">
        <div class="transcript-controls">
          <div class="font-size-control">
            <label>Font Size:</label>
            <input type="range" min="12" max="32" .value=${this.transcriptFontSize.toString()}
                   @input=${(e: Event) => this.transcriptFontSize = parseInt((e.target as HTMLInputElement).value)}>
            <span>${this.transcriptFontSize}px</span>
          </div>
        </div>
        
        <div class="transcript-messages">
          ${this.transcriptHistory.map(msg => html`
            <div class="transcript-message ${msg.speaker}" 
                 style="font-size: ${this.transcriptFontSize}px;">
              <div class="speaker-label">${msg.speaker}</div>
              <div class="message-text" @click=${(e: Event) => this.handleWordClick(e, msg.text)}>
                ${this.renderMessageWithClickableWords(msg.text)}
              </div>
            </div>
          `)}
          
          ${this.userInterimTranscript ? html`
            <div class="transcript-message user interim-transcript" 
                 style="font-size: ${this.transcriptFontSize}px;">
              <div class="speaker-label">user</div>
              <div class="message-text">${this.userInterimTranscript}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderDictionaryTab() {
    return html`
      <div class="dictionary-content">
        <div class="dictionary-controls">
          <input type="search" class="dictionary-search"
                 placeholder="Search words..."
                 .value=${this.dictionarySearchTerm}
                 @input=${(e: Event) => this.dictionarySearchTerm = (e.target as HTMLInputElement).value}>
        </div>
        
        <div class="dictionary-list">
          ${Array.from(this.dictionaryEntries.values()).map(entry => html`
            <div class="dictionary-entry">
              <div class="dictionary-header" @click=${() => this.toggleDictionaryWordExpansion(entry.word)}>
                <div>
                  <div class="dictionary-word">${entry.word}</div>
                  <div class="dictionary-translation">${entry.translation}</div>
                </div>
              </div>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private renderFlashcardsTab() {
    return html`
      <div class="flashcards-content">
        <div class="flashcard-queue-info">
          ${this.flashcards.length} flashcards available
        </div>
        
        ${this.flashcards.map(card => html`
          <div class="flashcard">
            <div class="flashcard-word">${card.dictionaryEntry.word}</div>
            <div class="flashcard-translation">${card.dictionaryEntry.translation}</div>
            <div class="flashcard-definition">${card.dictionaryEntry.definition}</div>
          </div>
        `)}
      </div>
    `;
  }

  private renderEvaluateTab() {
    return html`
      <div class="evaluation-content">
        <button class="evaluation-button" 
                @click=${this.evaluateConversation}
                ?disabled=${this.isEvaluating || this.transcriptHistory.length === 0}>
          ${this.isEvaluating ? 'Evaluating...' : 'Evaluate My Performance'}
        </button>
        
        ${this.evaluationResult ? html`
          <div class="evaluation-result">
            <div class="cefr-level">CEFR Level: ${this.evaluationResult.cefrLevel}</div>
            <div class="improvement-areas">
              <h4>Areas for Improvement:</h4>
              ${this.evaluationResult.improvementAreas.map(area => html`
                <div class="improvement-area">
                  <div class="improvement-category">${area.category}</div>
                  <div class="improvement-description">${area.description}</div>
                </div>
              `)}
            </div>
          </div>
        ` : ''}
        
        ${this.evaluationError ? html`
          <div class="evaluation-error">${this.evaluationError}</div>
        ` : ''}
      </div>
    `;
  }

  private renderPopup() {
    if (!this.popupData) return '';
    
    return html`
      <div class="word-popup" 
           style="left: ${this.popupData.x}px; top: ${this.popupData.y}px;">
        <button class="popup-close" @click=${this.closePopup}>×</button>
        
        ${this.isPopupLoading ? html`
          <div class="popup-loading">Loading...</div>
        ` : ''}
        
        ${this.popupError ? html`
          <div class="popup-error">${this.popupError}</div>
        ` : ''}
        
        ${!this.isPopupLoading && !this.popupError ? html`
          <div class="popup-word">${this.popupData.word}</div>
          <div class="popup-translation">${this.popupData.translation}</div>
          <div class="popup-definition">${this.popupData.definition}</div>
          <div class="popup-part-of-speech">${this.popupData.partOfSpeech}</div>
          
          <div class="popup-buttons">
            <button class="popup-button" @click=${() => this.addToDictionary(this.popupData!)}>
              Add to Dictionary
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderMessageWithClickableWords(text: string) {
    return text.split(' ').map(word => {
      const cleanWord = word.replace(/[^\w\s]/g, '').toLowerCase();
      return html`<span class="word" data-word="${cleanWord}">${word}</span> `;
    });
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  private async startConversation() {
    this.appState = 'conversation';
    this.saveSettings();
    await this.initOpenAIVoiceSession();
  }

  private updateLanguagesForProfile() {
    // Set default languages based on profile
    switch (this.currentProfile) {
      case 'Joshua':
        this.nativeLanguage = 'English';
        this.targetLanguage = 'Portuguese';
        break;
      default:
        this.nativeLanguage = SUPPORTED_LANGUAGES[0];
        this.targetLanguage = SUPPORTED_LANGUAGES[2];
    }
  }

  private loadSettings() {
    const saved = localStorage.getItem('polycast-settings');
    if (saved) {
      try {
        const settings = JSON.parse(saved);
        this.currentProfile = settings.currentProfile || this.profiles[0];
        this.nativeLanguage = settings.nativeLanguage || SUPPORTED_LANGUAGES[0];
        this.targetLanguage = settings.targetLanguage || SUPPORTED_LANGUAGES[2];
        this.transcriptFontSize = settings.transcriptFontSize || 26;
        this.rightPanelWidth = settings.rightPanelWidth || this.rightPanelWidth;
        
        if (settings.dictionaryEntries) {
          this.dictionaryEntries = new Map(settings.dictionaryEntries);
        }
        if (settings.flashcards) {
          this.flashcards = settings.flashcards;
        }
        if (settings.flashcardQueue) {
          this.flashcardQueue = settings.flashcardQueue;
        }
      } catch (e) {
        console.warn('Failed to load settings:', e);
      }
    }
  }

  private saveSettings() {
    const settings = {
      currentProfile: this.currentProfile,
      nativeLanguage: this.nativeLanguage,
      targetLanguage: this.targetLanguage,
      transcriptFontSize: this.transcriptFontSize,
      rightPanelWidth: this.rightPanelWidth,
      dictionaryEntries: Array.from(this.dictionaryEntries.entries()),
      flashcards: this.flashcards,
      flashcardQueue: this.flashcardQueue
    };
    localStorage.setItem('polycast-settings', JSON.stringify(settings));
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = '';
  }

  // Utility methods for UI functionality
  private handleWordClick(e: Event, messageText: string) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('word')) {
      const word = target.getAttribute('data-word');
      if (word) {
        this.showWordPopup(word, messageText, e);
      }
    }
  }

  private async showWordPopup(word: string, sentence: string, event: Event) {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    
    this.popupData = {
      word,
      sentence,
      translation: '',
      definition: '',
      partOfSpeech: '',
      x: rect.left,
      y: rect.bottom + 5,
      targetWidth: rect.width
    };
    
    this.isPopupLoading = true;
    this.popupError = null;
    
    try {
      const result = await fetchWordDetailsFromApi(word, sentence, this.targetLanguage, this.nativeLanguage);
      
      if ('error' in result) {
        this.popupError = result.error;
      } else {
        this.popupData = {
          ...this.popupData,
          translation: result.translation,
          definition: result.definition,
          partOfSpeech: result.partOfSpeech
        };
      }
    } catch (error) {
      this.popupError = 'Failed to fetch word details';
    }
    
    this.isPopupLoading = false;
    this.requestUpdate();
  }

  private closePopup() {
    this.popupData = null;
    this.isPopupLoading = false;
    this.popupError = null;
  }

  private addToDictionary(data: WordPopupData) {
    const entry: DictionaryEntry = {
      word: data.word,
      translation: data.translation,
      definition: data.definition,
      partOfSpeech: data.partOfSpeech,
      sentenceContext: data.sentence,
      frequency: null,
      dateAdded: Date.now()
    };
    
    this.dictionaryEntries.set(data.word.toLowerCase(), entry);
    this.saveSettings();
    this.closePopup();
    this.requestUpdate();
  }

  private toggleDictionaryWordExpansion(word: string) {
    const wordKey = word.toLowerCase();
    if (this.expandedDictionaryWords.has(wordKey)) {
      this.expandedDictionaryWords.delete(wordKey);
    } else {
      this.expandedDictionaryWords.add(wordKey);
    }
    this.requestUpdate();
  }

  private async evaluateConversation() {
    if (this.transcriptHistory.length === 0) {
      this.evaluationError = 'No conversation to evaluate';
      return;
    }

    this.isEvaluating = true;
    this.evaluationError = null;
    this.evaluationResult = null;

    try {
      const result = await fetchEvaluationFromApi(
        this.transcriptHistory,
        this.targetLanguage,
        this.nativeLanguage
      );

      if ('error' in result) {
        this.evaluationError = result.error;
      } else {
        this.evaluationResult = result.evaluation;
      }
    } catch (error) {
      this.evaluationError = 'Failed to evaluate conversation';
    }

    this.isEvaluating = false;
    this.requestUpdate();
  }

  // Panel dragging functionality
  private handlePanelDragStart(e: MouseEvent) {
    this.isDraggingPanel = true;
    this.dragStartX = e.clientX;
    this.initialRightPanelWidth = this.rightPanelWidth;
    document.addEventListener('mousemove', this.boundHandlePanelDragMove);
    document.addEventListener('mouseup', this.boundHandlePanelDragEnd);
    document.body.style.userSelect = 'none';
  }

  private handlePanelDragMove(e: MouseEvent) {
    if (!this.isDraggingPanel) return;
    
    const deltaX = this.dragStartX - e.clientX;
    const newRightPanelWidth = Math.max(
      this.minRightPanelWidth,
      Math.min(
        window.innerWidth - this.minLeftPanelWidth - this.dividerWidth,
        this.initialRightPanelWidth + deltaX
      )
    );
    
    this.rightPanelWidth = newRightPanelWidth;
    this.requestUpdate();
  }

  private handlePanelDragEnd() {
    this.isDraggingPanel = false;
    document.removeEventListener('mousemove', this.boundHandlePanelDragMove);
    document.removeEventListener('mouseup', this.boundHandlePanelDragEnd);
    document.body.style.userSelect = '';
    this.saveSettings();
  }

  // Language mapping utility
  private mapLanguageToBcp47(language: string): string {
    const mappings: { [key: string]: string } = {
      'English': 'en-US',
      'Spanish': 'es-ES', 
      'Portuguese': 'pt-BR'
    };
    return mappings[language] || 'en-US';
  }
}