#!/usr/bin/env python3
"""
Export wordfreq data to tiered JSON files for smart loading.
Creates three tiers per language: core (15k), extended (next 50k), complete (remaining).
Uses 1-10 decimal scale internally for more accuracy.
"""

from wordfreq import word_frequency, top_n_list
import json
import os

def convert_frequency_to_detailed_scale(freq):
    """Convert wordfreq frequency (0-1) to detailed 1-10 scale with decimals."""
    if freq == 0:
        return 1.0
    elif freq < 1e-7:
        return 1.0  # Extremely rare
    elif freq < 5e-7:
        return 1.5  # Very rare
    elif freq < 1e-6:
        return 2.0  # Rare
    elif freq < 5e-6:
        return 2.5  # Uncommon
    elif freq < 1e-5:
        return 3.0  # Somewhat uncommon
    elif freq < 5e-5:
        return 4.0  # Below average
    elif freq < 1e-4:
        return 5.0  # Average/neutral
    elif freq < 5e-4:
        return 6.0  # Above average
    elif freq < 1e-3:
        return 7.0  # Common
    elif freq < 5e-3:
        return 8.0  # Very common
    elif freq < 1e-2:
        return 9.0  # Extremely common
    else:
        return 10.0  # Core vocabulary

def convert_to_user_scale_by_rank(rank, total_words):
    """Convert rank position to user-friendly 1-5 scale based on distribution 5:4:3:2:1 = 1:2:4:8:16."""
    # Calculate percentile from rank (lower rank = higher percentile)
    percentile = (total_words - rank + 1) / total_words
    
    # Distribution: 5:4:3:2:1 = 1:2:4:8:16 (out of 32 parts)
    # Frequency 5 (most common): top 3.125% (1/32)
    # Frequency 4: next 6.25% (2/32) - top 9.375%
    # Frequency 3: next 12.5% (4/32) - top 21.875%
    # Frequency 2: next 25% (8/32) - top 46.875%
    # Frequency 1: remaining 53.125% (16/32)
    
    if percentile >= 0.96875:    # Top 3.125%
        return 5  # Very common/basic
    elif percentile >= 0.90625:  # Top 9.375%
        return 4  # Common
    elif percentile >= 0.78125:  # Top 21.875%
        return 3  # Neutral
    elif percentile >= 0.53125:  # Top 46.875%
        return 2  # Uncommon
    else:                        # Bottom 53.125%
        return 1  # Rare

