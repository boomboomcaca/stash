// Favorites API service

const API_BASE = ""; // Use relative URL since we're on same domain

export interface IFavoriteWord {
  word: string;
  language: string;
}

export interface IFavoriteResponse {
  success: boolean;
  exists?: boolean;
}

export interface ICheckFavoriteResponse {
  isFavorite: boolean;
}

// Cache for favorites to reduce API calls
let favoritesCache: Set<string> | null = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5000; // 5 seconds

function getCacheKey(word: string, language: string): string {
  return `${word.toLowerCase()}:${language}`;
}

function isCacheValid(): boolean {
  return (
    favoritesCache !== null && Date.now() - cacheTimestamp < CACHE_DURATION
  );
}

function updateCache(favorites: IFavoriteWord[]): void {
  favoritesCache = new Set(
    favorites.map((f) => getCacheKey(f.word, f.language))
  );
  cacheTimestamp = Date.now();
}

export async function getFavorites(): Promise<IFavoriteWord[]> {
  try {
    const response = await fetch(`${API_BASE}/favorites/`);
    if (!response.ok) {
      throw new Error(`Failed to get favorites: ${response.statusText}`);
    }
    const favorites = await response.json();
    updateCache(favorites);
    return favorites;
  } catch (error) {
    return [];
  }
}

export async function addFavorite(
  word: string,
  language: string
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/favorites/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ word, language }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add favorite: ${response.statusText}`);
    }

    const result: IFavoriteResponse = await response.json();

    // Update cache
    if (favoritesCache) {
      favoritesCache.add(getCacheKey(word, language));
    }

    return result.success;
  } catch (error) {
    return false;
  }
}

export async function removeFavorite(
  word: string,
  language: string
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/favorites/remove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ word, language }),
    });

    if (!response.ok) {
      throw new Error(`Failed to remove favorite: ${response.statusText}`);
    }

    const result: IFavoriteResponse = await response.json();

    // Update cache
    if (favoritesCache) {
      favoritesCache.delete(getCacheKey(word, language));
    }

    return result.success;
  } catch (error) {
    return false;
  }
}

export async function checkFavorite(
  word: string,
  language: string
): Promise<boolean> {
  // Check cache first
  if (isCacheValid() && favoritesCache) {
    return favoritesCache.has(getCacheKey(word, language));
  }

  try {
    const response = await fetch(
      `${API_BASE}/favorites/check?word=${encodeURIComponent(
        word
      )}&lang=${encodeURIComponent(language)}`
    );
    if (!response.ok) {
      throw new Error(`Failed to check favorite: ${response.statusText}`);
    }

    const result: ICheckFavoriteResponse = await response.json();
    return result.isFavorite;
  } catch (error) {
    return false;
  }
}

// Load favorites into cache on module load
getFavorites().catch(() => {});
