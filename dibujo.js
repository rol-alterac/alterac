// ═══════════════════════════════════════════════
//   HERRAMIENTAS DE DIBUJO — POLÍGONOS
// ═══════════════════════════════════════════════

import { collection, addDoc, deleteDoc, doc, getDocs, updateDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const COLOR_BORDE      = '#ff5050';
const OPACIDAD_RELLENO = 0.35;
const TAMANO_VERTICE   = 12;
const UMBRAL_CIERRE    = 20;
const PASOS_SUAVIDAD   = 20;

const iconoVertice = L.divIcon({
  className: 'vertex-icon',
  iconSize: [TAMANO_VERTICE, TAMANO_VERTICE],
  iconAnchor: [TAMANO_VERTICE / 2, TAMANO_VERTICE / 2],
  html: '<div class="vertex-dot"></div>',
});

let modoPintarActivo  = false;
let herramientaActiva = 'dibujar';
let poligonos         = [];
let dibujando         = false;
let puntosTemp        = [];
let lineaTemp         = null;
let circulosTemp      = [];
let poligonoEditando  = null;

const grupoDibujo = L.layerGroup();
const COLECCION   = 'dibujos';

function mapa() { return window.mapa; }

function init() {
  const m = mapa();
  if (!m) { setTimeout(init, 100); return; }
  grupoDibujo.addTo(m);
  cargarPoligonos();
}

// ═══════════════════════════════════════════════
//  FIRESTORE
// ═══════════════════════════════════════════════

async function guardarPoligono(data) {
  try {
    const docRef = await addDoc(collection(window.db, COLECCION), {
      originales: data.originales.map(ll => [ll.lat, ll.lng]),
      region: window.regionActiva || 'alterac',
      createdAt: new Date().toISOString(),
      estilo: data.estilo,
      autor: (window.usuarioActual && (window.usuarioActual.displayName || window.usuarioActual.email)) || 'anónimo',
    });
    data.firestoreId = docRef.id;
  } catch (e) { console.error('Error guardando polígono:', e); }
}

async function borrarPoligonoFirestore(id) {
  try { await deleteDoc(doc(window.db, COLECCION, id)); }
  catch (e) { console.error('Error borrando polígono:', e); }
}

async function cargarPoligonos() {
  try {
    const snapshot = await getDocs(collection(window.db, COLECCION));
    snapshot.forEach(d => {
      const datos = d.data();
      const origs = (datos.originales || datos.latlngs || []).map(
        ([lat, lng]) => L.latLng(lat, lng)
      );
      if (origs.length >= 3) crearPoligonoDesdeDatos(origs, d.id, datos.estilo, datos.region);
    });
  } catch (e) { console.error('Error cargando polígonos:', e); }
}

async function guardarActualizacion(data) {
  if (!data.firestoreId) return;
  const obj = { originales: data.originales.map(ll => [ll.lat, ll.lng]) };
  if (data.estilo) obj.estilo = data.estilo;
  obj.updatedAt = new Date().toISOString();
  try { await updateDoc(doc(window.db, COLECCION, data.firestoreId), obj); }
  catch (e) { console.error('Error actualizando polígono:', e); }
}

// ═══════════════════════════════════════════════
//  CATMULL-ROM
// ═══════════════════════════════════════════════

function suavizarPoligono(puntos, pasos) {
  if (puntos.length < 3) return puntos;
  const n = puntos.length;
  const salida = [];
  for (let i = 0; i < n; i++) {
    const p0 = puntos[(i - 1 + n) % n], p1 = puntos[i];
    const p2 = puntos[(i + 1) % n], p3 = puntos[(i + 2) % n];
    for (let j = 0; j < pasos; j++) {
      const t = j / pasos;
      salida.push(L.latLng(
        catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, t),
        catmullRom(p0.lng, p1.lng, p2.lng, p3.lng, t)
      ));
    }
  }
  salida.push(salida[0]);
  return salida;
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// ═══════════════════════════════════════════════
//  ESTILOS POR DEFECTO
// ═══════════════════════════════════════════════

const ESTILO_DEFECTO = {
  lineWeight: 4,
  lineDash: 'solid',
  lineColor: '#ff5050',
  fillColor: '#ff5050',
  fillOpacity: 0.35,
  fillType: 'solid',
};

// ═══════════════════════════════════════════════
//  UI
// ═══════════════════════════════════════════════

window.activarModoPintar = function() {
  if (!window.usuarioActual) { alert('Debes iniciar sesión para crear áreas.'); return; }
  modoPintarActivo = !modoPintarActivo;
  const tools = document.getElementById('herramientas-dibujo');
  const pincelBtn = document.querySelector('.btn-pintar-area');

  if (modoPintarActivo) {
    tools.classList.remove('oculto');
    if (pincelBtn) pincelBtn.classList.add('activo');
    // Activar Áreas al pintar
    if (!window.mostrarAreas) {
      window.mostrarAreas = true;
      const btnAreas = document.querySelector('.capa-fila-areas .btn-capa');
      if (btnAreas) { btnAreas.classList.add('activo'); btnAreas.classList.remove('inactivo'); }
      if (window.actualizarVisibilidadPoligonos) window.actualizarVisibilidadPoligonos();
    }
    document.body.style.cursor = 'crosshair';
    mapa().on('click', onMapClick);
    mostrarVertices();
  } else {
    tools.classList.add('oculto');
    if (pincelBtn) pincelBtn.classList.remove('activo');
    document.body.style.cursor = '';
    mapa().off('click', onMapClick);
    cancelarDibujo();
    ocultarVertices();
    poligonoEditando = null;
    if (!gid('modal-estilo').classList.contains('oculto')) cerrarModalEstilo();
  }
};

window.seleccionarHerramienta = function(h) {
  herramientaActiva = h;
  const btns = ['btn-dibujar', 'btn-borrar', 'btn-estilo'];
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('activo', id === 'btn-' + h);
  });
  document.body.style.cursor = h === 'borrar' ? 'pointer' : h === 'estilo' ? 'pointer' : 'crosshair';
  cancelarDibujo();
  poligonoEditando = null;
  if (h === 'dibujar') mostrarVertices();
  else ocultarVertices();
};

