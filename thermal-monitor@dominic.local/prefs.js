import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/* Preferences run in the Extensions app, not the shell, so this resource lives
 * in a different namespace than the shell-side imports in extension.js. */
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    discoverAll,
    readSensor,
    readGpuAsync,
    qualifiedName,
    defaultCpuSensorId,
    GPU_SENSOR_ID,
} from './lib/sensors.js';
import {formatTemp} from './lib/format.js';

const LIVE_REFRESH_MS = 1500;

const ANCHORS = [
    ['top-left', 'Top left'],
    ['top-right', 'Top right'],
    ['bottom-left', 'Bottom left'],
    ['bottom-right', 'Bottom right'],
];

const PANEL_POSITIONS = [
    ['left', 'Left'],
    ['center', 'Centre'],
    ['right', 'Right'],
];

const UNITS = [
    ['celsius', 'Celsius (°C)'],
    ['fahrenheit', 'Fahrenheit (°F)'],
];

/* Adw.ComboRow bound to a string-valued setting. */
function comboRow(settings, key, title, subtitle, choices) {
    const values = choices.map(c => c[0]);
    const row = new Adw.ComboRow({
        title,
        subtitle: subtitle ?? null,
        model: Gtk.StringList.new(choices.map(c => c[1])),
    });

    const sync = () => {
        const index = values.indexOf(settings.get_string(key));
        row.selected = index >= 0 ? index : 0;
    };
    sync();

    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle: subtitle ?? null});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, {lower, upper, step = 1, digits = 0, scale = 1}) {
    const row = new Adw.SpinRow({
        title,
        subtitle: subtitle ?? null,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 5,
        }),
        digits,
    });

    const isDouble = settings.settings_schema.get_key(key).get_value_type().dup_string() === 'd';
    const read = () => isDouble
        ? settings.get_double(key)
        : settings.get_int(key) / scale;
    const write = value => {
        if (isDouble)
            settings.set_double(key, value);
        else
            settings.set_int(key, Math.round(value * scale));
    };

    row.value = read();
    row.connect('notify::value', () => {
        if (Math.abs(read() - row.value) > 1e-6)
            write(row.value);
    });
    settings.connect(`changed::${key}`, () => {
        if (Math.abs(read() - row.value) > 1e-6)
            row.value = read();
    });
    return row;
}

