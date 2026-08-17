/* Sensor discovery and reading.
 *
 * Deliberately free of any GNOME Shell imports so that prefs.js, which runs in
 * a separate process, can reuse it to populate the sensor pickers.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const HWMON_ROOT = '/sys/class/hwmon';

const PCI_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]$/;
const I2C_RE = /^\d+-[0-9a-f]{4}$/;
const TEMP_INPUT_RE = /^(temp\d+)_input$/;

export const GPU_SENSOR_ID = 'nvidia/gpu0/temp';
export const GPU_CHIP = 'nvidia';

/* Chip names read as driver jargon. Matched in order against the chip name,
 * either exactly or as a prefix; anything unmatched falls back to a tidied-up
 * version of the raw name. */
const CHIP_LABELS = [
    [/^(k10temp|coretemp|zenpower|k8temp)$/, 'CPU'],
    [/^(amdgpu|nouveau|nvidia|radeon)$/, 'GPU'],
    [/^(nct\d|it\d{2}|nzxt|w83\d|f71\d|smsc47|asus)/, 'Board'],
    [/^nvme$/, 'NVMe'],
    [/^drivetemp$/, 'Drive'],
    [/^(spd5118|jc42|ee1004)$/, 'Memory'],
    [/^(mt79|iwlwifi|ath1|ath9|ath10|ath11|brcm|rtw)/, 'Wi-Fi'],
    [/^(r816|e1000|igb|igc|ixgbe|tg3|bnx|atl1)/, 'Ethernet'],
    [/^acpitz$/, 'ACPI'],
    [/^(pch_|intel_pch)/, 'PCH'],
    [/^(BAT|bat)/, 'Battery'],
];

/* Sensor keys whose raw hwmon label is unhelpfully terse. */
const SENSOR_LABELS = {
    'Tctl': 'Package (Tctl)',
    'Tccd1': 'Die 1 (CCD1)',
    'Tccd2': 'Die 2 (CCD2)',
    'Tccd3': 'Die 3 (CCD3)',
    'Tccd4': 'Die 4 (CCD4)',
    'Composite': 'Composite',
};

/* Board vendors write slot names in schematic shorthand. */
function tidyLabel(raw) {
    if (SENSOR_LABELS[raw])
        return SENSOR_LABELS[raw];
    const m2 = /^M2_(\d+)$/.exec(raw);
    if (m2)
        return `M.2 slot ${m2[1]}`;
    return raw;
}

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return decoder.decode(bytes).trim();
    } catch {
        return null;
    }
}

function listDir(path) {
    const names = [];
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return names;
    }
    let name;
    while ((name = dir.read_name()) !== null)
        names.push(name);
    dir.close();
    return names;
}

/* A stable identifier for the hardware behind an hwmon node. hwmonN numbering
 * is assigned in probe order and shuffles between boots, so ids are keyed on
 * the bus address instead. */
function busTag(devicePath) {
    if (!devicePath)
        return 'virtual';

    const parts = devicePath.split('/').filter(p => p.length > 0);
    for (let i = parts.length - 1; i >= 0; i--) {
        if (I2C_RE.test(parts[i]))
            return `i2c-${parts[i]}`;
        if (PCI_RE.test(parts[i]))
            return `pci-${parts[i]}`;
    }

    const platformIdx = parts.indexOf('platform');
    if (platformIdx >= 0 && parts[platformIdx + 1])
        return `platform-${parts[platformIdx + 1]}`;

    return parts.length ? parts[parts.length - 1] : 'virtual';
}

function chipLabel(chip) {
    for (const [pattern, label] of CHIP_LABELS) {
        if (pattern.test(chip))
            return label;
    }
    /* Strip the bus/instance suffix drivers tack on, e.g. r8169_0_900:00. */
    const base = chip.replace(/[_:-].*$/, '') || chip;
    return base.charAt(0).toUpperCase() + base.slice(1);
}

/* Extra context that makes otherwise identical chips distinguishable, e.g. two
 * NVMe drives both reporting "Composite". */
