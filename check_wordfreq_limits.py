#!/usr/bin/env python3
"""
Check the maximum available words in wordfreq for each language.
"""

from wordfreq import top_n_list, available_languages
import sys

def check_language_limits():
    """Check how many words are available for each language."""
    languages = {
        'English': 'en',
        'Spanish': 'es', 
        'Portuguese': 'pt'
    }
    
    print("Checking wordfreq limits for each language...")
    print("=" * 50)
    
    for lang_name, lang_code in languages.items():
        print(f"\n{lang_name} ({lang_code}):")
        
        # Try different sizes to find the limit
        test_sizes = [10000, 25000, 50000, 100000, 200000, 500000, 1000000]
        max_available = 0
        
        for size in test_sizes:
            try:
                words = top_n_list(lang_code, size)
                actual_count = len(words)
                max_available = actual_count
                print(f"  {size:,} requested -> {actual_count:,} available")
                
                # If we got fewer words than requested, we've hit the limit
                if actual_count < size:
                    break
                    
            except Exception as e:
                print(f"  {size:,} -> Error: {e}")
                break
        
        print(f"  📊 Maximum available: {max_available:,} words")
    
    print("\n" + "=" * 50)
    print("All available languages in wordfreq:")
    all_langs = available_languages()
    print(f"Total languages: {len(all_langs)}")
    for lang in sorted(all_langs):
        print(f"  {lang}")

if __name__ == '__main__':
    check_language_limits() 