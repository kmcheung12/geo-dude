import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import ThreeGlobe from 'three-globe';
import { feature } from 'topojson-client';
import { geoCentroid, geoContains } from 'd3-geo';

export function createGlobe(canvas) {
  // ── Settings ─────────────────────────────────────────────────────────────
  // All tunable constants live here. The debug GUI (enabled via #debug in URL)
  // mutates these values and calls the appropriate rebuild/refresh function.
  const settings = {
    globe: {
      starCount:          2000,
      starColor:          '#ffffff',
      starSize:           1.2,
      cloudRadius:        103,
      cloudColor:         '#ffffff',
      cloudOpacity:       0.12,
      cloudRotationSpeed: 0.00025,
      birdCountMobile:    4,
      birdCountDesktop:   9,
      birdColor:          '#d4eeff',
    },
    country: {
      highlightedCountryColor: '#f97316',
      selectedCountryColor:    '#22d3ee',
      fallbackCountryColor:    '#1a3450',
      defaultAltitude: 0.006,
      hoverAltitude: 0.055,
    },
    pins: {
      pastPinRadius:           0.3,
      currentPinRadius:        0.5,
      pastPinAltitude:         0.01,
      currentPinAltitude:      0.025,
      pastPinLabelColor:       '#ffffff',
      pastPinLabelOpacity:     0.4,   // separate because lil-gui colour pickers don't handle rgba strings
      currentPinLabelColor:    '#ffffff',
      pastPinLabelAltitude:    0.015,
      currentPinLabelAltitude: 0.032,
      pastPinLabelSize:        0.5,
      currentPinLabelSize:     0.9,
    },
  };

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
  // buildStars() disposes the previous Points mesh (geometry + material) before
  // creating a new one, preventing GPU memory leaks on repeated GUI rebuilds.
  // Stars already use a single BufferGeometry for all points — no per-star objects.
  let starsMesh = null;
  function buildStars() {
    if (starsMesh) {
      scene.remove(starsMesh);
      starsMesh.geometry.dispose();
      starsMesh.material.dispose();
    }
    const positions = [];
    for (let i = 0; i < settings.globe.starCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 800 + Math.random() * 200;
      positions.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    starsMesh = new THREE.Points(geo, new THREE.PointsMaterial({
      color: settings.globe.starColor,
      size:  settings.globe.starSize,
    }));
    scene.add(starsMesh);
  }
  buildStars();

  // ── Globe (three-globe) ──────────────────────────────────────────────────
  const globe = new ThreeGlobe()
    .showAtmosphere(true)
    .atmosphereColor('#22d3ee')
    .atmosphereAltitude(0.35);
  scene.add(globe);

  // ── Clouds ────────────────────────────────────────────────────────────────
  // buildClouds() is needed for radius changes (new SphereGeometry). Colour and
  // opacity can be updated directly on the material without rebuilding.
  let clouds = null;
  function buildClouds() {
    if (clouds) {
      scene.remove(clouds);
      clouds.geometry.dispose();
      clouds.material.dispose();
    }
    clouds = new THREE.Mesh(
      new THREE.SphereGeometry(settings.globe.cloudRadius, 48, 48),
      new THREE.MeshPhongMaterial({
        color:       settings.globe.cloudColor,
        transparent: true,
        opacity:     settings.globe.cloudOpacity,
        depthWrite:  false,
      })
    );
    scene.add(clouds);
  }
  buildClouds();

  // ── Birds ────────────────────────────────────────────────────────────────
  // All bird meshes share one ConeGeometry and one MeshBasicMaterial.
  // buildBirds() mutates the birds[] array in-place so the animate() closure
  // always references the live contents without needing a reference swap.
  // Colour changes only need birdMat.color.set() — no rebuild required.
  // Count changes (mobile/desktop) require a full rebuild via buildBirds().
  const birds = [];
  let birdGeo = null;
  let birdMat = null;

  function buildBirds() {
    birds.forEach(b => scene.remove(b.mesh));
    birds.length = 0;
    if (birdGeo) { birdGeo.dispose(); birdGeo = null; }
    if (birdMat) { birdMat.dispose(); birdMat = null; }

    const count = window.innerWidth < 768
      ? settings.globe.birdCountMobile
      : settings.globe.birdCountDesktop;
    birdGeo = new THREE.ConeGeometry(0.7, 1.8, 4);
    birdMat = new THREE.MeshBasicMaterial({
      color:       settings.globe.birdColor,
      transparent: true,
      opacity:     0.55,
    });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(birdGeo, birdMat);
      const axis = new THREE.Vector3(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).normalize();
      birds.push({ mesh, axis, angle: Math.random() * Math.PI * 2, speed: 0.004 + Math.random() * 0.003 });
      scene.add(mesh);
    }
  }
  buildBirds();

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

  // Set globe orientation to show (lat, lng) at the canvas centre, north always up.
  // Lat is clamped to [-89.9, 89.9] to prevent flipping past the poles.
  function setGlobeOrientation(lat, lng) {
    viewLat = Math.max(-89.9, Math.min(89.9, lat));
    viewLng = ((lng + 180) % 360 + 360) % 360 - 180;  // normalise to [-180, 180]
    globe.quaternion.setFromEuler(
      new THREE.Euler(viewLat * Math.PI / 180, -viewLng * Math.PI / 180, 0, 'YXZ')
    );
  }

  // Convert a 6-digit hex colour string to an rgba() string.
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let polygonFeatures  = [];
  let countryColors    = {};
  let highlightedCountry = null;
  let selectedCountry    = null;
  let hoveredCountry     = null;
  let _screenToLatLng    = null;   // set by api.load once canvas is ready
  let cameraTransition   = null;
  let viewLat         = 0;    // latitude  of the globe point facing the camera
  let viewLng         = 0;    // longitude of the globe point facing the camera
  let draggingEnabled = false;
  let currentCameraState = 'landing';
  let demoIntervalId     = null;
  let demoIndex          = 0;

  // ── Test hook ─────────────────────────────────────────────────────────────
  window.__globeState = {
    get cameraDistance()     { return camera.position.length(); },
    get draggable()          { return draggingEnabled; },
    get zoomable()           { return controls.enableZoom; },
    get highlightedCountry() { return highlightedCountry; },
    get selectedCountry()    { return selectedCountry; },
    get hoveredCountry()     { return hoveredCountry; },
    get cameraTransitioning(){ return cameraTransition !== null; },
    flyToCountry(name)       { flyToCountry(name); },
    rotateToLatLng(lat, lng) {
      globe._rotToken = Symbol();
      cameraTransition = null;
      controls.enabled = false;
      camera.position.set(0, 0, CAMERA_STATES.gameplay.distance);
      setGlobeOrientation(lat, lng);
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
      const { startDist, targetDist, startDir, targetDir, startTime, duration, cfg, onDone } = cameraTransition;
      const t    = Math.min((performance.now() - startTime) / duration, 1);
      const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      const dist = startDist + (targetDist - startDist) * ease;
      if (targetDir) {
        // Ease camera direction toward targetDir (gameplay: +Z) while changing distance
        camera.position.copy(startDir.clone().lerp(targetDir, ease).normalize()).multiplyScalar(dist);
      } else {
        camera.position.setLength(dist);
      }
      if (t >= 1) {
        camera.position.setLength(targetDist);
        cameraTransition = null;
        if (onDone) onDone();
      }
    }

    if (clouds) clouds.rotation.y += settings.globe.cloudRotationSpeed;

    birds.forEach(b => {
      b.angle += b.speed;
      const pos = new THREE.Vector3(107, 0, 0).applyAxisAngle(b.axis, b.angle);
      b.mesh.position.copy(pos);
      b.mesh.lookAt(new THREE.Vector3(107, 0, 0).applyAxisAngle(b.axis, b.angle + 0.02));
    });

    controls.update();
    globe.setPointOfView(camera);
    renderer.render(scene, camera);
  }
  animate();

  // ── Country colour function ───────────────────────────────────────────────
  function capColor(feat) {
    const name = feat.properties && feat.properties.name;
    if (name === highlightedCountry) return settings.country.highlightedCountryColor;
    if (name === selectedCountry)    return settings.country.selectedCountryColor;
    return countryColors[name] || settings.country.fallbackCountryColor;
  }

  function refreshPolygonColors() {
    console.log('refresh hl=', highlightedCountry);
    globe.polygonCapColor(f => capColor(f)).polygonsData([...polygonFeatures]);
  }

  // ── flyToCountry ──────────────────────────────────────────────────────────
  function flyToCountry(name) {
    const feat = polygonFeatures.find(f => f.properties && f.properties.name === name);
    if (!feat) return;
    const [lng, lat] = geoCentroid(feat);
    const startLat = viewLat, startLng = viewLng;
    // Take the short way around the longitude circle
    let dLng = lng - startLng;
    if (dLng > 180) dLng -= 360;
    if (dLng < -180) dLng += 360;
    const t0 = performance.now();
    const token = Symbol();
    globe._rotToken = token;
    (function step() {
      if (globe._rotToken !== token) return;
      const t = Math.min((performance.now() - t0) / 900, 1);
      const e = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;
      setGlobeOrientation(startLat + (lat - startLat) * e, startLng + dLng * e);
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
    .pointRadius(d => d.past ? settings.pins.pastPinRadius : settings.pins.currentPinRadius)
    .pointAltitude(d => d.past ? settings.pins.pastPinAltitude : settings.pins.currentPinAltitude)
    .pointsMerge(false);

  globe
    .labelsData([])
    .labelLat(d => d.lat).labelLng(d => d.lng)
    .labelText(d => d.label)
    .labelColor(d => d.past
      ? hexToRgba(settings.pins.pastPinLabelColor, settings.pins.pastPinLabelOpacity)
      : settings.pins.currentPinLabelColor)
    .labelSize(d => d.past ? settings.pins.pastPinLabelSize : settings.pins.currentPinLabelSize)
    .labelAltitude(d => d.past ? settings.pins.pastPinLabelAltitude : settings.pins.currentPinLabelAltitude)
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

  // ── Globe drag (constrained to lat/lng, no roll, no past-pole) ───────────
  controls.enableRotate = false;   // OrbitControls handles zoom only
  let isDragging    = false;
  let touchDragMoved = false;      // true when a touch drag has moved > threshold
  let dragStartX = 0, dragStartY = 0, dragStartLat = 0, dragStartLng = 0;

  function dragStart(clientX, clientY) {
    isDragging = true;
    touchDragMoved = false;
    dragStartX = clientX; dragStartY = clientY;
    dragStartLat = viewLat; dragStartLng = viewLng;
  }
  function dragMove(clientX, clientY) {
    if (!isDragging || !draggingEnabled) return;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) touchDragMoved = true;
    // degrees-per-pixel: camera FOV spread over canvas height, scaled by zoom distance
    const scale = (camera.fov / canvas.clientHeight) * (camera.position.length() / 100);
    globe._rotToken = Symbol();   // cancel any in-flight flyToCountry
    setGlobeOrientation(dragStartLat + dy * scale, dragStartLng - dx * scale);
  }
  function dragEnd() { isDragging = false; }

  canvas.addEventListener('mousedown',  e => { if (draggingEnabled) dragStart(e.clientX, e.clientY); });
  canvas.addEventListener('mousemove',  e => dragMove(e.clientX, e.clientY));
  window.addEventListener('mouseup',    dragEnd);
  canvas.addEventListener('touchstart', e => {
    if (draggingEnabled && e.touches.length === 1) dragStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  canvas.addEventListener('touchmove',  e => {
    if (e.touches.length === 1) dragMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  canvas.addEventListener('touchend', dragEnd, { passive: true });

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
      .polygonAltitude(settings.country.defaultAltitude);

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
      if (touchDragMoved) return;   // suppress tap after a drag
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
          return (n === hoveredCountry && n !== highlightedCountry) ? settings.country.hoverAltitude: settings.country.defaultAltitude;
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
    // For gameplay, reset globe to default orientation and cancel any fly animations
    // so the Euler drag system is aligned and country clicks are predictable.
    if (cfg.gameplay) {
      globe._rotToken = Symbol();
      setGlobeOrientation(0, 0);
    }
    const startDir  = camera.position.clone().normalize();
    const targetDir = cfg.gameplay ? new THREE.Vector3(0, 0, 1) : null;
    cameraTransition = { startDist, targetDist, startDir, targetDir, startTime: performance.now(), duration: 1200, cfg, onDone };
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
    draggingEnabled = enabled;
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

  // ── Debug GUI (enabled via #debug in URL hash) ────────────────────────────
  if (window.location.hash.includes('debug')) {
    import('lil-gui').then(({ GUI }) => {
      const gui = new GUI({ title: 'Globe Debug' });

      // ── Globe ─────────────────────────────────────────────────────────────
      const globeF = gui.addFolder('Globe');
      // starCount requires a full rebuild (new BufferGeometry + randomised positions)
      globeF.add(settings.globe, 'starCount', 100, 5000, 1).name('Star Count')
        .onFinishChange(buildStars);
      // starColor/starSize can update the live material without a rebuild
      globeF.addColor(settings.globe, 'starColor').name('Star Color')
        .onChange(() => { if (starsMesh) starsMesh.material.color.set(settings.globe.starColor); });
      globeF.add(settings.globe, 'starSize', 0.1, 5).name('Star Size')
        .onChange(() => { if (starsMesh) starsMesh.material.size = settings.globe.starSize; });
      // cloudRadius requires new SphereGeometry; colour/opacity update the material live
      globeF.add(settings.globe, 'cloudRadius', 100, 115, 0.5).name('Cloud Radius')
        .onFinishChange(buildClouds);
      globeF.addColor(settings.globe, 'cloudColor').name('Cloud Color')
        .onChange(() => { if (clouds) clouds.material.color.set(settings.globe.cloudColor); });
      globeF.add(settings.globe, 'cloudOpacity', 0, 1).name('Cloud Opacity')
        .onChange(() => { if (clouds) clouds.material.opacity = settings.globe.cloudOpacity; });
      globeF.add(settings.globe, 'cloudRotationSpeed', 0, 0.002).name('Cloud Rotation Speed');
      // birdCount changes require a rebuild; birdColor updates the shared material live
      globeF.add(settings.globe, 'birdCountMobile', 0, 20, 1).name('Bird Count (Mobile)')
        .onFinishChange(buildBirds);
      globeF.add(settings.globe, 'birdCountDesktop', 0, 30, 1).name('Bird Count (Desktop)')
        .onFinishChange(buildBirds);
      globeF.addColor(settings.globe, 'birdColor').name('Bird Color')
        .onChange(() => { if (birdMat) birdMat.color.set(settings.globe.birdColor); });

      // ── Country ───────────────────────────────────────────────────────────
      const countryF = gui.addFolder('Country');
      countryF.addColor(settings.country, 'highlightedCountryColor').name('Highlighted')
        .onChange(refreshPolygonColors);
      countryF.addColor(settings.country, 'selectedCountryColor').name('Selected')
        .onChange(refreshPolygonColors);
      countryF.addColor(settings.country, 'fallbackCountryColor').name('Fallback')
        .onChange(refreshPolygonColors);
      countryF.add(settings.country, 'defaultAltitude', 0.001, 0.1, 0.001)
        .onChange(refreshPolygonColors);
      countryF.add(settings.country, 'hoverAltitude', 0.01, 0.1, 0.01)
        .onChange(refreshPolygonColors);

      // ── Pins ──────────────────────────────────────────────────────────────
      const pinF = gui.addFolder('Pins');
      pinF.add(settings.pins, 'pastPinRadius', 0.1, 1).name('Past Pin Radius')
        .onChange(flushPins);
      pinF.add(settings.pins, 'currentPinRadius', 0.1, 1).name('Current Pin Radius')
        .onChange(flushPins);
      pinF.add(settings.pins, 'pastPinAltitude', 0, 0.1).name('Past Pin Altitude')
        .onChange(flushPins);
      pinF.add(settings.pins, 'currentPinAltitude', 0, 0.1).name('Current Pin Altitude')
        .onChange(flushPins);
      pinF.addColor(settings.pins, 'pastPinLabelColor').name('Past Label Color')
        .onChange(flushPins);
      pinF.add(settings.pins, 'pastPinLabelOpacity', 0, 1).name('Past Label Opacity')
        .onChange(flushPins);
      pinF.addColor(settings.pins, 'currentPinLabelColor').name('Current Label Color')
        .onChange(flushPins);
      pinF.add(settings.pins, 'pastPinLabelAltitude', 0, 0.1).name('Past Label Altitude')
        .onChange(flushPins);
      pinF.add(settings.pins, 'currentPinLabelAltitude', 0, 0.1).name('Current Label Altitude')
        .onChange(flushPins);
      pinF.add(settings.pins, 'pastPinLabelSize', 0.1, 2).name('Past Label Size')
        .onChange(flushPins);
      pinF.add(settings.pins, 'currentPinLabelSize', 0.1, 2).name('Current Label Size')
        .onChange(flushPins);
    });
  }

  return api;
}
