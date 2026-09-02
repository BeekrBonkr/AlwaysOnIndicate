UUID = always-on-indicate@beekrbonkr.github.io
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
MODULES = actions.js dbus.js decorations.js dockBadges.js keybindings.js \
          overlays.js panelIndicator.js prefsShortcuts.js util.js \
          windowEffects.js windowTracker.js
SRC = extension.js prefs.js $(MODULES) metadata.json stylesheet.css

.PHONY: all install uninstall pack clean test check

all: schemas/gschemas.compiled

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.always-on-indicate.gschema.xml
	glib-compile-schemas --strict schemas/

install: all
	mkdir -p $(INSTALL_DIR)/schemas
	cp $(SRC) $(INSTALL_DIR)/
	cp schemas/*.gschema.xml schemas/gschemas.compiled $(INSTALL_DIR)/schemas/
	@echo "Installed. Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf $(INSTALL_DIR)

pack: all
	gnome-extensions pack --force \
		$(foreach m,$(MODULES),--extra-source=$(m)) \
		.

clean:
	rm -f schemas/gschemas.compiled *.shell-extension.zip

# Syntax-check every module without a running shell (needs node)
check:
	@for f in extension.js prefs.js $(MODULES); do \
		node --input-type=module --check < $$f || exit 1; \
	done; echo "syntax ok"

# Run a nested gnome-shell to try the extension without logging out
test: install
	gnome-shell --devkit --wayland --virtual-monitor 1600x900

# Automated headless run: opens windows, drives the extension over D-Bus,
# walks the preferences window and saves screenshots (see tests/nested-test.sh)
test-headless: install
	tests/nested-test.sh $(or $(RUN),basic) $(or $(RUN),basic)
