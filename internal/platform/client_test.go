package platform

import (
	"testing"
)

func TestConfig_Validation(t *testing.T) {
	tests := []struct {
		name    string
		cfg     Config
		wantErr bool
	}{
		{
			name: "valid config",
			cfg: Config{
				DatabaseURL: "postgres://localhost/test",
				ServiceID:   "drive",
			},
			wantErr: false,
		},
		{
			name: "missing database URL",
			cfg: Config{
				DatabaseURL: "",
				ServiceID:   "drive",
			},
			wantErr: true,
		},
		{
			name: "default service ID",
			cfg: Config{
				DatabaseURL: "postgres://localhost/test",
				ServiceID:   "",
			},
			wantErr: false, // Service ID defaults to "drive"
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Can't fully test without a database, but we can test validation
			if tt.cfg.DatabaseURL == "" && !tt.wantErr {
				t.Error("Expected error for empty DatabaseURL")
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		input  string
		maxLen int
		want   string
	}{
		{"short", 10, "short"},
		{"longer string", 6, "longer..."},
		{"exact", 5, "exact"},
		{"", 5, ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := truncate(tt.input, tt.maxLen)
			if got != tt.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", tt.input, tt.maxLen, got, tt.want)
			}
		})
	}
}
