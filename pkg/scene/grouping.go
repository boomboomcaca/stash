package scene

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"

	"github.com/stashapp/stash/pkg/logger"
	"github.com/stashapp/stash/pkg/models"
)

var (
	// S01E01, s01e01, S1E1, etc. (Restrict season to 2 digits, episode to 4)
	seasonEpisodeRegex = regexp.MustCompile(`(?i)(.*?)[ ._-]s(\d{1,2})e(\d{1,4})`)
	// 1x01, 01x01, etc. (Restrict season to 2 digits, episode to 3 to avoid resolution conflict)
	xRegex = regexp.MustCompile(`(?i)(.*?)[ ._-](\d{1,2})x(\d{1,3})(?:$|[ ._-])`)
	// 第1季第1集 (Restrict season to 2 digits)
	chineseSeasonRegex = regexp.MustCompile(`(?i)(.*?)[ ._-]?第(\d{1,2})季[ ._-]?第(\d{1,4})集`)
)

type GroupingInfo struct {
	ShowName   string
	SeasonNum  int
	EpisodeNum int
	HasSeason  bool
	HasEpisode bool
}

func parseGroupingInfo(filename string) *GroupingInfo {
	// remove extension
	dotIndex := strings.LastIndex(filename, ".")
	if dotIndex != -1 {
		filename = filename[:dotIndex]
	}

	info := &GroupingInfo{}

	if matches := seasonEpisodeRegex.FindStringSubmatch(filename); len(matches) > 3 {
		logger.Infof("[Grouping] Matched seasonEpisodeRegex for %s: Show=%s, S=%s, E=%s", filename, matches[1], matches[2], matches[3])
		info.ShowName = cleanTitle(matches[1])
		info.SeasonNum, _ = strconv.Atoi(matches[2])
		info.EpisodeNum, _ = strconv.Atoi(matches[3])
		info.HasSeason = true
		info.HasEpisode = true
	} else if matches := xRegex.FindStringSubmatch(filename); len(matches) > 3 {
		logger.Infof("[Grouping] Matched xRegex for %s: Show=%s, S=%s, E=%s", filename, matches[1], matches[2], matches[3])
		info.ShowName = cleanTitle(matches[1])
		info.SeasonNum, _ = strconv.Atoi(matches[2])
		info.EpisodeNum, _ = strconv.Atoi(matches[3])
		info.HasSeason = true
		info.HasEpisode = true
	} else if matches := chineseSeasonRegex.FindStringSubmatch(filename); len(matches) > 3 {
		logger.Infof("[Grouping] Matched chineseSeasonRegex for %s: Show=%s, S=%s, E=%s", filename, matches[1], matches[2], matches[3])
		info.ShowName = cleanTitle(matches[1])
		info.SeasonNum, _ = strconv.Atoi(matches[2])
		info.EpisodeNum, _ = strconv.Atoi(matches[3])
		info.HasSeason = true
		info.HasEpisode = true
	}

	if info.ShowName == "" {
		return nil
	}

	return info
}

func cleanTitle(title string) string {
	title = strings.ReplaceAll(title, ".", " ")
	title = strings.ReplaceAll(title, "_", " ")
	title = strings.Trim(title, " ._-")
	// Capitalize each word
	return cases.Title(language.English).String(strings.ToLower(title))
}

type GroupRepository interface {
	FindByName(ctx context.Context, name string, nocase bool) (*models.Group, error)
	Create(ctx context.Context, newGroup *models.Group) error
	UpdatePartial(ctx context.Context, id int, updatedGroup models.GroupPartial) (*models.Group, error)
}

func autoGroupScene(ctx context.Context, groupRepo GroupRepository, sceneRepo ScanCreatorUpdater, sceneID int, filename string) error {
	info := parseGroupingInfo(filename)
	if info == nil {
		return nil
	}

	logger.Infof("Auto-grouping scene %d: Show=%s, Season=%d, Episode=%d", sceneID, info.ShowName, info.SeasonNum, info.EpisodeNum)

	// 1. Find or create Show Group
	showGroup, err := findOrCreateGroup(ctx, groupRepo, info.ShowName)
	if err != nil {
		return err
	}

	targetGroupID := showGroup.ID

	// 2. Find or create Season Group if applicable
	if info.HasSeason {
		seasonName := fmt.Sprintf("%s - Season %02d", info.ShowName, info.SeasonNum)
		seasonGroup, err := findOrCreateGroup(ctx, groupRepo, seasonName)
		if err != nil {
			return err
		}

		// Ensure Season Group is a subgroup of Show Group
		if err := ensureSubgroup(ctx, groupRepo, showGroup.ID, seasonGroup.ID); err != nil {
			logger.Errorf("Failed to ensure subgroup relationship: %v", err)
		}

		targetGroupID = seasonGroup.ID
	}

	// 3. Assign scene to the target group with episode index
	partial := models.NewScenePartial()
	index := info.EpisodeNum
	partial.GroupIDs = &models.UpdateGroupIDs{
		Groups: []models.GroupsScenes{
			{
				GroupID:    targetGroupID,
				SceneIndex: &index,
			},
		},
		Mode: models.RelationshipUpdateModeAdd,
	}

	if _, err := sceneRepo.UpdatePartial(ctx, sceneID, partial); err != nil {
		return fmt.Errorf("updating scene with group: %w", err)
	}

	return nil
}

func findOrCreateGroup(ctx context.Context, repo GroupRepository, name string) (*models.Group, error) {
	existing, err := repo.FindByName(ctx, name, true)
	if err != nil {
		return nil, fmt.Errorf("finding group %q: %w", name, err)
	}

	if existing != nil {
		return existing, nil
	}

	// Create new group
	newGroup := models.NewGroup()
	newGroup.Name = name
	if err := repo.Create(ctx, &newGroup); err != nil {
		return nil, fmt.Errorf("creating group %q: %w", name, err)
	}

	return &newGroup, nil
}

func ensureSubgroup(ctx context.Context, repo GroupRepository, parentID int, childID int) error {
	// Update child to add parent to containing groups
	partial := models.NewGroupPartial()
	partial.ContainingGroups = &models.UpdateGroupDescriptions{
		Groups: []models.GroupIDDescription{
			{
				GroupID:     parentID,
				Description: "",
			},
		},
		Mode: models.RelationshipUpdateModeAdd,
	}

	if _, err := repo.UpdatePartial(ctx, childID, partial); err != nil {
		return fmt.Errorf("updating group with parent: %w", err)
	}

	return nil
}