// ═══════════════════════════════════════════════
//  Dibujo temporal
// ═══════════════════════════════════════════════

function cancelarDibujo() {
  if (lineaTemp)  { grupoDibujo.removeLayer(lineaTemp);  lineaTemp = null; }
  circulosTemp.forEach(c => grupoDibujo.removeLayer(c));
  circulosTemp = []; puntosTemp = []; dibujando = false;
}

function actualizarTemp() {
  if (puntosTemp.length >= 2) {
    if (!lineaTemp) {
      lineaTemp = L.polyline(puntosTemp, { color: COLOR_BORDE, weight: 4, dashArray: '8, 6' });
      grupoDibujo.addLayer(lineaTemp);
    } else { lineaTemp.setLatLngs(puntosTemp); }
  }
  while (circulosTemp.length < puntosTemp.length) {
    const idx = circulosTemp.length;
    const c = L.marker(puntosTemp[idx], {
      icon: L.divIcon({ className: 'vertex-icon-temp', iconSize: [10, 10], iconAnchor: [5, 5], html: '<div class="vertex-dot-temp"></div>' }),
    });
    circulosTemp.push(c); grupoDibujo.addLayer(c);
  }
  while (circulosTemp.length > puntosTemp.length) {
    const c = circulosTemp.pop(); grupoDibujo.removeLayer(c);
  }
  circulosTemp.forEach((c, i) => c.setLatLng(puntosTemp[i]));
}

// ═══════════════════════════════════════════════
//  Eventos del mapa
// ═══════════════════════════════════════════════

function onMapClick(e) {
  if (herramientaActiva === 'borrar') {
    for (let i = poligonos.length - 1; i >= 0; i--) {
      const p = poligonos[i];
      if (puntoEnPoligono(e.latlng, p.polygon.getLatLngs()[0])) {
        grupoDibujo.removeLayer(p.polygon);
        p.vertices.forEach(v => grupoDibujo.removeLayer(v));
        if (p.firestoreId) borrarPoligonoFirestore(p.firestoreId);
        poligonos.splice(i, 1);
        return;
      }
    }
    return;
  }

  if (herramientaActiva === 'estilo') {
    for (const p of poligonos) {
      if (puntoEnPoligono(e.latlng, p.polygon.getLatLngs()[0])) {
        poligonoEditando = p;
        abrirModalEstilo(p);
        return;
      }
    }
    return;
  }

  const ll = e.latlng;
  if (puntosTemp.length >= 3) {
    const p1 = mapa().latLngToContainerPoint(puntosTemp[0]);
    if (p1.distanceTo(e.containerPoint) < UMBRAL_CIERRE) { cerrarPoligono(); return; }
  }
  puntosTemp.push(ll);
  dibujando = true;
  actualizarTemp();
}

// ═══════════════════════════════════════════════
//  Polígonos
// ═══════════════════════════════════════════════

