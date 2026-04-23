/**
 * Geo Challenge - D3.js Globe Module
 * Orthographic projection with highlighting, click detection, drag/zoom.
 * Supports polygon countries (TopoJSON) and point micro-countries (GeoJSON).
 */

function createGlobe(container) {
  let width = container.clientWidth || 600;
  let height = container.clientHeight || 500;
  let minDim = Math.min(width, height);
  let baseScale = minDim * 0.45;

  let svg, path, projection, g;
  let features = [];
  let microFeatures = [];
  let worldData = null;
  let draggable = false;
  let zoomable = false;
  let currentHighlight = null;
  let currentSelection = null;
  let onCountryClickCallback = null;
  let rotation = [0, 0];
  let currentScale = baseScale;
  let colorMap = {};

  const PIN_COLORS = ['#f97316','#a855f7','#ec4899','#06b6d4','#eab308','#14b8a6','#f43f5e','#8b5cf6'];
  const pins = new Map(); // name -> { lng, lat, color, locked }
  let myPinName = null;
  let gPins = null; // SVG group for pins
  let onPinPlaceCallback = null;
  let dragMoved = false;
  let dragEndTime = 0;

  function init() {
    container.innerHTML = '';
    width = container.clientWidth || 600;
    height = container.clientHeight || 500;
    minDim = Math.min(width, height);
    baseScale = minDim * 0.45;
    currentScale = baseScale;

    svg = d3.select(container)
      .append('svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .style('width', '100%')
      .style('height', '100%');

    projection = d3.geoOrthographic()
      .scale(currentScale)
      .translate([width / 2, height / 2])
      .clipAngle(90);

    path = d3.geoPath().projection(projection);

    // Ocean circle
    svg.append('defs').append('clipPath')
      .attr('id', 'globe-clip')
      .append('circle')
      .attr('cx', width / 2)
      .attr('cy', height / 2)
      .attr('r', currentScale);

    svg.append('circle')
      .attr('class', 'ocean')
      .attr('cx', width / 2)
      .attr('cy', height / 2)
      .attr('r', currentScale)
      .attr('fill', '#0b1220')
      .attr('stroke', '#334155')
      .attr('stroke-width', 1.5);

    g = svg.append('g')
      .attr('clip-path', 'url(#globe-clip)');

    setupInteractions();
    gPins = svg.append('g').attr('class', 'pins-layer');
  }

  function setupInteractions() {
    const drag = d3.drag()
      .filter(() => draggable)
      .on('start', () => { dragMoved = false; })
      .on('drag', (event) => {
        if (Math.abs(event.dx) > 0.5 || Math.abs(event.dy) > 0.5) dragMoved = true;
        const k = 0.25;
        rotation[0] += event.dx * k;
        rotation[1] -= event.dy * k;
        rotation[1] = Math.max(-90, Math.min(90, rotation[1]));
        projection.rotate(rotation);
        redraw();
      })
      .on('end', () => { dragEndTime = Date.now(); });

    const zoom = d3.zoom()
      .scaleExtent([baseScale * 0.6, baseScale * 2.5])
      .filter(event => {
        if (!zoomable) return false;
        // Wheel zoom always allowed
        if (event.type === 'wheel') return true;
        // On touch devices, only allow pinch (multi-touch) for zoom.
        // Single-finger drag should rotate the globe via drag behavior.
        if (event.type === 'touchstart') {
          return event.touches.length > 1;
        }
        // Reject pointer/mouse down so drag can handle rotation
        return false;
      })
      .on('zoom', (event) => {
        const newScale = event.transform.k;
        if (newScale === currentScale) return;
        currentScale = newScale;
        projection.scale(currentScale);
        svg.select('circle.ocean').attr('r', currentScale);
        svg.select('#globe-clip circle').attr('r', currentScale);
        redraw();
      });

    svg.call(zoom).call(drag)
      .on('click', handleClick);

    // Set initial zoom transform to match projection scale
    svg.call(zoom.transform, d3.zoomIdentity.scale(baseScale));
  }

  function redraw() {
    g.selectAll('path.country').attr('d', path);
    updateMicroCircles();
    updatePins();
  }

  function isPointVisible(coords) {
    const center = projection.invert([width / 2, height / 2]);
    if (!center) return false;
    return d3.geoDistance(coords, center) < Math.PI / 2;
  }

  function updateMicroCircles() {
    const r = Math.max(3, currentScale * 0.01);
    g.selectAll('circle.micro-country')
      .attr('cx', d => {
        const p = projection(d.geometry.coordinates);
        return p ? p[0] : -9999;
      })
      .attr('cy', d => {
        const p = projection(d.geometry.coordinates);
        return p ? p[1] : -9999;
      })
      .attr('r', r)
      .style('display', d => isPointVisible(d.geometry.coordinates) ? 'block' : 'none');
  }

  function updatePins() {
    if (!gPins) return;
    gPins.selectAll('.pin-marker').each(function(d) {
      const pin = pins.get(d.name);
      if (!pin) return;
      const p = projection([pin.lng, pin.lat]);
      if (!p) return;
      d3.select(this).attr('transform', `translate(${p[0]},${p[1]})`);
    });
  }

  function renderPin(name) {
    const pin = pins.get(name);
    if (!pin || !gPins) return;
    const p = projection([pin.lng, pin.lat]);
    if (!p) return;

    gPins.selectAll(`.pin-marker[data-name="${CSS.escape(name)}"]`).remove();

    const initial = name.charAt(0).toUpperCase();
    const grp = gPins.append('g')
      .attr('class', 'pin-marker' + (pin.locked ? ' locked' : ''))
      .attr('data-name', name)
      .attr('transform', `translate(${p[0]},${p[1]})`)
      .datum({ name });

    grp.append('circle').attr('r', 10).attr('fill', pin.color).attr('stroke', '#fff').attr('stroke-width', 2);
    grp.append('text').text(initial);
  }

  function placeMyPin(lng, lat) {
    if (!myPinName) return;
    pins.set(myPinName, { lng, lat, color: '#10b981', locked: false });
    renderPin(myPinName);
  }

  function updateOtherPin(name, lng, lat, colorIndex) {
    if (name === myPinName) return;
    const color = PIN_COLORS[colorIndex % PIN_COLORS.length];
    const existing = pins.get(name) || {};
    pins.set(name, { lng, lat, color, locked: existing.locked || false });
    renderPin(name);
  }

  function lockPinMarker(name) {
    const pin = pins.get(name);
    if (!pin) return;
    pin.locked = true;
    const el = gPins.select(`.pin-marker[data-name="${CSS.escape(name)}"]`);
    el.classed('locked', true);
  }

  function clearAllPins() {
    pins.clear();
    myPinName = null;
    if (gPins) gPins.selectAll('.pin-marker').remove();
  }

  function findCountryAtPoint(lng, lat) {
    for (const f of features) {
      if (d3.geoContains(f, [lng, lat])) return f.properties.name;
    }
    return null;
  }

  function baseColor(name) {
    return colorMap[name] || '#1e293b';
  }

  function handleClick(event) {
    if (!worldData) return;
    // Suppress post-drag clicks (mobile browsers synthesize click after touchend)
    if (dragMoved && (Date.now() - dragEndTime) < 400) return;
    const [mx, my] = d3.pointer(event, svg.node());
    const coords = projection.invert([mx, my]);
    if (!coords) return;

    if (onCountryClickCallback) {
      // select mode: find country under click
      let found = null;
      for (const f of features) {
        if (d3.geoContains(f, coords)) { found = f; break; }
      }
      if (!found) {
        let best = null, bestDist = Infinity;
        for (const f of microFeatures) {
          const p = projection(f.geometry.coordinates);
          if (!p) continue;
          const dx = p[0] - mx, dy = p[1] - my;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 12 && dist < bestDist) { bestDist = dist; best = f; }
        }
        found = best;
      }
      if (found) {
        const name = found.properties.name;
        setSelection(name);
        onCountryClickCallback(name);
      }
    } else if (myPinName) {
      // proximity mode: place pin at clicked coordinates
      const [lng, lat] = coords;
      placeMyPin(lng, lat);
      if (onPinPlaceCallback) onPinPlaceCallback(lat, lng);
    }
  }

  function load(url) {
    init();

    const colorPromise = d3.json('/api/country-colors').then(data => {
      colorMap = data || {};
    }).catch(() => {
      colorMap = {};
    });

    const topoPromise = d3.json(url).then(data => {
      worldData = data;
      features = topojson.feature(data, data.objects.countries).features;

      g.selectAll('path.country')
        .data(features)
        .enter()
        .append('path')
        .attr('class', 'country')
        .attr('d', path)
        .attr('fill', d => baseColor(d.properties.name))
        .attr('stroke', '#64748b')
        .attr('stroke-width', 0.5)
        .on('mouseover', function(event, d) {
          if (draggable) d3.select(this).attr('fill', '#334155');
        })
        .on('mouseout', function(event, d) {
          if (draggable && d3.select(this).attr('data-state') !== 'selected') {
            d3.select(this).attr('fill', baseColor(d.properties.name));
          }
        });
    });

    const microPromise = d3.json('/data/micro-countries.json').then(data => {
      microFeatures = data.features || [];
      const r = Math.max(3, currentScale * 0.01);

      g.selectAll('circle.micro-country')
        .data(microFeatures)
        .enter()
        .append('circle')
        .attr('class', 'micro-country')
        .attr('cx', d => {
          const p = projection(d.geometry.coordinates);
          return p ? p[0] : -9999;
        })
        .attr('cy', d => {
          const p = projection(d.geometry.coordinates);
          return p ? p[1] : -9999;
        })
        .attr('r', r)
        .attr('fill', d => baseColor(d.properties.name))
        .attr('stroke', '#64748b')
        .attr('stroke-width', 1)
        .style('pointer-events', 'none')
        .style('display', d => isPointVisible(d.geometry.coordinates) ? 'block' : 'none')
        .on('mouseover', function(event, d) {
          if (draggable) d3.select(this).attr('fill', '#334155');
        })
        .on('mouseout', function(event, d) {
          if (draggable && d3.select(this).attr('data-state') !== 'selected') {
            d3.select(this).attr('fill', baseColor(d.properties.name));
          }
        });
    });

    return Promise.all([colorPromise, topoPromise, microPromise]);
  }

  function getFeatureCoords(name) {
    const f = features.find(c => c.properties.name === name);
    if (f) return d3.geoCentroid(f);
    const m = microFeatures.find(c => c.properties.name === name);
    if (m) return m.geometry.coordinates;
    return null;
  }

  function highlightCountry(name) {
    clearHighlight();
    currentHighlight = name;
    applyStyle(name, '#3b82f6', '#ffffff', 1, 'highlight');

    const coords = getFeatureCoords(name);
    if (coords) {
      const targetRotation = [-coords[0], -coords[1]];
      svg.transition()
        .duration(1000)
        .tween('rotate', () => {
          const r = d3.interpolate(rotation, targetRotation);
          return t => {
            rotation = r(t);
            projection.rotate(rotation);
            redraw();
          };
        });
    }
  }

  function setSelection(name) {
    if (currentSelection && currentSelection !== name) {
      applyStyle(currentSelection, baseColor(currentSelection), '#64748b', 0.5, null);
    }
    currentSelection = name;
    applyStyle(name, '#10b981', '#ffffff', 1, 'selected');
  }

  function applyStyle(name, fill, stroke, strokeWidth, state) {
    // Polygon country
    const sel = g.selectAll('path.country').filter(d => d.properties.name === name);
    sel.attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', strokeWidth)
      .attr('data-state', state)
      .raise();

    // Micro-country circle
    const micro = g.selectAll('circle.micro-country').filter(d => d.properties.name === name);
    micro.attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', strokeWidth)
      .attr('data-state', state)
      .raise();
  }

  function clearHighlight() {
    currentHighlight = null;
    currentSelection = null;
    g.selectAll('path.country')
      .attr('fill', d => baseColor(d.properties.name))
      .attr('stroke', '#64748b')
      .attr('stroke-width', 0.5)
      .attr('data-state', null);

    g.selectAll('circle.micro-country')
      .attr('fill', d => baseColor(d.properties.name))
      .attr('stroke', '#64748b')
      .attr('stroke-width', 1)
      .attr('data-state', null);
  }

  function setDraggable(enabled) {
    draggable = enabled;
    updateCursor();
  }

  function setZoomable(enabled) {
    zoomable = enabled;
    updateCursor();
  }

  function updateCursor() {
    const interactive = draggable || zoomable;
    svg.style('cursor', interactive ? 'grab' : 'default');
  }

  return {
    load,
    highlightCountry,
    clearHighlight,
    setDraggable,
    setZoomable,
    findCountryAtPoint,
    placeMyPin,
    updateOtherPin,
    lockPinMarker,
    clearAllPins,
    setMyPinName(name) { myPinName = name; },
    set onCountryClick(fn) { onCountryClickCallback = fn; },
    set onPinPlace(fn) { onPinPlaceCallback = fn; },
  };
}
