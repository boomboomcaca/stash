package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/stashapp/stash/internal/manager/config"
	"github.com/stashapp/stash/pkg/logger"
)

type favoritesRoutes struct{}

type FavoriteWord struct {
	Word     string `json:"word"`
	Language string `json:"language"`
}

var (
	favoritesFile     = ""
	favoritesLock     sync.RWMutex
	favoritesFileOnce sync.Once
)

func getFavoritesFile() string {
	favoritesFileOnce.Do(func() {
		// Get config directory from stash config
		configDir := config.GetInstance().GetConfigPath()
		favoritesFile = filepath.Join(filepath.Dir(configDir), "favorites.json")
	})
	return favoritesFile
}

func (rs favoritesRoutes) Routes() chi.Router {
	r := chi.NewRouter()

	r.Get("/", rs.GetFavorites)
	r.Post("/add", rs.AddFavorite)
	r.Post("/remove", rs.RemoveFavorite)
	r.Get("/check", rs.CheckFavorite)

	return r
}

// GetFavorites returns all favorite words
func (rs favoritesRoutes) GetFavorites(w http.ResponseWriter, r *http.Request) {
	favorites, err := loadFavorites()
	if err != nil {
		logger.Errorf("Failed to load favorites: %v", err)
		http.Error(w, "Failed to load favorites", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if err := json.NewEncoder(w).Encode(favorites); err != nil {
		logger.Warnf("Failed to encode favorites response: %v", err)
	}
}

// AddFavorite adds a word to favorites
func (rs favoritesRoutes) AddFavorite(w http.ResponseWriter, r *http.Request) {
	var favorite FavoriteWord
	if err := json.NewDecoder(r.Body).Decode(&favorite); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if favorite.Word == "" {
		http.Error(w, "Word is required", http.StatusBadRequest)
		return
	}

	favorites, err := loadFavorites()
	if err != nil {
		logger.Errorf("Failed to load favorites: %v", err)
		http.Error(w, "Failed to load favorites", http.StatusInternalServerError)
		return
	}

	// Check if already exists
	for _, f := range favorites {
		if f.Word == favorite.Word && f.Language == favorite.Language {
			// Already exists, return success
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			if err := json.NewEncoder(w).Encode(map[string]bool{"success": true, "exists": true}); err != nil {
				logger.Warnf("Failed to encode response: %v", err)
			}
			return
		}
	}

	// Add new favorite
	favorites = append(favorites, favorite)

	if err := saveFavorites(favorites); err != nil {
		logger.Errorf("Failed to save favorites: %v", err)
		http.Error(w, "Failed to save favorites", http.StatusInternalServerError)
		return
	}

	logger.Debugf("Added favorite word: %s (%s)", favorite.Word, favorite.Language)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if err := json.NewEncoder(w).Encode(map[string]bool{"success": true, "exists": false}); err != nil {
		logger.Warnf("Failed to encode response: %v", err)
	}
}

// RemoveFavorite removes a word from favorites
func (rs favoritesRoutes) RemoveFavorite(w http.ResponseWriter, r *http.Request) {
	var favorite FavoriteWord
	if err := json.NewDecoder(r.Body).Decode(&favorite); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if favorite.Word == "" {
		http.Error(w, "Word is required", http.StatusBadRequest)
		return
	}

	favorites, err := loadFavorites()
	if err != nil {
		logger.Errorf("Failed to load favorites: %v", err)
		http.Error(w, "Failed to load favorites", http.StatusInternalServerError)
		return
	}

	// Remove the word
	newFavorites := make([]FavoriteWord, 0)
	found := false
	for _, f := range favorites {
		if f.Word == favorite.Word && f.Language == favorite.Language {
			found = true
			continue
		}
		newFavorites = append(newFavorites, f)
	}

	if !found {
		// Word not in favorites, return success anyway
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if err := json.NewEncoder(w).Encode(map[string]bool{"success": true}); err != nil {
			logger.Warnf("Failed to encode response: %v", err)
		}
		return
	}

	if err := saveFavorites(newFavorites); err != nil {
		logger.Errorf("Failed to save favorites: %v", err)
		http.Error(w, "Failed to save favorites", http.StatusInternalServerError)
		return
	}

	logger.Debugf("Removed favorite word: %s (%s)", favorite.Word, favorite.Language)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if err := json.NewEncoder(w).Encode(map[string]bool{"success": true}); err != nil {
		logger.Warnf("Failed to encode response: %v", err)
	}
}

// CheckFavorite checks if a word is in favorites
func (rs favoritesRoutes) CheckFavorite(w http.ResponseWriter, r *http.Request) {
	word := r.URL.Query().Get("word")
	lang := r.URL.Query().Get("lang")

	if word == "" {
		http.Error(w, "word parameter is required", http.StatusBadRequest)
		return
	}

	favorites, err := loadFavorites()
	if err != nil {
		logger.Errorf("Failed to load favorites: %v", err)
		http.Error(w, "Failed to load favorites", http.StatusInternalServerError)
		return
	}

	isFavorite := false
	for _, f := range favorites {
		if f.Word == word && f.Language == lang {
			isFavorite = true
			break
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if err := json.NewEncoder(w).Encode(map[string]bool{"isFavorite": isFavorite}); err != nil {
		logger.Warnf("Failed to encode response: %v", err)
	}
}

// loadFavorites loads favorites from JSON file
func loadFavorites() ([]FavoriteWord, error) {
	favoritesLock.RLock()
	defer favoritesLock.RUnlock()

	file := getFavoritesFile()

	// Check if file exists
	if _, err := os.Stat(file); os.IsNotExist(err) {
		return []FavoriteWord{}, nil
	}

	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}

	var favorites []FavoriteWord
	if err := json.Unmarshal(data, &favorites); err != nil {
		return nil, err
	}

	return favorites, nil
}

// saveFavorites saves favorites to JSON file
func saveFavorites(favorites []FavoriteWord) error {
	favoritesLock.Lock()
	defer favoritesLock.Unlock()

	file := getFavoritesFile()

	data, err := json.MarshalIndent(favorites, "", "  ")
	if err != nil {
		return err
	}

	// Ensure directory exists
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	return os.WriteFile(file, data, 0644)
}
