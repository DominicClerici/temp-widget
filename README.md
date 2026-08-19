# Thermal Monitor

A GNOME Shell extension that reads this machine's temperature and fan sensors,
in two independently toggleable parts:

- **Top bar indicator** — one always-visible reading; click it for a list of
  every other sensor, grouped by chip. Clicking a sensor in that list promotes
  it to the top bar, and the list marks whichever one is currently shown.
- **Desktop widget** — a panel of live charts pinned to the wallpaper layer,
  showing the last minute of history for the sensors you pick.

Built for Fedora 44 / GNOME Shell 50 on Wayland.

## Why one extension rather than an app plus an applet

Both halves have to live inside GNOME Shell:

- On Wayland only the shell itself can add anything to the top bar. An external
  process cannot.
- Mutter does not implement `wlr-layer-shell`, so a GTK process cannot claim a
  background layer either. A true desktop widget has to be parented into the
  shell's own background group.

## Install

```sh
make install     # symlinks into ~/.local/share/gnome-shell/extensions
```

Then **log out and back in** — Wayland cannot restart the shell in place — and:

```sh
make enable
make prefs
```

The install is a symlink, so later edits to the source take effect on the next
shell restart with no reinstall. Only schema changes need `make schemas`.

## Data sources

| Source | Sensors here | Cost |
| --- | --- | --- |
| `/sys/class/hwmon/*` read directly | CPU (`k10temp`), motherboard (`nct6686`), both NVMe drives, DIMM, Wi-Fi, Ethernet temperatures, plus the board's eight fan tachometers | ~140 file reads in 6 ms; no subprocess, no `lm_sensors` needed at runtime |
| `nvidia-smi` | RTX 5060 Ti core temperature and fan duty | one async subprocess per GPU poll, both values from one invocation |

NVIDIA exposes no hwmon node, so the GPU is the one source that needs a
subprocess. It is polled on a slower timer (6 s by default) and its last known
value is carried forward on the main tick, so every chart shares one time axis.

Sensor ids are built from the chip name and its **bus address**
(`k10temp/pci-0000:00:18.3/temp1`) rather than the `hwmonN` index, because that
index is assigned in probe order and shuffles between boots.

### Fan speeds

Fans are read from the same hwmon nodes as the temperatures — `fan*_input` on
`nct6686`, in whole RPM. This is deliberately independent of **fan2go**, which
controls those fans on this machine: fan2go writes PWM, the kernel driver
publishes the tachometer, and reading it needs neither fan2go running nor its
API enabled (it is off in `/etc/fan2go/fan2go.yaml`).

The GPU is the exception. NVML reports a duty *percentage* and the card exposes
no tachometer, so `GPU Fan` is shown as `51%` rather than an RPM. It is the same
value fan2go's `nvidia` backend drives.

Because a super-I/O chip exposes a header for every channel it has, wired or
not, five of this board's eight are permanently at 0 RPM. A fan is left out of
every list until it has reported a non-zero speed at least once, after which it
appears on its own — no rescan needed. *Show idle fan headers* on the Sensors
page lists all of them regardless.

## Configuration

`make prefs`, or the *Settings* item in the indicator's menu.

- **General** — poll interval (2 s default), GPU polling, unit, decimals, and
  the warning/critical thresholds used for colouring and chart guides.
- **Top Bar** — enable, which sensor to display, icon and colouring, placement,
  and which sensors the popup menu lists. The displayed sensor is more easily
  changed by clicking one in the popup itself; the combo here also offers
  *Automatic*, which tracks the CPU package sensor.
- **Desktop Widget** — enable, the ordered list of charted sensors, chart
  history length, size, opacity, and position.
- **Sensors** — every detected sensor with a live reading, a hide toggle, and
  the *Show idle fan headers* switch.

### Picking the top bar sensor

Click the indicator and click any sensor in the list. It becomes the top bar
reading, and the list marks it with a dot; the popup stays open so the mark is
visible as it moves. The mark also shows which sensor *Automatic* resolved to
before anything has been picked. Temperatures, RPM and fan percentages can all
be promoted to the top bar.

### Hiding bogus sensors

`nct6686` on this board reports `VRM MOS` as a constant **216 °C**, which is
meaningless. Hide it on the Sensors page and it disappears from every list,
including the automatic fallbacks.

### Positioning the widget

Drag it with the left mouse button. The position is stored as an offset from
whichever corner it ends up nearest, so it stays put when the resolution
changes. *Lock position* in prefs disables dragging; the anchor and offsets can
also be typed in directly.

Because the widget sits on the wallpaper layer it is covered by ordinary
windows — that is what makes it a desktop widget rather than an overlay.

## Development

```sh
make check      # compile the schema, syntax-check every JS file
make logs       # follow this extension's output from the real session
```

Testing shell changes on Wayland normally means logging out. Instead, run a
throwaway shell on a virtual monitor that does not touch the real session:

```sh
dbus-run-session -- gnome-shell --headless --virtual-monitor 1600x1000 \
    --wayland --wayland-display wayland-test-1
```

GNOME 50 dropped `--nested`; nested is now the default whenever
`--display-server` is absent.

## Layout

```
thermal-monitor@dominic.local/
├── extension.js          # entry point; owns the monitor and both views
├── prefs.js              # Adw preferences, with live sensor readings
├── lib/
│   ├── sensors.js        # hwmon temp + fan discovery and reads; no shell imports, so prefs can reuse it
│   ├── monitor.js        # one timer, ring-buffer history, `updated` signal
│   ├── indicator.js      # top bar button and popup menu
│   ├── widget.js         # desktop widget, background-layer attachment, dragging
│   ├── chart.js          # Cairo sparkline on an St.DrawingArea
│   └── format.js         # per-metric units and chart axes, thresholds, series colours
├── schemas/
└── stylesheet.css
```

A single `Monitor` drives everything; the indicator and the widget are passive
consumers of its `updated` signal, so the poll cost does not depend on how many
views are open.
