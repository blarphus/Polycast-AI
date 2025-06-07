/**
 * Smart tiered wordfreq loading service
 * Only loads the target language, and loads tiers on-demand
 */

interface TierLoadState {
  core: boolean;
  extended: boolean;
  complete: boolean;
}

interface LanguageCache {
  core: Map<string, number>;
  extended: Map<string, number>;
  complete: Map<string, number>;
  loadState: TierLoadState;
  metadata?: any;
}

// Cache for loaded wordfreq data by language
const languageCache = new Map<string, LanguageCache>();

// Currently supported languages
const SUPPORTED_LANGUAGES = ['english', 'spanish', 'portuguese'];

// Convert internal 1-10 decimal scale to user-friendly 1-5 scale
export function convertToUserScale(internalFreq: number): number {
  if (internalFreq <= 2.0) {
    return 1; // Rare
  } else if (internalFreq <= 4.0) {
    return 2; // Uncommon
  } else if (internalFreq <= 6.0) {
    return 3; // Neutral
  } else if (internalFreq <= 8.0) {
    return 4; // Common
  } else {
    return 5; // Very common/basic
  }
}

// Get the cache for a language, creating it if needed
function getLanguageCache(language: string): LanguageCache {
  const langKey = language.toLowerCase();
  
  if (!languageCache.has(langKey)) {
    languageCache.set(langKey, {
      core: new Map<string, number>(),
      extended: new Map<string, number>(),
      complete: new Map<string, number>(),
      loadState: {
        core: false,
        extended: false,
        complete: false
      }
    });
  }
  
  return languageCache.get(langKey)!;
}

