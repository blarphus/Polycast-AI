/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import type { FlashcardExampleSentence, EvaluationData, TranscriptMessage } from './index'; // Assuming index.tsx exports these

const MODEL_NAME = 'gemini-2.5-flash-preview-04-17';

// Initialize the GoogleGenAI client for this service
// API_KEY will be sourced from process.env by the execution environment
let ai: GoogleGenAI;
try {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
} catch (e) {
    console.error("Failed to initialize GoogleGenAI in service:", e);
    // Handle cases where API_KEY might not be available or client init fails
    // For now, functions will check if 'ai' is initialized.
}

interface WordDetails {
  partOfSpeech: string;
  translation: string;
  definition: string;
  lemmatizedWord: string; // The infinitive/singular form for dictionary storage
  displayWord: string; // The properly formatted word with articles for display
}

interface WordDetailsError {
  error: string;
}

interface WordFrequencyResult {
    frequency: number;
    rank?: number;
}
interface WordFrequencyError {
    error: string;
}

// Import the smart tiered loading service
import { getWordFrequency, preloadCoreLanguage, getCacheStats } from './wordfreq-service';

interface ExampleSentencesResult {
    sentences: FlashcardExampleSentence[];
}
interface ExampleSentencesError {
    error: string;
}

interface EvaluationResult {
    evaluation: EvaluationData;
}
interface EvaluationError {
    error: string;
}


export async function fetchWordDetailsFromApi(
  word: string,
  sentence: string,
  targetLanguage: string,
  nativeLanguage: string
): Promise<WordDetails | WordDetailsError> {
  if (!ai) return { error: "Gemini API client not initialized in service." };
  try {
    const prompt = `For the word "${word}" (which is in ${targetLanguage}) in the context of the ${targetLanguage} sentence "${sentence}", provide:
1. The part of speech for the word in this ${targetLanguage} context (e.g., noun, verb, adjective).
2. The lemmatized form of "${word}" - this means the infinitive form for verbs, singular form for nouns, or base form for adjectives.
3. The properly formatted dictionary form with appropriate articles if it's a noun (e.g., "la hermana" not just "hermana" for Spanish nouns, "o gato" not just "gato" for Portuguese nouns).
4. A translation of the word "${word}" from ${targetLanguage} to ${nativeLanguage}.
5. A concise definition of the word as it is used in this specific sentence, with the definition written in ${nativeLanguage}.

Return this information as a single string, with each of these five pieces of information separated by '//'.
Example: noun//hermana//la hermana//sister//A female sibling.
Do not include any other text, labels, or formatting. Just the five pieces of information separated by '//'.`;

    const response: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
    });
    
    const responseText = response.text?.trim() || "";
    const parts = responseText.split('//');

    if (parts.length === 5) {
      return {
        partOfSpeech: parts[0].trim() || 'N/A',
        lemmatizedWord: parts[1].trim() || word, // Fallback to original word if lemmatization fails
        displayWord: parts[2].trim() || parts[1].trim() || word, // Fallback to lemmatized or original
        translation: parts[3].trim() || 'N/A',
        definition: parts[4].trim() || 'N/A',
      };
    } else {
      console.error(`Unexpected format from API for word details ("${word}"): ${responseText}. Expected 5 parts, got ${parts.length}.`);
      return { error: `Failed to parse details for "${word}". Unexpected format.` };
    }
  } catch (e: any) {
    console.error(`Error fetching word details via API for "${word}":`, e);
    return { error: (e as Error).message || `API error fetching details for "${word}".` };
  }
}