function deviceHint(chip, devicePath) {
    if (!devicePath)
        return null;
    if (chip === 'nvme' || chip === 'drivetemp') {
        const model = readText(`${devicePath}/model`);
        if (model)
            return model.replace(/\s+/g, ' ').trim();
    }
    return null;
}

function tryReadLink(path) {
    try {
        return GLib.file_read_link(path);
    } catch {
        return null;
    }
}

/* /sys/class/hwmon/hwmonN is a symlink into /sys/devices whose target already
 * spells out the full hardware path, so one lexical canonicalisation gets us
 * there without needing realpath(3). The node itself sits at either
 * <device>/hwmon/hwmonN or <device>/hwmonN depending on the driver. */
function resolveDevicePath(hwmonName) {
    const link = tryReadLink(`${HWMON_ROOT}/${hwmonName}`);
    if (!link)
        return null;

    const full = link.startsWith('/')
        ? GLib.canonicalize_filename(link, null)
        : GLib.canonicalize_filename(link, HWMON_ROOT);

    let parts = full.split('/');
    if (parts[parts.length - 1] === hwmonName)
        parts.pop();
    if (parts[parts.length - 1] === 'hwmon')
        parts.pop();

    const devicePath = parts.join('/');
    return devicePath.length > 1 ? devicePath : null;
}

/**
 * Scan /sys/class/hwmon for every temperature input.
 *
 * @returns {Array<object>} descriptors sorted for stable presentation
 */
export function discoverHwmonSensors() {
    const sensors = [];

    for (const entry of listDir(HWMON_ROOT)) {
        if (!entry.startsWith('hwmon'))
            continue;

        const hwmonPath = `${HWMON_ROOT}/${entry}`;
        const chip = readText(`${hwmonPath}/name`);
        if (!chip)
            continue;

        const devicePath = resolveDevicePath(entry);
        const bus = busTag(devicePath);
        const hint = deviceHint(chip, devicePath);

        const keys = listDir(hwmonPath)
            .map(file => TEMP_INPUT_RE.exec(file))
            .filter(m => m !== null)
            .map(m => m[1])
            .sort((a, b) => numericSuffix(a) - numericSuffix(b));

        for (const key of keys) {
            const rawLabel = readText(`${hwmonPath}/${key}_label`);
            /* Unlabelled inputs would otherwise surface as "Memory temp1".
             * With a single input the chip name alone says everything; with
             * several, number them from one. */
            const label = rawLabel
                ? tidyLabel(rawLabel)
                : (keys.length === 1
                    ? chipLabel(chip)
                    : `Sensor ${keys.indexOf(key) + 1}`);

            sensors.push({
                id: `${chip}/${bus}/${key}`,
                chip,
                chipLabel: chipLabel(chip),
                bus,
                key,
                label,
                hint,
                path: `${hwmonPath}/${key}_input`,
                critPath: `${hwmonPath}/${key}_crit`,
                kind: 'hwmon',
            });
        }
    }

    sensors.sort((a, b) => {
        const chipOrder = chipRank(a.chip) - chipRank(b.chip);
        if (chipOrder !== 0)
            return chipOrder;
        const byChip = a.chip.localeCompare(b.chip) || a.bus.localeCompare(b.bus);
        if (byChip !== 0)
            return byChip;
        return numericSuffix(a.key) - numericSuffix(b.key);
    });

    return sensors;
}

/* CPU first, then GPU, then the motherboard super-I/O, then everything else. */
function chipRank(chip) {
    if (chip === 'k10temp' || chip === 'coretemp' || chip === 'zenpower')
        return 0;
    if (chip === 'amdgpu' || chip === GPU_CHIP)
        return 1;
    if (chip.startsWith('nct') || chip.startsWith('it87') || chip.startsWith('nzxt'))
        return 2;
    if (chip === 'nvme' || chip === 'drivetemp')
        return 3;
    return 4;
}