def export_tiered_language_data(language_name, language_code):
    """Export tiered frequency data for a specific language."""
    print(f"Exporting tiered data for {language_name} ({language_code})...")
    
    try:
        # Get maximum available words
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
        
        print(f"  Total available: {max_words:,} words")
        all_words = top_n_list(language_code, max_words)
        
        # Define tier boundaries
        tier_boundaries = {
            'core': 15000,      # Most common 15k words
            'extended': 65000,  # Next 50k words (total 65k)
            'complete': max_words  # All remaining words
        }
        
        # Create tiered data with ranking
        tiers = {
            'core': [],
            'extended': [],
            'complete': []
        }
        
        print(f"  Processing {len(all_words):,} words into tiers...")
        
        for i, word in enumerate(all_words):
            if i % 10000 == 0:
                print(f"    Progress: {i+1:,}/{len(all_words):,} ({(i+1)/len(all_words)*100:.1f}%)")
            
            freq = word_frequency(word, language_code)
            detailed_freq = convert_frequency_to_detailed_scale(freq)
            rank = i + 1  # 1-based ranking
            
            # Create word entry with frequency and rank
            word_entry = {
                'word': word,
                'frequency': detailed_freq,
                'rank': rank,
                'user_frequency': convert_to_user_scale_by_rank(rank, len(all_words))
            }
            
            # Determine which tier this word belongs to
            if i < tier_boundaries['core']:
                tiers['core'].append(word_entry)
            elif i < tier_boundaries['extended']:
                tiers['extended'].append(word_entry)
            else:
                tiers['complete'].append(word_entry)
        
        # Create public directory if it doesn't exist
        os.makedirs('public/wordfreq-tiers', exist_ok=True)
        
        # Export each tier
        total_size = 0
        tier_info = {}
        
        for tier_name, tier_data in tiers.items():
            if not tier_data:  # Skip empty tiers
                continue
                
            filename = f'public/wordfreq-tiers/{language_name.lower()}-{tier_name}.json'
            
            # Create both formats: array with ranking info and lookup object
            tier_export = {
                'words': tier_data,  # Array of word objects with rank/frequency
                'lookup': {entry['word']: {
                    'frequency': entry['frequency'],
                    'rank': entry['rank'],
                    'user_frequency': entry['user_frequency']
                } for entry in tier_data},  # Fast lookup object
                'tier_info': {
                    'name': tier_name,
                    'word_count': len(tier_data),
                    'rank_range': [tier_data[0]['rank'], tier_data[-1]['rank']] if tier_data else [0, 0]
                }
            }
            
            with open(filename, 'w', encoding='utf-8') as f:
                json.dump(tier_export, f, ensure_ascii=False, separators=(',', ':'))  # Compact format
            
            file_size_mb = os.path.getsize(filename) / 1024 / 1024
            total_size += file_size_mb
            tier_info[tier_name] = {
                'words': len(tier_data),
                'size_mb': file_size_mb,
                'filename': filename,
                'rank_range': tier_export['tier_info']['rank_range']
            }
            
            print(f"    {tier_name.upper()}: {len(tier_data):,} words -> {filename} ({file_size_mb:.1f} MB)")
            print(f"      Rank range: {tier_export['tier_info']['rank_range'][0]:,} - {tier_export['tier_info']['rank_range'][1]:,}")
        
        # Create metadata file for this language
        metadata = {
            'language': language_name,
            'language_code': language_code,
            'total_words': len(all_words),
            'total_size_mb': total_size,
            'tiers': tier_info,
            'frequency_scale': {
                'internal': '1.0-10.0 with decimals',
                'user_display': '1-5 integer scale'
            },
            'tier_boundaries': tier_boundaries
        }
        
        metadata_file = f'public/wordfreq-tiers/{language_name.lower()}-metadata.json'
        with open(metadata_file, 'w', encoding='utf-8') as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
        
        print(f"  ✅ {language_name} complete: {len(all_words):,} words, {total_size:.1f} MB total")
        return len(all_words)
        
    except Exception as e:
        print(f"  ❌ Error exporting {language_name}: {e}")
        return 0

def main():
    """Export tiered frequency data for all supported languages."""
    print("Starting tiered wordfreq data export...")
    print("=" * 60)
    
    languages = {
        'English': 'en',
        'Spanish': 'es', 
        'Portuguese': 'pt'
    }
    
    total_words = 0
    
    for lang_name, lang_code in languages.items():
        word_count = export_tiered_language_data(lang_name, lang_code)
        total_words += word_count
        print()
    
    print("=" * 60)
    print(f"🎉 Tiered export complete!")
    print(f"📊 Total words exported: {total_words:,}")
    print(f"📁 Files created in 'public/wordfreq-tiers/' directory")
    
    # Show directory contents
    if os.path.exists('public/wordfreq-tiers'):
        files = sorted(os.listdir('public/wordfreq-tiers'))
        total_dir_size = 0
        
        print(f"\n📂 Directory contents:")
        for file in files:
            filepath = f'public/wordfreq-tiers/{file}'
            size_mb = os.path.getsize(filepath) / 1024 / 1024
            total_dir_size += size_mb
            print(f"  {file} ({size_mb:.1f} MB)")
        
        print(f"\n💾 Total directory size: {total_dir_size:.1f} MB")

if __name__ == '__main__':
    main() 