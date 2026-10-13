package build

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestVersion(t *testing.T) {
	v, h, s := Version()
	// These are compile-time variables, so they may be empty in tests
	assert.NotNil(t, v)
	assert.NotNil(t, h)
	assert.NotNil(t, s)
}

func TestVersionString(t *testing.T) {
	result := VersionString()
	assert.NotEmpty(t, result)
	// Should contain "Build" in output
	assert.Contains(t, result, "Build")
}

func TestVersionString_AllEmpty(t *testing.T) {
	// When all version vars are empty
	oldVersion := version
	oldGithash := githash
	oldBuildstamp := buildstamp

	version = ""
	githash = ""
	buildstamp = ""

	result := VersionString()
	assert.Contains(t, result, "unknown")

	// Restore
	version = oldVersion
	githash = oldGithash
	buildstamp = oldBuildstamp
}

func TestVersionString_OnlyGithash(t *testing.T) {
	oldVersion := version
	oldGithash := githash

	version = ""
	githash = "abc123"

	result := VersionString()
	assert.Contains(t, result, "abc123")

	version = oldVersion
	githash = oldGithash
}

func TestVersionString_VersionWithGithash(t *testing.T) {
	oldVersion := version
	oldGithash := githash

	version = "v1.0.0"
	githash = "abc123"

	result := VersionString()
	assert.Contains(t, result, "v1.0.0")

	version = oldVersion
	githash = oldGithash
}

func TestIsOfficial(t *testing.T) {
	oldOfficial := officialBuild

	officialBuild = "true"
	assert.True(t, IsOfficial())

	officialBuild = "false"
	assert.False(t, IsOfficial())

	officialBuild = ""
	assert.False(t, IsOfficial())

	officialBuild = oldOfficial
}

func TestIsDevelop(t *testing.T) {
	oldVersion := version
	oldGithash := githash

	// Empty githash
	githash = ""
	assert.False(t, IsDevelop())

	// Non-develop version
	githash = "abc123"
	version = "v1.0.0"
	assert.False(t, IsDevelop())

	// Develop version pattern
	version = "v1.0.0-5-gabc123"
	assert.True(t, IsDevelop())

	version = oldVersion
	githash = oldGithash
}

func TestVersionString_VersionWithGithashNonDevelop(t *testing.T) {
	oldVersion := version
	oldGithash := githash
	oldBuildstamp := buildstamp

	// Non-develop version with githash should show both
	version = "v1.0.0"
	githash = "abc123"
	buildstamp = ""

	result := VersionString()
	assert.Contains(t, result, "v1.0.0")
	assert.Contains(t, result, "abc123")

	version = oldVersion
	githash = oldGithash
	buildstamp = oldBuildstamp
}

func TestVersionString_DevelopVersion(t *testing.T) {
	oldVersion := version
	oldGithash := githash

	// Develop version should not show githash separately
	version = "v1.0.0-5-gabc123"
	githash = "abc123"

	result := VersionString()
	assert.Contains(t, result, "v1.0.0-5-gabc123")
	// Should not have the separate githash in parentheses for develop builds
	assert.NotContains(t, result, "(abc123)")

	version = oldVersion
	githash = oldGithash
}

func TestVersionString_WithBuildstamp(t *testing.T) {
	oldVersion := version
	oldBuildstamp := buildstamp

	version = "v1.0.0"
	buildstamp = "2024-01-01"

	result := VersionString()
	assert.Contains(t, result, "2024-01-01")

	version = oldVersion
	buildstamp = oldBuildstamp
}

func TestVersionString_OfficialBuild(t *testing.T) {
	oldOfficial := officialBuild

	officialBuild = "true"
	result := VersionString()
	assert.Contains(t, result, "Official Build")

	officialBuild = oldOfficial
}

func TestUpdateRepo(t *testing.T) {
	oldRepo := updateRepo
	defer func() { updateRepo = oldRepo }()

	updateRepo = ""
	assert.Equal(t, defaultUpdateRepo, UpdateRepo())

	updateRepo = "myuser/stash"
	assert.Equal(t, "myuser/stash", UpdateRepo())
}
