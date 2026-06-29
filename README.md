# Amorph Cavern — audio-reaktives SVG-Game (Proof of Concept)

Ein **Amorph_FX-Plugin, das ein Spiel ist.** Es beweist, dass sich eine komplette,
visuell anspruchsvolle Spiel-UI für Amorph **fast ausschließlich in SVG** bauen
lässt — und dass Audio und Spiel in **beide Richtungen** miteinander reden.

> Steuere eine morphende Glow-Kreatur durch eine Höhle, deren Wände **live aus dem
> eingehenden Audiosignal** geformt werden. Bass verengt den Tunnel, Höhen erzeugen
> Spikes — lautes Material wird gefährlicher. Je näher du an der Wand bist, desto
> stärker **verbiegt das Spiel den Sound zurück** (Tiefpass schließt + Drive).

![Status](https://img.shields.io/badge/preflight-passing-brightgreen)

---

## Warum das ein guter SVG-Showcase ist

Die gesamte Grafik – inklusive HUD und Bedienelementen – ist **inline SVG in einer
einzigen `.js`-Datei**, ohne Imports, ohne externe Libraries, ohne Canvas, ohne
WebGL. Eingesetzte Techniken:

| Technik | Wo |
|---|---|
| `feTurbulence` (fractalNoise) + `feColorMatrix` + `feGaussianBlur` | animierter **Nebula**-Hintergrund (baseFrequency moduliert von den Höhen) |
| `feTurbulence` als **Film-Grain** | Korn-Overlay über der ganzen Szene |
| `feDisplacementMap` + Alpha-„Goo"-Matrix | die **amorphe, gooey Kreatur**, deren Verzerrung von den Mitten/Danger lebt |
| `feGaussianBlur` + `feMerge` | **Neon-Glow** auf den Höhlenwänden und der Titel-Schrift |
| Catmull-Rom → kubische Beziér-Pfade | weich geschwungene **Höhlenwände** (live aus Audio) und der **morphende Blob** |
| `radialGradient` / `linearGradient` | Tiefe, Glow-Kern, Vignette, Danger-Tönung |
| SVG-`<text>` + `<rect>` + Slider/Toggle | **komplettes HUD und das Tuning-Panel** – ebenfalls reines SVG |
| `feColorMatrix`-Tönung + Hue-Lerp | kohärentes **Farb-Grading**: sicher = Cyan→Magenta, Danger = Rot |

Alles skaliert verlustfrei (Vektor) und bleibt winzig (eine Datei).

---

## Architektur (Amorph-Drei-Schichten-Modell)

```
AmorphCavern.cmajorpatch   Manifest (1000×600, resizable)
AmorphCavernDSP.cmajor     DSP: Pass-through-FX + 3-Band-Analyse + Game→Sound-Bend
AmorphCavernUI.js          Single-File-SVG-Game-UI (Web Component)
```

**Datenfluss in beide Richtungen** (DSP und UI teilen keinen Speicher, sie reden nur
über die `patchConnection`-Bridge):

```
 Audio  ──► levelOut / bassOut / midOut / trebleOut  (output events, ~45 Hz)  ──►  formt die SVG-Welt
 Spiel  ──► param2 "Danger"  (sendEventOrValue, ~30 Hz)                        ──►  DSP verbiegt den Sound
```

### DSP (`AmorphCavernDSP.cmajor`)
Sauberer Stereo-Durchlass-Effekt. Er

1. teilt das Mono-Summensignal per One-Pole-Filtern in **Bass / Mid / Treble** +
   Gesamt-**Level** und streamt die Hüllkurven als `output event`s an die UI, und
2. nimmt den **Danger**-Wert aus dem Spiel entgegen und biegt damit das Audio:
   ein Tiefpass schließt von ~18 kHz auf ~400 Hz und `tanh`-Drive setzt ein, je
   näher die Kreatur an der Wand ist — man **hört** die Gefahr.

Parameter: `Sensitivity` (visueller Gain), `Danger` (vom Spiel geschrieben),
`FX Amount` (Stärke des Bends), `Bypass`.

### UI (`AmorphCavernUI.js`)
Folgt allen Dev-Kit-Regeln: eine Datei, kein Import, Light-DOM, `patchConnection`
statt Web Audio, vollständiges Cleanup in `disconnectedCallback`, Echo-Loop-Schutz
auf den Reglern, Pointer-Events mit `setPointerCapture`.

---

## Steuerung

- **Maus bewegen** (oder ↑/↓ bzw. W/S): fliegen
- **Klick / Leertaste**: abtauchen / neu starten
- **TUNE** (oben links): SVG-Panel mit Sensitivity, Bend-Amount, Bend-FX-Toggle
- Höhle, Glow, Partikel und Farbe reagieren auf das Audiosignal — ohne Audio läuft
  die Szene als ruhige Ambient-Demo weiter.

---

## In Amorph laden

Den Ordner als Patch öffnen (er enthält `AmorphCavern.cmajorpatch`). Audio durch das
Plugin routen — die Höhle erwacht. Ohne Eingangssignal bleibt die Szene als
Standbild-Animation aktiv.

## Verifikation

Geprüft mit dem [Amorph Dev Kit](../Amorph_DEV_KIt) Preflight
(`python3 tools/preflight.py .`): DSP-Lint, UI-Lint, Manifest und DSP↔UI-Sync
sind **clean**. Die UI wurde headless (Chromium/Playwright) mit gemockter Bridge
gerendert — Mount, Bridge-Events, Slider, Kollision, Tod/Respawn und Farb-Grading
laufen fehlerfrei.

> Proof of Concept — der Game-Loop ist bewusst schlank gehalten; der Fokus liegt
> auf der SVG-Grafiktechnik.
