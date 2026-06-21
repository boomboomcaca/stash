#!/usr/bin/perl
# Corrects ASR errors in the LN3 English transcript.
# Operates only on subtitle TEXT lines (not the index/timecode lines).
use strict; use warnings;
local $/; my $s = <STDIN>;

# Split into cue blocks separated by blank lines, fix only text lines.
my @blocks = split /\n\n/, $s;
for my $b (@blocks) {
  my @l = split /\n/, $b;
  next if @l < 3;                       # need index, timecode, >=1 text line
  for my $i (2..$#l) {                  # text lines start at index 2
    local $_ = $l[$i];

    # --- multi-word, do first (most specific) ---
    s/\bLohan alone\b/Low and Alone/g;          # "Lo and Alone" misheard
    s/\bLone and Alone\b/Low and Alone/g;
    s/\bLoan alone\b/Low and Alone/g;
    s/\bLow Lo wakes\b/Low wakes/g;             # dup
    s/\bfrom low and alone\b/from Low and Alone/g;
    s/takes a loan by the hand/takes Alone by the hand/g;
    s/\bA lone follows\b/Alone follows/g;
    s/resembles a loan/resembles Alone/g;
    s/to that of alone\b/to that of Alone/g;
    s/the supervisor Visor\b/the Supervisor/g;  # dup "supervisor, visor"
    s/\bThe The Necropolis\b/The Necropolis/g;
    s/transmission, mission/transmission/g;     # dup
    s/saved by Annette\b/saved by a net/g;       # "a net"
    s/was The Maw the Maw was/was The Maw. The Maw was/g;
    s/^age, living puppets/living puppets/g;     # echo of "stage"

    # --- single-token name normalisation ---
    s/\bLowe\b/Low/g;
    s/\bAlonne\b/Alone/g;
    s/\bLo\b/Low/g;                              # standalone "Lo" -> name
    s/\balone\b/Alone/g;                         # lowercase char ref -> name

    # --- lore term spelling ---
    s/\bgnomes\b/Nomes/g;
    s/\bgnome\b/Nome/g;
    s/\bInstitution\b/Institute/g;
    s/\bthe necropolis\b/the Necropolis/g;
    s/\bresting monster baby\b/resting Monster Baby/g;

    # --- stray mid-sentence "The" capitalisation (specific, safe) ---
    s/through The grates/through the grates/g;
    s/reopens The chute/reopens the chute/g;
    s/halls of The asylum/halls of the asylum/g;
    s/in The podcast series/in the podcast series/g;
    s/The chute\b/the chute/g;

    $l[$i] = $_;
  }
  $b = join "\n", @l;
}
print join "\n\n", @blocks;