export async function fetchWordFrequencyFromApi(
  word: string,
  targetLanguage: string
): Promise<WordFrequencyResult | WordFrequencyError> {
  try {
    // First try to get frequency from smart tiered wordfreq data
    const freqResult = await getWordFrequency(word, targetLanguage);
    
    if (freqResult) {
      const rankInfo = freqResult.rank ? ` rank #${freqResult.rank}` : '';
      console.log(`📊 Found frequency for "${word}" in tiered data: ${freqResult.userFrequency} (internal: ${freqResult.frequency.toFixed(1)},${rankInfo})`);
      return { frequency: freqResult.userFrequency, rank: freqResult.rank };
    }
    
    // Word not found in any tier - fallback to Gemini API
    console.log(`⚠️ Word "${word}" not found in tiered wordfreq data, using Gemini API fallback`);
    
    if (!ai) return { error: "Gemini API client not initialized in service." };
    
    const prompt = `Rate the commonness of the ${targetLanguage} word "${word}" on a scale of 1 to 5. Use the following scale:
1: Highly rare or technical; almost never appears outside specific fields.
2: Somewhat uncommon; appears occasionally in books or niche conversations.
3: Neutral; part of educated vocabulary but not basic.
4: Common; heard regularly by most speakers.
5: Core/basic vocabulary known and used by nearly all fluent speakers.
Respond with ONLY the number (1, 2, 3, 4, or 5). Do not include any other text or explanation.`;

    const response: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
    });
    
    const responseText = response.text?.trim();
    if (!responseText) {
      return { error: "Empty response from Gemini API" };
    }
    
    const apiFrequency = parseInt(responseText, 10);
    if (isNaN(apiFrequency) || apiFrequency < 1 || apiFrequency > 5) {
      console.warn(`Invalid frequency for "${word}" in ${targetLanguage}: ${responseText}`);
      return { error: `Invalid frequency value: ${responseText}`};
    }
    return { frequency: apiFrequency };
  } catch (e: any) {
    console.error(`Error fetching frequency for "${word}" in ${targetLanguage}:`, e);
    return { error: (e as Error).message || `Error fetching frequency for "${word}".`};
  }
}

export async function fetchExampleSentencesFromApi(
  word: string, 
  sentenceContext: string, 
  definition: string, 
  partOfSpeech: string,
  targetLanguage: string,
  nativeLanguage: string
): Promise<ExampleSentencesResult | ExampleSentencesError> {
  if (!ai) return { error: "Gemini API client not initialized in service." };
  try {
    const prompt = `For the ${targetLanguage} word "${word}", which appeared in the ${targetLanguage} sentence "${sentenceContext}" (its definition in ${nativeLanguage} is "${definition}", and its part of speech in ${targetLanguage} is "${partOfSpeech}"), please generate exactly three distinct example sentences in ${targetLanguage}. Each example sentence must use the word "${word}" with this specific meaning and part of speech. 
For each of these ${targetLanguage} sentences, also provide its translation into ${nativeLanguage}.
Return this information as a JSON array of objects. Each object in the array must have exactly two string keys: 
1.  "englishSentence": This key's value should be the example sentence in ${targetLanguage}.
2.  "portugueseTranslation": This key's value should be the translation of that ${targetLanguage} sentence into ${nativeLanguage}.
Do not include any markdown formatting like \`\`\`json or \`\`\` in your response. The JSON array should contain exactly three objects.`;

    const response: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });
    
    let jsonStr = response.text?.trim() || "";
    const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
    const match = jsonStr.match(fenceRegex);
    if (match && match[2]) {
      jsonStr = match[2].trim();
    }
    
    let rawSentences: any[];
    try {
      const parsedJson = JSON.parse(jsonStr);
      if (!Array.isArray(parsedJson)) {
        console.warn(`Example sentences API response for word "${word}" was not an array:`, parsedJson);
        return { sentences: [] };
      }
      rawSentences = parsedJson;
    } catch (e) {
      console.error(`Failed to parse JSON response for example sentences (word: "${word}"):`, e, "Raw string:", jsonStr);
      return { sentences: [] }; // Return empty on parse error
    }

    const mappedSentences: FlashcardExampleSentence[] = rawSentences
      .map(s_raw => {
        if (s_raw && typeof s_raw === 'object' && 
            typeof s_raw.englishSentence === 'string' && 
            typeof s_raw.portugueseTranslation === 'string') {
          return {
            english: s_raw.englishSentence, 
            portugueseTranslation: s_raw.portugueseTranslation, 
          };
        }
        return null; 
      })
      .filter(s_mapped => s_mapped !== null && s_mapped.english.trim() !== '' && s_mapped.portugueseTranslation.trim() !== '') as FlashcardExampleSentence[];
    
    if (mappedSentences.length === 0 && rawSentences.length > 0) {
      console.warn(`For word "${word}", API returned ${rawSentences.length} items, but none were valid/complete after mapping. Original:`, rawSentences);
    }
    return { sentences: mappedSentences.slice(0, 3) };

  } catch (e: any) {
    console.error(`Error during API call for example sentences (word: "${word}"):`, e);
    return { error: (e as Error).message || `API error fetching example sentences for "${word}".` };
  }
}