function estiloPoly(opts) {
  const e = Object.assign({}, ESTILO_DEFECTO, opts || {});
  const s = { color: e.lineColor, weight: e.lineWeight, opacity: 1 };
  if (e.lineDash === 'dashed') s.dashArray = '10, 8';
  else if (e.lineDash === 'dotted') s.dashArray = '3, 5';
  if (e.fillType === 'none') { s.fill = false; }
  else if (e.fillType === 'hatch') {
    s.fillColor = urlHatch(e);
    s.fillOpacity = e.fillOpacity;
    s.fill = true;
  } else {
    s.fillColor = e.fillColor;
    s.fillOpacity = e.fillOpacity;
    s.fill = true;
  }
  return s;
}

function urlHatch(data) {
  const id = 'hatch-' + (data.id || data.firestoreId || Math.random().toString(36).slice(2));
  const color = data.fillColor || COLOR_BORDE;
  const NS = 'http://www.w3.org/2000/svg';

  const existing = document.getElementById(id);
  if (existing) {
    const ln = existing.querySelector('line');
    if (ln) ln.setAttribute('stroke', color);
    return 'url(#' + id + ')';
  }

  const svg = mapa().getContainer().querySelector('svg');
  if (!svg) return color;
  let defs = svg.querySelector('defs');
  if (!defs) { defs = document.createElementNS(NS, 'defs'); svg.prepend(defs); }
  const pat = document.createElementNS(NS, 'pattern');
  pat.setAttribute('id', id); pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.setAttribute('width', '8'); pat.setAttribute('height', '8');
  const ln = document.createElementNS(NS, 'line');
  ln.setAttribute('x1', '0'); ln.setAttribute('y1', '0');
  ln.setAttribute('x2', '8'); ln.setAttribute('y2', '8');
  ln.setAttribute('stroke', color); ln.setAttribute('stroke-width', '1.5');
  pat.appendChild(ln); defs.appendChild(pat);
  return 'url(#' + id + ')';
}

function crearPoligonoSuave(originales, estilo) {
  const opts = estiloPoly(estilo);
  return L.polygon(suavizarPoligono(originales, PASOS_SUAVIDAD), opts);
}

function actualizarPoligono(polygon, originales, estilo) {
  polygon.setLatLngs(suavizarPoligono(originales, PASOS_SUAVIDAD));
  polygon.setStyle(estiloPoly(estilo || polygon._estilo));
}

function crearPoligonoDesdeDatos(originales, firestoreId, estiloGuardado, region) {
  const estilo = Object.assign({}, ESTILO_DEFECTO, estiloGuardado || {});
  estilo.id = Date.now() + Math.random();
  const polygon = crearPoligonoSuave(originales, estilo);

  const vertices = originales.map((ll, i) => {
    const m = L.marker(ll, { icon: iconoVertice, draggable: true });
    m._verticeIdx = i;
    m.on('drag', function() {
      const p = poligonos.find(x => x.id === this._polyId);
      if (!p) return;
      p.originales[this._verticeIdx] = this.getLatLng();
      actualizarPoligono(polygon, p.originales, p.estilo);
    });
    m.on('dragend', function() {
      const p = poligonos.find(x => x.id === this._polyId);
      if (p) guardarActualizacion(p);
    });
    return m;
  });

  const data = { id: Date.now() + Math.random(), polygon, vertices, originales, firestoreId, estilo, region };
  polygon._estilo = estilo;
  vertices.forEach(m => { m._polyId = data.id; });
  poligonos.push(data);
  if (!region || region === window.regionActiva) {
    grupoDibujo.addLayer(polygon);
    if (modoPintarActivo) vertices.forEach(m => grupoDibujo.addLayer(m));
  }
}

function cerrarPoligono() {
  if (puntosTemp.length < 3) return;
  const originales = puntosTemp.slice();
  const estilo = Object.assign({}, ESTILO_DEFECTO, { id: Date.now() + Math.random() });
  const polygon = crearPoligonoSuave(originales, estilo);

  const vertices = originales.map((ll, i) => {
    const m = L.marker(ll, { icon: iconoVertice, draggable: true });
    m._verticeIdx = i;
    m.on('drag', function() {
      const p = poligonos.find(x => x.id === this._polyId);
      if (!p) return;
      p.originales[this._verticeIdx] = this.getLatLng();
      actualizarPoligono(polygon, p.originales, p.estilo);
    });
    m.on('dragend', function() {
      const p = poligonos.find(x => x.id === this._polyId);
      if (p) guardarActualizacion(p);
    });
    return m;
  });

  const data = { id: Date.now() + Math.random(), polygon, vertices, originales, estilo, region: window.regionActiva };
  polygon._estilo = estilo;
  vertices.forEach(m => { m._polyId = data.id; });
  poligonos.push(data);
  grupoDibujo.addLayer(polygon);
  vertices.forEach(m => grupoDibujo.addLayer(m));
  cancelarDibujo();
  guardarPoligono(data);

  // Entrar directamente en modo estilo
  herramientaActiva = 'estilo';
  poligonoEditando = data;
  const btns = ['btn-dibujar', 'btn-borrar', 'btn-estilo'];
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('activo', id === 'btn-estilo');
  });
  document.body.style.cursor = 'pointer';
  ocultarVertices();
  abrirModalEstilo(data);
}

