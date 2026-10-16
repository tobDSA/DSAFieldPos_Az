/* FieldPos Radnett station overlay */
"use strict";

(function () {
  const STORAGE_KEY = "fieldposRadnettStations";
  const DATA_URL = "kartverk/radnett_stasjonerLok.csv";

  function storedEnabled() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === null ? true : value === "1";
    } catch (err) {
      return true;
    }
  }

  function parseNumber(value) {
    const num = Number(String(value || "").trim().replace(",", "."));
    return Number.isFinite(num) ? num : null;
  }

  function parseCsv(text, validLatLon) {
    return text
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(";"))
      .map((parts, index) => {
        const name = String(parts[0] || "").trim();
        const lat = parseNumber(parts[1]);
        const lon = parseNumber(parts[2]);
        return { id: `radnett-${index}-${name}`, name, lat, lon };
      })
      .filter((station) => station.name && validLatLon(station.lat, station.lon));
  }

  function create(options) {
    const map = options.map;
    const L = options.L || window.L;
    const validLatLon = options.validLatLon;
    const escapeHtml = options.escapeHtml;
    const toggle = options.toggle || null;
    const dockToggle = options.dockToggle || null;
    const paneName = options.paneName || "radnettStationsPane";

    const state = {
      enabled: true,
      loaded: false,
      loading: false,
      error: "",
      stations: []
    };

    if (!map.getPane(paneName)) {
      map.createPane(paneName);
    }
    map.getPane(paneName).style.zIndex = 435;
    map.getPane(paneName).style.pointerEvents = "none";

    const layer = L.layerGroup().addTo(map);

    async function load() {
      if (state.loaded || state.loading) return;
      state.loading = true;
      state.error = "";
      updateControls();

      try {
        const res = await fetch(DATA_URL, {
          cache: "force-cache",
          headers: { "Accept": "text/csv, text/plain" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const text = await res.text();
        state.stations = parseCsv(text, validLatLon);
        state.loaded = true;
        render();
      } catch (err) {
        state.error = err?.message || "ukjent feil";
        console.warn("[fieldpos] Radnett-stasjoner kunne ikke lastes", err);
      } finally {
        state.loading = false;
        updateControls();
      }
    }

    function updateControls() {
      const label = state.enabled
        ? state.loading
          ? "Radnett ..."
          : state.error
            ? "Radnett feil"
            : "Radnett på"
        : "Radnett av";

      if (toggle) toggle.checked = state.enabled;
      if (dockToggle) {
        dockToggle.textContent = label;
        dockToggle.classList.toggle("active", state.enabled);
        dockToggle.setAttribute("aria-pressed", state.enabled ? "true" : "false");
      }
    }

    function setEnabled(enabled) {
      state.enabled = Boolean(enabled);

      try {
        window.localStorage.setItem(STORAGE_KEY, state.enabled ? "1" : "0");
      } catch (err) {}

      updateControls();

      if (!state.enabled) {
        layer.clearLayers();
        return;
      }

      load();
      render();
    }

    function render() {
      layer.clearLayers();
      if (!state.enabled || !state.loaded) return;

      for (const station of state.stations) {
        L.marker([station.lat, station.lon], {
          pane: paneName,
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "radnett-station-label",
            html: `
              <span class="radnett-station-dot"></span>
              <span class="radnett-station-name">${escapeHtml(station.name)}</span>
            `,
            iconSize: [160, 24],
            iconAnchor: [6, 12]
          })
        }).addTo(layer);
      }
    }

    function start() {
      if (toggle) {
        toggle.addEventListener("change", () => setEnabled(toggle.checked));
      }
      if (dockToggle) {
        dockToggle.addEventListener("click", () => setEnabled(!state.enabled));
      }
      setEnabled(storedEnabled());
    }

    return {
      setEnabled,
      start
    };
  }

  window.FieldPosRadnettStations = { create };
})();