// Load a specific tier for a language
async function loadTier(language: string, tier: 'core' | 'extended' | 'complete'): Promise<boolean> {
  const langKey = language.toLowerCase();
  
  if (!SUPPORTED_LANGUAGES.includes(langKey)) {
    console.warn(`Language ${language} not supported for wordfreq`);
    return false;
  }
  
  const cache = getLanguageCache(langKey);
  
  // Skip if already loaded
  if (cache.loadState[tier]) {
    return true;
  }
  
  try {
    console.log(`📥 Loading ${tier} wordfreq data for ${language}...`);
    
    const response = await fetch(`/wordfreq-tiers/${langKey}-${tier}.json`);
    
    if (!response.ok) {
      throw new Error(`Failed to load ${tier} data: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Load into the appropriate tier cache from the new ranked format
    if (data.lookup) {
      // New format with lookup object
      if (!wordRankCache.has(langKey)) {
        wordRankCache.set(langKey, new Map());
      }
      const rankCache = wordRankCache.get(langKey)!;
      
      for (const [word, wordData] of Object.entries(data.lookup)) {
        const typedWordData = wordData as { frequency: number; rank: number; user_frequency: number };
        cache[tier].set(word.toLowerCase(), typedWordData.frequency);
        rankCache.set(word.toLowerCase(), {
          frequency: typedWordData.frequency,
          rank: typedWordData.rank,
          userFrequency: typedWordData.user_frequency
        });
      }
    } else {
      // Fallback for old format
      for (const [word, frequency] of Object.entries(data)) {
        cache[tier].set(word.toLowerCase(), frequency as number);
      }
    }
    
    cache.loadState[tier] = true;
    
    console.log(`✅ Loaded ${tier} tier for ${language}: ${Object.keys(data).length} words`);
    return true;
    
  } catch (error) {
    console.error(`Failed to load ${tier} tier for ${language}:`, error);
    cache.loadState[tier] = false;
    return false;
  }
}

// Load metadata for a language
async function loadMetadata(language: string): Promise<any> {
  const langKey = language.toLowerCase();
  const cache = getLanguageCache(langKey);
  
  if (cache.metadata) {
    return cache.metadata;
  }
  
  try {
    const response = await fetch(`/wordfreq-tiers/${langKey}-metadata.json`);
    if (response.ok) {
      cache.metadata = await response.json();
      return cache.metadata;
    }
  } catch (error) {
    console.warn(`Could not load metadata for ${language}:`, error);
  }
  
  return null;
}

// Store word rank data for easy access
const wordRankCache = new Map<string, Map<string, { frequency: number; rank: number; userFrequency: number }>>();

// Smart word frequency lookup with tiered loading
export async function getWordFrequency(word: string, language: string): Promise<{ frequency: number; userFrequency: number; rank?: number } | null> {
  const langKey = language.toLowerCase();
  const wordKey = word.toLowerCase();
  
  if (!SUPPORTED_LANGUAGES.includes(langKey)) {
    console.warn(`Language ${language} not supported for wordfreq`);
    return null;
  }
  
  const cache = getLanguageCache(langKey);
  
  // Step 1: Check core tier (load if not loaded)
  if (!cache.loadState.core) {
    const loaded = await loadTier(langKey, 'core');
    if (!loaded) return null;
  }
  
  let frequency = cache.core.get(wordKey);
  if (frequency !== undefined) {
    const rankData = wordRankCache.get(langKey)?.get(wordKey);
    return {
      frequency,
      userFrequency: convertToUserScale(frequency),
      rank: rankData?.rank
    };
  }
  
  // Step 2: Check extended tier (load if not loaded)
  if (!cache.loadState.extended) {
    console.log(`🔍 Word "${word}" not in core, loading extended tier...`);
    const loaded = await loadTier(langKey, 'extended');
    if (!loaded) return null;
  }
  
  frequency = cache.extended.get(wordKey);
  if (frequency !== undefined) {
    const rankData = wordRankCache.get(langKey)?.get(wordKey);
    return {
      frequency,
      userFrequency: convertToUserScale(frequency),
      rank: rankData?.rank
    };
  }
  
  // Step 3: Check complete tier (load if not loaded)
  if (!cache.loadState.complete) {
    console.log(`🔍 Word "${word}" not in extended, loading complete tier...`);
    const loaded = await loadTier(langKey, 'complete');
    if (!loaded) return null;
  }
  
  frequency = cache.complete.get(wordKey);
  if (frequency !== undefined) {
    const rankData = wordRankCache.get(langKey)?.get(wordKey);
    return {
      frequency,
      userFrequency: convertToUserScale(frequency),
      rank: rankData?.rank
    };
  }
  
  // Word not found in any tier
  console.log(`⚠️ Word "${word}" not found in any ${language} tier`);
  return null;
}

// Preload core tier for a language (call when user selects target language)
export async function preloadCoreLanguage(language: string): Promise<boolean> {
  console.log(`🚀 Preloading core vocabulary for ${language}...`);
  
  const success = await loadTier(language.toLowerCase(), 'core');
  
  if (success) {
    // Also load metadata in background
    loadMetadata(language.toLowerCase()).catch(err => 
      console.warn('Failed to load metadata:', err)
    );
  }
  
  return success;
}

// Get loading status for a language
export function getLoadingStatus(language: string): TierLoadState {
  const cache = getLanguageCache(language.toLowerCase());
  return { ...cache.loadState };
}

// Get cache statistics
export function getCacheStats(): { [language: string]: { 
  coreWords: number; 
  extendedWords: number; 
  completeWords: number;
  totalWords: number;
  loadState: TierLoadState;
}} {
  const stats: any = {};
  
  for (const [lang, cache] of languageCache.entries()) {
    stats[lang] = {
      coreWords: cache.core.size,
      extendedWords: cache.extended.size,
      completeWords: cache.complete.size,
      totalWords: cache.core.size + cache.extended.size + cache.complete.size,
      loadState: { ...cache.loadState }
    };
  }
  
  return stats;
}

// Get words by rank range (useful for flashcard generation)
export async function getWordsByRankRange(
  language: string, 
  startRank: number, 
  endRank: number
): Promise<Array<{ word: string; frequency: number; rank: number; userFrequency: number }> | null> {
  const langKey = language.toLowerCase();
  
  if (!SUPPORTED_LANGUAGES.includes(langKey)) {
    console.warn(`Language ${language} not supported for wordfreq`);
    return null;
  }

  // Determine which tiers we need to load
  const neededTiers: Array<'core' | 'extended' | 'complete'> = [];
  
  if (startRank <= 15000) neededTiers.push('core');
  if (startRank <= 65000 && endRank > 15000) neededTiers.push('extended');
  if (endRank > 65000) neededTiers.push('complete');

  // Load required tiers
  for (const tier of neededTiers) {
    await loadTier(langKey, tier);
  }

  // Get rank cache
  const rankCache = wordRankCache.get(langKey);
  if (!rankCache) return null;

  // Filter words by rank range
  const words: Array<{ word: string; frequency: number; rank: number; userFrequency: number }> = [];
  
  for (const [word, data] of rankCache.entries()) {
    if (data.rank >= startRank && data.rank <= endRank) {
      words.push({
        word,
        frequency: data.frequency,
        rank: data.rank,
        userFrequency: data.userFrequency
      });
    }
  }

  // Sort by rank
  words.sort((a, b) => a.rank - b.rank);
  
  return words;
}

// Clear cache for a language (useful for memory management)
export function clearLanguageCache(language: string): void {
  const langKey = language.toLowerCase();
  languageCache.delete(langKey);
  wordRankCache.delete(langKey);
  console.log(`🧹 Cleared cache for ${language}`);
} 