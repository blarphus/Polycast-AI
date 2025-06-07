
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


  private client: GoogleGenAI; // This client is now primarily for live.connect
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private transcriptionBuffer = ''; 

  private speechRecognition: any | null = null;
  private boundHandlePanelDragMove: (e: MouseEvent) => void;
  private boundHandlePanelDragEnd: (e: MouseEvent) => void;


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
    .sort-by-select { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e0e0e0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 10px center; background-size: 1em; padding-right: 2.5em;}

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

    .flashcard-actions .correct-btn { background-color: #28a745; }
    .flashcard-actions .correct-btn:hover { background-color: #218838; }
    .flashcard-actions .incorrect-btn { background-color: #dc3545; }
    .flashcard-actions .incorrect-btn:hover { background-color: #c82333; }

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
    .card-count { margin: 0 20px; font-size: 0.95em; }
    .no-flashcards-message {
        text-align: center;
        padding: 20px;
        font-size: 1em;
        color: #8a80a5;
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

  `;

  constructor() {
    super();
    this.currentProfile = localStorage.getItem('lastActiveProfile') || this.profiles[0];
    
    let initialWidth = parseInt(localStorage.getItem('rightPanelWidth') || '600', 10);
    initialWidth = Math.max(this.minRightPanelWidth, initialWidth); 
    this.rightPanelWidth = initialWidth;

    this.boundHandlePanelDragMove = this.handlePanelDragMove.bind(this);
    this.boundHandlePanelDragEnd = this.handlePanelDragEnd.bind(this);
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
    this.flashcards = storedFlashcards ? JSON.parse(storedFlashcards) : [];

    const storedIntervals = localStorage.getItem(this.getProfileKey('flashcardIntervals'));
    this.flashcardIntervals = storedIntervals ? new Map(JSON.parse(storedIntervals)) : new Map();
    
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
    
    this.transcriptionBuffer = '';
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
    
    if (this.session) {
        this.initSpeechRecognition(); 
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
      this.updateError("Speech Recognition API not supported by this browser.");
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
            this.updateStatus(`You: ${finalSegment}`);
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
      this.updateError(errorMsg);
    };
  }

  private async initClient() {
    if (this.session) {
        try { this.session.close(); } catch (e) { /* ignore */ }
        this.session = null as any;
    }
    try {
      // This client is now only for live.connect
      this.client = new GoogleGenAI({
        apiKey: process.env.API_KEY!,
      });
      this.outputNode.connect(this.outputAudioContext.destination);
      await this.initSession(); 
    } catch (e: any) {
      this.isInitializingSession = false; 
      this.requestUpdate('isInitializingSession');
      console.error("Failed to initialize GoogleGenAI client for session:", e);
      this.updateError(`Client Init Error (Session): ${e.message}. Ensure API_KEY is valid and configured.`);
      this.session = null as any; 
    }
  }

  private processTranscriptionBuffer() {
    const sentenceRegex = /^(.*?[.!?])\s*/;
    let match;
    while ((match = this.transcriptionBuffer.match(sentenceRegex))) {
      const sentence = match[1].trim();
      if (sentence) {
        this.transcriptHistory = [
            ...this.transcriptHistory,
            { speaker: 'model', text: sentence, id: `model-${crypto.randomUUID()}` }
        ];
      }
      this.transcriptionBuffer = this.transcriptionBuffer.substring(match[0].length);
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
“Yo tengo un perro.”
“Mi hermana va a la escuela.”
“Nosotros vivimos en una casa grande.”
Negation & Questions
“No me gusta el café.”
“¿Tú hablas inglés?”
“¿Qué haces los fines de semana?”
Past and Future Tense
“Ayer fui al mercado.”
“Ella estudió por tres horas.”
“Voy a visitar a mi abuela mañana.”
Modal Verbs
“Puedes usar mi teléfono.”
“Debemos hacer la tarea.”
“Ellos no pueden venir hoy.”
Descriptions & Comparisons
“Mi madre es más alta que mi padre.”
“La comida está deliciosa.”
“Esta película es mejor que la otra.”
Conditionals & Hypotheticals
“Si llueve, me quedaré en casa.”
“Si tuviera más tiempo, viajaría a México.”
“Si ves a Juan, dile que llamé.”

🔸 Phase 2: Conceptual Production (5 minutes)
Objective: Check grammar awareness and conceptual understanding using ${this.nativeLanguage} prompts, but require student to answer in ${this.targetLanguage}. This forces them to retrieve forms flexibly.

Still speak in ${this.nativeLanguage}. Ask open-ended questions about grammar or meaning. Student must respond in ${this.targetLanguage}.

Instructions (in ${this.nativeLanguage}):
PHASE_2_INSTRUCTION_PLACEHOLDER

Categories & Sample Prompts (examples are in Spanish, adapt if Native Language is different):
Past Tense Recall
“¿Qué hiciste ayer por la tarde?”
“Dime tres cosas que hiciste la semana pasada.”
Modal Function / Obligation
“¿Qué deberíamos hacer cuando estamos enfermos?”
“¿Qué puedes hacer tú que otras personas no pueden?”
Por vs. Para / Prepositions (language-specific, this is a Spanish example)
“Dame un ejemplo de una situación para ‘por’ y otra para ‘para’.”
“¿Cuándo se usa ‘a’ y cuándo ‘en’?”
Reflexives / Daily Routine
“Descríbeme tu rutina diaria usando verbos reflexivos.”
Conditionals (first and second)
“¿Qué harías si no tuvieras que trabajar mañana?”
“¿Qué vas a hacer si llueve este fin de semana?”

🔸 Phase 3: Target-Language Immersion (5 minutes)
Objective: Evaluate comprehension and free production under real-time ${this.targetLanguage} pressure. No more native language. Questions are longer, abstract, or multi-part.

Speak only in ${this.targetLanguage}. Ask more advanced and cognitively demanding questions. The student must answer in full ${this.targetLanguage} sentences.

Instructions (in ${this.targetLanguage}):
“Now I will ask you questions only in ${this.targetLanguage}. Please answer fully.”

Categories & Sample Prompts:
Narrative Listening
“Yesterday, I went to the store and forgot my wallet. I had to go back home, get it, and return. What happened in the story?”
Reasoning & Opinions
“Do you think students should have homework every day? Why or why not?”
“Which is better: living in a big city or a small town? Explain.”
Hypothetical / Second Conditional
“If you could visit any country in the world, where would you go and why?”
Instructions & Sequences
“Tell me how to cook your favorite meal, step by step.”
Comparative Reasoning
“Compare two people you know. Who is more patient? Who is funnier?”
Abstract Expression
“Why is it important to learn ${this.targetLanguage}?”
“What does being a good friend mean to you?”

🔸 Wrap-Up
In ${this.targetLanguage}:
“Thank you. That’s the end of our session. I understand your level now and will use your answers to create a learning plan just for you. See you next time.”
    `.trim();

    let phase1Instruction: string;
    let phase2Instruction: string;

    if (this.nativeLanguage === 'English') {
      phase1Instruction = `“I will say phrases. Please translate them aloud into ${this.targetLanguage}. We'll start with easy phrases, then they will become more difficult.”`;
      phase2Instruction = `“Now I will ask you questions. The questions are in English, but your answers must be in ${this.targetLanguage}.”`;
    } else if (this.nativeLanguage === 'Portuguese') {
      phase1Instruction = `“Vou dizer algumas frases. Por favor, traduza-as em voz alta para ${this.targetLanguage}. Começaremos com frases fáceis, depois ficarão mais difíceis.”`;
      phase2Instruction = `“Agora vou fazer-lhe algumas perguntas. As perguntas estão em Português, mas as suas respostas devem estar em ${this.targetLanguage}.”`;
    } else { 
      phase1Instruction = `“Voy a decir frases. Por favor tradúcelas en voz alta al ${this.targetLanguage}. Comenzamos con frases fáciles. Luego serán más difíciles.”`;
      phase2Instruction = `“Ahora voy a hacerte preguntas. Las preguntas están en español, pero tus respuestas deben estar en ${this.targetLanguage}.”`;
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
    this.updateStatus('Diagnostic session completed! You can now have regular conversations.');
  }


  private async initSession() {
    const diagnosticKey = this.getProfileKey('diagnosticCompleted');
    const diagnosticCompleted = localStorage.getItem(diagnosticKey) === 'true';
    this.isDiagnosticSessionActive = !diagnosticCompleted; 

    this.isInitializingSession = true; 
    this.session = null as any; 
    this.requestUpdate(); 

    const model = 'gemini-2.5-flash-preview-native-audio-dialog'; 
    let systemInstructionText: string;

    if (this.isDiagnosticSessionActive) {
      systemInstructionText = this.getDiagnosticSystemInstruction();
      this.updateStatus(`Starting diagnostic session for ${this.currentProfile}...`);
    } else {
      systemInstructionText = this.getRegularSystemInstruction();
      this.updateStatus(`Initializing session for ${this.currentProfile}...`);
    }

    try {
      this.session = await this.client.live.connect({ // Uses this.client for live session
        model: model,
        callbacks: {
          onopen: () => {
            this.isInitializingSession = false;
            this.requestUpdate('isInitializingSession');
            if (this.isDiagnosticSessionActive) {
              this.updateStatus(`Diagnostic session started with ${this.currentProfile}. Please follow the tutor's instructions.`);
            } else {
              this.updateStatus('Conversation session opened.');
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            const serverContent = message.serverContent;
            const modelTurn = serverContent?.modelTurn;

            if (modelTurn?.parts) {
              const audioPart = modelTurn.parts.find(p => p.inlineData);
              if (audioPart?.inlineData) {
                this.isModelSpeaking = true;
                this.isModelAudioTurnComplete = false;
                this.stopUserSpeechRecognition();

                const audio = audioPart.inlineData;
                this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
                const audioBuffer = await decodeAudioData(decode(audio.data), this.outputAudioContext, 24000, 1);
                const source = this.outputAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.outputNode);
                source.addEventListener('ended', () => {
                  this.sources.delete(source);
                  if (this.sources.size === 0 && this.isModelAudioTurnComplete) {
                    this.isModelSpeaking = false;
                    if (this.isRecording) {
                      this.startUserSpeechRecognition();
                    }
                  }
                });
                source.start(this.nextStartTime);
                this.nextStartTime = this.nextStartTime + audioBuffer.duration;
                this.sources.add(source);
              }
            }

            const outputTranscription = serverContent?.outputTranscription;
            if (outputTranscription?.text) {
              this.transcriptionBuffer += outputTranscription.text;
              this.processTranscriptionBuffer();

              if (this.isDiagnosticSessionActive) {
                const lowerText = outputTranscription.text.toLowerCase();
                if (lowerText.includes("end of our session") || lowerText.includes("see you next time")) {
                  this.markDiagnosticAsCompleted();
                }
              }
            }

            if (serverContent?.turnComplete) {
              this.isModelAudioTurnComplete = true;
              const remainingText = this.transcriptionBuffer.trim();
              if (remainingText.length > 0) {
                 if (remainingText) {
                    this.transcriptHistory = [
                        ...this.transcriptHistory,
                        { speaker: 'model', text: remainingText, id: `model-${crypto.randomUUID()}` }
                    ];
                }
              }
              this.transcriptionBuffer = '';
              if (this.sources.size === 0) { 
                this.isModelSpeaking = false;
                if (this.isRecording) {
                  this.startUserSpeechRecognition();
                }
              }
            }

            const interrupted = serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
              this.transcriptionBuffer = '';
              this.isModelAudioTurnComplete = true; 
              this.isModelSpeaking = false;
              if (this.isRecording) {
                this.startUserSpeechRecognition();
              }
            }
          },
          onerror: (e: ErrorEvent) => {
            this.isInitializingSession = false;
            this.requestUpdate('isInitializingSession');
            this.updateError(`Session error: ${e.message}`);
            this.session = null as any;
          },
          onclose: (e: CloseEvent) => {
            this.isInitializingSession = false;
            this.requestUpdate('isInitializingSession');
            this.updateStatus('Session closed: ' + e.reason);
            this.session = null as any; 
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: {voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}}},
          systemInstruction: systemInstructionText,
        },
      });
    } catch (e: any) {
      this.isInitializingSession = false;
      this.requestUpdate('isInitializingSession');
      console.error("Failed to initialize session:", e);
      this.updateError(`Failed to initialize session: ${e.message}`);
      this.session = null as any; 
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
    this.error = '';
  }

  private updateError(msg: string) {
    this.error = msg;
    this.status = '';
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
           this.updateError("Microphone access denied or speech recognition blocked by browser.");
        } else {
           this.updateError(`Speech recognition start error: ${e.message}`);
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


  private async startRecording() {
    if (this.isRecording) return;

    if (!this.session) {
      this.updateError("Session not initialized. Please reset or ensure the session started correctly.");
      return;
    }
    
    this.inputAudioContext.resume();
    this.outputAudioContext.resume();
    this.updateStatus('Requesting microphone access...');
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true}, video: false});
      this.updateStatus('Microphone access granted. Starting capture...');
      this.sourceNode = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.inputNode);
      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(bufferSize, 1, 1);
      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording || !this.session) return;
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };
      this.inputNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);
      
      this.isRecording = true; 
      if (!this.isModelSpeaking) { 
        this.startUserSpeechRecognition();
      }
      
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err: any) {
      console.error('Error starting recording:', err);
      this.updateError(`Error: ${err.message}`);
      this.stopRecording(); 
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext) {
       this.stopUserSpeechRecognition();
       return;
    }
    
    this.isRecording = false; 
    this.stopUserSpeechRecognition();

    this.updateStatus('Stopping recording...');
    
    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode.onaudioprocess = null;
      this.scriptProcessorNode = null as any;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null as any;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null as any;
    }
    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private async reset() {
    this.stopRecording(); 
    if (this.session) {
        try { this.session.close(); } catch (e) { /* ignore */ }
        this.session = null as any;
    }

    this.transcriptionBuffer = '';
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

    if (this.speechRecognition && this.session) { 
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
        };
      } else { // It's WordDetails
        this.popupData = {
          ...this.popupData,
          partOfSpeech: details.partOfSpeech || 'N/A',
          translation: details.translation || 'N/A',
          definition: details.definition || 'N/A',
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
    const displayWord = wordData.word; 
    const wordKey = displayWord.toLowerCase().trim();

    if (this.dictionaryEntries.has(wordKey)) {
      this.handleDeleteDictionaryEntry(wordKey); 
    } else {
      const optimisticEntry: DictionaryEntry = {
        word: displayWord,
        translation: wordData.translation,
        definition: wordData.definition,
        partOfSpeech: wordData.partOfSpeech,
        sentenceContext: wordData.sentence,
        frequency: null, 
        dateAdded: Date.now(),
      };
      this.dictionaryEntries.set(wordKey, optimisticEntry);
      this.dictionaryEntries = new Map(this.dictionaryEntries);

      this.isFetchingFrequencyFor = displayWord;
      this.isFetchingSentencesFor = displayWord;
      this.popupError = null;
      this.requestUpdate(); 

      try {
        const frequencyResult = await fetchWordFrequencyFromApi(displayWord, this.targetLanguage);
        // Fix: Use type guard for WordFrequencyResult | WordFrequencyError
        let frequency: number | null = null;
        if (!('error' in frequencyResult)) { // It's WordFrequencyResult
            frequency = frequencyResult.frequency;
        } else {
            console.warn(`Failed to fetch frequency for "${displayWord}": ${frequencyResult.error}`);
            // frequency remains null, which is an acceptable state for DictionaryEntry
        }
        
        const sentencesResult = await fetchExampleSentencesFromApi(
          displayWord,
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
            console.warn(`Error fetching example sentences for "${displayWord}": ${sentencesResult.error}`);
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

        const finalEntry: DictionaryEntry = { ...optimisticEntry, frequency };
        this.dictionaryEntries.set(wordKey, finalEntry);

        const flashcardId = `${wordKey}_flashcard`;
        const newFlashcard: Flashcard = {
          id: flashcardId,
          originalWordKey: wordKey,
          dictionaryEntry: finalEntry,
          exampleSentences: exampleSentences,
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

  private handleDeleteDictionaryEntry(wordKey: string) {
    if (this.dictionaryEntries.has(wordKey)) {
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
    this.flashcardQueue = this.flashcards
      .sort((a, b) => {
        const freqA = a.dictionaryEntry.frequency ?? 0; 
        const freqB = b.dictionaryEntry.frequency ?? 0;
        if (freqB !== freqA) return freqB - freqA; 

        const intervalA = this.flashcardIntervals.get(a.id) || 1;
        const intervalB = this.flashcardIntervals.get(b.id) || 1;
        if (intervalA !== intervalB) return intervalA - intervalB; 

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
    this.requestUpdate('flashcardQueue'); 
  }

  private handleFlashcardFlip(cardId?: string) {
    if (!cardId) return;
    this.flashcardFlipState.set(cardId, !this.flashcardFlipState.get(cardId));
    this.requestUpdate('flashcardFlipState');
  }

  private handleFlashcardAnswer(cardId: string, isCorrect: boolean) {
    if (!cardId) return;
    let interval = this.flashcardIntervals.get(cardId) || 1;
    if (isCorrect) {
        interval++;
    } else {
        interval = Math.max(1, interval - 1);
    }
    this.flashcardIntervals.set(cardId, interval);
    this.flashcardFlipState.set(cardId, false); 

    const cardIndexInQueue = this.flashcardQueue.indexOf(cardId);
    if (cardIndexInQueue > -1) {
        this.flashcardQueue.splice(cardIndexInQueue, 1);
        this.flashcardQueue.push(cardId); 
    }
    
    if (this.currentFlashcardQueueIndex >= this.flashcardQueue.length) {
        this.currentFlashcardQueueIndex = 0; 
    }
    
    if (this.flashcardQueue.length > 0) {
        const nextCardIdToShow = this.flashcardQueue[this.currentFlashcardQueueIndex];
        this.flashcardFlipState.set(nextCardIdToShow, false);
    }
    this.saveProfileData();
    this.requestUpdate();
  }

  private navigateFlashcard(direction: 'next' | 'prev') {
    if (this.flashcardQueue.length === 0) return;

    const currentCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
    if (currentCardId) { 
        this.flashcardFlipState.set(currentCardId, false);
    }

    if (direction === 'next') {
        this.currentFlashcardQueueIndex = (this.currentFlashcardQueueIndex + 1) % this.flashcardQueue.length;
    } else {
        this.currentFlashcardQueueIndex = (this.currentFlashcardQueueIndex - 1 + this.flashcardQueue.length) % this.flashcardQueue.length;
    }
    
    const newCardId = this.flashcardQueue[this.currentFlashcardQueueIndex];
     if (newCardId) {
        this.flashcardFlipState.set(newCardId, false);
    }
    this.requestUpdate('currentFlashcardQueueIndex');
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
      const isKnown = this.dictionaryEntries.has(wordKey);
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

  private renderFrequencyDots(frequency: number | null) {
    if (frequency === null || frequency < 1 || frequency > 5) {
      return html`<span>N/A</span>`;
    }
    let color = '#22C55E'; 
    if (frequency === 1) color = '#EF4444'; 
    else if (frequency === 2) color = '#F97316'; 
    else if (frequency === 3) color = '#FACC15'; 
    else if (frequency === 4) color = '#84CC16'; 

    return html`
      <div class="frequency-dots" aria-label="Frequency: ${frequency} out of 5">
        ${Array(frequency).fill(0).map(() => html`<div class="frequency-dot" style="background-color: ${color};"></div>`)}
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
    } else if (result) { // It's EvaluationResult
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

    const isWordInPopupDictionary = this.popupData ? this.dictionaryEntries.has(this.popupData.word.toLowerCase().trim()) : false;
    const isFetchingCurrentPopupWordEnrichments = this.popupData ? (this.isFetchingFrequencyFor === this.popupData.word || this.isFetchingSentencesFor === this.popupData.word) : false;
    
    const dictionaryButtonDisabledState = 
        (this.isPopupLoading && (!this.popupData || !this.popupData.definition)) || 
        isFetchingCurrentPopupWordEnrichments;

    const filteredDictionaryEntries = Array.from(this.dictionaryEntries.values()).filter(entry => 
      entry.word.toLowerCase().includes(this.dictionarySearchTerm.toLowerCase()) 
    ).sort((a, b) => {
        return a.word.localeCompare(b.word); 
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
          <div class="controls">
            <button 
              id="resetButton" 
              @click=${this.reset} 
              ?disabled=${this.isRecording || this.isInitializingSession} 
              aria-label="Reset Session">
              <svg xmlns="http://www.w3.org/2000/svg" height="40px" viewBox="0 -960 960 960" width="40px" fill="currentColor"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" /></svg>
            </button>
            <button 
              id="startButton" 
              @click=${this.startRecording} 
              ?disabled=${!this.session || this.isRecording || !this.speechRecognition || this.isSpeechRecognitionActive || this.isInitializingSession} 
              aria-label="Start Recording">
              <svg viewBox="0 0 100 100" width="32px" height="32px" fill="#c80000" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="45" /></svg>
            </button>
            <button 
              id="stopButton" 
              @click=${this.stopRecording} 
              ?disabled=${!this.isRecording} 
              aria-label="Stop Recording">
              <svg viewBox="0 0 100 100" width="32px" height="32px" fill="#ffffff" xmlns="http://www.w3.org/2000/svg"><rect x="15" y="15" width="70" height="70" rx="10" /></svg>
            </button>
          </div>
          <div id="status" role="status" aria-live="polite"> ${this.error || this.status} </div>
          <gdm-live-audio-visuals-3d .inputNode=${this.inputNode} .outputNode=${this.outputNode}></gdm-live-audio-visuals-3d>
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
                ${this.isDiagnosticSessionActive ? 'DIAGNOSTIC SESSION' : `TRANSCRIPT (${this.currentProfile} | ${this.targetLanguage})`}
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
                        <option value="alphabetical">Alphabetical (A-Z)</option>
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
                      <span class="dictionary-entry-word">${entry.word} (${this.targetLanguage})</span>
                      <div style="display: flex; align-items: center; gap: 10px;">
                        ${this.renderFrequencyDots(entry.frequency)}
                        <button 
                          class="delete-dictionary-entry-btn"
                          @click=${(e: Event) => { e.stopPropagation(); this.handleDeleteDictionaryEntry(entryWordKey); }}
                          title="Delete '${entry.word}' from dictionary"
                          aria-label="Delete ${entry.word} from dictionary for profile ${this.currentProfile}"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 21q-.825 0-1.412-.587T5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413T17 21zM17 6H7v13h10zM9 17h2V8H9zm4 0h2V8h-2zM7 6v13z"></path></svg>
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
                    <div class="flashcard-container ${isFlipped ? 'flipped' : ''}">
                      <div class="flashcard card-front">
                        <div class="flashcard-content-area" lang="${this.mapLanguageToBcp47(this.targetLanguage)}">${flashcardFrontContent}</div>
                      </div>
                      <div class="flashcard card-back">
                        <div class="flashcard-content-area" lang="${this.mapLanguageToBcp47(this.targetLanguage)}">${flashcardBackContent}</div>
                        <div class="flashcard-interval">Interval: ${currentInterval}</div>
                        <div class="flashcard-actions">
                          <button class="incorrect-btn" @click=${(e: Event) => { e.stopPropagation(); this.handleFlashcardAnswer(currentCardId!, false); }} aria-label="Mark as incorrect">Incorrect</button>
                          <button class="correct-btn" @click=${(e: Event) => { e.stopPropagation(); this.handleFlashcardAnswer(currentCardId!, true); }} aria-label="Mark as correct">Correct</button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="flashcard-nav">
                    <button @click=${() => this.navigateFlashcard('prev')} ?disabled=${this.flashcardQueue.length <= 1} aria-label="Previous card">◄</button>
                    <span class="card-count">Card ${this.flashcardQueue.length > 0 ? this.currentFlashcardQueueIndex + 1 : 0} of ${this.flashcardQueue.length}</span>
                    <button @click=${() => this.navigateFlashcard('next')} ?disabled=${this.flashcardQueue.length <= 1} aria-label="Next card">►</button>
                  </div>
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
            <span id="popup-selected-word-title" class="popup-selected-word">${this.popupData.word}</span>
            <button
              class="dictionary-toggle-btn ${isWordInPopupDictionary ? 'added' : ''}"
              @click=${() => this.handleToggleDictionary(this.popupData!)}
              title="${isWordInPopupDictionary ? 'Remove from Dictionary' : 'Add to Dictionary'}"
              aria-label="${isWordInPopupDictionary ? 'Remove ' + this.popupData.word + ' from Dictionary (' + this.currentProfile + ')' : 'Add ' + this.popupData.word + ' to Dictionary (' + this.currentProfile + ')'}"
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
}