export default class ThermalMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._settings = settings;
        this._sensors = discoverAll(settings.get_boolean('gpu-enabled'));
        this._liveRows = new Map();
        this._gpuValue = null;

        window.add(this._generalPage());
        window.add(this._panelPage());
        window.add(this._widgetPage());
        window.add(this._sensorsPage());

        window.set_default_size(660, 780);

        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, LIVE_REFRESH_MS, () => {
                this._refreshLive();
                return GLib.SOURCE_CONTINUE;
            });
        this._refreshLive();

        window.connect('close-request', () => {
            if (this._timerId) {
                GLib.Source.remove(this._timerId);
                this._timerId = 0;
            }
            return false;
        });
    }

    _sensorById(id) {
        return this._sensors.find(s => s.id === id) ?? null;
    }

    _visibleSensors() {
        const hidden = new Set(this._settings.get_strv('hidden-sensors'));
        return this._sensors.filter(s => !hidden.has(s.id));
    }

    /* ---------------------------------------------------------------- */

    _generalPage() {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const polling = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'How often sensors are read. hwmon reads come straight from sysfs and cost almost nothing.',
        });
        polling.add(spinRow(this._settings, 'poll-interval',
            'Poll interval', 'Seconds between sensor readings',
            {lower: 0.5, upper: 60, step: 0.5, digits: 1, scale: 1000}));
        polling.add(switchRow(this._settings, 'gpu-enabled',
            'NVIDIA GPU temperature',
            'Requires nvidia-smi, which is spawned as a subprocess on each GPU poll'));
        polling.add(spinRow(this._settings, 'gpu-poll-interval',
            'GPU poll interval', 'Kept slower than the main interval to limit subprocess churn',
            {lower: 1, upper: 120, step: 1, digits: 0, scale: 1000}));
        page.add(polling);

        const display = new Adw.PreferencesGroup({title: 'Display'});
        display.add(comboRow(this._settings, 'unit', 'Unit', null, UNITS));
        display.add(spinRow(this._settings, 'decimals',
            'Decimal places', null, {lower: 0, upper: 1, step: 1}));
        page.add(display);

        const thresholds = new Adw.PreferencesGroup({
            title: 'Thresholds',
            description: 'Always in Celsius, regardless of the display unit. Readings at or above a threshold are coloured, and the levels are drawn as guides on the charts.',
        });
        thresholds.add(spinRow(this._settings, 'warn-temp',
            'Warning', null, {lower: 0, upper: 150, step: 1, digits: 0}));
        thresholds.add(spinRow(this._settings, 'crit-temp',
            'Critical', null, {lower: 0, upper: 150, step: 1, digits: 0}));
        page.add(thresholds);

        return page;
    }

    /* ---------------------------------------------------------------- */

    _panelPage() {
        const page = new Adw.PreferencesPage({
            title: 'Top Bar',
            icon_name: 'view-continuous-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: 'Top Bar Indicator'});
        group.add(switchRow(this._settings, 'panel-enabled',
            'Show in the top bar', 'The indicator and the desktop widget are independent'));

        const sensors = this._visibleSensors();
        const ids = ['', ...sensors.map(s => s.id)];
        const autoId = defaultCpuSensorId(sensors);
        const autoLabel = autoId
            ? `Automatic (${qualifiedName(this._sensorById(autoId))})`
            : 'Automatic';
        const labels = [autoLabel, ...sensors.map(s => qualifiedName(s))];

        const sensorRow = new Adw.ComboRow({
            title: 'Displayed sensor',
            model: Gtk.StringList.new(labels),
        });
        const syncSensor = () => {
            const index = ids.indexOf(this._settings.get_string('panel-sensor'));
            sensorRow.selected = index >= 0 ? index : 0;
        };
        syncSensor();
        sensorRow.connect('notify::selected', () => {
            this._settings.set_string('panel-sensor', ids[sensorRow.selected] ?? '');
        });
        this._settings.connect('changed::panel-sensor', syncSensor);
        group.add(sensorRow);

        group.add(switchRow(this._settings, 'panel-show-icon', 'Show thermometer icon'));
        group.add(switchRow(this._settings, 'panel-colorize',
            'Colour when hot', 'Tint the reading once it passes the warning threshold'));
        group.add(comboRow(this._settings, 'panel-position',
            'Placement', null, PANEL_POSITIONS));
        group.add(spinRow(this._settings, 'panel-index',
            'Position offset', 'Order within the chosen part of the top bar',
            {lower: 0, upper: 20, step: 1}));
        page.add(group);

        const menuGroup = new Adw.PreferencesGroup({
            title: 'Popup Menu',
            description: 'Sensors listed when the indicator is clicked. With nothing selected, every visible sensor is shown.',
        });
        this._addSelectionRows(menuGroup, 'menu-sensors');
        page.add(menuGroup);

        return page;
    }

    /* Checkbox list backed by a string-array setting, where an empty array
     * means "all". The first toggle materialises the full list so that
     * unchecking one entry does not silently hide the rest. */
    _addSelectionRows(group, key) {
        const sensors = this._visibleSensors();

        const currentSet = () => {
            const chosen = this._settings.get_strv(key);
            return chosen.length
                ? new Set(chosen)
                : new Set(sensors.map(s => s.id));
        };

        for (const sensor of sensors) {
            const row = new Adw.SwitchRow({
                title: qualifiedName(sensor),
                subtitle: sensor.id,
                active: currentSet().has(sensor.id),
            });
            row.connect('notify::active', () => {
                const set = currentSet();
                if (row.active)
                    set.add(sensor.id);
                else
                    set.delete(sensor.id);
                const ordered = sensors.filter(s => set.has(s.id)).map(s => s.id);
                this._settings.set_strv(key, ordered);
            });
            group.add(row);
        }
    }

    /* ---------------------------------------------------------------- */

    _widgetPage() {
        const page = new Adw.PreferencesPage({
            title: 'Desktop Widget',
            icon_name: 'view-grid-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: 'Desktop Widget'});
        group.add(switchRow(this._settings, 'widget-enabled',
            'Show on the desktop', 'Pinned to the wallpaper layer, behind ordinary windows'));
        page.add(group);

        this._chartGroup = new Adw.PreferencesGroup({
            title: 'Charted Sensors',
            description: 'Shown top to bottom in this order.',
        });
        page.add(this._chartGroup);
        this._rebuildChartList();

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        appearance.add(spinRow(this._settings, 'widget-history-seconds',
            'Chart history', 'Seconds of data shown on each chart',
            {lower: 15, upper: 900, step: 15}));
        appearance.add(spinRow(this._settings, 'widget-width',
            'Width', 'Logical pixels', {lower: 180, upper: 1200, step: 10}));
        appearance.add(spinRow(this._settings, 'widget-chart-height',
            'Chart height', 'Logical pixels per chart', {lower: 24, upper: 200, step: 4}));
        appearance.add(spinRow(this._settings, 'widget-opacity',
            'Opacity', 'Percent', {lower: 10, upper: 100, step: 5}));
        appearance.add(switchRow(this._settings, 'widget-show-title', 'Show header'));
        page.add(appearance);

        const position = new Adw.PreferencesGroup({
            title: 'Position',
            description: 'The widget can also be dragged with the left mouse button; doing so updates these values.',
        });
        position.add(comboRow(this._settings, 'widget-anchor',
            'Anchor corner', 'Offsets are measured from this corner of the work area', ANCHORS));
        position.add(spinRow(this._settings, 'widget-x',
            'Horizontal offset', null, {lower: 0, upper: 10000, step: 8}));
        position.add(spinRow(this._settings, 'widget-y',
            'Vertical offset', null, {lower: 0, upper: 10000, step: 8}));
        position.add(spinRow(this._settings, 'widget-monitor',
            'Monitor', '-1 follows the primary monitor', {lower: -1, upper: 16, step: 1}));
        position.add(switchRow(this._settings, 'widget-locked',
            'Lock position', 'Ignore mouse drags'));
        page.add(position);

        return page;
    }

    _rebuildChartList() {
        for (const row of this._chartRows ?? [])
            this._chartGroup.remove(row);
        this._chartRows = [];

        const visible = this._visibleSensors();
        const chosen = this._settings.get_strv('widget-sensors')
            .filter(id => visible.some(s => s.id === id));

        chosen.forEach((id, index) => {
            const sensor = this._sensorById(id);
            const row = new Adw.ActionRow({
                title: `${index + 1}. ${qualifiedName(sensor)}`,
                subtitle: id,
            });

            const up = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: index > 0,
                css_classes: ['flat'],
                tooltip_text: 'Move up',
            });
            const down = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                valign: Gtk.Align.CENTER,
                sensitive: index < chosen.length - 1,
                css_classes: ['flat'],
                tooltip_text: 'Move down',
            });
            const remove = new Gtk.Button({
                icon_name: 'list-remove-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Remove',
            });

            up.connect('clicked', () => this._moveChart(index, -1));
            down.connect('clicked', () => this._moveChart(index, 1));
            remove.connect('clicked', () => {
                const next = [...chosen];
                next.splice(index, 1);
                this._settings.set_strv('widget-sensors', next);
                this._rebuildChartList();
            });

            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(remove);
            this._chartGroup.add(row);
            this._chartRows.push(row);
        });

        if (!chosen.length) {
            const empty = new Adw.ActionRow({
                title: 'No sensors chosen',
                subtitle: 'The widget falls back to the first three sensors until you add some.',
            });
            this._chartGroup.add(empty);
            this._chartRows.push(empty);
        }

        const remaining = visible.filter(s => !chosen.includes(s.id));
        const addRow = new Adw.ComboRow({
            title: 'Add a sensor',
            model: Gtk.StringList.new(
                remaining.length ? remaining.map(s => qualifiedName(s)) : ['Everything already added']),
            sensitive: remaining.length > 0,
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: 'Add',
            sensitive: remaining.length > 0,
        });
        addButton.connect('clicked', () => {
            const sensor = remaining[addRow.selected];
            if (!sensor)
                return;
            this._settings.set_strv('widget-sensors', [...chosen, sensor.id]);
            this._rebuildChartList();
        });
        addRow.add_suffix(addButton);
        this._chartGroup.add(addRow);
        this._chartRows.push(addRow);
    }

    _moveChart(index, delta) {
        const chosen = this._settings.get_strv('widget-sensors');
        const target = index + delta;
        if (target < 0 || target >= chosen.length)
            return;
        [chosen[index], chosen[target]] = [chosen[target], chosen[index]];
        this._settings.set_strv('widget-sensors', chosen);
        this._rebuildChartList();
    }

    /* ---------------------------------------------------------------- */

    _sensorsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Sensors',
            icon_name: 'temperature-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Detected Sensors',
            description: 'Live readings. Hide sensors you never want to see — useful for inputs that report obviously bogus values.',
        });

        for (const sensor of this._sensors) {
            const row = new Adw.ActionRow({
                title: qualifiedName(sensor),
                subtitle: sensor.id,
            });

            const value = new Gtk.Label({
                label: '--',
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label', 'numeric'],
                width_chars: 8,
                xalign: 1,
            });
            const hide = new Gtk.ToggleButton({
                icon_name: 'view-conceal-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Hide this sensor everywhere',
                active: this._settings.get_strv('hidden-sensors').includes(sensor.id),
            });
            hide.connect('toggled', () => {
                const hidden = new Set(this._settings.get_strv('hidden-sensors'));
                if (hide.active)
                    hidden.add(sensor.id);
                else
                    hidden.delete(sensor.id);
                this._settings.set_strv('hidden-sensors', [...hidden]);
                row.set_sensitive(!hide.active);
            });
            row.set_sensitive(!hide.active);

            row.add_suffix(value);
            row.add_suffix(hide);
            group.add(row);
            this._liveRows.set(sensor.id, value);
        }

        page.add(group);
        return page;
    }

    _refreshLive() {
        const options = {
            unit: this._settings.get_string('unit'),
            decimals: this._settings.get_int('decimals'),
        };

        for (const sensor of this._sensors) {
            const label = this._liveRows.get(sensor.id);
            if (!label)
                continue;
            const celsius = sensor.kind === 'gpu'
                ? this._gpuValue
                : readSensor(sensor);
            label.label = formatTemp(celsius, options);
        }

        if (this._liveRows.has(GPU_SENSOR_ID) && !this._gpuPending) {
            this._gpuPending = true;
            readGpuAsync().then(value => {
                this._gpuPending = false;
                this._gpuValue = value;
            }).catch(() => {
                this._gpuPending = false;
            });
        }
    }
}
