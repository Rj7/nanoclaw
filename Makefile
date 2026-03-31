# NanoClaw Makefile
# Usage: make <target>

.PHONY: help status start stop restart logs logs-error logs-setup \
        build dev container memory memory-main memory-global conversations \
        groups db-groups db-sessions db-tasks test format typecheck clean \
        agent agent-tail agents containers cost cost-today cost-week \
        x-feed-start x-feed-stop x-feed-status x-feed-logs x-feed-setup

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

agent: ## Show what the agent is currently working on
agent-tail: ## Follow agent activity live
	@container=$$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" | head -1); \
	if [ -n "$$container" ]; then \
		group=$$(echo "$$container" | sed 's/nanoclaw-//;s/-[0-9]*$$//' | tr '-' '_'); \
		jid=$$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder = '$$group'" 2>/dev/null); \
		echo "\033[36m── $$group ──\033[0m"; \
		echo "\033[33mInput:\033[0m"; \
		if [ -n "$$jid" ]; then \
			sqlite3 store/messages.db "SELECT sender_name || ': ' || replace(substr(content, 1, 120), char(10), ' ') FROM messages WHERE chat_jid = '$$jid' AND is_from_me = 0 ORDER BY timestamp DESC LIMIT 5;" 2>/dev/null | tac; \
		fi; \
		echo ""; \
		echo "\033[33mTailing...\033[0m"; \
		docker logs -f "$$container" 2>&1 | grep --line-buffered -E "tools=|text=|Result #|Session init|Received input|rate_limit"; \
	else echo "No agent running"; fi

	@for container in $$(docker ps --filter "name=nanoclaw-" --format "{{.Names}}" 2>/dev/null); do \
		group=$$(echo "$$container" | sed 's/nanoclaw-//;s/-[0-9]*$$//' | tr '-' '_'); \
		uptime=$$(docker ps --filter "name=$$container" --format "{{.RunningFor}}" 2>/dev/null); \
		msgs=$$(docker logs "$$container" 2>&1 | grep -c "\[msg #" 2>/dev/null || echo 0); \
		echo "\033[36m── $$group (up $$uptime, $$msgs msgs) ──\033[0m"; \
		echo ""; \
		echo "\033[33mInput:\033[0m"; \
		jid=$$(sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder = '$$group'" 2>/dev/null); \
		if [ -n "$$jid" ]; then \
			sqlite3 store/messages.db "SELECT sender_name || ': ' || replace(substr(content, 1, 120), char(10), ' ') FROM messages WHERE chat_jid = '$$jid' AND is_from_me = 0 ORDER BY timestamp DESC LIMIT 5;" 2>/dev/null | tac; \
		fi; \
		echo ""; \
		echo "\033[33mActivity:\033[0m"; \
		docker logs "$$container" 2>&1 | grep -E "tools=|text=|Result #|Session init" | tail -10; \
		echo ""; \
	done; \
	if [ -z "$$(docker ps --filter 'name=nanoclaw-' -q 2>/dev/null)" ]; then \
		echo "No agent running"; \
		echo ""; echo "\033[36m── Last Run ──\033[0m"; \
		sqlite3 -header -column store/messages.db \
			"SELECT group_folder AS 'group', status, printf('\$$%.4f', cost_usd) AS cost, input_tokens||'in/'||output_tokens||'out' AS tokens, substr(started_at, 1, 19) AS started FROM agent_runs ORDER BY started_at DESC LIMIT 3;" 2>/dev/null || echo "(no runs yet)"; \
	fi

containers: ## List running agent containers
	@docker ps --filter "name=nanoclaw-" --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}" 2>/dev/null; \
	count=$$(docker ps --filter "name=nanoclaw-" -q 2>/dev/null | wc -l); \
	echo ""; echo "$$count container(s) running"

summary: ## Today's activity summary (messages, agent runs, errors)
	@echo "\033[36m── Today's Summary ──\033[0m"
	@today=$$(date +%Y-%m-%d); \
	msgs=$$(sqlite3 store/messages.db "SELECT COUNT(*) FROM messages WHERE timestamp LIKE '$$today%'"); \
	echo "Messages: $$msgs"; \
	runs=$$(sqlite3 store/messages.db "SELECT COUNT(*) FROM agent_runs WHERE started_at LIKE '$$today%'" 2>/dev/null || echo 0); \
	echo "Agent runs: $$runs"; \
	cost=$$(sqlite3 store/messages.db "SELECT COALESCE(printf('%.4f', SUM(cost_usd)), '0.0000') FROM agent_runs WHERE started_at LIKE '$$today%'" 2>/dev/null || echo "0.0000"); \
	echo "Cost today: \$$$$cost"; \
	tokens=$$(sqlite3 store/messages.db "SELECT COALESCE(SUM(input_tokens),0) || ' in / ' || COALESCE(SUM(output_tokens),0) || ' out' FROM agent_runs WHERE started_at LIKE '$$today%'" 2>/dev/null || echo "0 in / 0 out"); \
	echo "Tokens: $$tokens"; \
	errors=$$(grep -ci "error" logs/nanoclaw.log 2>/dev/null || echo 0); \
	echo "Errors in log: $$errors"; \
	echo ""; \
	echo "\033[36m── Recent Messages ──\033[0m"; \
	sqlite3 -column store/messages.db "SELECT substr(sender_name, 1, 12) AS who, substr(content, 1, 70) AS what, substr(timestamp, 12, 5) AS time FROM messages WHERE timestamp LIKE '$$today%' ORDER BY timestamp DESC LIMIT 10;"

# ── Cost ──────────────────────────────────────────────────────

cost: cost-today ## Show today's API cost (alias)

cost-today: ## Today's API cost and token usage
	@echo "\033[36m── Today's Cost ──\033[0m"
	@sqlite3 -header -column store/messages.db " \
		SELECT \
			group_folder AS 'group', \
			COUNT(*) AS runs, \
			COALESCE(printf('\$$%.4f', SUM(cost_usd)), '\$$0') AS cost, \
			COALESCE(SUM(input_tokens), 0) AS input_tok, \
			COALESCE(SUM(output_tokens), 0) AS output_tok, \
			COALESCE(SUM(num_turns), 0) AS turns \
		FROM agent_runs \
		WHERE started_at >= date('now') \
		GROUP BY group_folder \
		UNION ALL \
		SELECT '── TOTAL ──', COUNT(*), \
			COALESCE(printf('\$$%.4f', SUM(cost_usd)), '\$$0'), \
			COALESCE(SUM(input_tokens), 0), \
			COALESCE(SUM(output_tokens), 0), \
			COALESCE(SUM(num_turns), 0) \
		FROM agent_runs WHERE started_at >= date('now'); \
	" 2>/dev/null || echo "(no agent_runs table yet — restart service to create it)"

cost-week: ## This week's API cost and token usage
	@echo "\033[36m── This Week's Cost ──\033[0m"
	@sqlite3 -header -column store/messages.db " \
		SELECT \
			date(started_at) AS day, \
			COUNT(*) AS runs, \
			COALESCE(printf('\$$%.4f', SUM(cost_usd)), '\$$0') AS cost, \
			COALESCE(SUM(input_tokens), 0) AS input_tok, \
			COALESCE(SUM(output_tokens), 0) AS output_tok \
		FROM agent_runs \
		WHERE started_at >= date('now', '-7 days') \
		GROUP BY date(started_at) \
		ORDER BY day DESC; \
	" 2>/dev/null || echo "(no agent_runs table yet — restart service to create it)"
	@echo ""
	@echo "\033[36m── Week Total ──\033[0m"
	@sqlite3 -column store/messages.db " \
		SELECT \
			COUNT(*) || ' runs' AS runs, \
			COALESCE(printf('\$$%.4f', SUM(cost_usd)), '\$$0') AS cost, \
			COALESCE(SUM(input_tokens), 0) || ' in / ' || COALESCE(SUM(output_tokens), 0) || ' out' AS tokens \
		FROM agent_runs \
		WHERE started_at >= date('now', '-7 days'); \
	" 2>/dev/null || echo "(no data)"

# ── X Feed Monitor ────────────────────────────────────────────

x-feed-setup: ## Authenticate the X feed monitor browser profile
	npm run x-feed-setup

x-feed-start: ## Start X feed monitor (systemd)
	systemctl --user start nanoclaw-x-feed

x-feed-stop: ## Stop X feed monitor
	systemctl --user stop nanoclaw-x-feed

x-feed-status: ## X feed monitor status
	@systemctl --user status nanoclaw-x-feed 2>/dev/null || \
	(pidfile=data/x-feed-monitor.pid; \
	if [ -f "$$pidfile" ] && kill -0 $$(cat "$$pidfile") 2>/dev/null; then \
		echo "Running (PID $$(cat $$pidfile))"; \
	else echo "Not running"; fi)

x-feed-logs: ## Tail X feed monitor logs
	@tail -f logs/x-feed-monitor.log 2>/dev/null || echo "No logs yet"

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
