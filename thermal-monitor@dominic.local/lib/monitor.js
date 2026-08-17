/* Polling engine: owns sensor discovery, the timers, and per-sensor history.
 *
 * Everything downstream (panel indicator, desktop widget) is a passive
 * consumer that redraws on the `updated` signal, so there is exactly one
 * timer driving the extension regardless of how many views are open.
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {
    discoverAll,
    readSensor,
    readCritical,
    readGpuAsync,
    GPU_SENSOR_ID,
} from './sensors.js';

/**
 * Fixed-capacity circular buffer of samples. Missing readings are stored as
 * NaN so gaps stay visible in the charts rather than being interpolated over.
 */
class Ring {
    constructor(capacity) {
        this._data = new Float64Array(Math.max(2, capacity)).fill(NaN);
        this._start = 0;
        this._count = 0;
    }

    get capacity() {
        return this._data.length;
    }

    get count() {
        return this._count;
    }

    push(value) {
        const cap = this._data.length;
        const v = Number.isFinite(value) ? value : NaN;
        if (this._count < cap) {
            this._data[(this._start + this._count) % cap] = v;
            this._count++;
        } else {
            this._data[this._start] = v;
            this._start = (this._start + 1) % cap;
        }
    }

    /**
     * Sample by age, index 0 being the oldest retained sample.
     *
     * @param {number} i index
     * @returns {number} sample value, NaN when missing
     */
    at(i) {
        if (i < 0 || i >= this._count)
            return NaN;
        return this._data[(this._start + i) % this._data.length];
    }

    get latest() {
        return this._count ? this.at(this._count - 1) : NaN;
    }

    /**
     * Extent of the finite samples currently held.
     *
     * @returns {{min: number, max: number}|null} range, or null when empty
     */
    extent() {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < this._count; i++) {
            const v = this.at(i);
            if (!Number.isFinite(v))
                continue;
            if (v < min)
                min = v;
            if (v > max)
                max = v;
        }
        return min <= max ? {min, max} : null;
    }

    /**
     * Grow or shrink while keeping the most recent samples.
     *
     * @param {number} capacity new capacity
     */
    resize(capacity) {
        const cap = Math.max(2, capacity);
        if (cap === this._data.length)
            return;
        const keep = Math.min(this._count, cap);
        const next = new Float64Array(cap).fill(NaN);
        for (let i = 0; i < keep; i++)
            next[i] = this.at(this._count - keep + i);
        this._data = next;
        this._start = 0;
        this._count = keep;
    }
}

