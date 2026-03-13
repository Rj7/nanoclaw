# NanoClaw Makefile
# Usage: make <target>

.PHONY: help status start stop restart logs logs-error logs-setup \
        build dev container memory memory-main memory-global conversations \
        groups db-groups db-sessions db-tasks test format typecheck clean

# ── Service ──────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

status: ## Service status
	@systemctl --user status nanoclaw

start: ## Start service
	systemctl --user start nanoclaw

stop: ## Stop service
	systemctl --user stop nanoclaw

restart: ## Restart service (rebuild first)
	npm run build
	systemctl --user restart nanoclaw

# ── Logs ─────────────────────────────────────────────────────

logs: ## Tail live logs
	tail -f logs/nanoclaw.log

logs-error: ## Tail error log
	tail -f logs/nanoclaw.error.log

logs-setup: ## View setup log
	cat logs/setup.log

logs-agent: ## Tail latest agent container log
	@latest=$$(ls -t data/sessions/*/logs/container-*.log 2>/dev/null | head -1); \
	if [ -n "$$latest" ]; then tail -f "$$latest"; else echo "No agent logs found"; fi

# ── Build ────────────────────────────────────────────────────

build: ## Build TypeScript
	npm run build

dev: ## Run with hot reload
	npm run dev

container: ## Rebuild agent container image
	./container/build.sh

container-clean: ## Force clean rebuild (prune cache first)
	docker builder prune -f
	./container/build.sh

# ── Memory ───────────────────────────────────────────────────

memory: memory-main ## View main group memory (alias)

memory-main: ## View main group memory files
	@echo "\033[36m── MEMORY.md ──\033[0m"
	@cat groups/main/MEMORY.md 2>/dev/null || echo "(not created yet)"
	@echo ""
	@echo "\033[36m── Daily Notes ──\033[0m"
	@ls -1 groups/main/memory/*.md 2>/dev/null || echo "(no daily notes yet)"
	@echo ""
	@latest=$$(ls -t groups/main/memory/*.md 2>/dev/null | head -1); \
	if [ -n "$$latest" ]; then echo "\033[36m── $$latest ──\033[0m"; cat "$$latest"; fi

memory-global: ## View global memory
	@cat groups/global/CLAUDE.md

memory-today: ## View today's daily note
	@cat groups/main/memory/$$(date +%Y-%m-%d).md 2>/dev/null || echo "No notes for today yet"

# ── Conversations ────────────────────────────────────────────

conversations: ## List archived conversations
	@ls -1t groups/main/conversations/*.md 2>/dev/null || echo "No conversations archived yet"

conversation-latest: ## View latest archived conversation
	@latest=$$(ls -t groups/main/conversations/*.md 2>/dev/null | head -1); \
	if [ -n "$$latest" ]; then cat "$$latest"; else echo "No conversations yet"; fi

# ── Database ─────────────────────────────────────────────────

groups: ## List registered groups
	@sqlite3 -header -column store/messages.db "SELECT jid, name, folder, trigger_pattern, is_main FROM registered_groups;"

db-sessions: ## List active sessions
	@sqlite3 -header -column store/messages.db "SELECT * FROM sessions;"

db-tasks: ## List scheduled tasks
	@sqlite3 -header -column store/messages.db "SELECT id, group_folder, prompt, schedule_type, schedule_value, status, next_run FROM tasks;"

db-messages: ## Show recent messages (last 20)
	@sqlite3 -header -column store/messages.db "SELECT substr(sender_name, 1, 15) AS sender, substr(content, 1, 60) AS content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 20;"

# ── Development ──────────────────────────────────────────────

test: ## Run tests
	npx vitest run

format: ## Format code
	npm run format

typecheck: ## Type-check without emitting
	npm run typecheck

# ── Cleanup ──────────────────────────────────────────────────

clean-sessions: ## Clear stale agent-runner copies from sessions
	rm -rf data/sessions/*/agent-runner-src
	@echo "Cleared stale agent-runner copies"

clean-ipc: ## Clear stuck IPC files
	@find data/ipc -name '*.json' -mmin +60 -delete 2>/dev/null; echo "Cleared old IPC files"
