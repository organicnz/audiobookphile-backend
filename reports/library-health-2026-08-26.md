# Library Health Report — 2025-08-25/26 repair sessions

Production: `iambzzclljayqdxkeepy` · All mutations snapshotted to `reports/backups/`

## Structural repairs
| Fix | Scale | Verification |
|---|---|---|
| Duration-less duplicate entries purged from `library_files` | 3,246 entries / 97 items | post-counts clean |
| Non-audio files (PDF, MP4s) moved out of `audio_files` | 4 entries | af nonaudio=0 |
| AppleDouble `._Patriot.mp3` junk objects deleted from Storage | 8 folders | bucket listing |
| Orphaned `playback_sessions` (dead item refs) deleted | 63 rows | all FK tables now 0 orphans |

## Recovered audiobooks
| Item | Recovery | Plays? |
|---|---|---|
| Three Body Problem | 59 objects re-keyed from orphaned storage folder into `{itemId}/` | ✅ 60 tracks, HTTP 206 |
| Demon-Haunted World | track 1 recovered; parts 2-4 never migrated | partial, `missingTrackCount=3` |

## Splits (multi-book items)
- **Quantum Gravity** (400 tracks) → 3 novels: Keeping It Real (81) / Selling Out (163) / Going Under (156)
- **"Aldous Huxley "** → The Divine Within + The Perennial Philosophy (1 track each)

## Merges (audited)
- Mortality ×2 — byte-identical rips → merged via audited `merge_two_library_items`; merge + deletion audit rows recorded

## Titles/authors recovered (19 items)
Evidence sources: embedded `tagAlbum`/`tagArtist`, folder paths, single-track names.
Project Hail Mary · 101 Essays That Will Change the Way You Think · We Need to Talk About the
British Empire · Everything I Know · The Willpower Instinct · Fear: Trump in the White House ·
The Insecure Mind of Sergei Kraev · Arguably: Essays · The Demon-Haunted World · Particle
Physics: A Very Short Introduction · The Field · Сумерки богов · 21 Lessons for the 21st
Century · Eat and Run · Feynman Lectures Vol. 2 · The Hidden Reality · Decoding Reality:
subtitle · Uncertainty: subtitle · Experiencing Needs as a Gift.

## Deliberately left alone
- Dark Psychology Collection vs Essential Guide subset: identical generic chapter names make
  any filename-dedupe merge destructive. Separate is correct.
- 9 NULL-author items with no embedded tags — honest unknown > fabricated data.
- Erich Fromm Collection kept as one intentional collection item.
- Улисс / Ulysses: different translations, legitimately separate.

## Remaining work for owner
- **86 byte-less legacy imports** need re-upload: `reports/reupload-needed-2026-08-25.csv`
- Rotate the Groq/z.ai API keys shared in chat (already stored in GH Secrets)
