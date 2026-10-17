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
  const viewButtons = dialog.querySelectorAll("[data-instrument-view]");

  function selectInstrument(view) {
    const measurement = view === "measurement";
    measurementHost.hidden = !measurement;
    frame.hidden = measurement;
    viewButtons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.instrumentView === view)));
    window.dispatchEvent(new CustomEvent("fieldpos:set-view", {detail: measurement ? "measure-a" : "map"}));
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
  if (new URLSearchParams(window.location.search).get("view") === "measure-a") {
    dialog.showModal();
    selectInstrument("measurement");
  }
})();
