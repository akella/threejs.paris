import * as THREE from "three";
import { REVISION } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
  TileCompressionPlugin,
  TileFlatteningPlugin,
} from "3d-tiles-renderer/plugins";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { WiggleBone } from "wiggle/spring";
import { ThreePerf } from "three-perf";
import GUI from "lil-gui";

const STICK_HEIGHT = 2;
const STICK_THICKNESS = 0.14;

// --- popup design system: dark glass, hairline borders, one accent ---
const ACCENT = "#948aea";
// clamp()s keep the card comfortable from a 320px phone up to desktop
const POPUP_CARD =
  "text-align:center;padding:clamp(30px,7vw,56px) clamp(22px,6vw,64px);" +
  "max-width:min(560px,92vw);cursor:default;" +
  "border:1px solid rgba(255,255,255,.09);border-radius:20px;" +
  "background:rgba(13,13,15,.92);box-shadow:0 24px 80px rgba(0,0,0,.55)";
// overlay: centres the card, but scrolls it instead of clipping when a
// short screen can't fit the whole thing (body itself can't scroll)
const POPUP_OVERLAY =
  "position:fixed;inset:0;justify-content:center;align-items:center;" +
  "padding:20px;overflow-y:auto;-webkit-overflow-scrolling:touch;" +
  "background:rgba(5,5,8,.7);font-family:system-ui,sans-serif;" +
  "backdrop-filter:blur(10px)";
const POPUP_EYEBROW =
  "display:flex;gap:9px;align-items:center;justify-content:center;" +
  "color:#8a8a90;font-size:12px;font-weight:600;letter-spacing:2.5px;" +
  "text-transform:uppercase";
const POPUP_DOT = `width:6px;height:6px;border-radius:50%;background:${ACCENT};flex:none`;
const POPUP_PILL =
  "display:inline-block;padding:10px 22px;border-radius:999px;" +
  "background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);" +
  "color:#c9c9ce;font-size:14px;text-decoration:none";
// primary action, same weight as the welcome screen's button
const POPUP_CTA =
  "display:inline-block;margin-top:22px;padding:15px 42px;border-radius:999px;" +
  `background:${ACCENT};color:#fff;font-size:14px;font-weight:700;` +
  "text-decoration:none";

// --- Paris city tiles ---
const USE_CITY = true;
// NOTE: local dev only — move to an env var before deploying anywhere public
const ION_TOKEN = "[ADD YOUR TOKEN]";
const ION_ASSET_GOOGLE_TILES = "2275207"; // Google Photorealistic 3D Tiles
const EIFFEL_LAT = 48.85837;
const EIFFEL_LON = 2.29448;
const GROUND_ELLIPSOID_HEIGHT = 78; // metres: ~35m altitude + ~44m geoid in Paris
const TOWER_REAL_HEIGHT = 330; // metres -> our STICK_HEIGHT units
const CITY_SCALE = STICK_HEIGHT / TOWER_REAL_HEIGHT;
const CITY_ROTATION_Y = -45.5; // degrees, tuned by hand
const FLATTEN_RADIUS = 130; // metres — disc that swallows the real tower's footprint

// conference venue: Maison de la Chimie, 28 Rue Saint-Dominique, 75007
const VENUE_LAT = 48.86006;
const VENUE_LON = 2.31645;
const VENUE_BASKET_SIZE = 160; // metres, funnel height (open top)
const VENUE_TOP_RADIUS = 135; // metres, wide mouth for catching
const VENUE_BOTTOM_RADIUS = 35; // metres, narrow neck
const VENUE_FLARE = 1.6; // profile curve exponent (1 = straight cone)

// scratch for basket-local coordinate checks
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _localVel = new THREE.Vector3();
const _normal3 = new THREE.Vector3();

// funnel radius at height fraction t in [0, 1]
function funnelRadius(t) {
  return VENUE_BOTTOM_RADIUS + (VENUE_TOP_RADIUS - VENUE_BOTTOM_RADIUS) * Math.pow(t, VENUE_FLARE);
}

const BASKET_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BASKET_FRAGMENT = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float t = uTime;

    // two layers of upward-flowing wave bands
    float wave = sin((vUv.y - t * 0.12) * 28.0) * 0.5 + 0.5;
    wave = pow(wave, 4.0);
    float wave2 = sin((vUv.y - t * 0.05) * 9.0 + sin(vUv.x * 6.2832) * 0.5) * 0.5 + 0.5;
    wave2 = pow(wave2, 3.0);

    // glowing frame around each panel
    vec2 d = min(vUv, 1.0 - vUv);
    float edge = 1.0 - smoothstep(0.0, 0.08, min(d.x, d.y));

    // subtle scanline flicker
    float flicker = 0.92 + 0.08 * sin(t * 23.0 + vUv.y * 40.0);

    vec3 base = vec3(0.05, 0.35, 0.9);
    vec3 bright = vec3(0.35, 0.85, 1.0);
    vec3 col = base + bright * (wave * 0.8 + wave2 * 0.5) + bright * edge;
    float alpha = 0.18 + 0.5 * wave * flicker + 0.25 * wave2 + 0.55 * edge;

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.9));
  }
