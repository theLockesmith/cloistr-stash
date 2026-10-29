package server

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// cloistr-audit on !191: folder create still logged the folder's name. No log
// call anywhere in the server may carry a file or folder name: the server must
// not keep what the client encrypts or means to (architecture: relay metadata).
func TestNoLogCallCarriesAName(t *testing.T) {
	logMethods := map[string]bool{"Debug": true, "Info": true, "Warn": true, "Error": true}
	nameish := func(s string) bool {
		s = strings.ToLower(s)
		return s == "name" || s == "filename" || strings.HasSuffix(s, "_name")
	}
	fset := token.NewFileSet()
	var found []string
	walked := 0
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		walked++
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || !logMethods[sel.Sel.Name] {
				return true
			}
			for _, arg := range call.Args[1:] {
				bad := false
				switch a := arg.(type) {
				case *ast.BasicLit:
					bad = a.Kind == token.STRING && nameish(strings.Trim(a.Value, "\"`"))
				case *ast.SelectorExpr:
					bad = nameish(a.Sel.Name)
				}
				if bad {
					found = append(found, fset.Position(arg.Pos()).String())
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if walked < 10 {
		t.Fatalf("scanned only %d files; the walk did not reach internal/", walked)
	}
	if len(found) > 0 {
		t.Fatalf("log calls carrying a name:\n  %s", strings.Join(found, "\n  "))
	}
}
