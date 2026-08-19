/* Top bar indicator: current CPU temperature, with a popup listing the other
 * sensors grouped by chip. */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {displayName, defaultCpuSensorId, FAMILY_FAN} from './sensors.js';
import {formatReading, levelFor, LEVEL_NORMAL} from './format.js';

const LEVEL_STYLE_CLASSES = {
    normal: 'thermal-level-normal',
    warn: 'thermal-level-warn',
    crit: 'thermal-level-crit',
};

/* A menu row that picks the sensor for the top bar: name on the left, live
 * reading on the right, and a radio mark on whichever one is being shown. */
const SensorRow = GObject.registerClass({
    Signals: {'selected': {}},
}, class SensorRow extends PopupMenu.PopupBaseMenuItem {
    constructor(sensor, text) {
        super({activate: true, hover: true, can_focus: true});
        this.sensor = sensor;

        this._name = new St.Label({
            text,
            style_class: 'thermal-menu-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value = new St.Label({
            text: '--',
            style_class: 'thermal-menu-value',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.add_child(this._name);
        this.add_child(this._value);
        this.setOrnament(PopupMenu.Ornament.NO_DOT);
    }

    /* Emitting our own signal rather than chaining up keeps the popup open on
     * click, so the mark visibly moves to the row that was just picked. */
    activate(_event) {
        this.emit('selected');
    }

    setSelected(selected) {
        this.setOrnament(
            selected ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    }

    update(value, options, warn, crit) {
        this._value.text = formatReading(value, this.sensor.metric, options);
        const level = levelFor(value, this.sensor.family, warn, crit);
        for (const cls of Object.values(LEVEL_STYLE_CLASSES))
            this._value.remove_style_class_name(cls);
        this._value.add_style_class_name(LEVEL_STYLE_CLASSES[level]);
        this.accessible_name = `${this._name.text} ${this._value.text}`;
    }
});

export const ThermalIndicator = GObject.registerClass(
class ThermalIndicator extends PanelMenu.Button {
    constructor(extension, monitor) {
        super(0.5, 'Thermal Monitor', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._monitor = monitor;
        this._rows = [];

        this._buildButton();
        this._buildMenu();

        this._monitorIds = [
            monitor.connect('updated', () => this._sync()),
            monitor.connect('sensors-changed', () => this._rebuildMenu()),
        ];

        this._settingsIds = [
            'changed::panel-sensor',
            'changed::panel-show-icon',
            'changed::panel-colorize',
            'changed::unit',
            'changed::decimals',
            'changed::warn-temp',
            'changed::crit-temp',
        ].map(key => this._settings.connect(key, () => this._sync()));

        this._settingsIds.push(
            this._settings.connect('changed::menu-sensors', () => this._rebuildMenu()),
            this._settings.connect('changed::hidden-sensors', () => this._rebuildMenu()));

        this.connect('destroy', () => this._onDestroy());
        this._sync();
    }

    _buildButton() {
        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box thermal-panel-box',
            orientation: Clutter.Orientation.HORIZONTAL,
        });

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${this._extension.path}/icons/thermometer-symbolic.svg`),
            style_class: 'system-status-icon thermal-panel-icon',
        });
        this._label = new St.Label({
            text: '--',
            style_class: 'thermal-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
    }

    _buildMenu() {
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Thermal Monitor Settings');
        settingsItem.connect('activate', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);

        this._rebuildMenu();
    }

    /* Which sensors the popup lists: the user's selection, or everything
     * visible when nothing has been chosen yet. */
    _menuSensors() {
        const visible = this._monitor.visibleSensors;
        const chosen = this._settings.get_strv('menu-sensors');
        if (!chosen.length)
            return visible;

        const order = new Map(chosen.map((id, i) => [id, i]));
        return visible
            .filter(s => order.has(s.id))
            .sort((a, b) => order.get(a.id) - order.get(b.id));
    }

    _rebuildMenu() {
        this._section.removeAll();
        this._rows = [];

        const sensors = this._menuSensors();
        if (!sensors.length) {
            const empty = new PopupMenu.PopupMenuItem('No sensors selected', {
                reactive: false,
                style_class: 'thermal-menu-empty',
            });
            this._section.addMenuItem(empty);
            return;
        }

        /* Group by chip instance, so the two NVMe drives get one heading each,
         * and split a chip's fans off from its temperatures: the board reports
         * both, and they read as two different lists. */
        const groups = new Map();
        for (const sensor of sensors) {
            const key = `${sensor.family}|${sensor.chipLabel}|${sensor.hint ?? ''}`;
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(sensor);
        }

        for (const members of groups.values()) {
            const heading = this._headingFor(members);
            /* A lone sensor already named after its heading ("Wi-Fi", "GPU
             * Fan") would sit under an identical one, so drop the heading and
             * let the row carry the full name instead. */
            const showHeading = !(members.length === 1 &&
                !members[0].hint &&
                displayName(members[0]) === heading);

            if (showHeading) {
                this._section.addMenuItem(
                    new PopupMenu.PopupSeparatorMenuItem(heading));
            }

            for (const sensor of members) {
                const row = new SensorRow(
                    sensor, showHeading ? sensor.label : displayName(sensor));
                row.connect('selected',
                    () => this._settings.set_string('panel-sensor', sensor.id));
                this._rows.push(row);
                this._section.addMenuItem(row);
            }
        }

        this._sync();
    }

    _headingFor(members) {
        const [first] = members;
        const base = first.hint
            ? `${first.chipLabel} — ${first.hint}`
            : first.chipLabel;
        if (first.family !== FAMILY_FAN)
            return base;
        return `${base} ${members.length > 1 ? 'Fans' : 'Fan'}`;
    }

    /* The sensor the top bar is actually showing, which is the configured one
     * unless it has gone away or been hidden. */
    _activeSensorId() {
        const visible = this._monitor.visibleSensors;
        const configured = this._settings.get_string('panel-sensor');
        if (configured && visible.some(s => s.id === configured))
            return configured;
        return defaultCpuSensorId(visible) ?? '';
    }

    _formatOptions() {
        return {
            unit: this._settings.get_string('unit'),
            decimals: this._settings.get_int('decimals'),
        };
    }

    _sync() {
        const options = this._formatOptions();
        const warn = this._settings.get_double('warn-temp');
        const crit = this._settings.get_double('crit-temp');

        this._icon.visible = this._settings.get_boolean('panel-show-icon');

        const sensorId = this._activeSensorId();
        const sensor = this._monitor.sensorById(sensorId);
        const value = sensorId ? this._monitor.value(sensorId) : null;
        this._label.text = formatReading(value, sensor?.metric, options);

        const level = this._settings.get_boolean('panel-colorize')
            ? levelFor(value, sensor?.family, warn, crit)
            : LEVEL_NORMAL;
        for (const cls of Object.values(LEVEL_STYLE_CLASSES))
            this._label.remove_style_class_name(cls);
        this._label.add_style_class_name(LEVEL_STYLE_CLASSES[level]);

        this._label.accessible_name = sensor
            ? `${displayName(sensor)} ${this._label.text}`
            : 'Reading unavailable';

        for (const row of this._rows) {
            row.update(this._monitor.value(row.sensor.id), options, warn, crit);
            row.setSelected(row.sensor.id === sensorId);
        }
    }

    _onDestroy() {
        for (const id of this._monitorIds)
            this._monitor.disconnect(id);
        this._monitorIds = [];
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
    }
});
