"use strict";

(() => {
  const header = document.querySelector(".app-header");
  const heading = document.querySelector(".brand-block h1");
  heading.textContent = "DSA FieldPos Mobile";
  document.title = "DSA FieldPos Mobile";

  const desktop = document.createElement("a");
  desktop.href = "/";
  desktop.className = "mobile-desktop-link";
  desktop.textContent = "Full visning";
  header.append(desktop);

  const toolbar = document.createElement("nav");
  toolbar.className = "mobile-toolbar";
  toolbar.setAttribute("aria-label", "Kart og måler");
  const gps = document.getElementById("gps-toggle");
  gps.textContent = "GPS på";
  gps.setAttribute("aria-label", "Slå på GPS");
  gps.setAttribute("aria-pressed", "false");
  const dosimeter = document.getElementById("dosimeter-window-open");
  dosimeter.textContent = "Dosimeter";
  dosimeter.setAttribute("aria-haspopup", "dialog");
  const norway = document.getElementById("zoom-norway");
  toolbar.append(gps, dosimeter, norway);
  document.body.append(toolbar);

  const dialog = document.createElement("dialog");
  dialog.id = "mobile-dosimeter-dialog";
  dialog.setAttribute("aria-labelledby", "mobile-dosimeter-title");
  dialog.innerHTML = `<div class="mobile-instrument-case"><header class="mobile-instrument-header">
    <h2 id="mobile-dosimeter-title">DSA FieldNexus</h2>
    <button type="button" id="mobile-dosimeter-close">Til kartet</button>
  </header><div class="mobile-instrument-body">
    <nav class="mobile-instrument-rail" aria-label="Instrumentvalg">
      <button type="button" data-instrument-view="dosimeter" aria-pressed="true">Dosimeter</button>
      <button type="button" data-instrument-view="measurement" aria-pressed="false">Måleskjema</button>
      <button type="button" disabled>LOGG</button>
      <button type="button" class="online" disabled>NEXUS<br>ONLINE</button>
      <span class="mobile-instrument-spine" aria-hidden="true"></span>
    </nav>
    <div class="mobile-instrument-content">
      <iframe title="Dosimeter" allow="geolocation" src="about:blank"></iframe>
      <section id="mobile-measurement-host" aria-label="Måleskjema" hidden></section>
    </div>
  </div></div>`;
  document.body.append(dialog);
  const frame = dialog.querySelector("iframe");
  const measurementHost = dialog.querySelector("#mobile-measurement-host");
  const panel = document.getElementById("measurement-a-panel");
  panel.setAttribute("aria-label", "Måleskjema");
  panel.querySelector("h2").textContent = "Måleskjema";
  measurementHost.append(panel);
  const form = document.getElementById("measurement-a-form");
  const labels = [...form.querySelectorAll("label")];
  const stationLabel = document.getElementById("measure-station-name").closest("label");
  const timeLabel = document.getElementById("measure-timestamp").closest("label");
  const operator = document.getElementById("measure-event");
  const operatorLabel = operator.closest("label");
  operatorLabel.firstChild.textContent = "Operatør\n";
  const pointName = document.getElementById("measure-point-name");
  const pointNameLabel = pointName.closest("label");
  for (const id of ["measure-event", "measure-type", "measure-team", "measure-session", "measure-point-name"]) {
    const input = document.getElementById(id);
    input.value = "";
    input.removeAttribute("required");
    input.placeholder = "<fyll inn>";
  }
  for (const input of form.querySelectorAll('input:not([readonly]):not([type="checkbox"]), textarea')) {
    if (input.id !== "measure-station-name") input.placeholder = "<fyll inn>";
  }
  const storedDose = document.getElementById("measure-doserate");
  storedDose.closest("label").hidden = true;
  const headingBlock = form.querySelector(".measurement-heading");
  headingBlock.querySelector(".measurement-kicker").textContent = "Registrer måling";
  const essentials = document.createElement("div");
  essentials.className = "mobile-measurement-essentials";
  const doseLabel = document.createElement("label");
  doseLabel.className = "mobile-dose-field";
  doseLabel.innerHTML = 'Doserate <span class="mobile-dose-input"><input id="mobile-dose-rate" type="number" min="0" step="any" inputmode="decimal" required><span>µSv/h</span></span>';
  const displayDose = doseLabel.querySelector("input");
  displayDose.value = storedDose.value ? String(Number(storedDose.value) * 1e6) : "";
  displayDose.addEventListener("input", () => {
    storedDose.value = displayDose.value === "" ? "" : String(Number((Number(displayDose.value) * 1e-6).toPrecision(12)));
  });
  const positionSummary = document.createElement("p");
  positionSummary.className = "mobile-position-summary";
  positionSummary.id = "mobile-position-summary";
  positionSummary.textContent = "Posisjon fylles fra GPS eller ved markering på dosimeteret.";
  essentials.append(stationLabel, operatorLabel, pointNameLabel, doseLabel, timeLabel, positionSummary);
  const details = document.createElement("section");
  details.className = "mobile-measurement-parameters";
  details.setAttribute("aria-label", "Valgfrie parametere");
  const detailFields = document.createElement("div");
  detailFields.className = "mobile-detail-fields";
  detailFields.append(...labels.filter(label => ![stationLabel, operatorLabel, pointNameLabel, timeLabel].includes(label)));
  details.append(detailFields);
  const actions = document.createElement("div");
  actions.className = "mobile-submit-bar";
  const sendStatus = document.createElement("p");
  sendStatus.id = "mobile-send-status";
  sendStatus.setAttribute("role", "status");
  const sendButton = document.getElementById("measurement-send");
  actions.append(sendStatus, sendButton);
  // Original form controls and names stay intact for the existing API/CSV payload.
  const output = document.getElementById("measurement-output");
  output.hidden = true;
  document.getElementById("measurement-map-slot").hidden = true;
  const scrollArea = document.createElement("div");
  scrollArea.className = "mobile-form-scroll";
  scrollArea.append(headingBlock, essentials, details, output);
  form.replaceChildren(scrollArea, actions);
  headingBlock.querySelector("#measurement-now").hidden = true;

  window.addEventListener("fieldpos:measurement-prepared", event => {
    const draft = event.detail;
    displayDose.value = String(draft.readingMicroSvH);
    positionSummary.textContent = `${draft.position.simulated ? "Simulert posisjon" : "GPS-posisjon"}: ${Number(draft.position.lat).toFixed(5)}, ${Number(draft.position.lon).toFixed(5)}`;
    form.querySelector(".measurement-kicker").textContent = "Markert fra treningssimulator";
    sendStatus.textContent = "Klar til innsending";
    delete sendStatus.dataset.state;
    scrollArea.scrollTop = 0;
  });
  window.addEventListener("fieldpos:measurement-result", event => {
    sendStatus.textContent = event.detail.message;
    sendStatus.dataset.state = event.detail.ok ? "success" : "error";
  });

  const viewButtons = dialog.querySelectorAll("[data-instrument-view]");

  function selectInstrument(view) {
    const measurement = view === "measurement";
    measurementHost.hidden = !measurement;
    frame.hidden = measurement;
    viewButtons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.instrumentView === view)));
    window.dispatchEvent(new CustomEvent("fieldpos:set-view", {detail: measurement ? "measure-a" : "map"}));
    if (measurement) window.dispatchEvent(new CustomEvent("fieldpos:measurement-position"));
    if (!measurement && frame.getAttribute("src") === "about:blank") {
      frame.src = "/mobile/dosimeter?embedded=1";
    }
  }

  // Keep the same form, submit handlers, map and GPS watch when switching views.
  dosimeter.addEventListener("click", () => selectInstrument("dosimeter"));
  viewButtons.forEach(button => button.addEventListener("click", () => selectInstrument(button.dataset.instrumentView)));
  dialog.querySelector("#mobile-dosimeter-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    window.dispatchEvent(new CustomEvent("fieldpos:set-view", {detail: "map"}));
    frame.src = "about:blank";
    measurementHost.hidden = true;
    dosimeter.focus();
  });
  function prepareMarkedMeasurement(draft) {
    if (!draft || draft.type !== "fieldpos:mark-measurement" ||
        !Number.isFinite(draft.readingMicroSvH) || draft.readingMicroSvH < 0 ||
        !Number.isFinite(draft.position?.lat) || Math.abs(draft.position.lat) > 90 ||
        !Number.isFinite(draft.position?.lon) || Math.abs(draft.position.lon) > 180 ||
        !Number.isFinite(Date.parse(draft.timestamp))) return;
    if (!dialog.open) dialog.showModal();
    selectInstrument("measurement");
    window.dispatchEvent(new CustomEvent("fieldpos:prepare-measurement", {detail: draft}));
  }
  window.addEventListener("message", event => {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
    prepareMarkedMeasurement(event.data);
  });
  try {
    const pending = window.sessionStorage.getItem("fieldposPendingMeasurement");
    if (pending) {
      window.sessionStorage.removeItem("fieldposPendingMeasurement");
      prepareMarkedMeasurement(JSON.parse(pending));
    }
  } catch (error) { console.warn("Kunne ikke hente markert måling", error); }

  if (new URLSearchParams(window.location.search).get("view") === "measure-a") {
    dialog.showModal();
    selectInstrument("measurement");
  }
})();