// ═══════════════════════════════════════════════
//  Mostrar / ocultar vértices
// ═══════════════════════════════════════════════

function mostrarVertices() {
  poligonos.forEach(p => p.vertices.forEach(v => grupoDibujo.addLayer(v)));
}
function ocultarVertices() {
  poligonos.forEach(p => p.vertices.forEach(v => grupoDibujo.removeLayer(v)));
}

// ═══════════════════════════════════════════════
//  MODAL ESTILO
// ═══════════════════════════════════════════════

function abrirModalEstilo(data) {
  const e = data.estilo || ESTILO_DEFECTO;
  gid('estilo-line-weight').value = e.lineWeight;
  gid('estilo-line-weight-val').textContent = e.lineWeight;
  gid('estilo-line-type').value = e.lineDash || 'solid';
  gid('estilo-line-color').value = e.lineColor || '#ff5050';
  gid('estilo-fill-color').value = e.fillColor || '#ff5050';
  gid('estilo-fill-opacity').value = Math.round((e.fillOpacity || 0.35) * 100);
  gid('estilo-fill-opacity-val').textContent = Math.round((e.fillOpacity || 0.35) * 100) + '%';
  gid('estilo-fill-type').value = e.fillType || 'solid';
  gid('boton-alterac').classList.add('modal-abierto');
  gid('modal-estilo').classList.remove('oculto');
}

window.cerrarModalEstilo = function() {
  gid('modal-estilo').classList.add('oculto');
  gid('boton-alterac').classList.remove('modal-abierto');
  poligonoEditando = null;
};

window.aplicarEstilo = function() {
  if (!poligonoEditando) return;
  const p = poligonoEditando;
  const estilo = {
    lineWeight: +gid('estilo-line-weight').value,
    lineDash: gid('estilo-line-type').value,
    lineColor: gid('estilo-line-color').value,
    fillColor: gid('estilo-fill-color').value,
    fillOpacity: +gid('estilo-fill-opacity').value / 100,
    fillType: gid('estilo-fill-type').value,
  };
  p.estilo = Object.assign(p.estilo || {}, estilo);
  p.polygon._estilo = p.estilo;
  actualizarPoligono(p.polygon, p.originales, p.estilo);
  guardarActualizacion(p);
  cerrarModalEstilo();
};

function gid(id) { return document.getElementById(id); }

window.actualizarVisibilidadPoligonos = function() {
  const region = window.regionActiva;
  const areasOn = window.mostrarAreas !== false;
  poligonos.forEach(data => {
    const regionOk = !data.region || data.region === region;
    const visible = areasOn && regionOk;
    if (visible && !grupoDibujo.hasLayer(data.polygon)) {
      grupoDibujo.addLayer(data.polygon);
      data.vertices.forEach(m => { if (modoPintarActivo) grupoDibujo.addLayer(m); });
    } else if (!visible && grupoDibujo.hasLayer(data.polygon)) {
      grupoDibujo.removeLayer(data.polygon);
      data.vertices.forEach(m => grupoDibujo.removeLayer(m));
    }
  });
};

// ── Live preview sliders ──
const slW = gid('estilo-line-weight');
const slO = gid('estilo-fill-opacity');
if (slW) slW.addEventListener('input', function() { gid('estilo-line-weight-val').textContent = this.value; });
if (slO) slO.addEventListener('input', function() { gid('estilo-fill-opacity-val').textContent = this.value + '%'; });

// ═══════════════════════════════════════════════
//  Hit test
// ═══════════════════════════════════════════════

function puntoEnPoligono(ll, latlngs) {
  let inside = false;
  for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
    const xi = latlngs[i].lng, yi = latlngs[i].lat;
    const xj = latlngs[j].lng, yj = latlngs[j].lat;
    if ((yi > ll.lat) !== (yj > ll.lat) && ll.lng < ((xj - xi) * (ll.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

init();