`;
const BONE_COUNT = 8; // joints along the stick, root included
const MAX_BEND = 1.9; // max bend angle from vertical, radians (~109°)

// scratch vectors for the arc-length solver (no per-frame allocations)
const _p = new THREE.Vector3();
const _pPrev = new THREE.Vector3();

// length of a quadratic bezier a -> c(control) -> b, sampled polyline
function quadBezierLength(a, control, b, divisions = 24) {
  let length = 0;
  _pPrev.copy(a);
  for (let i = 1; i <= divisions; i++) {
    const t = i / divisions;
    const s = 1 - t;
    _p.set(
      s * s * a.x + 2 * s * t * control.x + t * t * b.x,
      s * s * a.y + 2 * s * t * control.y + t * t * b.y,
      s * s * a.z + 2 * s * t * control.z + t * t * b.z,
    );
    length += _p.distanceTo(_pPrev);
    _pPrev.copy(_p);
  }
  return length;
}

export default class Sketch {
  constructor(options) {
    this.scene = new THREE.Scene();

    this.container = options.dom;
    this.width = this.container.offsetWidth;
    this.height = this.container.offsetHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.width, this.height);
    this.renderer.setClearColor(0xeeeeee, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, this.width / this.height, 0.01, 1000);
    this.camera.position.set(2.4, 1.8, 3.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, STICK_HEIGHT * 0.5, 0);
    this.controls.update();

    this.isPlaying = true;

    this.clock = new THREE.Clock();

    // dev tooling only shows up with ?debug in the URL — clean look for
    // shared links
    this.debugMode = new URLSearchParams(window.location.search).has("debug");

    if (this.debugMode) {
      this.perf = new ThreePerf({
        anchorX: "left",
        domElement: document.body,
        renderer: this.renderer,
      });
    }

    this.addCesiumCredit();
    this.addLights();
    this.addGround();
    if (USE_CITY) this.addCity();
    this.loadTower();
    this.setupDrag();
    this.setUpSettings();
    this.resize();
    if (USE_CITY) {
      // camera holds at the intro's orbital start pose (tiles preload
      // behind the blur) until the welcome screen is dismissed
      this.startIntro();
      this.introHold = true;
      this.showWelcome();
    }
    this.render();
    this.setupResize();
  }

  setUpSettings() {
    this.settings = {
      stiffness: 300, // tip spring: omega = sqrt(stiffness), rad/s
      damping: 6, // tip spring: zeta = damping / (2 * sqrt(stiffness))
      bendShape: 0.5, // height of the bezier control point, as fraction of stick height
      gravity: 40, // world units/s^2 for the ball
      launchPower: 1,
      showTipHandle: false,
      showSkeleton: false,
      showDebug: false,
      faceOffset: 1.45, // face distance from ball centre, in radii
      skyBrightness: 0.4, // scene.backgroundIntensity on the HDR sky
      envLight: 0.7, // scene.environmentIntensity (HDR as light source)
      sunAzimuth: -147, // degrees around Y — matches the tiles' baked shadows
      sunElevation: 37, // degrees above horizon
      sunIntensity: 1.5,
      shadowOpacity: 0.2,
      fogColor: 0xa6a6a6,
      fogNear: 20,
      fogFar: 140,
    };
    this.gui = new GUI();
    this.gui.add(this.settings, "stiffness", 50, 2000, 10);
    this.gui.add(this.settings, "damping", 1, 60, 0.5);
    this.gui.add(this.settings, "bendShape", 0.1, 0.9, 0.05);
    this.gui.add(this.settings, "gravity", 5, 100, 1);
    this.gui.add(this.settings, "launchPower", 0.2, 3, 0.05);
    this.gui.add(this.settings, "faceOffset", 1.0, 2.5, 0.05);

    if (this.tiles) {
      const city = this.gui.addFolder("city");
      const cs = {
        height: 0,
        x: 0,
        z: 0,
        rotationY: CITY_ROTATION_Y, // degrees, spins the city around the tower base
        errorTarget: this.tiles.errorTarget,
        showCity: true,
      };
      city.add(cs, "height", -2, 2, 0.005).onChange((v) => {
        this.cityGroup.position.y = v;
      });
      city.add(cs, "x", -5, 5, 0.01).onChange((v) => {
        this.cityGroup.position.x = v;
      });
      city.add(cs, "z", -5, 5, 0.01).onChange((v) => {
        this.cityGroup.position.z = v;
      });
      city.add(cs, "rotationY", -180, 180, 0.5).onChange((v) => {
        this.cityGroup.rotation.y = v * THREE.MathUtils.DEG2RAD;
      });
      city.add(cs, "errorTarget", 2, 40, 1).onChange((v) => {
        this.tiles.errorTarget = v;
      });
      city.add(cs, "showCity").onChange((v) => {
        this.cityGroup.visible = v;
        this.grid.visible = !v;
        this.groundDisc.visible = !v;
      });
    }
    this.settings.replayIntro = () => this.startIntro();
    this.gui.add(this.settings, "replayIntro");

    const atm = this.gui.addFolder("atmosphere");
    atm.add(this.settings, "skyBrightness", 0.05, 1.5, 0.05).onChange((v) => {
      this.scene.backgroundIntensity = v;
    });
    atm.add(this.settings, "envLight", 0, 2, 0.05).onChange((v) => {
      this.scene.environmentIntensity = v;
    });
    atm.addColor(this.settings, "fogColor").onChange((v) => {
      if (this.scene.fog) this.scene.fog.color.set(v);
    });
    atm.add(this.settings, "fogNear", 0, 100, 1).onChange((v) => {
      if (this.scene.fog) this.scene.fog.near = v;
    });
    atm.add(this.settings, "fogFar", 20, 400, 5).onChange((v) => {
      if (this.scene.fog) this.scene.fog.far = v;
    });
    const applySun = () => this.updateSun();
    atm.add(this.settings, "sunAzimuth", -180, 180, 1).onChange(applySun);
    atm.add(this.settings, "sunElevation", 5, 90, 1).onChange(applySun);
    atm.add(this.settings, "sunIntensity", 0, 4, 0.05).onChange(applySun);
    atm.add(this.settings, "shadowOpacity", 0, 1, 0.05).onChange(applySun);

    this.gui.add(this.settings, "showTipHandle").onChange((v) => {
      if (this.tipHandle) this.tipHandle.visible = v;
    });
    this.gui.add(this.settings, "showSkeleton").onChange((v) => {
      if (this.skeletonHelper) this.skeletonHelper.visible = v;
    });
    this.gui.add(this.settings, "showDebug").onChange((v) => {
      if (!this.debugGroup) return;
      this.debugGroup.visible = v;
      if (!v) this.debugDesiredDots.forEach((d) => (d.visible = false));
    });

    // settings still drive the scene (defaults apply either way), the
    // panel itself is dev-only
    if (!this.debugMode) this.gui.hide();

    // apply setting-driven defaults that aren't read every frame
    this.updateSun();
  }

  setupResize() {
    window.addEventListener("resize", this.resize.bind(this));
  }

  resize() {
    this.width = this.container.offsetWidth;
    this.height = this.container.offsetHeight;
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (this.tiles) {
      this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
    }
    // fat-line width is computed in screen space from this uniform
    if (this.aimMaterial) this.aimMaterial.resolution.set(this.width, this.height);
  }

  addCesiumCredit() {
    const el = document.createElement("a");
    el.href = "https://ion.cesium.com/";
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    el.textContent = "Made possible with support from Cesium ion";
    el.setAttribute("aria-label", "Made possible with support from Cesium ion");

    el.style.cssText =
      "position:fixed;top:18px;right:20px;z-index:9000;" +
      "color:rgba(255,255,255,.72);font:600 12px/1.2 system-ui,sans-serif;" +
      "letter-spacing:.2px;text-decoration:none;" +
      "padding:8px 10px;border-radius:5px;" +
      "background:rgba(5,5,8,.28);backdrop-filter:blur(8px);" +
      "-webkit-backdrop-filter:blur(8px);" +
      "transition:color .2s ease,background .2s ease;";

    el.addEventListener("mouseenter", () => {
      el.style.color = "#fff";
      el.style.background = "rgba(5,5,8,.5)";
    });

    el.addEventListener("mouseleave", () => {
      el.style.color = "rgba(255,255,255,.72)";
      el.style.background = "rgba(5,5,8,.28)";
    });

    document.body.appendChild(el);
    this.cesiumCredit = el;
  }
  addLights() {
    const light1 = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(light1);

    // the sun: casts the tower/ball shadow. Google tiles are unlit (photo
    // textures with baked light), so shadows land on a transparent
    // ShadowMaterial catcher disc instead of the tiles themselves
    this.sun = new THREE.DirectionalLight(0xfff2e0, 1.5);
    this.sun.position.set(2, 4, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -3.5;
    this.sun.shadow.camera.right = 3.5;
    this.sun.shadow.camera.top = 3.5;
    this.sun.shadow.camera.bottom = -3.5;
    this.sun.shadow.camera.near = 0.1;
    this.sun.shadow.camera.far = 20;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target); // target stays at the tower base

    this.shadowCatcher = new THREE.Mesh(
      new THREE.CircleGeometry(3.5, 48),
      new THREE.ShadowMaterial({ opacity: 0.35 }),
    );
    this.shadowCatcher.rotation.x = -Math.PI / 2;
    this.shadowCatcher.position.y = 0.002;
    this.shadowCatcher.receiveShadow = true;
    this.scene.add(this.shadowCatcher);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    // HDR sky: background + lighting environment (replaces RoomEnvironment
    // once loaded)
    new RGBELoader().load("/wasteland.hdr", (texture) => {
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.background = texture;
      this.scene.environment = texture;
      // HDR radiance clips to white without tone mapping — scale it down
      // to sit next to the SDR city tiles instead of tone-mapping (which
      // would shift the tile colours too)
      this.scene.backgroundIntensity = this.settings?.skyBrightness ?? 0.4;
      this.scene.environmentIntensity = this.settings?.envLight ?? 0.7;
    });
  }

  updateSun() {
    const az = THREE.MathUtils.degToRad(this.settings.sunAzimuth);
    const el = THREE.MathUtils.degToRad(this.settings.sunElevation);
    const r = 5.4; // fixed orbit radius, well outside the play area
    this.sun.position.set(
      Math.sin(az) * Math.cos(el) * r,
      Math.sin(el) * r,
      Math.cos(az) * Math.cos(el) * r,
    );
    this.sun.intensity = this.settings.sunIntensity;
    this.shadowCatcher.material.opacity = this.settings.shadowOpacity;
  }

  // ------------------------------------------------------------------
  // Cinematic intro zoom (technique from Makio64/threejs-cinematic-world-zoom):
  // a bearing/pitch/distance camera rig where distance interpolates
  // GEOMETRICALLY (log space) so the zoom reads as constant-speed even
  // though it spans ~3 orders of magnitude, from near-orbit to street.
  // ------------------------------------------------------------------
  startIntro() {
    if (!this.tiles) return;

    const target = new THREE.Vector3(0, STICK_HEIGHT * 0.5, 0);

    // end pose = the hand-tuned game camera, expressed on the rig
    const endOffset = new THREE.Vector3(2.4, 1.8, 3.2).sub(target);
    const endDist = endOffset.length();
    const endPitch = Math.asin(endOffset.y / endDist);
    const endBearing = Math.atan2(endOffset.x, endOffset.z);

    this.intro = {
      t: 0,
      duration: 8,
      target,
      startDist: 1500, // ~250 km up — Earth curvature is visible
      endDist,
      startPitch: THREE.MathUtils.degToRad(80), // looking almost straight down
      endPitch,
      // three-quarters of a turn unwinds into the final bearing: a
      // slowing spiral rather than a straight elevator drop
      startBearing: endBearing - Math.PI * 1.5,
      endBearing,
    };
    this.introActive = true;
    this.controls.enabled = false;
  }

  updateIntro(dt) {
    const intro = this.intro;
    intro.t += dt / intro.duration;
    const raw = Math.min(intro.t, 1);
    // smootherstep: zero velocity AND acceleration at both ends, so the
    // hand-off to OrbitControls at the end is invisible
    const e = raw * raw * raw * (raw * (raw * 6 - 15) + 10);

    // constant perceived zoom rate: equal ratios per unit time
    const dist = intro.startDist * Math.pow(intro.endDist / intro.startDist, e);
    const pitch = THREE.MathUtils.lerp(intro.startPitch, intro.endPitch, e);
    const bearing = THREE.MathUtils.lerp(intro.startBearing, intro.endBearing, e);

    const cp = Math.cos(pitch);
    this.camera.position
      .set(Math.sin(bearing) * cp, Math.sin(pitch), Math.cos(bearing) * cp)
      .multiplyScalar(dist)
      .add(intro.target);
    this.camera.lookAt(intro.target);

    // slide the frustum with the altitude — a fixed 0.01..1000 range
    // can't hold depth precision across the whole descent
    this.camera.near = THREE.MathUtils.clamp(dist * 0.002, 0.01, 4);
    this.camera.far = Math.max(1000, dist * 4);
    this.camera.updateProjectionMatrix();

    // push the fog out while high up so it doesn't swallow the planet,
    // easing back to the gameplay haze as we descend
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(this.settings.fogNear, dist * 0.8);
      this.scene.fog.far = Math.max(this.settings.fogFar, dist * 6);
    }

    if (raw >= 1) {
      this.introActive = false;
      this.camera.near = 0.01;
      this.camera.far = 1000;
      this.camera.updateProjectionMatrix();
      if (this.scene.fog) {
        this.scene.fog.near = this.settings.fogNear;
        this.scene.fog.far = this.settings.fogFar;
      }
      this.controls.enabled = true;
      this.controls.target.copy(intro.target);
      this.controls.update();
    }
  }

  addGround() {
    this.grid = new THREE.GridHelper(10, 20, 0x888888, 0xcccccc);
    this.scene.add(this.grid);

    this.groundDisc = new THREE.Mesh(
      new THREE.CircleGeometry(5, 48),
      new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.95 }),
    );
    this.groundDisc.rotation.x = -Math.PI / 2;
    this.groundDisc.position.y = -0.001;
    this.scene.add(this.groundDisc);

    // the real city replaces the placeholder ground
    this.grid.visible = !USE_CITY;
    this.groundDisc.visible = !USE_CITY;
  }

  addCity() {
    // atmospheric haze so the tile edge melts into the sky instead of a
    // razor horizon line; colour matched to the HDR's horizon glow.
    // Units: 1 world unit ≈ 165 m, so 20..140 ≈ 3..23 km of visibility
    this.scene.fog = new THREE.Fog(0xa6a6a6, 20, 140);

    this.tiles = new TilesRenderer();
    this.tiles.registerPlugin(
      new CesiumIonAuthPlugin({
        apiToken: ION_TOKEN,
        assetId: ION_ASSET_GOOGLE_TILES,
        autoRefreshToken: true,
      }),
    );
    const dracoLoader = new DRACOLoader().setDecoderPath(
      `https://unpkg.com/three@0.${REVISION}.x/examples/jsm/libs/draco/gltf/`,
    );
    this.tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));
    this.tiles.registerPlugin(new TileCompressionPlugin());
    // put the Eiffel Tower's spot at the scene origin, Y-up
    this.tiles.registerPlugin(
      new ReorientationPlugin({
        lat: EIFFEL_LAT * THREE.MathUtils.DEG2RAD,
        lon: EIFFEL_LON * THREE.MathUtils.DEG2RAD,
        height: GROUND_ELLIPSOID_HEIGHT,
      }),
    );

    // squash the REAL Eiffel tower: everything above a street-level disc
    // around its footprint gets projected flat, leaving an empty plaza.
    // The shape must live in the tileset's local (ECEF, metres) frame.
    this.flatten = new TileFlatteningPlugin();
    this.tiles.registerPlugin(this.flatten);

    const latRad = EIFFEL_LAT * THREE.MathUtils.DEG2RAD;
    const lonRad = EIFFEL_LON * THREE.MathUtils.DEG2RAD;
    const ecefPos = new THREE.Vector3();
    const ecefUp = new THREE.Vector3();
    this.tiles.ellipsoid.getCartographicToPosition(
      latRad,
      lonRad,
      GROUND_ELLIPSOID_HEIGHT,
      ecefPos,
    );
    this.tiles.ellipsoid.getCartographicToNormal(latRad, lonRad, ecefUp);

    const flattenDisc = new THREE.Mesh(new THREE.CircleGeometry(FLATTEN_RADIUS, 48));
    flattenDisc.position.copy(ecefPos);
    flattenDisc.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), // CircleGeometry's normal
      ecefUp,
    );
    flattenDisc.updateMatrixWorld(true);
    this.flatten.addShape(flattenDisc, ecefUp.clone().negate(), {
      thresholdMode: "flatten", // flatten no matter how far above the disc
      threshold: Infinity,
      flattenRange: 0,
    });

    this.addVenueBasket();

    this.tiles.setCamera(this.camera);
    this.tiles.setResolutionFromRenderer(this.camera, this.renderer);
    this.tiles.errorTarget = 12;

    this.tiles.addEventListener("load-error", (e) => {
      console.error("3d-tiles load error (token/asset access?)", e);
    });

    this.addVenuePopup();

    // scale the real-metres city into our physics units (2 units = 330 m)
    this.cityGroup = new THREE.Group();
    this.cityGroup.scale.setScalar(CITY_SCALE);
    this.cityGroup.rotation.y = CITY_ROTATION_Y * THREE.MathUtils.DEG2RAD;
    this.cityGroup.add(this.tiles.group);
    this.scene.add(this.cityGroup);
  }

  // Open-top "basket" over the venue: 4 energy walls + floor, sci-fi wave
  // shader, "three.js conf" label. Parented to tiles.group in ECEF metres
  // so it rides every city transform automatically.
  addVenueBasket() {
    const S = VENUE_BASKET_SIZE;

    this.venueUniforms = { uTime: { value: 0 } };
    const wallMaterial = new THREE.ShaderMaterial({
      uniforms: this.venueUniforms,
      vertexShader: BASKET_VERTEX,
      fragmentShader: BASKET_FRAGMENT,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.venueBasket = new THREE.Group();

    // funnel profile: flat bottom disc, then walls flaring out toward the
    // wide open top. Stored (in metres) for the ball collision as well.
    this.venueProfile = [
      [0.001, 1],
      [VENUE_BOTTOM_RADIUS, 1],
    ];
    const PROFILE_STEPS = 10;
    for (let i = 1; i <= PROFILE_STEPS; i++) {
      const t = i / PROFILE_STEPS;
      this.venueProfile.push([funnelRadius(t), 1 + (S - 1) * t]);
    }
    const lathePoints = this.venueProfile.map(([r, y]) => new THREE.Vector2(r, y));
    const funnel = new THREE.Mesh(new THREE.LatheGeometry(lathePoints, 64), wallMaterial);
    this.venueBasket.add(funnel);

    // "three.js conf" label on all four sides (canvas texture, no font files)
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.font = "bold 140px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "#4fd8ff";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#eaffff";
    ctx.fillText("three.js conf", 512, 128);
    const labelTexture = new THREE.CanvasTexture(canvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    labelTexture.anisotropy = 4;

    const labelMaterial = new THREE.MeshBasicMaterial({
      map: labelTexture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const labelGeo = new THREE.PlaneGeometry(S * 0.8, S * 0.8 * 0.25);
    const labelOffset = funnelRadius(0.6) + 4; // just outside the flared wall
    const labels = [
      { pos: [0, S * 0.6, labelOffset], rotY: 0 },
      { pos: [0, S * 0.6, -labelOffset], rotY: Math.PI },
      { pos: [labelOffset, S * 0.6, 0], rotY: Math.PI / 2 },
      { pos: [-labelOffset, S * 0.6, 0], rotY: -Math.PI / 2 },
    ];
    labels.forEach(({ pos, rotY }) => {
      const label = new THREE.Mesh(labelGeo, labelMaterial);
      label.position.set(...pos);
      label.rotation.y = rotY;
      this.venueBasket.add(label);
    });

    // place at the venue, floor on the ground, aligned to local up
    const venuePos = new THREE.Vector3();
    const venueUp = new THREE.Vector3();
    const latRad = VENUE_LAT * THREE.MathUtils.DEG2RAD;
    const lonRad = VENUE_LON * THREE.MathUtils.DEG2RAD;
    this.tiles.ellipsoid.getCartographicToPosition(
      latRad,
      lonRad,
      GROUND_ELLIPSOID_HEIGHT,
      venuePos,
    );
    this.tiles.ellipsoid.getCartographicToNormal(latRad, lonRad, venueUp);
    this.venueBasket.position.copy(venuePos);
    this.venueBasket.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), venueUp);
    this.tiles.group.add(this.venueBasket);

    this.venueScored = false;
  }

  addVenuePopup() {
    const el = document.createElement("div");
    el.style.cssText = `${POPUP_OVERLAY};display:none;z-index:100;cursor:pointer`;
    el.innerHTML = `<div style="${POPUP_CARD}">
        <div style="${POPUP_EYEBROW}"><span style="${POPUP_DOT}"></span>three.js conf &mdash; Paris</div>
        <h1 style="margin:22px 0 10px;color:#f2f2f4;font-size:40px;font-weight:300;
          letter-spacing:-.5px;line-height:1.15">
          Right into the <span style="color:${ACCENT}">conf!</span> 🥳</h1>
        <p id="popup-see-you" style="color:#9a9aa0;font-size:18px;margin:0 0 24px">
          See you there.</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <span style="${POPUP_PILL}">📍 Paris</span>
          <span style="${POPUP_PILL}">📅 10&ndash;11 September</span>
          <a href="https://threejs.paris" target="_blank" rel="noopener"
            style="${POPUP_PILL}">🌐 threejs.paris &#8599;</a>
        </div>
        <div style="margin-top:26px;padding:18px 20px;border-radius:14px;
          border:1px dashed rgba(123, 46, 238, 0.45);background:rgba(255, 255, 255, 0.06)">
          <div style="color:#9a9aa0;font-size:12px;font-weight:600;
            letter-spacing:2px;text-transform:uppercase">15% off with code</div>
          <div style="margin-top:8px;color:${ACCENT};font-size:26px;font-weight:700;
            letter-spacing:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">
            CODROPS</div>
        </div>
        <a href="https://threejs.paris/tickets" target="_blank" rel="noopener"
          style="${POPUP_CTA}">Get your ticket &#8599;</a>
        <div style="margin-top:20px;color:#5c5c63;font-size:12px">
          click outside to keep throwing</div>
      </div>`;
    el.onclick = () => (el.style.display = "none");
    // only the backdrop closes it: the card holds a promo code people will
    // want to select and copy
    el.firstElementChild.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(el);
    this.popup = el;
  }

  showWelcome() {
    const el = document.createElement("div");
    el.style.cssText = `${POPUP_OVERLAY};display:flex;z-index:110`;
    el.innerHTML = `
      <div style="${POPUP_CARD}">
        <div style="${POPUP_EYEBROW}"><span style="${POPUP_DOT}"></span>three.js conf &mdash; Paris</div>
        <div style="font-size:48px;margin-top:18px">&#128508;</div>
        <h1 style="margin:14px 0 30px;color:#f2f2f4;font-size:32px;font-weight:300;
          letter-spacing:-.5px;line-height:1.2">
          Can you catapult yourself to the<br/>
          <span style="color:${ACCENT}">first Three.js conference?</span></h1>
        <input placeholder="Your name" maxlength="30" autocomplete="off"
          style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);
          border-radius:999px;color:#f2f2f4;font-size:16px;padding:14px 26px;
          text-align:center;outline:none;width:72%;transition:border-color .2s"/>
        <br/>
        <button style="margin-top:18px;background:${ACCENT};border:none;
          border-radius:999px;color:#fff;font-size:14px;font-weight:700;
          padding:15px 42px;cursor:pointer;">
          Let's go!</button>
      </div>`;
    document.body.appendChild(el);

    const input = el.querySelector("input");
    input.addEventListener("focus", () => {
      input.style.borderColor = "rgba(112, 26, 241, 0.6)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "rgba(255,255,255,.14)";
    });

    const start = () => {
      this.playerName = input.value.trim();
      this.setBallName(); // no-op if the tower/ball isn't built yet
      el.remove();
      this.introHold = false; // release the paused cinematic dive
    };
    el.querySelector("button").addEventListener("click", start);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") start();
    });
    // desktop only: autofocusing on a phone throws up the keyboard and
    // hides half the card before anyone has read it
    if (!window.matchMedia("(pointer: coarse)").matches) {
      setTimeout(() => input.focus(), 50);
    }
  }

  scoreBasket() {
    this.venueScored = true;
    // personalize with the name from the welcome screen (textContent — no
    // HTML injection from user input)
    const seeYou = this.popup.querySelector("#popup-see-you");
    if (seeYou && this.playerName) {
      seeYou.textContent = `See you there, ${this.playerName}.`;
    }
    // stays up until dismissed — the card carries a promo code and a
    // ticket link, so auto-hiding would yank the CTA away mid-read
    this.popup.style.display = "flex";
  }

  makeRustMaterial() {
    // Procedural rust: the glb has UVs but no texture, and its FBX-era UV
    // islands are not trustworthy for a seamless material. Instead we shade
    // from the REST-POSE vertex position (the raw `position` attribute,
    // sampled before skinning) so the pattern is glued to the iron and
    // doesn't swim while the tower bends.
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, // colour comes entirely from the shader patch below
      roughness: 1,
      metalness: 0.3,
      side: THREE.DoubleSide, // lattice has visible back faces
    });

    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRestPos;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRestPos = position;");

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          /* glsl */ `#include <common>
          varying vec3 vRestPos;

          float rustHash(vec3 p) {
            return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
          }
          float rustNoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(
                mix(rustHash(i), rustHash(i + vec3(1, 0, 0)), f.x),
                mix(rustHash(i + vec3(0, 1, 0)), rustHash(i + vec3(1, 1, 0)), f.x),
                f.y
              ),
              mix(
                mix(rustHash(i + vec3(0, 0, 1)), rustHash(i + vec3(1, 0, 1)), f.x),
                mix(rustHash(i + vec3(0, 1, 1)), rustHash(i + vec3(1, 1, 1)), f.x),
                f.y
              ),
              f.z
            );
          }
          float rustFbm(vec3 p) {
            float v = 0.0;
            float a = 0.5;
            for (int k = 0; k < 4; k++) {
              v += a * rustNoise(p);
              p *= 2.17;
              a *= 0.5;
            }
            return v;
          }`,
        )
        .replace(
          "#include <color_fragment>",
          /* glsl */ `#include <color_fragment>
          // large weather patches + fine speckle; streaks stretched
          // vertically (y squashed) like rain-washed oxidation
          vec3 rp = vRestPos * vec3(9.0, 3.0, 9.0);
          float patches = rustFbm(rp);
          float speckle = rustNoise(vRestPos * 90.0);

          vec3 paintBrown = vec3(0.215, 0.125, 0.075); // "Venetian brown" paint
          vec3 rustMid    = vec3(0.42, 0.20, 0.09);    // settled rust
          vec3 rustBright = vec3(0.60, 0.30, 0.12);    // fresh oxide bloom

          vec3 rustCol = mix(paintBrown, rustMid, smoothstep(0.30, 0.62, patches));
          rustCol = mix(
            rustCol,
            rustBright,
            smoothstep(0.55, 0.95, patches * 0.72 + speckle * 0.40)
          );
          diffuseColor.rgb = rustCol;`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          /* glsl */ `#include <roughnessmap_fragment>
          // oxide blooms are matte, remaining paint keeps a slight sheen
          roughnessFactor = mix(0.55, 0.95, smoothstep(0.30, 0.75, patches));`,
        );
    };

    return material;
  }

  loadTower() {
    new GLTFLoader().load(
      "/tower.glb",
      (gltf) => {
        let source = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((child) => {
          if (child.isMesh && !source) source = child;
        });

        // bake the node transform, center on origin, base at y=0, and
        // normalize height to STICK_HEIGHT so all physics tuning holds
        const geometry = source.geometry.clone();
        geometry.applyMatrix4(source.matrixWorld);
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        const center = box.getCenter(new THREE.Vector3());
        geometry.translate(-center.x, -box.min.y, -center.z);
        const s = STICK_HEIGHT / (box.max.y - box.min.y);
        geometry.scale(s, s, s);

        this.buildStick(geometry, this.makeRustMaterial());
      },
      undefined,
      (err) => {
        console.warn("tower.glb failed to load, using box stick", err);
        const geometry = new THREE.BoxGeometry(
          STICK_THICKNESS,
          STICK_HEIGHT,
          STICK_THICKNESS,
          2,
          48,
          2,
        );
        geometry.translate(0, STICK_HEIGHT / 2, 0);
        const material = new THREE.MeshStandardMaterial({
          color: 0xff5533,
          roughness: 0.4,
        });
        this.buildStick(geometry, material);
      },
    );
  }

  buildStick(geometry, material) {
    const segHeight = STICK_HEIGHT / (BONE_COUNT - 1);
    this.segHeight = segHeight;

    // Skin every vertex to the two nearest joints, blended by height,
    // so the box bends smoothly instead of shearing at joint boundaries.
    const position = geometry.attributes.position;
    const skinIndices = [];
    const skinWeights = [];
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      const f = THREE.MathUtils.clamp(y / segHeight, 0, BONE_COUNT - 1);
      const i0 = Math.min(Math.floor(f), BONE_COUNT - 2);
      const w = f - i0;
      skinIndices.push(i0, i0 + 1, 0, 0);
      skinWeights.push(1 - w, w, 0, 0);
    }
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

    this.stick = new THREE.SkinnedMesh(geometry, material);
    this.stick.castShadow = true;

    this.bones = [];
    for (let i = 0; i < BONE_COUNT; i++) {
      const bone = new THREE.Bone();
      bone.position.y = i === 0 ? 0 : segHeight;
      if (i > 0) this.bones[i - 1].add(bone);
      this.bones.push(bone);
    }
    this.stick.add(this.bones[0]);
    this.stick.bind(new THREE.Skeleton(this.bones));
    this.scene.add(this.stick);

    this.skeletonHelper = new THREE.SkeletonHelper(this.stick);
    this.skeletonHelper.visible = false;
    this.scene.add(this.skeletonHelper);

    // rest world position of each joint (base never moves, so these are static)
    this.jointRest = this.bones.map((_, i) => new THREE.Vector3(0, i * segHeight, 0));
    this.tipRest = new THREE.Vector3(0, STICK_HEIGHT, 0);

    // single source of truth for the whole stick: a world-space tip point
    // on a damped spring anchored to tipRest. The chain is always slaved
    // to the bezier ending at this point — no per-bone physics feedback.
    this.tipPoint = this.tipRest.clone();
    this.tipVel = new THREE.Vector3();
    this.renderTip = this.tipRest.clone(); // tipPoint projected onto the natural dome
    this.bendDir = new THREE.Vector3(1, 0, 0); // last known horizontal bend direction
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._control = new THREE.Vector3();

    // wiggle all joints except the fixed root; order root->tip so parents
    // update before children each frame
    this.wiggleBones = [];
    for (let i = 1; i < BONE_COUNT; i++) {
      const wb = new WiggleBone(this.bones[i], {
        stiffness: 500,
        damping: 14,
      });
      wb.jointIndex = i;
      this.wiggleBones.push(wb);
    }

    // grab handle riding on the top joint — added AFTER wiggle wrapping,
    // because WiggleBone deep-clones the bone (a clone of this mesh would
    // render as a ghost sphere frozen at the rest pose)
    this.tipHandle = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0x2255ff, roughness: 0.3 }),
    );
    this.tipHandle.visible = false; // optional grab affordance, off by default
    this.bones[BONE_COUNT - 1].add(this.tipHandle);

    this.tipTangent = new THREE.Vector3(0, 1, 0); // curve direction at the tip

    this.addDebug();
    this.addBall();
    this.addAimArc();
  }

  addAimArc() {
    // Line2 "fat line": plain THREE.Line is stuck at 1px on most GPUs.
    // Dashes come from LineMaterial's USE_DASH path; animating dashOffset
    // marches them along the arc toward the landing point
    this.aimArcCount = 96;
    this.aimPositions = new Float32Array(this.aimArcCount * 3);
    this.aimMaterial = new LineMaterial({
      color: 0xd4af37,
      linewidth: 5, // px (worldUnits: false)
      dashed: true,
      dashSize: 0.22,
      gapSize: 0.14,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
    });
    this.aimMaterial.resolution.set(this.width, this.height);

    const geometry = new LineGeometry();
    geometry.setPositions(this.aimPositions);
    this.aimLine = new Line2(geometry, this.aimMaterial);
    this.aimLine.visible = false;
    this.aimLine.frustumCulled = false;
    this.scene.add(this.aimLine);
    this._arcVel = new THREE.Vector3();
    this._arcPos = new THREE.Vector3();
  }

  // Predict the launch and draw the ballistic arc. Launch happens at the
  // rest-crossing with speed ~ sqrt(stiffness) * |displacement|, reduced by
  // the damping the spring sheds during the quarter-swing back to vertical.
  updateAimArc() {
    const k = this.settings.stiffness;
    const zeta = this.settings.damping / (2 * Math.sqrt(k));
    const decay = Math.exp((-zeta * (Math.PI / 2)) / Math.sqrt(Math.max(1 - zeta * zeta, 1e-4)));
    this._arcVel
      .copy(this.tipRest)
      .sub(this.tipPoint)
      .multiplyScalar(Math.sqrt(k) * decay * this.settings.launchPower);
    this._arcPos.set(0, STICK_HEIGHT + (this.ballSeat ?? 0.1), 0);

    const pts = this.aimPositions;
    const h = 0.035;
    const g = this.settings.gravity;
    let i = 0;
    for (; i < this.aimArcCount; i++) {
      pts[i * 3] = this._arcPos.x;
      pts[i * 3 + 1] = this._arcPos.y;
      pts[i * 3 + 2] = this._arcPos.z;
      this._arcVel.y -= g * h;
      this._arcPos.addScaledVector(this._arcVel, h);
      if (this._arcPos.y < 0) break;
    }
    // Line2 has no drawRange trick — collapse unused tail onto the last
    // point so it contributes zero-length (invisible) segments
    for (let j = i; j < this.aimArcCount; j++) {
      pts[j * 3] = pts[(i - 1) * 3];
      pts[j * 3 + 1] = pts[(i - 1) * 3 + 1];
      pts[j * 3 + 2] = pts[(i - 1) * 3 + 2];
    }
    this.aimLine.geometry.setPositions(pts);
    this.aimLine.computeLineDistances(); // dashes need cumulative distances
  }

  addBall() {
    this.ballRadius = 0.18;
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(this.ballRadius, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0x948aea, roughness: 0.3 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    // seat depth: < 1 radius, so the ball nests INTO the tip a little
    // instead of balancing on top of it
    this.ballSeat = this.ballRadius * 0.55;

    // sit on the tip right away — don't wait for the first update tick
    this.ball.position.copy(this.renderTip).addScaledVector(this.tipTangent, this.ballSeat);

    this.ballState = "riding"; // riding -> flying -> landed -> riding
    this.ballVel = new THREE.Vector3();
    this.armed = false; // set on drag release; launches at the rest-crossing
    this.prevDot = 0;
    this.respawnTimer = 0;

    this.addBallFace();
    this.setBallName(); // in case the welcome screen finished before the glb
  }

  setBallName() {
    const name = this.playerName;
    if (!name || !this.ball || this.nameTag) return;

    const pad = { x: 38, y: 20 };
    const fontSize = 64;
    const font = `bold ${fontSize}px system-ui, sans-serif`;
    const canvas = document.createElement("canvas");
    let ctx = canvas.getContext("2d");
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(name).width) + pad.x * 2;
    canvas.height = fontSize + pad.y * 2;
    ctx = canvas.getContext("2d"); // resizing reset the state
    ctx.font = font;

    // pill matching the popup style: dark glass + cyan border
    const r = canvas.height / 2;
    ctx.beginPath();
    ctx.roundRect(3, 3, canvas.width - 6, canvas.height - 6, r);
    ctx.fillStyle = "rgba(2,12,40,.78)";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#4fd8ff";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, canvas.width / 2, canvas.height / 2 + 4);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.nameTag = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false, // stays readable when the ball ducks behind the tower
      }),
    );
    this.nameTag.renderOrder = 5;
    const h = 0.14;
    this.nameTag.scale.set((h * canvas.width) / canvas.height, h, 1);
    this.scene.add(this.nameTag);
  }

  addBallFace() {
    this.faceCanvas = document.createElement("canvas");
    this.faceCanvas.width = 256;
    this.faceCanvas.height = 256;
    this.faceCtx = this.faceCanvas.getContext("2d");
    this.faceTexture = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTexture.colorSpace = THREE.SRGBColorSpace;
    this.faceTexture.anisotropy = 4;

    this.faceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: this.faceTexture,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.faceMesh.scale.setScalar(this.ballRadius * 1.8);
    this.scene.add(this.faceMesh);

    this.fear = 0; // 0 = calm, 1 = terrified
    this.launchFear = 0; // frozen at launch, held during flight
    this.blinkClosed = false;
    this.blinkTimer = 2.5; // time to next blink toggle
    this._drawnFear = -1;
    this._drawnBlink = false;
    this.drawFace(0, false);
  }

  // calm: two round eyes + flat mouth. scared: >_< eyes + frown.
  drawFace(fear, blink = false) {
    const ctx = this.faceCtx;
    ctx.clearRect(0, 0, 256, 256);
    ctx.fillStyle = "#111";
    ctx.strokeStyle = "#111";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const eyeY = 108;
    const eyes = [88, 168]; // left, right
    // eyes SNAP between the two types (no crossfade) — cartoon faces read
    // as one expression or the other, a blend looks like ghost eyes
    const scared = fear > 0.35;
    ctx.globalAlpha = 1;
    if (!scared) {
      if (blink) {
        // closed lids: short horizontal strokes where the eyes were
        ctx.lineWidth = 13;
        eyes.forEach((x) => {
          ctx.beginPath();
          ctx.moveTo(x - 20, eyeY);
          ctx.lineTo(x + 20, eyeY);
          ctx.stroke();
        });
      } else {
        eyes.forEach((x) => {
          ctx.beginPath();
          ctx.arc(x, eyeY, 21, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    } else {
      ctx.lineWidth = 15;
      const w = 17;
      const h = 21;
      // left eye ">"
      ctx.beginPath();
      ctx.moveTo(eyes[0] - w, eyeY - h);
      ctx.lineTo(eyes[0] + w * 0.8, eyeY);
      ctx.lineTo(eyes[0] - w, eyeY + h);
      ctx.stroke();
      // right eye "<"
      ctx.beginPath();
      ctx.moveTo(eyes[1] + w, eyeY - h);
      ctx.lineTo(eyes[1] - w * 0.8, eyeY);
      ctx.lineTo(eyes[1] + w, eyeY + h);
      ctx.stroke();
    }

    // mouth: happy smile at rest, flattening to a tense straight line
    // as fear rises
    const smile = 1 - fear;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(97, 170);
    ctx.quadraticCurveTo(128, 170 + smile * 32, 159, 170);
    ctx.stroke();

    this.faceTexture.needsUpdate = true;
    this._drawnFear = fear;
    this._drawnBlink = blink;
  }

  updateBallFace(dt) {
    // how scared should the ball be right now?
    let target;
    if (this.ballState === "flying") {
      target = this.launchFear; // committed — stay scared for the whole flight
    } else if (this.ballState === "landed") {
      target = 0; // phew
    } else {
      // riding: fear follows how far the tower is bent
      const disp = this._v1.copy(this.tipPoint).sub(this.tipRest).length();
      target = THREE.MathUtils.clamp(disp / (STICK_HEIGHT * 1.05), 0, 1);
    }
    this.fear += (target - this.fear) * Math.min(1, dt * 8);

    // idle blink: quick lid-close every few seconds, only while calm
    // (the scared >< eyes never blink — terror doesn't rest)
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkClosed = !this.blinkClosed;
      this.blinkTimer = this.blinkClosed ? 0.13 : 2 + Math.random() * 3;
    }
    const blink = this.blinkClosed && this.fear < 0.35;

    if (Math.abs(this.fear - this._drawnFear) > 0.02 || blink !== this._drawnBlink) {
      this.drawFace(this.fear, blink);
    }

    // face direction: mostly toward the camera, but steered toward the
    // mouse (screen-space offset mapped onto the camera's right/up axes)
    // so the ball appears to watch the cursor
    const toCam = this._v1.copy(this.camera.position).sub(this.ball.position).normalize();

    this._v2.copy(this.ball.position).project(this.camera);
    let dx = this.pointer.x - this._v2.x;
    let dy = this.pointer.y - this._v2.y;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }

    const e = this.camera.matrixWorld.elements;
    const dir = this._v2.copy(toCam);
    dir.addScaledVector(this._control.set(e[0], e[1], e[2]), dx * 0.55);
    dir.addScaledVector(this._control.set(e[4], e[5], e[6]), dy * 0.55);
    dir.normalize();

    // floats ahead of the sphere: when the gaze turns sideways the face
    // slides off the silhouette, which is what sells the cartoon depth
    // (1.15 = tangent plane just clears the surface; higher = more pop)
    const offset = this.settings?.faceOffset ?? 1.45;
    this.faceMesh.position.copy(this.ball.position).addScaledVector(dir, this.ballRadius * offset);

    if (this.nameTag) {
      this.nameTag.position.copy(this.ball.position);
      this.nameTag.position.y += this.ballRadius * 2.2;
    }
    this.faceMesh.lookAt(this._v1.copy(this.faceMesh.position).add(dir));
  }

  updateBall(dt) {
    const R = this.ballRadius;

    if (this.ballState === "riding") {
      // sit on the tip, along the curve's end direction
      this.ball.position.copy(this.renderTip).addScaledVector(this.tipTangent, this.ballSeat);

      // catapult release: the tip is fastest when the spring displacement
      // crosses zero (passing vertical). Detect the sign flip of
      // displacement . velocity and let go exactly there.
      if (this.armed && !this.drag.active) {
        const disp = this._v1.copy(this.tipPoint).sub(this.tipRest);
        const dot = disp.dot(this.tipVel);
        if (this.prevDot < 0 && dot >= 0 && this.tipVel.length() > 1) {
          this.ballState = "flying";
          this.ballVel.copy(this.tipVel).multiplyScalar(this.settings.launchPower);
          this.armed = false;
          this.launchFear = Math.max(this.fear, 0.85); // screaming all the way
        }
        this.prevDot = dot;
      }
      return;
    }

    if (this.ballState === "flying") {
      this.ballVel.y -= this.settings.gravity * dt;
      this.ball.position.addScaledVector(this.ballVel, dt);

      const inBasket = this.handleBasket();

      if (!inBasket && this.ball.position.y < R) {
        this.ball.position.y = R;
        if (Math.abs(this.ballVel.y) > 1.5) {
          this.ballVel.y *= -0.45; // bounce
          this.ballVel.x *= 0.8;
          this.ballVel.z *= 0.8;
        } else {
          this.ballVel.y = 0; // roll out
          this.ballVel.x *= 0.95;
          this.ballVel.z *= 0.95;
          if (this.ballVel.lengthSq() < 0.01) {
            this.ballState = "landed";
            this.respawnTimer = 1.5;
          }
        }
      }
      return;
    }

    // landed: pause, then reload onto the tip
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) this.ballState = "riding";
  }

  // Scoring + funnel collision, both in the basket's local frame (metres).
  // Returns true while the ball is inside the basket zone, which disables
  // the flat-ground collision there.
  handleBasket() {
    if (!this.venueBasket) return false;

    const local = this._v2
      .copy(this.ball.position)
      .applyMatrix4(_mat4.copy(this.venueBasket.matrixWorld).invert());
    const ballR = this.ballRadius / CITY_SCALE; // metres
    const rho = Math.hypot(local.x, local.z);

    // broad-phase: near the funnel at all?
    if (
      rho > VENUE_TOP_RADIUS + ballR * 2 ||
      local.y > VENUE_BASKET_SIZE + ballR * 2 ||
      local.y < -ballR
    ) {
      return false;
    }

    // narrow-phase: sphere vs surface-of-revolution, reduced to a 2D
    // point-vs-polyline test in the (radius, height) plane
    let bestDist = Infinity;
    let bestNx = 0; // 2D normal, radial component
    let bestNy = 1;
    let bestIdx = -1; // segment 0 = the bottom disc
    const prof = this.venueProfile;
    for (let i = 0; i < prof.length - 1; i++) {
      const [ax, ay] = prof[i];
      const [bx, by] = prof[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      let t = ((rho - ax) * dx + (local.y - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + dx * t;
      const cy = ay + dy * t;
      const ox = rho - cx;
      const oy = local.y - cy;
      const d = Math.hypot(ox, oy);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        if (d > 1e-6) {
          bestNx = ox / d;
          bestNy = oy / d;
        } else {
          bestNx = 0;
          bestNy = 1;
        }
      }
    }

    if (bestDist < ballR) {
      // lift the 2D normal back to 3D around the axis
      const invRho = rho > 1e-4 ? 1 / rho : 0;
      _normal3.set(bestNx * local.x * invRho, bestNy, bestNx * local.z * invRho);
      if (invRho === 0) _normal3.set(0, 1, 0);

      // ball velocity into the local metre frame (uniform scale + rotation)
      this.venueBasket.getWorldQuaternion(_quat);
      _localVel.copy(this.ballVel).applyQuaternion(_quat.invert()).divideScalar(CITY_SCALE);

      // push out of the surface
      local.addScaledVector(_normal3, ballR - bestDist);

      const vn = _localVel.dot(_normal3);
      if (vn < 0) {
        _localVel.addScaledVector(_normal3, -(1 + 0.3) * vn); // restitution
        _localVel.multiplyScalar(0.985); // gentle rolling friction
      }

      // write the corrected state back to world space
      this.ball.position.copy(local).applyMatrix4(this.venueBasket.matrixWorld);
      this.venueBasket.getWorldQuaternion(_quat);
      this.ballVel.copy(_localVel).multiplyScalar(CITY_SCALE).applyQuaternion(_quat);

      // SUCCESS = the ball made it all the way down to the funnel floor
      if (bestIdx === 0) {
        if (!this.venueScored) this.scoreBasket();
        // settled at the bottom
        if (_localVel.lengthSq() < 4 && this.ballState === "flying") {
          this.ballState = "landed";
          this.respawnTimer = 2.5;
        }
      }
    }

    return rho < VENUE_TOP_RADIUS && local.y < VENUE_BASKET_SIZE;
  }

  addDebug() {
    // green dots: live spring aim points (world pos each bone rotates toward)
    // magenta dots: bezier targets the springs get pinned to while dragging
    this.debugGroup = new THREE.Group();
    this.debugGroup.visible = this.settings.showDebug;
    this.scene.add(this.debugGroup);

    const springMat = new THREE.MeshBasicMaterial({
      color: 0x00cc44,
      depthTest: false,
    });
    const desiredMat = new THREE.MeshBasicMaterial({
      color: 0xff00ff,
      depthTest: false,
    });
    const dotGeo = new THREE.SphereGeometry(0.035, 12, 8);

    this.debugSpringDots = [];
    this.debugDesiredDots = [];
    this.wiggleBones.forEach(() => {
      const s = new THREE.Mesh(dotGeo, springMat);
      s.renderOrder = 10;
      this.debugGroup.add(s);
      this.debugSpringDots.push(s);

      const d = new THREE.Mesh(dotGeo, desiredMat);
      d.renderOrder = 10;
      d.visible = false;
      this.debugGroup.add(d);
      this.debugDesiredDots.push(d);
    });
  }

  setupDrag() {
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragPlane = new THREE.Plane();
    this.drag = {
      active: false,
      target: new THREE.Vector3(), // where the pointer wants the tip
      grabOffset: new THREE.Vector3(), // tip position minus initial plane hit
      samples: [], // recent {pos, time} for fling velocity
    };

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown.bind(this));
    el.addEventListener("pointermove", this.onPointerMove.bind(this));
    window.addEventListener("pointerup", this.onPointerUp.bind(this));
  }

  updatePointer(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  // Cheap grab test: distance from the pointer ray to the bone chain
  // segments. Raycasting the real SkinnedMesh applies bone transforms to
  // every vertex in JS (~8ms/frame on the 27k-vert tower) — this is O(bones)
  // and follows the bent pose for free.
  rayHitsStick() {
    const ray = this.raycaster.ray;
    const a = this._v1;
    const b = this._v2;
    this.bones[0].getWorldPosition(a);
    for (let i = 1; i < BONE_COUNT; i++) {
      this.bones[i].getWorldPosition(b);
      const r = i === BONE_COUNT - 1 ? 0.45 : 0.3; // fatter near the tip
      if (ray.distanceSqToSegment(a, b) < r * r) return true;
      a.copy(b);
    }
    return false;
  }

  onPointerDown(e) {
    if (!this.stick || this.introActive) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.rayHitsStick()) return;

    this.drag.active = true;
    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = "grabbing";

    // reload the catapult: recall the ball onto the tip
    this.ballState = "riding";
    this.armed = false;
    this.venueScored = false;

    // drag on a camera-facing plane through the current tip position
    const tipWorld = new THREE.Vector3();
    this.tipHandle.getWorldPosition(tipWorld);
    const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    this.dragPlane.setFromNormalAndCoplanarPoint(normal, tipWorld);

    // drag by delta: wherever the grab started maps to the CURRENT tip
    // position, so nothing jumps on pointerdown
    const initialHit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.dragPlane, initialHit);
    this.drag.grabOffset.copy(tipWorld).sub(initialHit);

    this.drag.samples.length = 0;
    this.moveDragTarget(e);
  }

  onPointerMove(e) {
    if (this.drag.active) {
      this.moveDragTarget(e);
      return;
    }
    if (!this.stick) return;
    // hover affordance
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.renderer.domElement.style.cursor = this.rayHitsStick() ? "grab" : "";
  }

  moveDragTarget(e) {
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;
    hit.add(this.drag.grabOffset);

    // snap the raw pointer position onto the natural bend trajectory
    this.naturalTip(hit, this.drag.target);

    this.drag.samples.push({
      pos: this.drag.target.clone(),
      time: performance.now(),
    });
    if (this.drag.samples.length > 5) this.drag.samples.shift();
  }

  onPointerUp() {
    if (!this.drag.active) return;
    this.drag.active = false;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = "";

    // fling velocity of the tip in units/second, handed to the tip spring
    const s = this.drag.samples;
    this.tipVel.set(0, 0, 0);
    if (s.length >= 2) {
      const a = s[0];
      const b = s[s.length - 1];
      const dt = (b.time - a.time) / 1000;
      if (dt > 0.001) {
        this.tipVel.copy(b.pos).sub(a.pos).divideScalar(dt);
        this.tipVel.clampLength(0, 25);
      }
    }
    // tipPoint already sits at the dragged position; the spring takes over

    // arm the catapult only for a real pull (not an accidental tap)
    const displacement = this._v1.copy(this.tipPoint).sub(this.tipRest).length();
    this.armed = displacement > 0.25;
    this.prevDot = -1; // "approaching rest" so the first crossing launches
  }

  // Project any point onto the "natural bend dome": keep its bend direction
  // and its angle from vertical, then solve for the tip distance where the
  // bezier's ARC LENGTH equals the stick length. The pointer thus only says
  // "which way and how far to bend" — the stick can never compress/stretch.
  naturalTip(point, out) {
    const base = this.jointRest[0];
    const v = this._v1.copy(point).sub(base);
    const len = v.length();

    let theta = len > 1e-6 ? Math.acos(THREE.MathUtils.clamp(v.y / len, -1, 1)) : 0;
    theta = Math.min(theta, MAX_BEND);

    // horizontal bend direction; reuse the last one when pointing straight up
    this._v2.set(v.x, 0, v.z);
    if (this._v2.lengthSq() > 1e-8) this.bendDir.copy(this._v2.normalize());
    const dir = this._v2.copy(this.bendDir).multiplyScalar(Math.sin(theta));
    dir.y = Math.cos(theta);

    const control = this._control.set(
      base.x,
      base.y + STICK_HEIGHT * this.settings.bendShape,
      base.z,
    );

    // arc length grows monotonically with tip distance -> bisection
    let lo = STICK_HEIGHT * 0.2;
    let hi = STICK_HEIGHT * 1.05;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      out.copy(dir).multiplyScalar(mid).add(base);
      if (quadBezierLength(base, control, out) < STICK_HEIGHT) lo = mid;
      else hi = mid;
    }
    out
      .copy(dir)
      .multiplyScalar((lo + hi) / 2)
      .add(base);
    return out;
  }

  // advance the master tip spring (semi-implicit Euler, substepped)
  integrateTip(dt) {
    const k = this.settings.stiffness;
    const c = this.settings.damping;
    const accel = new THREE.Vector3();
    const steps = 2;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      accel
        .copy(this.tipRest)
        .sub(this.tipPoint)
        .multiplyScalar(k)
        .addScaledVector(this.tipVel, -c);
      this.tipVel.addScaledVector(accel, h);
      this.tipPoint.addScaledVector(this.tipVel, h);
    }
  }

  // slave the whole chain to the bezier ending at tipPoint. Joint desired
  // positions: base -> control point vertically above the base -> tipPoint,
  // so the base stays clamped-vertical and curvature builds toward the tip.
  // Bone i's spring steers the segment i -> i+1, so it gets joint i+1's
  // position (the top bone gets a tangent extrapolation past the tip).
  applyChainToTip() {
    // render through the dome projection: even mid-oscillation the shape
    // is a full-length bend, never a compressed curl
    this.naturalTip(this.tipPoint, this.renderTip);

    const base = this.jointRest[0];
    const control = new THREE.Vector3(
      base.x,
      base.y + STICK_HEIGHT * this.settings.bendShape,
      base.z,
    );
    const curve = new THREE.QuadraticBezierCurve3(base, control, this.renderTip);
    curve.getTangent(1, this.tipTangent); // normalized; ball + top bone use it
    const desired = new THREE.Vector3();
    this.wiggleBones.forEach((wb, idx) => {
      const next = wb.jointIndex + 1;
      if (next > BONE_COUNT - 1) {
        desired.copy(this.renderTip).addScaledVector(this.tipTangent, this.segHeight);
      } else {
        // getPointAt = arc-length parameterized: joint targets sit exactly
        // one segment apart ALONG the curve. Uniform-parameter getPoint()
        // bunches samples on strong bends, which made the chain overshoot
        // clustered targets and zigzag into an S.
        curve.getPointAt(next / (BONE_COUNT - 1), desired);
      }
      wb.springX.updateConfig({ fromValue: desired.x, initialVelocity: 0 });
      wb.springY.updateConfig({ fromValue: desired.y, initialVelocity: 0 });
      wb.springZ.updateConfig({ fromValue: desired.z, initialVelocity: 0 });

      this.debugDesiredDots[idx].position.copy(desired);
      this.debugDesiredDots[idx].visible = this.debugGroup.visible;
    });
  }

  stop() {
    this.isPlaying = false;
  }

  play() {
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.render();
    }
  }

  render() {
    if (!this.isPlaying) return;
    requestAnimationFrame(this.render.bind(this));

    const dt = Math.min(this.clock.getDelta(), 1 / 30);

    // during the hold, dt=0 keeps positioning the camera at the start
    // pose (and driving fog/near/far) without advancing the flight
    if (this.introActive) this.updateIntro(this.introHold ? 0 : dt);

    if (this.tiles) {
      this.camera.updateMatrixWorld();
      this.tiles.update();
      this.venueUniforms.uTime.value += dt;
    }

    if (this.stick) {
      if (this.drag.active) {
        this.tipPoint.copy(this.drag.target); // kinematic while held
        this.updateAimArc();
        // decreasing offset slides the dash pattern in +distance
        // direction, i.e. from the tip toward the landing point
        this.aimMaterial.dashOffset -= dt * 1.2;
        this.aimLine.visible = true;
      } else {
        this.integrateTip(dt);
        this.aimLine.visible = false;
      }
      this.applyChainToTip();
      this.wiggleBones.forEach((wb) => wb.update());
      this.updateBall(dt);
      this.updateBallFace(dt);
    }

    if (this.stick && this.debugGroup.visible) {
      this.wiggleBones.forEach((wb, idx) => {
        this.debugSpringDots[idx].position.set(
          wb.springX.currentValue,
          wb.springY.currentValue,
          wb.springZ.currentValue,
        );
      });
    }

    if (this.perf) this.perf.begin();
    this.renderer.render(this.scene, this.camera);
    if (this.perf) this.perf.end();
  }
}

new Sketch({
  dom: document.getElementById("container"),
});
