import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Monitor} from './lib/monitor.js';
import {ThermalIndicator} from './lib/indicator.js';
import {DesktopWidget} from './lib/widget.js';

const INDICATOR_ROLE = 'thermal-monitor';

export default class ThermalMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._monitor = new Monitor(this._settings);
        this._indicator = null;
        this._widget = null;

        this._settingsIds = [
            this._settings.connect('changed::panel-enabled', () => this._syncIndicator()),
            this._settings.connect('changed::panel-position', () => this._rebuildIndicator()),
            this._settings.connect('changed::panel-index', () => this._rebuildIndicator()),
            this._settings.connect('changed::widget-enabled', () => this._syncWidget()),
        ];

        this._monitor.start();
        this._syncIndicator();
        this._syncWidget();
    }

    disable() {
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];

        this._destroyIndicator();
        this._destroyWidget();

        this._monitor?.destroy();
        this._monitor = null;
        this._settings = null;
    }

    _syncIndicator() {
        const wanted = this._settings.get_boolean('panel-enabled');
        if (wanted && !this._indicator) {
            this._indicator = new ThermalIndicator(this, this._monitor);
            Main.panel.addToStatusArea(
                INDICATOR_ROLE,
                this._indicator,
                this._settings.get_int('panel-index'),
                this._settings.get_string('panel-position'));
        } else if (!wanted) {
            this._destroyIndicator();
        }
    }

    _rebuildIndicator() {
        if (!this._indicator)
            return;
        this._destroyIndicator();
        this._syncIndicator();
    }

    _destroyIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    _syncWidget() {
        const wanted = this._settings.get_boolean('widget-enabled');
        if (wanted && !this._widget) {
            this._widget = new DesktopWidget(this, this._monitor);
            this._widget.connect('destroy', () => this._onWidgetDestroyed());
        } else if (!wanted) {
            this._destroyWidget();
        }
    }

    /* The shell rebuilds the background group when the wallpaper or the
     * monitor layout changes, taking our actor with it. Put it back. */
    _onWidgetDestroyed() {
        this._widget = null;
        if (this._tearingDown || !this._settings?.get_boolean('widget-enabled'))
            return;
        if (this._widgetRetryId)
            return;

        this._widgetRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._widgetRetryId = 0;
            if (!this._tearingDown && this._settings?.get_boolean('widget-enabled'))
                this._syncWidget();
            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyWidget() {
        this._tearingDown = true;
        if (this._widgetRetryId) {
            GLib.Source.remove(this._widgetRetryId);
            this._widgetRetryId = 0;
        }
        this._widget?.destroy();
        this._widget = null;
        this._tearingDown = false;
    }
}