export const Monitor = GObject.registerClass({
    Signals: {
        'updated': {},
        'sensors-changed': {},
    },
}, class Monitor extends GObject.Object {
    constructor(settings) {
        super();
        this._settings = settings;
        this._sensors = [];
        this._byId = new Map();
        this._values = new Map();
        this._critical = new Map();
        this._history = new Map();
        this._gpuValue = null;
        this._gpuPending = false;
        this._tickId = 0;
        this._gpuTickId = 0;
        this._running = false;

        this._settingsIds = [
            this._settings.connect('changed::poll-interval', () => this._restartTimers()),
            this._settings.connect('changed::gpu-poll-interval', () => this._restartTimers()),
            this._settings.connect('changed::gpu-enabled', () => this.refresh()),
            this._settings.connect('changed::widget-history-seconds', () => this._resizeHistory()),
        ];
    }

    get sensors() {
        return this._sensors;
    }

    /**
     * Sensors minus the ones the user has hidden.
     *
     * @returns {Array<object>} visible sensor descriptors
     */
    get visibleSensors() {
        const hidden = new Set(this._settings.get_strv('hidden-sensors'));
        return this._sensors.filter(s => !hidden.has(s.id));
    }

    sensorById(id) {
        return this._byId.get(id) ?? null;
    }

    /**
     * Most recent reading for a sensor.
     *
     * @param {string} id sensor id
     * @returns {number|null} degrees Celsius
     */
    value(id) {
        const v = this._values.get(id);
        return Number.isFinite(v) ? v : null;
    }

    /**
     * Driver-reported critical temperature, when the sensor exposes one.
     *
     * @param {string} id sensor id
     * @returns {number|null} degrees Celsius
     */
    critical(id) {
        return this._critical.get(id) ?? null;
    }

    /**
     * Sample history for a sensor.
     *
     * @param {string} id sensor id
     * @returns {Ring|null} history buffer
     */
    history(id) {
        return this._history.get(id) ?? null;
    }

    /**
     * Seconds between samples, as a float, for chart time axes.
     *
     * @returns {number} interval in seconds
     */
    get intervalSeconds() {
        return this._settings.get_int('poll-interval') / 1000;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this.refresh();
        this._restartTimers();
    }

    stop() {
        this._running = false;
        this._clearTimers();
    }

    destroy() {
        this.stop();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._history.clear();
        this._values.clear();
        this._byId.clear();
        this._sensors = [];
    }

    /**
     * Re-scan the hardware. Cheap enough to call on demand, e.g. when the
     * preferences window is opened or a drive is hot-plugged.
     */
    refresh() {
        const includeGpu = this._settings.get_boolean('gpu-enabled');
        const found = discoverAll(includeGpu);
        const previousIds = this._sensors.map(s => s.id).join('|');

        this._sensors = found;
        this._byId = new Map(found.map(s => [s.id, s]));

        const capacity = this._historyCapacity();
        for (const sensor of found) {
            if (!this._history.has(sensor.id))
                this._history.set(sensor.id, new Ring(capacity));
            if (!this._critical.has(sensor.id)) {
                const crit = readCritical(sensor);
                if (crit !== null)
                    this._critical.set(sensor.id, crit);
            }
        }
        /* Drop history for hardware that has gone away. */
        for (const id of [...this._history.keys()]) {
            if (!this._byId.has(id)) {
                this._history.delete(id);
                this._values.delete(id);
                this._critical.delete(id);
            }
        }

        if (found.map(s => s.id).join('|') !== previousIds)
            this.emit('sensors-changed');
    }

    _historyCapacity() {
        const seconds = this._settings.get_int('widget-history-seconds');
        const interval = Math.max(0.1, this.intervalSeconds);
        return Math.max(2, Math.ceil(seconds / interval) + 1);
    }

    _resizeHistory() {
        const capacity = this._historyCapacity();
        for (const ring of this._history.values())
            ring.resize(capacity);
        this.emit('updated');
    }

    _clearTimers() {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        if (this._gpuTickId) {
            GLib.Source.remove(this._gpuTickId);
            this._gpuTickId = 0;
        }
    }

    _restartTimers() {
        this._clearTimers();
        if (!this._running)
            return;

        this._resizeHistory();

        const interval = this._settings.get_int('poll-interval');
        this._tick();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });

        if (this._settings.get_boolean('gpu-enabled') && this._byId.has(GPU_SENSOR_ID)) {
            const gpuInterval = Math.max(
                interval, this._settings.get_int('gpu-poll-interval'));
            this._pollGpu();
            this._gpuTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, gpuInterval, () => {
                this._pollGpu();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _tick() {
        for (const sensor of this._sensors) {
            /* The GPU is polled on its own slower timer; carry the last known
             * reading forward so every series shares one time axis. */
            const value = sensor.kind === 'gpu'
                ? this._gpuValue
                : readSensor(sensor);

            if (value === null)
                this._values.delete(sensor.id);
            else
                this._values.set(sensor.id, value);

            this._history.get(sensor.id)?.push(value === null ? NaN : value);
        }
        this.emit('updated');
    }

    _pollGpu() {
        if (this._gpuPending)
            return;
        this._gpuPending = true;

        readGpuAsync().then(value => {
            this._gpuPending = false;
            if (!this._running)
                return;
            this._gpuValue = value;
            if (value !== null)
                this._values.set(GPU_SENSOR_ID, value);
        }).catch(() => {
            this._gpuPending = false;
        });
    }
});
