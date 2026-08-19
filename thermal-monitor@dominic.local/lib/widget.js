/* Desktop widget: a panel of live sensor charts pinned to the wallpaper layer,
 * so it sits behind ordinary windows the way a desktop widget should.
 *
 * Mutter does not implement wlr-layer-shell, so a separate GTK process cannot
 * claim a background layer on Wayland. Parenting into the shell's own
 * background group is the only route to a true desktop widget here.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Chart} from './chart.js';
import {displayName, FAMILY_TEMPERATURE} from './sensors.js';
import {formatReading, levelFor, seriesColor, cssColor} from './format.js';

const EDGE_MARGIN = 8;

const LEVEL_STYLE_CLASSES = {
    normal: 'thermal-level-normal',
    warn: 'thermal-level-warn',
    crit: 'thermal-level-crit',
};

/* One sensor: name and reading on a header row, chart underneath. */
const ChartRow = GObject.registerClass(
class ChartRow extends St.BoxLayout {
    constructor(sensor, index, chartHeight) {
        super({
            style_class: 'thermal-widget-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this.sensor = sensor;
        const color = seriesColor(index);

        const header = new St.BoxLayout({
            style_class: 'thermal-widget-row-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });

        this._swatch = new St.Widget({
            style_class: 'thermal-widget-swatch',
            style: `background-color: ${cssColor(color)};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = new St.Label({
            text: displayName(sensor),
            style_class: 'thermal-widget-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._value = new St.Label({
            text: '--',
            style_class: 'thermal-widget-value',
            y_align: Clutter.ActorAlign.CENTER,
        });

        header.add_child(this._swatch);
        header.add_child(this._name);
        header.add_child(this._value);

        this._chart = new Chart({color, metric: sensor.metric, height: chartHeight});

        this.add_child(header);
        this.add_child(this._chart);
    }

    setSeries(ring) {
        this._chart.setSeries(ring);
    }

    setThresholds(warn, crit) {
        this._chart.setThresholds(warn, crit);
    }

    setChartHeight(height) {
        this._chart.height = height;
    }

    update(value, options, warn, crit) {
        this._value.text = formatReading(value, this.sensor.metric, options);
        const level = levelFor(value, this.sensor.family, warn, crit);
        for (const cls of Object.values(LEVEL_STYLE_CLASSES))
            this._value.remove_style_class_name(cls);
        this._value.add_style_class_name(LEVEL_STYLE_CLASSES[level]);
        this._chart.queue_repaint();
    }
});

export const DesktopWidget = GObject.registerClass(
class DesktopWidget extends St.BoxLayout {
    constructor(extension, monitor) {
        super({
            style_class: 'thermal-widget',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            can_focus: false,
        });

        this._extension = extension;
        this._settings = extension.getSettings();
        this._monitor = monitor;
        this._rows = [];
        this._dragging = false;
        this._dragStart = null;
        this._parentKind = null;

        this._buildHeader();

        this._content = new St.BoxLayout({
            style_class: 'thermal-widget-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(this._content);

        this._attach();
        this._rebuildRows();
        this._applyStyle();
        this._reposition();

        this._monitorIds = [
            monitor.connect('updated', () => this._sync()),
            monitor.connect('sensors-changed', () => this._rebuildRows()),
        ];

        this._settingsIds = [
            this._settings.connect('changed::widget-sensors', () => this._rebuildRows()),
            this._settings.connect('changed::hidden-sensors', () => this._rebuildRows()),
            this._settings.connect('changed::widget-show-title', () => this._applyStyle()),
            this._settings.connect('changed::widget-chart-height', () => this._applyStyle()),
            this._settings.connect('changed::widget-opacity', () => this._applyStyle()),
            this._settings.connect('changed::widget-width', () => {
                this._applyStyle();
                this._reposition();
            }),
            ...['widget-anchor', 'widget-x', 'widget-y', 'widget-monitor'].map(
                key => this._settings.connect(`changed::${key}`, () => this._reposition())),
            ...['unit', 'decimals', 'warn-temp', 'crit-temp'].map(
                key => this._settings.connect(`changed::${key}`, () => this._sync())),
        ];

        this._monitorsId = Main.layoutManager.connect(
            'monitors-changed', () => this._reposition());

        /* At construction the work area can still be the full screen, because
         * the panel and any docks have not been allocated yet. Re-place the
         * widget once the real work area is known, and whenever it changes. */
        this._workAreasId = global.display.connect(
            'workareas-changed', () => this._reposition());

        /* Bottom- and right-anchored placements depend on the widget's own
         * size, which is only final after allocation. Repositioning does not
         * change the height, so this cannot feed back on itself. */
        this._heightId = this.connect('notify::height', () => {
            if (!this._dragging)
                this._reposition();
        });

        this._setupDrag();
        this._sync();

        /* Cleanup hangs off the signal rather than a destroy() override: the
         * shell can dispose background-group children from C, which never
         * routes through a JS method and would strand these handlers. */
        this.connect('destroy', () => this._onDestroy());
    }

    _buildHeader() {
        this._header = new St.BoxLayout({
            style_class: 'thermal-widget-header',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._title = new St.Label({
            text: 'Sensors',
            style_class: 'thermal-widget-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._header.add_child(this._title);
        this.add_child(this._header);
    }

    /* Prefer the wallpaper layer. The private background group is where every
     * desktop-level shell extension has to live, so fall back through the
     * window group and finally the chrome layer if the shell ever renames it. */
    _attach() {
        const layout = Main.layoutManager;

        if (layout._backgroundGroup) {
            layout._backgroundGroup.add_child(this);
            this._parentKind = 'background';
        } else if (global.window_group) {
            global.window_group.insert_child_below(this, null);
            this._parentKind = 'window-group';
        } else {
            layout.addChrome(this, {trackFullscreen: true});
            this._parentKind = 'chrome';
        }

        /* Quiet on the expected path; noisy if a future shell forces a
         * fallback, since that changes the stacking the widget relies on. */
        if (this._parentKind !== 'background') {
            console.warn('[thermal-monitor] background group unavailable, ' +
                `widget attached to the ${this._parentKind} layer instead`);
        }
    }

    /* addChrome registers the actor with the layout manager, so that pairing
     * has to be undone explicitly; a plain child is unparented by destroy(). */
    _detach() {
        if (this._parentKind === 'chrome')
            Main.layoutManager.removeChrome(this);
    }

    _widgetSensors() {
        const visible = this._monitor.visibleSensors;
        const chosen = this._settings.get_strv('widget-sensors');
        if (!chosen.length) {
            /* Nothing configured yet: show something useful rather than an
             * empty box. */
            return visible.slice(0, 3);
        }
        const byId = new Map(visible.map(s => [s.id, s]));
        return chosen.map(id => byId.get(id)).filter(Boolean);
    }

    _rebuildRows() {
        this._content.destroy_all_children();
        this._rows = [];

        const chartHeight = this._settings.get_int('widget-chart-height');
        const sensors = this._widgetSensors();

        if (!sensors.length) {
            this._content.add_child(new St.Label({
                text: 'No sensors selected',
                style_class: 'thermal-widget-empty',
                x_expand: true,
            }));
            return;
        }

        sensors.forEach((sensor, index) => {
            const row = new ChartRow(sensor, index, chartHeight);
            row.setSeries(this._monitor.history(sensor.id));
            this._rows.push(row);
            this._content.add_child(row);
        });

        this._sync();
    }

    _applyStyle() {
        const width = this._settings.get_int('widget-width');
        const opacity = this._settings.get_int('widget-opacity');
        const chartHeight = this._settings.get_int('widget-chart-height');

        this.width = width;
        this.opacity = Math.round(opacity * 255 / 100);
        this._header.visible = this._settings.get_boolean('widget-show-title');

        for (const row of this._rows)
            row.setChartHeight(chartHeight);
    }

    _workArea() {
        const index = this._settings.get_int('widget-monitor');
        const monitors = Main.layoutManager.monitors;
        const resolved = index >= 0 && index < monitors.length
            ? index
            : Main.layoutManager.primaryIndex;
        return Main.layoutManager.getWorkAreaForMonitor(resolved);
    }

    _reposition() {
        const area = this._workArea();
        const anchor = this._settings.get_string('widget-anchor');
        const offsetX = this._settings.get_int('widget-x');
        const offsetY = this._settings.get_int('widget-y');

        /* Height depends on the row count, which is only known after layout;
         * fall back to the preferred height so the first placement is right. */
        const [, naturalWidth] = this.get_preferred_width(-1);
        const [, naturalHeight] = this.get_preferred_height(naturalWidth);
        const width = this.width > 0 ? this.width : naturalWidth;
        const height = naturalHeight;

        const right = anchor.endsWith('right');
        const bottom = anchor.startsWith('bottom');

        let x = right
            ? area.x + area.width - width - offsetX
            : area.x + offsetX;
        let y = bottom
            ? area.y + area.height - height - offsetY
            : area.y + offsetY;

        this.set_position(...this._clampToArea(x, y, width, height, area));
    }

    _clampToArea(x, y, width, height, area) {
        const maxX = area.x + area.width - width - EDGE_MARGIN;
        const maxY = area.y + area.height - height - EDGE_MARGIN;
        return [
            Math.round(Math.max(area.x + EDGE_MARGIN, Math.min(x, maxX))),
            Math.round(Math.max(area.y + EDGE_MARGIN, Math.min(y, maxY))),
        ];
    }

    /* Drag to reposition, storing the result as an offset from whichever
     * corner the widget ends up nearest. Keeping the anchor corner-relative
     * means the widget stays put when the resolution changes. */
    _setupDrag() {
        this.connect('button-press-event', (actor, event) => {
            if (this._settings.get_boolean('widget-locked'))
                return Clutter.EVENT_PROPAGATE;
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();
            this._dragging = true;
            this._dragStart = {
                stageX,
                stageY,
                actorX: this.x,
                actorY: this.y,
            };
            this.add_style_pseudo_class('dragging');
            return Clutter.EVENT_STOP;
        });

        this.connect('motion-event', (actor, event) => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            const [stageX, stageY] = event.get_coords();
            const area = this._workArea();
            const [x, y] = this._clampToArea(
                this._dragStart.actorX + (stageX - this._dragStart.stageX),
                this._dragStart.actorY + (stageY - this._dragStart.stageY),
                this.width, this.height, area);
            this.set_position(x, y);
            return Clutter.EVENT_STOP;
        });

        const finish = () => {
            if (!this._dragging)
                return Clutter.EVENT_PROPAGATE;
            this._dragging = false;
            this.remove_style_pseudo_class('dragging');
            this._persistPosition();
            return Clutter.EVENT_STOP;
        };

        this.connect('button-release-event', finish);
        this.connect('leave-event', () => {
            if (this._dragging)
                finish();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _persistPosition() {
        const area = this._workArea();
        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;
        const right = centerX > area.x + area.width / 2;
        const bottom = centerY > area.y + area.height / 2;

        const anchor = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`;
        const offsetX = right
            ? area.x + area.width - (this.x + this.width)
            : this.x - area.x;
        const offsetY = bottom
            ? area.y + area.height - (this.y + this.height)
            : this.y - area.y;

        this._settings.set_string('widget-anchor', anchor);
        this._settings.set_int('widget-x', Math.max(0, Math.round(offsetX)));
        this._settings.set_int('widget-y', Math.max(0, Math.round(offsetY)));
    }

    _sync() {
        const options = {
            unit: this._settings.get_string('unit'),
            decimals: this._settings.get_int('decimals'),
        };
        const warn = this._settings.get_double('warn-temp');
        const crit = this._settings.get_double('crit-temp');

        for (const row of this._rows) {
            const id = row.sensor.id;
            /* Threshold guides are a temperature idea; a fan chart has no
             * line to draw. */
            if (row.sensor.family === FAMILY_TEMPERATURE)
                row.setThresholds(warn, this._monitor.critical(id) ?? crit);
            else
                row.setThresholds(null, null);
            row.update(this._monitor.value(id), options, warn, crit);
        }
    }

    _onDestroy() {
        for (const id of this._monitorIds ?? [])
            this._monitor.disconnect(id);
        this._monitorIds = [];
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (this._workAreasId) {
            global.display.disconnect(this._workAreasId);
            this._workAreasId = 0;
        }
        this._heightId = 0;
        this._detach();
    }
});
