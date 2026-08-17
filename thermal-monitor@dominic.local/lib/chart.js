/* A single-series sparkline drawn with Cairo onto an St.DrawingArea. */

import Cairo from 'gi://cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

/* The y-axis never squeezes tighter than this, so a sensor idling at a steady
 * temperature shows a flat line rather than amplified sub-degree noise. */
const MIN_SPAN_CELSIUS = 8;
const AXIS_PADDING_CELSIUS = 2;

export const Chart = GObject.registerClass(
class Chart extends St.DrawingArea {
    constructor(params = {}) {
        const {color = [0.35, 0.68, 0.98], ...rest} = params;
        super({
            style_class: 'thermal-chart',
            x_expand: true,
            ...rest,
        });

        this._color = color;
        this._ring = null;
        this._warn = null;
        this._crit = null;

        this.connect('repaint', () => this._draw());
    }

    /**
     * Point the chart at a history buffer. Cheap: the ring is read live on
     * every repaint rather than copied.
     *
     * @param {object} ring history buffer from the monitor
     */
    setSeries(ring) {
        this._ring = ring;
        this.queue_repaint();
    }

    setColor(color) {
        this._color = color;
        this.queue_repaint();
    }

    /**
     * Draw horizontal threshold guides at these temperatures.
     *
     * @param {number|null} warn warning threshold in Celsius
     * @param {number|null} crit critical threshold in Celsius
     */
    setThresholds(warn, crit) {
        this._warn = warn;
        this._crit = crit;
        this.queue_repaint();
    }

    /* Fit the axis to the data, widened to MIN_SPAN_CELSIUS and rounded to
     * whole degrees so the baseline stops jittering between frames. */
    _axisRange(extent) {
        let {min, max} = extent;
        min -= AXIS_PADDING_CELSIUS;
        max += AXIS_PADDING_CELSIUS;

        const span = max - min;
        if (span < MIN_SPAN_CELSIUS) {
            const grow = (MIN_SPAN_CELSIUS - span) / 2;
            min -= grow;
            max += grow;
        }

        min = Math.floor(min);
        max = Math.ceil(max);
        if (max - min < 1)
            max = min + 1;
        return {min, max};
    }

    _draw() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();

        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            this._drawBackground(cr, width, height);

            const ring = this._ring;
            const extent = ring?.extent();
            if (!ring || !extent || ring.count < 1) {
                this._drawEmpty(cr, width, height);
                return;
            }

            const {min, max} = this._axisRange(extent);
            const toY = value =>
                height - ((value - min) / (max - min)) * height;
            /* Anchor the newest sample to the right edge so the line grows
             * leftwards while history fills up, instead of stretching. */
            const step = ring.capacity > 1 ? width / (ring.capacity - 1) : width;
            const toX = index =>
                width - (ring.count - 1 - index) * step;

            this._drawThresholds(cr, width, toY, min, max);
            this._drawSeries(cr, ring, height, toX, toY);
        } finally {
            cr.$dispose();
        }
    }

    _drawBackground(cr, width, height) {
        cr.setSourceRGBA(1, 1, 1, 0.05);
        cr.rectangle(0, 0, width, height);
        cr.fill();

        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(1);
        for (let i = 1; i < 3; i++) {
            const y = Math.round(height * i / 3) + 0.5;
            cr.moveTo(0, y);
            cr.lineTo(width, y);
        }
        cr.stroke();
    }

    _drawEmpty(cr, width, height) {
        cr.setSourceRGBA(1, 1, 1, 0.18);
        cr.setLineWidth(1);
        cr.setDash([3, 3], 0);
        const y = Math.round(height / 2) + 0.5;
        cr.moveTo(0, y);
        cr.lineTo(width, y);
        cr.stroke();
        cr.setDash([], 0);
    }

    _drawThresholds(cr, width, toY, min, max) {
        cr.setLineWidth(1);
        cr.setDash([2, 3], 0);
        for (const [value, rgb] of [
            [this._warn, [0.98, 0.72, 0.26]],
            [this._crit, [0.95, 0.38, 0.36]],
        ]) {
            if (value === null || value < min || value > max)
                continue;
            const y = Math.round(toY(value)) + 0.5;
            cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 0.45);
            cr.moveTo(0, y);
            cr.lineTo(width, y);
            cr.stroke();
        }
        cr.setDash([], 0);
    }

    /* Walks the ring once, breaking the path wherever a sample is missing so
     * gaps in the data are not drawn as straight lines across them. */
    _drawSeries(cr, ring, height, toX, toY) {
        const [r, g, b] = this._color;
        const segments = [];
        let current = [];

        for (let i = 0; i < ring.count; i++) {
            const value = ring.at(i);
            if (!Number.isFinite(value)) {
                if (current.length)
                    segments.push(current);
                current = [];
                continue;
            }
            current.push([toX(i), toY(value)]);
        }
        if (current.length)
            segments.push(current);

        for (const points of segments) {
            if (points.length < 2) {
                const [x, y] = points[0];
                cr.setSourceRGBA(r, g, b, 0.95);
                cr.arc(x, y, 1.5, 0, 2 * Math.PI);
                cr.fill();
                continue;
            }

            cr.moveTo(points[0][0], height);
            for (const [x, y] of points)
                cr.lineTo(x, y);
            cr.lineTo(points[points.length - 1][0], height);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.18);
            cr.fill();

            cr.setLineWidth(1.6);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(r, g, b, 0.95);
            cr.moveTo(points[0][0], points[0][1]);
            for (const [x, y] of points.slice(1))
                cr.lineTo(x, y);
            cr.stroke();
        }

        const last = segments.length
            ? segments[segments.length - 1][segments[segments.length - 1].length - 1]
            : null;
        if (last) {
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(last[0], last[1], 2.2, 0, 2 * Math.PI);
            cr.fill();
        }
    }
});
