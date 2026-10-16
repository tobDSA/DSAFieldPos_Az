/* FieldPos place-name overlay */
"use strict";

(function () {
  const STORAGE_KEY = "fieldposPlaceNames";
  const DATA_URL = "data/24hour/overpass_place_names_scandinavia.json";

  function storedEnabled() {
    try {
      const value = window.localStorage.getItem(STORAGE_KEY);
      return value === null ? true : value === "1";
    } catch (err) {
      return true;
    }
  }

  function thresholdForZoom(zoom) {
    if (zoom <= 5) return { rank: 10, limit: 80, className: "major" };
    if (zoom <= 6) return { rank: 20, limit: 140, className: "major" };
    if (zoom <= 7) return { rank: 30, limit: 220, className: "medium" };
    if (zoom <= 8) return { rank: 40, limit: 320, className: "medium" };
    if (zoom <= 9) return { rank: 50, limit: 440, className: "small" };
    if (zoom <= 11) return { rank: 60, limit: 560, className: "small" };
    return { rank: 80, limit: 700, className: "tiny" };
  }

  function populationOf(place) {
    const population = Number(place?.population);
    return Number.isFinite(population) ? population : 0;
  }

  function rankOf(place) {
    const rank = Number(place?.rank);
    if (Number.isFinite(rank)) return rank;

    const fallback = {
      city: 10,
      town: 20,
      village: 30,
      hamlet: 40,
      suburb: 50,
      locality: 60,
      island: 60,
      islet: 80
    };
    return fallback[place?.place] || 80;
  }

  function create(options) {
    const map = options.map;
    const L = options.L || window.L;
    const validLatLon = options.validLatLon;
    const escapeHtml = options.escapeHtml;
    const toggle = options.toggle || null;
    const button = options.button || null;
    const paneName = options.paneName || "placeNamesPane";

    const state = {
      enabled: true,
      loaded: false,
      loading: false,
      places: [],
      timer: null
    };

    if (!map.getPane(paneName)) {
      map.createPane(paneName);
    }
    map.getPane(paneName).style.zIndex = 430;
    map.getPane(paneName).style.pointerEvents = "none";

    const layer = L.layerGroup().addTo(map);

    function scheduleRender() {
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(render, 120);
    }

    async function load() {
      if (state.loaded || state.loading) return;
      state.loading = true;

      try {
        const res = await fetch(DATA_URL, {
          cache: "force-cache",
          headers: { "Accept": "application/json" }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const payload = await res.json();
        state.places = Array.isArray(payload)
          ? payload
              .filter((place) => place?.name && validLatLon(Number(place.lat), Number(place.lon)))
              .map((place) => ({
                id: place.id || `${place.osmType || "place"}-${place.osmId || place.name}`,
                name: String(place.name),
                place: place.place || "",
                rank: rankOf(place),
                population: populationOf(place),
                lat: Number(place.lat),
                lon: Number(place.lon)
              }))
              .sort((a, b) => a.rank - b.rank || b.population - a.population || a.name.localeCompare(b.name))
          : [];
        state.loaded = true;
        render();
      } catch (err) {
        console.warn("[fieldpos] stedsnavn kunne ikke lastes", err);
      } finally {
        state.loading = false;
      }
    }

    function setEnabled(enabled) {
      state.enabled = Boolean(enabled);

      try {
        window.localStorage.setItem(STORAGE_KEY, state.enabled ? "1" : "0");
      } catch (err) {}

      if (toggle) {
        toggle.checked = state.enabled;
      }
      if (button) {
        button.textContent = state.enabled ? "Stedsnavn på" : "Stedsnavn av";
        button.classList.toggle("active", state.enabled);
        button.setAttribute("aria-pressed", state.enabled ? "true" : "false");
      }

      if (!state.enabled) {
        layer.clearLayers();
        return;
      }

      load();
      scheduleRender();
    }

    function render() {
      layer.clearLayers();
      if (!state.enabled || !state.loaded || !state.places.length) return;

      const rules = thresholdForZoom(map.getZoom());
      const bounds = map.getBounds().pad(0.08);
      const places = [];

      for (const place of state.places) {
        if (place.rank > rules.rank) break;
        if (!bounds.contains([place.lat, place.lon])) continue;
        places.push(place);
        if (places.length >= rules.limit) break;
      }

      for (const place of places) {
        L.marker([place.lat, place.lon], {
          pane: paneName,
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: `place-name-label ${rules.className}`,
            html: `<span>${escapeHtml(place.name)}</span>`,
            iconSize: [120, 20],
            iconAnchor: [60, 10]
          })
        }).addTo(layer);
      }
    }

    function start() {
      if (toggle) {
        toggle.addEventListener("change", () => setEnabled(toggle.checked));
      }
      if (button) {
        button.addEventListener("click", () => setEnabled(!state.enabled));
      }
      map.on("zoomend moveend", scheduleRender);
      setEnabled(storedEnabled());
    }

    return {
      render,
      scheduleRender,
      setEnabled,
      start
    };
  }

  window.FieldPosPlaceNames = { create };
})();
