.PHONY: help build run test clean lint docker-build docker-run

help:
	@echo "coldforge-files Makefile targets:"
	@echo "  build          - Build the binary"
	@echo "  run            - Run the server locally"
	@echo "  test           - Run all tests"
	@echo "  test-coverage  - Run tests with coverage report"
	@echo "  clean          - Remove build artifacts"
	@echo "  lint           - Run linter (if installed)"
	@echo "  docker-build   - Build Docker image"
	@echo "  docker-run     - Run Docker container"

build:
	@echo "Building coldforge-files..."
	go build -o bin/coldforge-files ./cmd/server

run: build
	@echo "Running coldforge-files..."
	./bin/coldforge-files -config config/config.example.yml

test:
	@echo "Running tests..."
	go test -v ./...

test-coverage:
	@echo "Running tests with coverage..."
	go test -v -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

test-race:
	@echo "Running tests with race detector..."
	go test -race ./...

clean:
	@echo "Cleaning..."
	rm -rf bin/ dist/ coverage.out coverage.html

lint:
	@echo "Running linter..."
	golangci-lint run ./...

docker-build:
	@echo "Building Docker image..."
	docker build -t coldforge-files:latest .

docker-run: docker-build
	@echo "Running Docker container..."
	docker run -p 8080:8080 -v $(PWD)/data:/data coldforge-files:latest

.DEFAULT_GOAL := help
