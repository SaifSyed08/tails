# Fluid cursor — cursify reference

Source: <https://cursify.ui-layouts.com/components/fluid-cursor>, fetched for the
`aurora` preset.

## What it actually is

Not a trail effect. It is a full **WebGL Navier–Stokes fluid solver** — the
Pavel Dobryakov `WebGL-Fluid-Simulation` lineage — running a real incompressible
fluid step every frame:

> curl → vorticity confinement → divergence → *N* pressure iterations →
> gradient subtraction → advect velocity → advect dye → display

It needs a WebGL2 context (with a WebGL1 fallback path), half-float texture
support, and six or more separate fragment shader programs, plus double-buffered
framebuffers for velocity, dye, divergence, curl and pressure.

```javascript
let config = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 1440,
  CAPTURE_RESOLUTION: 512,
  DENSITY_DISSIPATION: 3.5,
  VELOCITY_DISSIPATION: 2,
  PRESSURE: 0.1,
  PRESSURE_ITERATIONS: 20,
  CURL: 3,
  SPLAT_RADIUS: 0.2,
  SPLAT_FORCE: 6000,
  SHADING: true,
  COLOR_UPDATE_SPEED: 10,
  PAUSED: false,
  BACK_COLOR: { r: 0.5, g: 0, b: 0 },
  TRANSPARENT: true,
};
```

```tsx
const FluidCursor = () => {
  useEffect(() => {
    fluidCursor();
  }, []);

  return (
    <div className='fixed top-0 left-0 z-2 pointer-events-none'>
      <canvas id='fluid' className='w-screen h-screen' />
    </div>
  );
};
```

Pointer input drives it through `splat(x, y, dx, dy, color)`, which injects
velocity `(dx, dy)` and dye colour into the fields at the cursor. Clicks splat
with amplified colour and a randomised force offset.

## What we shipped instead, and why

`aurora` uses an **approximation**, not this solver, and the difference is worth
being explicit about because the two are not close in kind.

The real thing costs, every frame the pointer moves: 20 pressure iterations plus
six other full-screen shader passes over a 128² velocity field and a 1440² dye
field. That is a continuous GPU load on a chat application whose job is
displaying text, and `DYE_RESOLUTION: 1440` alone is a 1440×1440 half-float
target per buffer. The request was also for something "much smaller and more
subtle" than the original, which is the opposite of what a full dye-advection
sim is good at — its whole appeal is billowing.

So `trail.kind: 'fluid'` in `trailCanvas.ts` is a 2D-canvas approximation: soft
additive radial blobs seeded along the pointer path, each carrying a velocity
sampled from pointer motion, advected and dissipated per frame with an
exponential falloff standing in for `DENSITY_DISSIPATION`. It reads as fluid at
small scale — which is all the preset asks for — at a cost of a few dozen
`arc()` fills rather than a shader pipeline.

It is a **look-alike, not a port.** If a real solver is ever wanted, this
document is the starting point and the honest scope is "vendor the upstream
library", not "extend the approximation".

## The architectural question this forced

Both cursify effects are canvas implementations, so neither fits the declarative
trail vocabulary, which places DOM elements. Two options:

1. new `trail.kind` values backed by **app-owned** canvas renderers, or
2. a canvas layer the theme can switch on and **script**.

We took (1). (2) is arbitrary code execution in the renderer, which discards
every guarantee the appearance module is built on — the `url()` ban, the
ephemerality that makes "reload the window" a complete recovery path, and the
principle textures established that *the app draws and the theme chooses*. A
theme that can run a shader can do anything a script can do.

Under (1) a theme still gets to choose the effect and supply its colours, size
and speed through tokens; it just does not get to supply the code. That is the
same trade already made for textures, ambient motion and the pixel-tile channel.
