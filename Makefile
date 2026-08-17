UUID     := thermal-monitor@dominic.local
SRC      := $(UUID)
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_DIR  := $(SRC)/schemas

SOURCES := $(shell find $(SRC) -type f)

.PHONY: all schemas check install uninstall enable disable prefs logs pack clean

all: schemas

## Compile the GSettings schema in-tree.
schemas: $(SCHEMA_DIR)/gschemas.compiled

$(SCHEMA_DIR)/gschemas.compiled: $(SCHEMA_DIR)/*.gschema.xml
	glib-compile-schemas --strict $(SCHEMA_DIR)

## Syntax-check every JS file. GJS has no --check, so Node parses them as ESM;
## it never resolves the gi:// imports, which is exactly what we want.
check: schemas
	@fail=0; \
	for f in $$(find $(SRC) -name '*.js'); do \
		tmp=$$(mktemp /tmp/tm-check-XXXXXX.mjs); \
		cp "$$f" "$$tmp"; \
		if ! node --check "$$tmp" 2>&1 | sed "s|$$tmp|$$f|"; then fail=1; fi; \
		rm -f "$$tmp"; \
	done; \
	exit $$fail
	@echo "syntax OK"

## Install by symlink so edits land immediately; only the schema needs a rebuild.
install: schemas
	mkdir -p $(dir $(INSTALL_DIR))
	rm -rf $(INSTALL_DIR)
	ln -s $(CURDIR)/$(SRC) $(INSTALL_DIR)
	@echo "Installed $(UUID) -> $(CURDIR)/$(SRC)"
	@echo "Log out and back in (Wayland cannot restart the shell in place), then: make enable"

uninstall:
	rm -rf $(INSTALL_DIR)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

## Follow just this extension's shell output.
logs:
	journalctl --user -f -o cat -u org.gnome.Shell@user.service --since "1 min ago" \
		| grep --line-buffered -Ei 'thermal|extension'

## Run a throwaway nested GNOME Shell with the extension loaded. The only way
## to test shell changes on Wayland without logging out of the real session.
nested: install
	@echo "Close the nested window to finish."
	env MUTTER_DEBUG_DUMMY_MODE_SPECS=1280x800 \
		dbus-run-session -- gnome-shell --nested --wayland

## Build a distributable zip.
pack: schemas
	cd $(SRC) && zip -r ../$(UUID).zip . -x '*.compiled'
	@echo "Wrote $(UUID).zip"

clean:
	rm -f $(SCHEMA_DIR)/gschemas.compiled $(UUID).zip
