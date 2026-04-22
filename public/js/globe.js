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
      .attr('cx', width / 2)
      .attr('cy', height / 2)
      .attr('r', currentScale)
      .attr('fill', '#0b1220')
      .attr('stroke', '#334155')
      .attr('stroke-width', 1.5);

    g = svg.append('g')
      .attr('clip-path', 'url(#globe-clip)');

    setupInteractions();
  }

  function setupInteractions() {
    const drag = d3.drag()
      .on('drag', (event) => {
        if (!draggable) return;
        const k = 0.25;
        rotation[0] += event.dx * k;
        rotation[1] -= event.dy * k;
        rotation[1] = Math.max(-90, Math.min(90, rotation[1]));
        projection.rotate(rotation);
        redraw();
      });

    const zoom = d3.zoom()
      .scaleExtent([baseScale * 0.6, baseScale * 2.5])
      .on('zoom', (event) => {
        if (!zoomable) return;
        const newScale = event.transform.k;
        if (newScale === currentScale) return;
        currentScale = newScale;
        projection.scale(currentScale);
        svg.select('circle').attr('r', currentScale);
        svg.select('#globe-clip circle').attr('r', currentScale);
        redraw();
      });

    svg.call(drag).call(zoom)
      .on('click', handleClick);

    // Set initial zoom transform to match projection scale
    svg.call(zoom.transform, d3.zoomIdentity.scale(baseScale));
  }

  function redraw() {
    g.selectAll('path.country').attr('d', path);
    updateMicroCircles();
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

  function baseColor(name) {
    return colorMap[name] || '#1e293b';
  }

  function handleClick(event) {
    if (!draggable || !worldData) return;
    const [mx, my] = d3.pointer(event, svg.node());
    const coords = projection.invert([mx, my]);
    if (!coords) return;

    // Check polygon countries first
    let found = null;
    for (const f of features) {
      if (d3.geoContains(f, coords)) {
        found = f;
        break;
      }
    }

    if (!found) {
      // Check micro-countries by projected proximity
      let best = null;
      let bestDist = Infinity;
      const threshold = 12;
      for (const f of microFeatures) {
        const p = projection(f.geometry.coordinates);
        if (!p) continue;
        const dx = p[0] - mx;
        const dy = p[1] - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < threshold && dist < bestDist) {
          bestDist = dist;
          best = f;
        }
      }
      found = best;
    }

    if (found && onCountryClickCallback) {
      const name = found.properties.name;
      setSelection(name);
      onCountryClickCallback(name);
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
    set onCountryClick(fn) { onCountryClickCallback = fn; },
  };
}
