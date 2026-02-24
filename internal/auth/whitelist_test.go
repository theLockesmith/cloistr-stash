package auth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewWhitelist(t *testing.T) {
	pubkeys := []string{"pk1", "pk2", "pk3"}
	w := NewWhitelist(pubkeys)

	if w.Count() != 3 {
		t.Errorf("Expected 3 pubkeys, got %d", w.Count())
	}

	for _, pk := range pubkeys {
		if !w.IsAllowed(pk) {
			t.Errorf("Expected %s to be allowed", pk)
		}
	}
}

func TestNewWhitelistTrimsWhitespace(t *testing.T) {
	pubkeys := []string{"  pk1  ", "pk2\n", "\tpk3"}
	w := NewWhitelist(pubkeys)

	if !w.IsAllowed("pk1") {
		t.Error("pk1 should be allowed after trimming")
	}
	if !w.IsAllowed("pk2") {
		t.Error("pk2 should be allowed after trimming")
	}
	if !w.IsAllowed("pk3") {
		t.Error("pk3 should be allowed after trimming")
	}
}

func TestNewWhitelistIgnoresEmpty(t *testing.T) {
	pubkeys := []string{"pk1", "", "  ", "pk2"}
	w := NewWhitelist(pubkeys)

	if w.Count() != 2 {
		t.Errorf("Expected 2 pubkeys (ignoring empty), got %d", w.Count())
	}
}

func TestIsAllowed(t *testing.T) {
	w := NewWhitelist([]string{"allowed"})

	if !w.IsAllowed("allowed") {
		t.Error("Expected 'allowed' to be allowed")
	}
	if w.IsAllowed("notallowed") {
		t.Error("Expected 'notallowed' to not be allowed")
	}
}

func TestAdd(t *testing.T) {
	w := NewWhitelist(nil)

	if !w.IsEmpty() {
		t.Error("Expected empty whitelist")
	}

	w.Add("newpk")

	if w.IsEmpty() {
		t.Error("Expected non-empty whitelist after Add")
	}
	if !w.IsAllowed("newpk") {
		t.Error("Expected 'newpk' to be allowed after Add")
	}
}

func TestRemove(t *testing.T) {
	w := NewWhitelist([]string{"pk1", "pk2"})

	w.Remove("pk1")

	if w.IsAllowed("pk1") {
		t.Error("Expected 'pk1' to not be allowed after Remove")
	}
	if !w.IsAllowed("pk2") {
		t.Error("Expected 'pk2' to still be allowed")
	}
}

func TestList(t *testing.T) {
	pubkeys := []string{"pk1", "pk2", "pk3"}
	w := NewWhitelist(pubkeys)

	list := w.List()

	if len(list) != 3 {
		t.Errorf("Expected 3 pubkeys in list, got %d", len(list))
	}

	// Check all pubkeys are in list
	found := make(map[string]bool)
	for _, pk := range list {
		found[pk] = true
	}
	for _, pk := range pubkeys {
		if !found[pk] {
			t.Errorf("Expected %s in list", pk)
		}
	}
}

func TestLoadFromFile(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "whitelist.txt")

	content := `pk1
pk2
# this is a comment
pk3

pk4`
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		t.Fatalf("Failed to write whitelist file: %v", err)
	}

	w := NewWhitelist(nil)
	if err := w.LoadFromFile(filePath); err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if w.Count() != 4 {
		t.Errorf("Expected 4 pubkeys, got %d", w.Count())
	}

	for _, pk := range []string{"pk1", "pk2", "pk3", "pk4"} {
		if !w.IsAllowed(pk) {
			t.Errorf("Expected %s to be allowed", pk)
		}
	}

	// Comment should not be added
	if w.IsAllowed("# this is a comment") {
		t.Error("Comments should not be added to whitelist")
	}
}

func TestLoadFromFileMissing(t *testing.T) {
	w := NewWhitelist(nil)
	err := w.LoadFromFile("/nonexistent/file.txt")
	if err == nil {
		t.Error("Expected error for missing file")
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("TEST_WHITELIST", "pk1,pk2,pk3")
	defer os.Unsetenv("TEST_WHITELIST")

	w := NewWhitelist(nil)
	w.LoadFromEnv("TEST_WHITELIST")

	if w.Count() != 3 {
		t.Errorf("Expected 3 pubkeys, got %d", w.Count())
	}

	for _, pk := range []string{"pk1", "pk2", "pk3"} {
		if !w.IsAllowed(pk) {
			t.Errorf("Expected %s to be allowed", pk)
		}
	}
}

func TestLoadFromEnvTrimsWhitespace(t *testing.T) {
	os.Setenv("TEST_WHITELIST", "  pk1 , pk2  ,  pk3  ")
	defer os.Unsetenv("TEST_WHITELIST")

	w := NewWhitelist(nil)
	w.LoadFromEnv("TEST_WHITELIST")

	if !w.IsAllowed("pk1") {
		t.Error("pk1 should be allowed after trimming")
	}
	if !w.IsAllowed("pk2") {
		t.Error("pk2 should be allowed after trimming")
	}
	if !w.IsAllowed("pk3") {
		t.Error("pk3 should be allowed after trimming")
	}
}

func TestLoadFromEnvEmpty(t *testing.T) {
	os.Unsetenv("TEST_WHITELIST_EMPTY")

	w := NewWhitelist(nil)
	w.LoadFromEnv("TEST_WHITELIST_EMPTY")

	if !w.IsEmpty() {
		t.Error("Expected whitelist to remain empty for unset env var")
	}
}

func TestConcurrentAccess(t *testing.T) {
	w := NewWhitelist([]string{"initial"})

	// Concurrent reads and writes
	done := make(chan bool)

	// Writer
	go func() {
		for i := 0; i < 100; i++ {
			w.Add("pk" + string(rune(i)))
		}
		done <- true
	}()

	// Reader
	go func() {
		for i := 0; i < 100; i++ {
			_ = w.IsAllowed("initial")
			_ = w.Count()
			_ = w.List()
		}
		done <- true
	}()

	<-done
	<-done
}