function numericSuffix(key) {
    const m = /(\d+)$/.exec(key);
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * Descriptor for the NVIDIA GPU, if nvidia-smi is on PATH.
 *
 * @returns {object|null} sensor descriptor
 */
export function discoverGpuSensor() {
    if (!GLib.find_program_in_path('nvidia-smi'))
        return null;

    return {
        id: GPU_SENSOR_ID,
        chip: GPU_CHIP,
        chipLabel: 'GPU',
        bus: 'gpu0',
        key: 'temp',
        label: 'Core',
        hint: null,
        path: null,
        critPath: null,
        kind: 'gpu',
    };
}

/**
 * Every sensor this machine exposes, hwmon plus GPU.
 *
 * @param {boolean} includeGpu whether to probe for nvidia-smi
 * @returns {Array<object>} sensor descriptors
 */
export function discoverAll(includeGpu = true) {
    const sensors = discoverHwmonSensors();
    if (includeGpu) {
        const gpu = discoverGpuSensor();
        if (gpu) {
            /* Slot the GPU in right after the CPU sensors. */
            const idx = sensors.findIndex(s => chipRank(s.chip) > 1);
            if (idx === -1)
                sensors.push(gpu);
            else
                sensors.splice(idx, 0, gpu);
        }
    }
    return sensors;
}

/**
 * Read one hwmon sensor.
 *
 * @param {object} sensor descriptor from discovery
 * @returns {number|null} degrees Celsius, or null if unreadable
 */
export function readSensor(sensor) {
    if (!sensor?.path)
        return null;
    const raw = readText(sensor.path);
    if (raw === null)
        return null;
    const milli = Number(raw);
    if (!Number.isFinite(milli))
        return null;
    return milli / 1000;
}

/**
 * Read the driver-reported critical temperature, used to pick sane per-sensor
 * chart bounds.
 *
 * @param {object} sensor descriptor from discovery
 * @returns {number|null} degrees Celsius
 */
export function readCritical(sensor) {
    if (!sensor?.critPath)
        return null;
    const raw = readText(sensor.critPath);
    if (raw === null)
        return null;
    const milli = Number(raw);
    if (!Number.isFinite(milli))
        return null;
    const celsius = milli / 1000;
    /* Some drivers park unused limits at absurd values. */
    if (celsius <= 0 || celsius > 200)
        return null;
    return celsius;
}

/**
 * Query the NVIDIA GPU temperature without blocking the compositor.
 *
 * @returns {Promise<number|null>} degrees Celsius
 */
export function readGpuAsync() {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve(null);
            return;
        }

        proc.communicate_utf8_async(null, null, (source, result) => {
            try {
                const [, stdout] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) {
                    resolve(null);
                    return;
                }
                const value = Number(String(stdout).trim().split('\n')[0]);
                resolve(Number.isFinite(value) ? value : null);
            } catch {
                resolve(null);
            }
        });
    });
}

/**
 * Human-readable name for a sensor, e.g. "CPU Package (Tctl)".
 *
 * @param {object} sensor descriptor from discovery
 * @returns {string} display name
 */
export function displayName(sensor) {
    if (!sensor)
        return 'Unknown';
    if (sensor.label === sensor.chipLabel)
        return sensor.label;
    return `${sensor.chipLabel} ${sensor.label}`;
}

/**
 * Longer name including the device hint, for prefs lists where two chips of the
 * same kind need telling apart.
 *
 * @param {object} sensor descriptor from discovery
 * @returns {string} qualified display name
 */
export function qualifiedName(sensor) {
    const base = displayName(sensor);
    return sensor?.hint ? `${base} — ${sensor.hint}` : base;
}

/**
 * Best guess at the sensor that represents overall CPU temperature.
 *
 * @param {Array<object>} sensors candidates from discovery
 * @returns {string|null} sensor id
 */
export function defaultCpuSensorId(sensors) {
    const preferences = [
        s => s.chip === 'k10temp' && s.label.startsWith('Package'),
        s => s.chip === 'coretemp' && /Package/i.test(s.label),
        s => s.chip === 'zenpower' && /Tdie|Package/i.test(s.label),
        s => s.chip === 'k10temp',
        s => s.chip === 'coretemp',
        s => /^nct|^it87/.test(s.chip) && s.label === 'CPU',
        s => s.chip === 'acpitz',
    ];

    for (const match of preferences) {
        const found = sensors.find(match);
        if (found)
            return found.id;
    }
    return sensors.length ? sensors[0].id : null;
}
