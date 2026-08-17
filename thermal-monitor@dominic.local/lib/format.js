/* Shared presentation helpers. No shell imports, so prefs.js can use them too. */

export const LEVEL_NORMAL = 'normal';
export const LEVEL_WARN = 'warn';
export const LEVEL_CRIT = 'crit';

/**
 * Convert Celsius to the configured display unit.
 *
 * @param {number} celsius temperature in degrees Celsius
 * @param {string} unit 'celsius' or 'fahrenheit'
 * @returns {number} temperature in the target unit
 */
export function convert(celsius, unit) {
    return unit === 'fahrenheit' ? celsius * 9 / 5 + 32 : celsius;
}

/**
 * Unit suffix, degree sign included.
 *
 * @param {string} unit 'celsius' or 'fahrenheit'
 * @returns {string} suffix
 */
export function unitSuffix(unit) {
    return unit === 'fahrenheit' ? '°F' : '°C';
}

/**
 * Render a temperature for display.
 *
 * @param {number|null} celsius temperature in degrees Celsius, or null
 * @param {object} opts formatting options
 * @param {string} [opts.unit] 'celsius' or 'fahrenheit'
 * @param {number} [opts.decimals] decimal places
 * @param {boolean} [opts.suffix] whether to append the unit
 * @returns {string} formatted temperature
 */
export function formatTemp(celsius, {unit = 'celsius', decimals = 0, suffix = true} = {}) {
    if (celsius === null || celsius === undefined || !Number.isFinite(celsius))
        return suffix ? `--${unitSuffix(unit)}` : '--';
    const value = convert(celsius, unit).toFixed(decimals);
    return suffix ? `${value}${unitSuffix(unit)}` : value;
}

/**
 * Classify a reading against the configured thresholds.
 *
 * @param {number|null} celsius temperature in degrees Celsius
 * @param {number} warn warning threshold in Celsius
 * @param {number} crit critical threshold in Celsius
 * @returns {string} one of the LEVEL_* constants
 */
export function levelFor(celsius, warn, crit) {
    if (celsius === null || !Number.isFinite(celsius))
        return LEVEL_NORMAL;
    if (celsius >= crit)
        return LEVEL_CRIT;
    if (celsius >= warn)
        return LEVEL_WARN;
    return LEVEL_NORMAL;
}

/* Chart series colours. Chosen to stay distinguishable against the dark widget
 * background and to survive the common forms of colour blindness. */
const SERIES_COLORS = [
    [0.35, 0.68, 0.98],
    [0.98, 0.62, 0.31],
    [0.44, 0.83, 0.55],
    [0.85, 0.52, 0.92],
    [0.96, 0.80, 0.34],
    [0.45, 0.78, 0.86],
    [0.94, 0.48, 0.55],
    [0.66, 0.70, 0.94],
];

export const THRESHOLD_COLORS = {
    [LEVEL_NORMAL]: null,
    [LEVEL_WARN]: [0.98, 0.72, 0.26],
    [LEVEL_CRIT]: [0.95, 0.38, 0.36],
};

/**
 * Stable colour for a chart series.
 *
 * @param {number} index position of the series in the widget
 * @returns {Array<number>} rgb triple in the 0..1 range
 */
export function seriesColor(index) {
    return SERIES_COLORS[index % SERIES_COLORS.length];
}

/**
 * Format an rgb triple as a CSS colour.
 *
 * @param {Array<number>} rgb triple in the 0..1 range
 * @param {number} [alpha] opacity in the 0..1 range
 * @returns {string} css rgba() string
 */
export function cssColor([r, g, b], alpha = 1) {
    const to255 = v => Math.round(v * 255);
    return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${alpha})`;
}
