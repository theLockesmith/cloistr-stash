package server

import (
	"encoding/json"
	"testing"
	"time"

	"git.aegis-hq.xyz/coldforge/cloistr-stash/internal/metadata"
)

// STASH-13 (found live 2026-10-19): a tag saved on a file was gone when Tags…
// was reopened, and the tag filter never appeared. The relay event kept its
// 't' tags and the metadata parser read them, but the file list reply dropped
// them, so the app never saw a tag.
func TestFileListRowCarriesTags(t *testing.T) {
	row := fileResponse(&metadata.FileMetadata{
		SHA256:    testSHA256,
		Name:      "a.txt",
		FileID:    "file-1",
		CreatedAt: time.Unix(1_800_000_000, 0),
		Tags:      []string{"work", "q4"},
	})
	body, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Tags) != 2 || got.Tags[0] != "work" || got.Tags[1] != "q4" {
		t.Fatalf("tags in the list row = %v, want [work q4] (body %s)", got.Tags, body)
	}
}
