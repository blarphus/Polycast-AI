#!/usr/bin/env python3
"""
Export wordfreq data to JSON files for use in the frontend.
This creates frequency data for the top words in each language.
"""

from wordfreq import word_frequency, top_n_list
import json
import os

def convert_frequency_to_scale(freq):
    """Convert wordfreq frequency (0-1) to our 1-5 scale."""
    if freq == 0:
        return 1
    elif freq < 1e-6:
        return 1  # Very rare
    elif freq < 1e-5:
        return 2  # Uncommon
    elif freq < 1e-4:
        return 3  # Neutral
    elif freq < 1e-3:
        return 4  # Common
    else:
        return 5  # Very common/basic

def export_language_frequencies(language_name, language_code, num_words=None):
    """Export frequency data for a specific language."""
    print(f"Exporting {language_name} ({language_code}) frequencies...")
    
    try:
        # Get maximum available words for this language if num_words not specified
        if num_words is None:
            # Find maximum available by trying progressively larger numbers
            test_sizes = [100000, 200000, 300000, 400000, 500000]
            max_words = 50000  # Fallback minimum
            
            for size in test_sizes:
                try:
                    test_words = top_n_list(language_code, size)
                    if len(test_words) < size:
                        max_words = len(test_words)
                        break
                    max_words = len(test_words)
                except:
                    break
            
            print(f"  Auto-detected maximum: {max_words:,} words")
            words = top_n_list(language_code, max_words)
        else:
            # Use specified number
            words = top_n_list(language_code, num_words)
            
        print(f"  Found {len(words):,} words")
        
        freq_data = {}
        
        for i, word in enumerate(words):
            if i % 5000 == 0:
                print(f"  Processing word {i+1:,}/{len(words):,} ({(i+1)/len(words)*100:.1f}%)")
            
            freq = word_frequency(word, language_code)
            scaled_freq = convert_frequency_to_scale(freq)
            freq_data[word] = scaled_freq
        
        # Create public directory if it doesn't exist
        os.makedirs('public', exist_ok=True)
        
        # Write to JSON file
        filename = f'public/wordfreq-{language_name.lower()}.json'
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(freq_data, f, ensure_ascii=False, indent=2)
        
        # Calculate file size
        file_size_mb = os.path.getsize(filename) / 1024 / 1024
        print(f"  Exported {len(freq_data):,} words to {filename} ({file_size_mb:.1f} MB)")
        return len(freq_data)
        
    except Exception as e:
        print(f"  Error exporting {language_name}: {e}")
        return 0

def main():
    """Export frequency data for all supported languages."""
    print("Starting wordfreq data export...")
    
    languages = {
        'English': 'en',
        'Spanish': 'es', 
        'Portuguese': 'pt'
    }
    
    total_words = 0
    
    for lang_name, lang_code in languages.items():
        word_count = export_language_frequencies(lang_name, lang_code)
        total_words += word_count
        print()
    
    print(f"Export complete! Total words exported: {total_words:,}")
    print("\nFiles created in the 'public/' directory:")
    total_size = 0
    for lang_name in languages.keys():
        filename = f"public/wordfreq-{lang_name.lower()}.json"
        if os.path.exists(filename):
            size = os.path.getsize(filename) / 1024 / 1024  # MB
            total_size += size
            print(f"  {filename} ({size:.1f} MB)")
    print(f"\nTotal dictionary size: {total_size:.1f} MB")

if __name__ == '__main__':
    main() 