// Preload core vocabulary for a target language
export async function preloadTargetLanguage(language: string): Promise<boolean> {
  console.log(`🚀 Preloading core vocabulary for ${language}...`);
  return await preloadCoreLanguage(language);
}

// Get wordfreq cache statistics
export function getWordfreqStats() {
  return getCacheStats();
}

export async function fetchEvaluationFromApi(
  transcriptHistory: TranscriptMessage[],
  targetLanguage: string,
  nativeLanguage: string
): Promise<EvaluationResult | EvaluationError> {
  if (!ai) return { error: "Gemini API client not initialized in service." };
  if (transcriptHistory.length === 0) {
    return { error: "Transcript is empty." };
  }

  const formattedTranscript = transcriptHistory
    .map(msg => `[${msg.speaker.toUpperCase()}]: ${msg.text}`)
    .join('\n\n');

  const prompt = `You are an AI language evaluation assistant. The user is a native ${nativeLanguage} speaker learning ${targetLanguage}.
Below is a transcript of a conversation they had in ${targetLanguage}. The parts labeled [USER] are from the user, and [MODEL] are from the AI.
Your task is to evaluate the user's ${targetLanguage} proficiency based ONLY on their contributions in the [USER] parts of the transcript.
Focus on identifying broad grammatical, lexical, or pronunciation categories where the user could improve, rather than correcting individual sentences.

Transcript:
---
${formattedTranscript}
---

Please provide your evaluation as a JSON object with the following structure:
1.  "improvementAreas": An array containing up to 3-4 objects. Each object should represent a general area or category for improvement in ${targetLanguage}. Examples of categories include "Present Tense Verb Conjugation", "Use of 'ser' vs 'estar'", "Noun-Adjective Agreement", "Pronunciation of 'r' sounds", "Vocabulary for daily routines". If the user's performance is excellent and no specific broad areas for improvement are evident from this short transcript, this array can be empty. Each object in the "improvementAreas" array must have two string keys:
    *   "category": The name of the improvement category, written in ${targetLanguage}.
    *   "description": A brief explanation of this category and why it's important or what the user should focus on, written in ${nativeLanguage}.
2.  "cefrLevel": A string representing your assessment of the user's overall CEFR level (e.g., "A1", "A2", "B1", "B2", "C1", "C2") demonstrated in this transcript for ${targetLanguage}.

Only return the JSON object. Do not include any markdown formatting like \`\`\`json or \`\`\` in your response. Ensure the "category" is in ${targetLanguage} and "description" is in ${nativeLanguage}.`;

  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    let jsonStr = response.text?.trim() || "";
    const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
    const match = jsonStr.match(fenceRegex);
    if (match && match[2]) {
      jsonStr = match[2].trim();
    }
    
    const rawResult = JSON.parse(jsonStr) as { 
      improvementAreas?: { category?: string, description?: string }[],
      cefrLevel?: string 
    };

    if (rawResult && Array.isArray(rawResult.improvementAreas) && typeof rawResult.cefrLevel === 'string') {
      const evaluation: EvaluationData = {
          improvementAreas: rawResult.improvementAreas.map(area => ({
              category: area.category || "N/A",
              description: area.description || "N/A"
          })).filter(area => area.category !== "N/A" && area.category.trim() !== "" && area.description !== "N/A" && area.description.trim() !== ""), 
          cefrLevel: rawResult.cefrLevel || "N/A"
      };
      return { evaluation };
    } else {
      console.error("Invalid JSON structure received from evaluation API:", rawResult);
      return { error: "Invalid data structure received from evaluation service." };
    }
  } catch (e: any) {
    console.error("Error evaluating transcript via API:", e);
    return { error: (e as Error).message || "API error during evaluation." };
  }
}
