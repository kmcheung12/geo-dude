import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ThreeGlobe from 'three-globe';
import { feature } from 'topojson-client';
import { geoCentroid, geoContains } from 'd3-geo';

export function createGlobe(canvas) {
  // ── Scene ────────────────────────────────────────────────────────────────
  const scene = new THREE.Scene();

  // ── Renderer ─────────────────────────────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 1);

  // ── Camera ───────────────────────────────────────────────────────────────
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 2000);
  camera.position.set(0, 0, 400);

  // ── Controls ─────────────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 110;
  controls.maxDistance = 500;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.2;
  controls.enabled = false;

  // ── Lights ───────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(200, 100, 200);
  scene.add(sun);

  // ── Stars ────────────────────────────────────────────────────────────────
  const starPositions = [];
  for (let i = 0; i < 2000; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 800 + Math.random() * 200;
    starPositions.push(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi)
    );
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2 })));

  // ── Globe (three-globe) ──────────────────────────────────────────────────
  const globe = new ThreeGlobe()
    .showAtmosphere(true)
    .atmosphereColor('#22d3ee')
    .atmosphereAltitude(0.15);
  scene.add(globe);

  // ── Decorative holders ────────────────────────────────────────────────────
  let clouds = null;
  const birds  = [];
  const planes = [];

  // ── Clouds ────────────────────────────────────────────────────────────────
  clouds = new THREE.Mesh(
    new THREE.SphereGeometry(103, 48, 48),
    new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false })
  );
  scene.add(clouds);

  // ── Birds ────────────────────────────────────────────────────────────────
  const BIRD_COUNT = window.innerWidth < 768 ? 4 : 9;
  for (let i = 0; i < BIRD_COUNT; i++) {
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 1.8, 4),
      new THREE.MeshBasicMaterial({ color: 0xd4eeff, transparent: true, opacity: 0.55 })
    );
    const axis = new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).normalize();
    birds.push({ mesh, axis, angle: Math.random() * Math.PI * 2, speed: 0.004 + Math.random() * 0.003 });
    scene.add(mesh);
  }

  // ── Utility ──────────────────────────────────────────────────────────────
  function latLngToVec3(lat, lng, radius) {
    const phi   = (90 - lat) * Math.PI / 180;
    const theta = (90 - lng) * Math.PI / 180;
    return new THREE.Vector3(
       radius * Math.sin(phi) * Math.cos(theta),
       radius * Math.cos(phi),
       radius * Math.sin(phi) * Math.sin(theta)
    );
  }

  // ── Airplanes (desktop only) ──────────────────────────────────────────────
  if (window.innerWidth >= 768) {
    [
      { from: [-74.0, 40.7], to: [2.35,  48.85] },
      { from: [139.7, 35.7], to: [-87.6, 41.8]  },
      { from: [-43.2,-22.9], to: [18.4, -33.9]  },
    ].forEach(({ from, to }) => {
      const origin = latLngToVec3(from[1], from[0], 100);
      const dest   = latLngToVec3(to[1],   to[0],   100);
      const mid    = origin.clone().add(dest).multiplyScalar(0.5).setLength(130);
      const curve  = new THREE.CatmullRomCurve3(
        new THREE.QuadraticBezierCurve3(origin, mid, dest).getPoints(60)
      );
      const mesh = new THREE.Mesh(
        new THREE.ConeGeometry(0.55, 1.6, 4),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65 })
      );
      planes.push({ mesh, curve, t: Math.random() });
      scene.add(mesh);
    });
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let polygonFeatures  = [];
  let countryColors    = {};
  let highlightedCountry = null;
  let selectedCountry    = null;
  let hoveredCountry     = null;
  let _screenToLatLng    = null;   // set by api.load once canvas is ready
  let cameraTransition   = null;
  let currentCameraState = 'landing';
  let demoIntervalId     = null;
  let demoIndex          = 0;

  // ── Test hook ─────────────────────────────────────────────────────────────
  window.__globeState = {
    get cameraDistance()     { return camera.position.length(); },
    get draggable()          { return controls.enableRotate; },
    get zoomable()           { return controls.enableZoom; },
    get highlightedCountry() { return highlightedCountry; },
    get selectedCountry()    { return selectedCountry; },
    get hoveredCountry()     { return hoveredCountry; },
    flyToCountry(name)       { flyToCountry(name); },
    rotateToLatLng(lat, lng) {
      globe._rotToken = Symbol();  // cancel any in-flight flyToCountry animation
      const target = latLngToVec3(lat, lng, 1);
      const front  = camera.position.clone().normalize();
      globe.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(target, front));
      globe.updateMatrixWorld(true);
    },
    screenToLatLngAt(cx, cy) { return _screenToLatLng ? _screenToLatLng(cx, cy) : null; },
  };

  // ── Resize ────────────────────────────────────────────────────────────────
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Render loop ───────────────────────────────────────────────────────────
  function animate() {
    requestAnimationFrame(animate);

    if (cameraTransition) {
      const { startDist, targetDist, startTime, duration, cfg, onDone } = cameraTransition;
      const t    = Math.min((performance.now() - startTime) / duration, 1);
      const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      camera.position.setLength(startDist + (targetDist - startDist) * ease);
      if (t >= 1) {
        camera.position.setLength(targetDist);
        cameraTransition = null;
        if (onDone) onDone();
      }
    }

    if (clouds) clouds.rotation.y += 0.00025;

    birds.forEach(b => {
      b.angle += b.speed;
      const pos = new THREE.Vector3(107, 0, 0).applyAxisAngle(b.axis, b.angle);
      b.mesh.position.copy(pos);
      b.mesh.lookAt(new THREE.Vector3(107, 0, 0).applyAxisAngle(b.axis, b.angle + 0.02));
    });

    planes.forEach(p => {
      p.t = (p.t + 0.0008) % 1;
      const pos     = p.curve.getPoint(p.t);
      const tangent = p.curve.getTangent(p.t);
      p.mesh.position.copy(pos);
      p.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent.normalize());
    });

    controls.update();
    globe.setPointOfView(camera);
    renderer.render(scene, camera);
  }
  animate();

  // ── Country colour function ───────────────────────────────────────────────
  function capColor(feat) {
    const name = feat.properties && feat.properties.name;
    if (name === highlightedCountry) return '#f97316';
    if (name === selectedCountry)    return '#22d3ee';
    return countryColors[name] || '#1a3450';
  }

  function refreshPolygonColors() {
    const hl  = highlightedCountry;   // snapshot now
    console.log('refresh hl=', hl);
    const sel = selectedCountry;
    globe.polygonCapColor(f => {
      const name = f.properties?.name;
      if (name === hl)  return '#f97316';
      if (name === sel) return '#22d3ee';
      return countryColors[name] || '#1a3450';
    }).polygonsData([...polygonFeatures]);
    globe.polygonCapColor( f => capColor(f));
  }

  // ── flyToCountry ──────────────────────────────────────────────────────────
  function flyToCountry(name) {
    const feat = polygonFeatures.find(f => f.properties && f.properties.name === name);
    if (!feat) return;
    const [lng, lat] = geoCentroid(feat);
    const target = latLngToVec3(lat, lng, 1);
    const front = camera.position.clone().normalize();
    const targetQ = new THREE.Quaternion().setFromUnitVectors(target, front);
    const startQ = globe.quaternion.clone();
    // if (targetQ.dot(startQ) < 0) targetQ.invert();
    const t0 = performance.now();
    const token = Symbol();
    globe._rotToken = token;
    (function step() {
      if (globe._rotToken !== token) return;
      const t = Math.min((performance.now() - t0) / 900, 1);
      const e = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      globe.quaternion.copy(startQ).slerp(targetQ, e);
      if (t < 1) requestAnimationFrame(step);
    })();
  }

  // ── Camera state configs ──────────────────────────────────────────────────
  const CAMERA_STATES = {
    landing:  { distance: 400, autoRotate: true,  autoRotateSpeed: 0.175, gameplay: false },
    lobby:    { distance: 230, autoRotate: true,  autoRotateSpeed: 0.075, gameplay: false },
    gameplay: { distance: 145, autoRotate: false, autoRotateSpeed: 0,    gameplay: true  },
  };

  // ── Pin system ───────────────────────────────────────────────────────────
  const PIN_COLORS = ['#f97316','#a855f7','#ec4899','#22d3ee','#fbbf24','#14b8a6','#f43f5e','#3b82f6'];
  const pinsMap = new Map();
  let myPinName = null;

  globe
    .pointsData([])
    .pointLat(d => d.lat).pointLng(d => d.lng)
    .pointColor(d => d.color)
    .pointRadius(d => d.past ? 0.3 : 0.5)
    .pointAltitude(d => d.past ? 0.01 : 0.025)
    .pointsMerge(false);

  globe
    .labelsData([])
    .labelLat(d => d.lat).labelLng(d => d.lng)
    .labelText(d => d.label)
    .labelColor(d => d.past ? 'rgba(255,255,255,0.4)' : '#ffffff')
    .labelSize(d => d.past ? 0.5 : 0.9)
    .labelAltitude(d => d.past ? 0.015 : 0.032)
    .labelResolution(2);

  function flushPins() {
    const points = [], labels = [];
    pinsMap.forEach(({ color, current, past }, name) => {
      past.forEach(p => {
        points.push({ lat: p.lat, lng: p.lng, color: color + '66', past: true });
        labels.push({ lat: p.lat, lng: p.lng, label: '·', past: true });
      });
      if (current) {
        points.push({ lat: current.lat, lng: current.lng,
                      color: current.locked ? '#ffffff' : color, past: false });
        labels.push({ lat: current.lat, lng: current.lng,
                      label: name[0].toUpperCase(), past: false });
      }
    });
    globe.pointsData(points);
    globe.labelsData(labels);
  }

  // ── Demo ─────────────────────────────────────────────────────────────────
  const DEMO_COUNTRIES = [
    'France','Brazil','Japan','Australia','Nigeria','Canada','India','Argentina',
    'Germany','Kenya','Mexico','Egypt','Indonesia','Norway','South Africa',
  ];

  // ── Public API ────────────────────────────────────────────────────────────
  const api = { onCountryClick: null, onPinPlace: null };

  api.load = async function(countriesUrl) {
    const [colData, topo] = await Promise.all([
      fetch('/api/country-colors').then(r => r.json()),
      fetch(countriesUrl).then(r => r.json()),
    ]);
    Object.assign(countryColors, colData);
    polygonFeatures = feature(topo, topo.objects.countries).features;

    globe
      .polygonsData(polygonFeatures)
      .polygonCapColor(capColor)
      .polygonSideColor(() => 'rgba(15, 33, 55, 0.6)')
      .polygonStrokeColor(() => '#1e4068')
      .polygonAltitude(0.006);

    // ── Click / hover detection via Three.js Raycaster ────────────────────
    const raycaster = new THREE.Raycaster();
    const mouse2d   = new THREE.Vector2();
    const GLOBE_RADIUS = 100;
    const globeSphere  = new THREE.Sphere(new THREE.Vector3(0, 0, 0), GLOBE_RADIUS);

    function screenToLatLng(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      mouse2d.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
      mouse2d.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse2d, camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectSphere(globeSphere, hit)) return null;
      // Transform world-space hit into the globe's local frame to account for
      // any rotation applied by flyToCountry (demo or highlight auto-spin).
      const local = globe.worldToLocal(hit.clone());
      const lat   = 90 - Math.acos(local.y / GLOBE_RADIUS) * 180 / Math.PI;
      const theta = Math.atan2(local.z, local.x);
      const lng   = 90 - theta * 180 / Math.PI - (theta < -Math.PI / 2 ? 360 : 0);
      return { lat, lng };
    }
    _screenToLatLng = screenToLatLng;

    function lngLatToFeature(lng, lat) {
      for (const f of polygonFeatures) {
        if (geoContains(f, [lng, lat])) return f;
      }
      return null;
    }

    let lastMouseDown = 0;
    canvas.addEventListener('mousedown', () => { lastMouseDown = Date.now(); });

    canvas.addEventListener('click', (event) => {
      // Suppress post-drag clicks
      if (Date.now() - lastMouseDown > 300) return;
      const ll = screenToLatLng(event.clientX, event.clientY);
      if (!ll) return;

      if (api.onCountryClick) {
        const feat = lngLatToFeature(ll.lng, ll.lat);
        if (feat) {
          const name = feat.properties && feat.properties.name;
          if (name) {
            api.setSelection(name);
            api.onCountryClick(name);
          }
        }
      } else if (api.onPinPlace) {
        api.onPinPlace(ll.lat, ll.lng);
      }
    });

    // Touch support
    canvas.addEventListener('touchend', (event) => {
      if (event.changedTouches.length !== 1) return;
      const t = event.changedTouches[0];
      const ll = screenToLatLng(t.clientX, t.clientY);
      if (!ll) return;
      if (api.onCountryClick) {
        const feat = lngLatToFeature(ll.lng, ll.lat);
        if (feat) {
          const name = feat.properties && feat.properties.name;
          if (name) { api.setSelection(name); api.onCountryClick(name); }
        }
      } else if (api.onPinPlace) {
        api.onPinPlace(ll.lat, ll.lng);
      }
    }, { passive: true });

    // Hover (desktop only)
    if (window.innerWidth >= 768) {
      canvas.addEventListener('mousemove', (event) => {
        const ll = screenToLatLng(event.clientX, event.clientY);
        if (!ll) { hoveredCountry = null; return; }
        const feat = lngLatToFeature(ll.lng, ll.lat);
        const name = feat && feat.properties && feat.properties.name;
        if (name === hoveredCountry) return;
        hoveredCountry = name;
        globe.polygonAltitude(f => {
          const n = f.properties && f.properties.name;
          return (n === hoveredCountry && n !== highlightedCountry) ? 0.055 : 0.006;
        });
      });
    }
  };

  api.resize = resize;

  api.transitionTo = function(stateName, onDone) {
    const cfg = CAMERA_STATES[stateName];
    if (!cfg) return;
    currentCameraState = stateName;
    controls.autoRotate      = cfg.autoRotate;
    controls.autoRotateSpeed = cfg.autoRotateSpeed;
    // Enable user interaction only in gameplay; landing/lobby run auto-rotate only
    controls.enabled    = cfg.gameplay;
    controls.enableZoom = cfg.gameplay;

    const startDist  = camera.position.length();
    const targetDist = cfg.distance;
    if (Math.abs(startDist - targetDist) < 2) {
      if (onDone) onDone();
      return;
    }
    cameraTransition = { startDist, targetDist, startTime: performance.now(), duration: 1200, cfg, onDone };
  };

  api.highlightCountry = function(name) {
    highlightedCountry = name;
    console.log("highlight:", name);
    selectedCountry    = null;
    refreshPolygonColors();
    flyToCountry(name);
  };

  api.clearHighlight = function() {
    console.trace('clearHighlight called');
    highlightedCountry = null;
    selectedCountry    = null;
    refreshPolygonColors();
  };

  api.setSelection = function(name) {
    selectedCountry = name;
    refreshPolygonColors();
  };

  api.setDraggable = function(enabled) {
    // Only affects rotate; zoom and master enabled are managed by transitionTo
    controls.enableRotate = enabled;
  };

  api.setZoomable = function(enabled) {
    controls.enableZoom = enabled;
  };

  api.setMyPinName = name => { myPinName = name; };

  api.placeMyPin = (lng, lat) => {
    const entry = pinsMap.get(myPinName) || { color: '#10b981', current: null, past: [] };
    entry.current = { lat, lng, locked: false };
    pinsMap.set(myPinName, entry);
    flushPins();
  };

  api.updateOtherPin = (name, lng, lat, colorIndex) => {
    const color = PIN_COLORS[colorIndex % PIN_COLORS.length];
    const entry = pinsMap.get(name) || { color, current: null, past: [] };
    entry.color   = color;
    entry.current = { lat, lng, locked: false };
    pinsMap.set(name, entry);
    flushPins();
  };

  api.lockPinMarker = name => {
    const entry = pinsMap.get(name);
    if (entry && entry.current) { entry.current.locked = true; flushPins(); }
  };

  api.clearAllPins = () => { pinsMap.clear(); flushPins(); };

  api.archivePins = () => {
    pinsMap.forEach(entry => {
      if (entry.current) {
        entry.past.push({ lat: entry.current.lat, lng: entry.current.lng });
        entry.current = null;
      }
    });
    flushPins();
  };

  // findCountryAtPoint stub — used by app.js for proximity scoring
  api.findCountryAtPoint = (lng, lat) => {
    // three-globe handles click detection; this is called for server-side logic
    // Return null — server computes distances independently
    return null;
  };

  api.stopLobbyDemo = function() {
    if (demoIntervalId) { clearInterval(demoIntervalId); demoIntervalId = null; }
    api.clearAllPins();
  };

  api.startLobbyDemo = function(mode) {
    api.stopLobbyDemo();

    function step() {
      api.clearAllPins();
      const name = DEMO_COUNTRIES[demoIndex % DEMO_COUNTRIES.length];
      demoIndex++;

      if (mode === 'highlight') {
        api.highlightCountry(name);
      } else if (mode === 'select') {
        flyToCountry(name);
        api.setSelection(name);
      } else {
        const feat = polygonFeatures.find(f => f.properties && f.properties.name === name);
        if (feat) {
          const [lng, lat] = geoCentroid(feat);
          api.updateOtherPin('demo',
            lng + (Math.random() - 0.5) * 20,
            lat + (Math.random() - 0.5) * 20,
            demoIndex % 8
          );
        }
        flyToCountry(name);
      }
    }

    step();
    demoIntervalId = setInterval(step, 5600);
  };

  return api;
}
