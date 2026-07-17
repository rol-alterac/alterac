// ╔══════════════════════════════════════════════╗
// ║         CONFIGURACIÓN — EDITA AQUÍ          ║
// ╚══════════════════════════════════════════════╝

const firebaseConfig = {
  apiKey:            "AIzaSyCFqj2Sk086YpgqHl81msY-9yKQHQ_W9To",
  authDomain:        "rol-alterac.firebaseapp.com",
  projectId:         "rol-alterac",
  storageBucket:     "rol-alterac.firebasestorage.app",
  messagingSenderId: "929570451692",
  appId:             "1:929570451692:web:7ebd20ab4999b5b9f635c9"
};

const CLOUDINARY_CLOUD_NAME = "s30rldoa";
const CLOUDINARY_PRESET     = "mapa-fotos";
const ANCHO_MAPA = 8192;
const ALTO_MAPA  = 8192;
const ARCHIVO_MAPA = 'mapa-base.png';
const CAPAS_EXTRA = [];

const REGIONES = {
  alterac:    { label: 'Alterac',    ruta: 'Mapas/Alterac' },
  stromgarde: { label: 'Stromgarde', ruta: 'Mapas/Stromgarde' },
  lago:       { label: 'Lago',       ruta: 'Mapas/Lago' },
};
const TIPOS_CAPA = ['base', 'nombres', 'escudos'];
const Z_CAPAS = { base: 101, nombres: 104, escudos: 100 };
const NOMBRES_REGION = Object.keys(REGIONES);
let regionActiva = 'alterac';
window.regionActiva = regionActiva;
const estadoCapasRegion = { base: true, nombres: false, escudos: false };

// ╔══════════════════════════════════════════════╗
// ║       A PARTIR DE AQUÍ NO TOQUES NADA       ║
// ╚══════════════════════════════════════════════╝

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, onSnapshot, updateDoc, setDoc }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const fbApp   = initializeApp(firebaseConfig);
const db      = getFirestore(fbApp);
window.db     = db;
const auth    = getAuth(fbApp);
const pinsCol = collection(db, 'pins');

// — Lecturas por usuario —
let readsData        = {};   // { pinId: isoTimestamp }
let readsUnsubscribe = null;

// — Caché local de lecturas (respaldo inmediato aunque Firestore tarde) —
function _lsKey(uid)          { return 'cgal_reads_' + uid; }
function cargarReadsLocal(uid) {
  try { return JSON.parse(localStorage.getItem(_lsKey(uid)) || '{}'); }
  catch { return {}; }
}
function guardarReadsLocal(uid, data) {
  try { localStorage.setItem(_lsKey(uid), JSON.stringify(data)); }
  catch {}
}

// — Mapa —
const bounds = [[0, 0], [ALTO_MAPA, ANCHO_MAPA]];
const mapa = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: -1, maxZoom: 0, zoomSnap: 0.25,
  zoomControl: false,
  maxBounds: bounds,
  maxBoundsViscosity: 1.0,
});
mapa.setView([4565.0, 1922.0], -1);
window.mapa = mapa;

function actualizarLimites() {
  if (regionActiva === 'alterac') {
    var z = mapa.getZoom();
    var limX;
    if (z <= -1) limX = 6780.0;
    else if (z <= -0.25) limX = 6780.0 + (z + 1) / 0.75 * (6784.4 - 6780.0);
    else limX = 6784.4 + (z + 0.25) / 0.25 * (6787.0 - 6784.4);
    mapa.setMaxBounds([[0, 0], [8192, limX]]);
  } else {
    mapa.setMaxBounds([[0, 0], [8192, 8192]]);
  }
}
mapa.on('zoomend', actualizarLimites);
actualizarLimites();

// — Capas de imagen (de abajo hacia arriba en el mapa) —
const EMPTY_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MapaTileLayer = L.GridLayer.extend({
  initialize(ruta, opts) {
    this._ruta = ruta;
    L.GridLayer.prototype.initialize.call(this, opts);
  },
  createTile(coords, done) {
    const img = document.createElement('img');
    const pz = coords.z + 5;
    const px = coords.x;
    const n  = Math.pow(2, pz);
    const py = coords.y + n;
    if (px < 0 || px >= n || py < 0 || py >= n) {
      img.src = EMPTY_TILE;
    } else {
      img.src = `${this._ruta}/${pz}/${px}/${py}.png`;
    }
    img.onload  = () => done(null, img);
    img.onerror = () => { img.src = EMPTY_TILE; done(null, img); };
    return img;
  }
});
function crearCapaTiles(ruta, zIndex) {
  return new MapaTileLayer(ruta, {
    tileSize: 256,
    minZoom: -1, maxZoom: 0,
    zIndex, bounds, noWrap: true,
    keepBuffer: 0,
    updateWhenIdle: true,
    updateWhenZooming: false
  });
}
const capasRegion = {};
for (const [reg, cfg] of Object.entries(REGIONES)) {
  capasRegion[reg] = {};
  for (const tipo of TIPOS_CAPA) {
    capasRegion[reg][tipo] = crearCapaTiles(`${cfg.ruta}/mapa-${tipo}`, Z_CAPAS[tipo]);
  }
}
// Añadir capas por defecto de la región inicial
for (const tipo of TIPOS_CAPA) {
  if (estadoCapasRegion[tipo]) {
    capasRegion[regionActiva][tipo].addTo(mapa);
  }
}

// — Capas de marcas —
const grupoPins    = L.layerGroup().addTo(mapa);
const grupoNombres = L.layerGroup().addTo(mapa);
const estadoCapas  = { marcas: true, nombres: true, eventos: true };

// — Filtro por categoría (marcas) —
const response = await fetch('./categorias.json');
const CATEGORIAS = await response.json();
const categoriasVisibles = new Set(CATEGORIAS);

// — Filtro por categoría (eventos) —
const responseEv = await fetch('./categorias-eventos.json');
const CATEGORIAS_EVENTOS = await responseEv.json();
const categoriasEventosVisibles = new Set(CATEGORIAS_EVENTOS);

function debeEstarVisible(datos) {
  const regionOk = !datos.region || datos.region === regionActiva;
  if (datos.tipo === 'evento') {
    return regionOk && estadoCapas.eventos && categoriasEventosVisibles.has(datos.categoria || 'Sistema');
  }
  return regionOk && estadoCapas.marcas && categoriasVisibles.has(datos.categoria || 'Sistema');
}

window.cambiarRegion = function(nuevaRegion) {
  if (nuevaRegion === regionActiva) return;
  // Quitar capas de la región anterior
  for (const tipo of TIPOS_CAPA) {
    mapa.removeLayer(capasRegion[regionActiva][tipo]);
  }
  regionActiva = nuevaRegion;
  window.regionActiva = regionActiva;
  // Poner capas de la nueva región según estado
  for (const tipo of TIPOS_CAPA) {
    if (estadoCapasRegion[tipo]) {
      capasRegion[regionActiva][tipo].addTo(mapa);
    }
  }
  actualizarVisibilidadMarcas();
  if (window.actualizarVisibilidadPoligonos) window.actualizarVisibilidadPoligonos();
  actualizarLimites();
};

function actualizarVisibilidadMarcas() {
  for (const id of Object.keys(markersPorId)) {
    const datos   = datosPorId[id];
    const visible = debeEstarVisible(datos);

    const marker = markersPorId[id];
    if (visible) { if (!grupoPins.hasLayer(marker))    grupoPins.addLayer(marker); }
    else          { grupoPins.removeLayer(marker); }

    const tooltip = tooltipsPorId[id];
    if (tooltip) {
      if (visible) { if (!grupoNombres.hasLayer(tooltip)) grupoNombres.addLayer(tooltip); }
      else          { grupoNombres.removeLayer(tooltip); }
    }
  }
}

// — Panel de control de capas —
const capasControl = document.createElement('div');
capasControl.id = 'capas-control';

function crearFilaImagen(label, tipo, inicialActivo = true) {
  const fila = document.createElement('div');
  fila.className = 'capa-fila';

  const btn = document.createElement('button');
  btn.className = inicialActivo ? 'btn-capa activo' : 'btn-capa inactivo';
  btn.textContent = label;
  btn.addEventListener('click', () => {
    estadoCapasRegion[tipo] = !estadoCapasRegion[tipo];
    const capa = capasRegion[regionActiva][tipo];
    if (estadoCapasRegion[tipo]) {
      capa.addTo(mapa);
      btn.classList.replace('inactivo', 'activo');
    } else {
      mapa.removeLayer(capa);
      btn.classList.replace('activo', 'inactivo');
    }
  });

  fila.appendChild(btn);
  return fila;
}

capasControl.appendChild(crearFilaImagen('Escudos', 'escudos', false));
capasControl.appendChild(crearFilaImagen('Nombres', 'nombres', false));
capasControl.appendChild(crearFilaImagen('Mapa',    'base',    true));

// — Fila Etiquetas (antes ocupaba Marcas) —
const filaMarcas = document.createElement('div');
filaMarcas.className = 'capa-fila capa-fila-etiquetas';

const btnMarcas = document.createElement('button');
btnMarcas.className = 'btn-capa activo';
btnMarcas.textContent = 'Marcas';
btnMarcas.addEventListener('click', () => {
  estadoCapas.marcas = !estadoCapas.marcas;
  btnMarcas.classList.toggle('activo',   estadoCapas.marcas);
  btnMarcas.classList.toggle('inactivo', !estadoCapas.marcas);
  actualizarVisibilidadMarcas();
});

const btnExpandirCats = document.createElement('button');
btnExpandirCats.className = 'btn-expandir-cats';
btnExpandirCats.textContent = '';
btnExpandirCats.title = 'Filtrar por categoría';

const dropdownCats = document.createElement('div');
dropdownCats.id = 'categorias-dropdown';
dropdownCats.className = 'oculto';

// — Estado del isolate —
let catAislada        = null;
let snapshotPreIsolate = null;

function sincronizarCheckboxes() {
  dropdownCats.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = categoriasVisibles.has(cb.dataset.cat);
  });
}

function entrarIsolate(cat) {
  snapshotPreIsolate = new Set(categoriasVisibles);
  catAislada = cat;
  categoriasVisibles.clear();
  categoriasVisibles.add(cat);
  sincronizarCheckboxes();
  dropdownCats.querySelectorAll('.btn-isolate').forEach(b => {
    b.classList.toggle('activo', b.dataset.cat === cat);
  });
  actualizarVisibilidadMarcas();
}

function salirIsolate() {
  if (snapshotPreIsolate === null) return;
  categoriasVisibles.clear();
  snapshotPreIsolate.forEach(c => categoriasVisibles.add(c));
  snapshotPreIsolate = null;
  catAislada = null;
  sincronizarCheckboxes();
  dropdownCats.querySelectorAll('.btn-isolate').forEach(b => b.classList.remove('activo'));
  actualizarVisibilidadMarcas();
}

CATEGORIAS.forEach(cat => {
  const fila = document.createElement('div');
  fila.className = 'cat-fila';

  const check = document.createElement('input');
  check.type        = 'checkbox';
  check.checked     = true;
  check.id          = `cat-chk-${CSS.escape(cat)}`;
  check.dataset.cat = cat;

  check.addEventListener('change', () => {
    if (catAislada !== null) {
      // Salir del isolate, restaurar snapshot, luego aplicar este cambio encima
      salirIsolate();
      if (check.checked) categoriasVisibles.add(cat);
      else               categoriasVisibles.delete(cat);
      sincronizarCheckboxes();
    } else {
      if (check.checked) categoriasVisibles.add(cat);
      else               categoriasVisibles.delete(cat);
    }
    actualizarVisibilidadMarcas();
  });

  const lbl = document.createElement('label');
  lbl.htmlFor     = check.id;
  lbl.textContent = cat;

  const btnIsolate = document.createElement('button');
  btnIsolate.className   = 'btn-isolate';
  btnIsolate.textContent = '◎';
  btnIsolate.title       = `Solo ${cat}`;
  btnIsolate.dataset.cat = cat;
  btnIsolate.addEventListener('click', () => {
    if (catAislada === cat) {
      salirIsolate(); // segunda pulsada = desactivar isolate
    } else {
      entrarIsolate(cat);
    }
  });

  fila.appendChild(check);
  fila.appendChild(lbl);
  fila.appendChild(btnIsolate);
  dropdownCats.appendChild(fila);
});

const btnEtiquetas = document.createElement('button');
btnEtiquetas.className = 'btn-capa activo';
btnEtiquetas.textContent = 'Etiquetas';
btnEtiquetas.addEventListener('click', () => {
  estadoCapas.nombres = !estadoCapas.nombres;
  btnEtiquetas.classList.toggle('activo',   estadoCapas.nombres);
  btnEtiquetas.classList.toggle('inactivo', !estadoCapas.nombres);
  if (estadoCapas.nombres) {
    if (!mapa.hasLayer(grupoNombres)) mapa.addLayer(grupoNombres);
  } else {
    mapa.removeLayer(grupoNombres);
  }
});

btnExpandirCats.addEventListener('click', () => {
  const abierto = !dropdownCats.classList.contains('oculto');
  dropdownCats.classList.toggle('oculto', abierto);
});

filaMarcas.appendChild(btnEtiquetas);
capasControl.appendChild(filaMarcas);

// — Fila Marcas con desplegable (antes ocupaba Etiquetas) —
const filaEtiquetas = document.createElement('div');
filaEtiquetas.className = 'capa-fila capa-fila-marcas';

filaEtiquetas.appendChild(btnExpandirCats);
filaEtiquetas.appendChild(btnMarcas);
capasControl.appendChild(filaEtiquetas);
capasControl.appendChild(dropdownCats);

// — Fila Eventos con desplegable de categorías —
let catAisladaEventos        = null;
let snapshotPreIsolateEventos = null;

function sincronizarCheckboxesEventos() {
  dropdownCatsEventos.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = categoriasEventosVisibles.has(cb.dataset.cat);
  });
}

function entrarIsolateEventos(cat) {
  snapshotPreIsolateEventos = new Set(categoriasEventosVisibles);
  catAisladaEventos = cat;
  categoriasEventosVisibles.clear();
  categoriasEventosVisibles.add(cat);
  sincronizarCheckboxesEventos();
  dropdownCatsEventos.querySelectorAll('.btn-isolate').forEach(b => {
    b.classList.toggle('activo', b.dataset.cat === cat);
  });
  actualizarVisibilidadMarcas();
}

function salirIsolateEventos() {
  if (snapshotPreIsolateEventos === null) return;
  categoriasEventosVisibles.clear();
  snapshotPreIsolateEventos.forEach(c => categoriasEventosVisibles.add(c));
  snapshotPreIsolateEventos = null;
  catAisladaEventos = null;
  sincronizarCheckboxesEventos();
  dropdownCatsEventos.querySelectorAll('.btn-isolate').forEach(b => b.classList.remove('activo'));
  actualizarVisibilidadMarcas();
}

const dropdownCatsEventos = document.createElement('div');
dropdownCatsEventos.id = 'categorias-eventos-dropdown';
dropdownCatsEventos.className = 'oculto';

CATEGORIAS_EVENTOS.forEach(cat => {
  const fila = document.createElement('div');
  fila.className = 'cat-fila';

  const check = document.createElement('input');
  check.type        = 'checkbox';
  check.checked     = true;
  check.id          = `cat-ev-chk-${CSS.escape(cat)}`;
  check.dataset.cat = cat;

  check.addEventListener('change', () => {
    if (catAisladaEventos !== null) {
      salirIsolateEventos();
      if (check.checked) categoriasEventosVisibles.add(cat);
      else               categoriasEventosVisibles.delete(cat);
      sincronizarCheckboxesEventos();
    } else {
      if (check.checked) categoriasEventosVisibles.add(cat);
      else               categoriasEventosVisibles.delete(cat);
    }
    actualizarVisibilidadMarcas();
  });

  const lbl = document.createElement('label');
  lbl.htmlFor     = check.id;
  lbl.textContent = cat;

  const btnIsolate = document.createElement('button');
  btnIsolate.className   = 'btn-isolate';
  btnIsolate.textContent = '◎';
  btnIsolate.title       = `Solo ${cat}`;
  btnIsolate.dataset.cat = cat;
  btnIsolate.addEventListener('click', () => {
    if (catAisladaEventos === cat) {
      salirIsolateEventos();
    } else {
      entrarIsolateEventos(cat);
    }
  });

  fila.appendChild(check);
  fila.appendChild(lbl);
  fila.appendChild(btnIsolate);
  dropdownCatsEventos.appendChild(fila);
});

const filaEventos = document.createElement('div');
filaEventos.className = 'capa-fila capa-fila-eventos';

const btnExpandirCatsEventos = document.createElement('button');
btnExpandirCatsEventos.className = 'btn-expandir-cats';
btnExpandirCatsEventos.textContent = '';
btnExpandirCatsEventos.title = 'Filtrar por categoría de evento';

btnExpandirCatsEventos.addEventListener('click', () => {
  const abierto = !dropdownCatsEventos.classList.contains('oculto');
  dropdownCatsEventos.classList.toggle('oculto', abierto);
});

const btnEventos = document.createElement('button');
btnEventos.className = 'btn-capa activo';
btnEventos.textContent = 'Eventos';
btnEventos.addEventListener('click', () => {
  estadoCapas.eventos = !estadoCapas.eventos;
  btnEventos.classList.toggle('activo',   estadoCapas.eventos);
  btnEventos.classList.toggle('inactivo', !estadoCapas.eventos);
  actualizarVisibilidadMarcas();
});

filaEventos.appendChild(btnExpandirCatsEventos);
filaEventos.appendChild(btnEventos);
capasControl.appendChild(filaEventos);
capasControl.appendChild(dropdownCatsEventos);

// — Fila Áreas —
const filaAreas = document.createElement('div');
filaAreas.className = 'capa-fila capa-fila-areas';
const btnAreas = document.createElement('button');
btnAreas.className = 'btn-capa activo';
btnAreas.textContent = 'Áreas';
btnAreas.addEventListener('click', () => {
  window.mostrarAreas = !window.mostrarAreas;
  btnAreas.classList.toggle('activo',   window.mostrarAreas);
  btnAreas.classList.toggle('inactivo', !window.mostrarAreas);
  if (window.actualizarVisibilidadPoligonos) window.actualizarVisibilidadPoligonos();
  // Si se desmarca Áreas, cerrar pincel
  if (!window.mostrarAreas && document.querySelector('.btn-pintar-area.activo') && window.activarModoPintar) {
    window.activarModoPintar();
  }
});

const btnPintarArea = document.createElement('button');
btnPintarArea.className = 'btn-pintar-area';
btnPintarArea.title = 'Pintar Área';
btnPintarArea.addEventListener('click', () => {
  if (!usuarioActual) { alert('Debes iniciar sesión para crear áreas.'); return; }
  if (window.activarModoPintar) window.activarModoPintar();
});

filaAreas.appendChild(btnPintarArea);
filaAreas.appendChild(btnAreas);
capasControl.appendChild(filaAreas);
window.mostrarAreas = true;

// Mover herramientas de dibujo debajo de Áreas
const hd = document.getElementById('herramientas-dibujo');
if (hd) capasControl.appendChild(hd);

document.body.appendChild(capasControl);

// ══════════════════════════════
//  AUTENTICACIÓN
// ══════════════════════════════

let usuarioActual = null;

onAuthStateChanged(auth, (usuario) => {
  usuarioActual = usuario;
  window.usuarioActual = usuario;

  // Gestionar suscripción a lecturas del usuario
  if (readsUnsubscribe) { readsUnsubscribe(); readsUnsubscribe = null; }

  if (usuario) {
    // Carga inmediata desde localStorage: sin esperar a Firestore, los tooltips
    // ya se pintan correctamente desde el primer frame.
    readsData = cargarReadsLocal(usuario.uid);
    actualizarClasesTooltips();

    readsUnsubscribe = onSnapshot(doc(db, 'reads', usuario.uid), (snap) => {
      const remoto = snap.exists() ? snap.data() : {};
      // Merge: para cada pin conservamos el timestamp MÁS RECIENTE.
      // Esto evita que un snapshot con datos en caché antigua sobreescriba
      // una actualización optimista local hecha segundos antes.
      const merged = { ...readsData };
      for (const [id, ts] of Object.entries(remoto)) {
        if (!merged[id] || ts > merged[id]) merged[id] = ts;
      }
      readsData = merged;
      guardarReadsLocal(usuario.uid, readsData);
      actualizarClasesTooltips();
    });
  } else {
    readsData = {};
    actualizarClasesTooltips();
  }

  actualizarUI(usuario);
});

function actualizarUI(usuario) {
  const infoEl       = document.getElementById('info-usuario');
  const btnLogin     = document.getElementById('btn-login');
  const btnLogout    = document.getElementById('btn-logout');
  const btnAñadir    = document.getElementById('btn-añadir');
  const btnAñadirEv  = document.getElementById('btn-añadir-evento');

  if (usuario) {
    const nombreCompleto = usuario.displayName || '';
    const soloNombre = nombreCompleto.split(' ')[0];

    infoEl.textContent = `👤 ${soloNombre || usuario.email}`;

    btnLogin.classList.add('oculto');
    btnLogout.classList.remove('oculto');
    btnAñadir.classList.remove('oculto');
    btnAñadirEv.classList.remove('oculto');
  } else {
    infoEl.textContent = '';
    btnLogin.classList.remove('oculto');
    btnLogout.classList.add('oculto');
    btnAñadir.classList.add('oculto');
    btnAñadirEv.classList.add('oculto');
    cancelarModoPin();
  }
}

window.loginGoogle = async function() {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (err) { console.error('Error login:', err); alert('No se pudo iniciar sesión.'); }
};
window.logoutGoogle = async function() { await signOut(auth); };

// ══════════════════════════════
//  REFERENCIAS DE CAPAS POR ID
//  (necesarias para actualizar el tooltip sin recargar)
// ══════════════════════════════

const tooltipsPorId = {};  // id → tooltip Leaflet
const markersPorId  = {};  // id → marker Leaflet
const datosPorId    = {};  // id → objeto marca (para actualizar referencias)

// ══════════════════════════════
//  SISTEMA DE LEÍDO / NO LEÍDO
// ══════════════════════════════

function esNoLeido(datos) {
  if (!usuarioActual) return false;
  const lastMod = datos.updatedAt || datos.creadoEn;
  if (!lastMod) return false;
  const readAt = readsData[datos.id];
  if (!readAt) return true;          // Nunca abierto → no leído
  return lastMod > readAt;           // Modificado después de la última lectura
}

function actualizarClaseTooltip(id) {
  const tooltip = tooltipsPorId[id];
  if (!tooltip) return;
  const noLeido    = esNoLeido(datosPorId[id]);
  const nuevaClase = noLeido ? 'tooltip-no-leido' : 'tooltip-leido';
  const el = tooltip.getElement();
  if (el) {
    el.classList.toggle('tooltip-no-leido', noLeido);
    el.classList.toggle('tooltip-leido',    !noLeido);
  } else {
    // El tooltip aún no tiene elemento DOM (p.ej. se llama antes de que Leaflet
    // lo renderice). Actualizamos la opción y reintentamos en el siguiente frame.
    tooltip.options.className = nuevaClase;
    requestAnimationFrame(() => {
      const el2 = tooltip.getElement();
      if (el2) {
        el2.classList.toggle('tooltip-no-leido', noLeido);
        el2.classList.toggle('tooltip-leido',    !noLeido);
      }
    });
  }
}

function actualizarClasesTooltips() {
  for (const id of Object.keys(tooltipsPorId)) {
    actualizarClaseTooltip(id);
  }
}

async function marcarComoLeido(pinId) {
  if (!usuarioActual) return;

  // Usamos el propio updatedAt del pin como timestamp de lectura.
  // Así evitamos el desfase entre el reloj local y el del servidor de Firestore:
  // si el servidor marcó updatedAt = T, guardamos readAt = T → T > T es false → leído ✓
  const pinData    = datosPorId[pinId];
  const tsLectura  = (pinData && (pinData.updatedAt || pinData.creadoEn))
                     || new Date().toISOString();

  readsData[pinId] = tsLectura;
  guardarReadsLocal(usuarioActual.uid, readsData);  // guardado inmediato en localStorage
  actualizarClaseTooltip(pinId);

  try {
    await setDoc(doc(db, 'reads', usuarioActual.uid), { [pinId]: tsLectura }, { merge: true });
  } catch (err) {
    console.error('Error marcando como leído:', err);
  }
}

// ══════════════════════════════
//  CARGAR Y ESCUCHAR MARCAS
// ══════════════════════════════

onSnapshot(pinsCol, (snapshot) => {
  snapshot.docChanges().forEach(change => {
    const datos = { ...change.doc.data(), id: change.doc.id };

    if (change.type === 'added') {
      datosPorId[datos.id] = datos;
      añadirMarcaAlMapa(datos);
    }

    if (change.type === 'modified') {
      // Actualizar datos locales
      Object.assign(datosPorId[datos.id], datos);

      // Actualizar etiqueta del mapa en tiempo real
      if (tooltipsPorId[datos.id]) {
        tooltipsPorId[datos.id].setContent(datos.nombre);
      }
      // Actualizar icono y handler de clic del marcador
      if (markersPorId[datos.id]) {
        markersPorId[datos.id].setIcon(iconoPorCategoria(datos.categoria, datos.escala || 1));
        markersPorId[datos.id].off('click');
        markersPorId[datos.id].on('click', () => abrirPanel(datosPorId[datos.id]));
      }
      // Refrescar estado leído/no leído
      actualizarClaseTooltip(datos.id);
    }

    if (change.type === 'removed') {
      if (markersPorId[datos.id])  { grupoPins.removeLayer(markersPorId[datos.id]); delete markersPorId[datos.id]; }
      if (tooltipsPorId[datos.id]) { grupoNombres.removeLayer(tooltipsPorId[datos.id]); delete tooltipsPorId[datos.id]; }
      delete datosPorId[datos.id];
    }
  });
});

function iconoPorCategoria(categoria, escala = 1) {
  const nombre = encodeURIComponent(categoria || 'Sistema Genérico');
  const s = Math.round(40 * escala);
  return L.icon({
    iconUrl:    `Iconos/${nombre}.png`,
    iconSize:   [s, s],
    iconAnchor: [s / 2, s / 2],
    popupAnchor:[0, -s / 2],
  });
}

function añadirMarcaAlMapa(marca) {
  const icono = iconoPorCategoria(marca.categoria, marca.escala || 1);

  const marker = L.marker([marca.lat, marca.lng], { icon: icono });
  marker.on('click', () => abrirPanel(datosPorId[marca.id]));
  if (debeEstarVisible(marca)) grupoPins.addLayer(marker);
  markersPorId[marca.id] = marker;

  const etiqueta = L.tooltip({ permanent: true, direction: 'top', offset: [0, -14], className: esNoLeido(marca) ? 'tooltip-no-leido' : 'tooltip-leido' })
    .setContent(marca.nombre)
    .setLatLng([marca.lat, marca.lng]);
  if (debeEstarVisible(marca)) grupoNombres.addLayer(etiqueta);
  tooltipsPorId[marca.id] = etiqueta;
}

// ══════════════════════════════
//  MODO AÑADIR MARCA
// ══════════════════════════════

let modoAñadirPin  = false;
let coordsNuevoPin = null;
let tipoCreacion   = 'marca';

window.activarModoPin = function(tipo = 'marca') {
  if (!usuarioActual) { alert('Debes iniciar sesión.'); return; }
  tipoCreacion = tipo;
  modoAñadirPin = true;
  document.getElementById('btn-añadir').classList.add('oculto');
  document.getElementById('btn-añadir-evento').classList.add('oculto');
  document.getElementById('instruccion').classList.remove('oculto');
  mapa.getContainer().style.cursor = 'crosshair';
};

window.cancelarModoPin = function() {
  modoAñadirPin = false;
  if (usuarioActual) {
    document.getElementById('btn-añadir').classList.remove('oculto');
    document.getElementById('btn-añadir-evento').classList.remove('oculto');
  }
  document.getElementById('instruccion').classList.add('oculto');
  mapa.getContainer().style.cursor = '';
};

// ══════════════════════════════
//  EDITOR DE TEXTO ENRIQUECIDO
// ══════════════════════════════

// Editor activo antes de que el botón de toolbar robe el foco
let editorActivo = null;

document.addEventListener('focusin', (e) => {
  if (e.target && e.target.classList.contains('editor-content')) {
    editorActivo = e.target;
  }
});

function actualizarToolbar(editorEl) {
  const toolbar = editorEl.previousElementSibling;
  if (!toolbar || !toolbar.classList.contains('editor-toolbar')) return;

  ['bold', 'italic', 'underline'].forEach(cmd => {
    const btn = toolbar.querySelector(`button[onclick="formatText('${cmd}')"]`);
    if (btn) btn.classList.toggle('activo', document.queryCommandState(cmd));
  });
}

window.formatText = function(cmd) {
  // Devolver el foco al editor antes de ejecutar el comando
  if (editorActivo) editorActivo.focus();
  document.execCommand(cmd, false, null);
  // Esperar un tick para que el navegador procese el cambio
  setTimeout(() => {
    if (editorActivo) actualizarToolbar(editorActivo);
  }, 0);
};

window.formatSize = function(selectEl) {
  const val = selectEl.value;
  if (!val) return;
  if (editorActivo) editorActivo.focus();
  document.execCommand('fontSize', false, val);
};

// Actualizar toolbar al mover el cursor o cambiar la selección
document.addEventListener('selectionchange', () => {
  setTimeout(() => {
    if (editorActivo) actualizarToolbar(editorActivo);
  }, 0);
});

// ══════════════════════════════
//  IMÁGENES INLINE EN EDITOR
// ══════════════════════════════

let rangoGuardado   = null;
let editorCapturado = null;

function guardarRangoSeleccion() {
  const sel = window.getSelection();
  rangoGuardado   = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
  editorCapturado = editorActivo;
}

function restaurarRangoSeleccion() {
  if (!rangoGuardado || !editorCapturado) return;
  editorCapturado.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(rangoGuardado);
}

window.insertarImagenEditor = function() {
  if (!editorActivo) { alert('Haz clic primero dentro del editor de texto.'); return; }
  guardarRangoSeleccion();

  const fileInput = document.createElement('input');
  fileInput.type  = 'file';
  fileInput.accept = 'image/*';

  fileInput.addEventListener('change', async function() {
    const file = fileInput.files[0];
    if (!file) return;

    const cajaEl  = document.getElementById('progreso-caja');
    const barraId = 'progreso-barra';
    const textoId = 'progreso-texto';

    cajaEl.classList.remove('oculto');
    try {
      const url = await subirFotoCloudinary(file, 0, 1, barraId, textoId);
      document.getElementById(textoId).textContent = 'Imagen insertada ✓';
      insertarImgEnEditor(url);
    } catch (err) {
      console.error('Error subiendo imagen inline:', err);
      alert('Error al subir la imagen.');
    }
  });

  fileInput.click();
};

function crearControlesImg(size, align) {
  size  = size  || 100;
  align = align || 'center';
  const div = document.createElement('div');
  div.className = 'img-inline-controls';
  div.innerHTML = `
    <button type="button" class="iic-btn" onclick="imgInlineSize(this,-25)" title="Reducir (−25%)">−</button>
    <span class="img-size-label">${size}%</span>
    <button type="button" class="iic-btn" onclick="imgInlineSize(this,25)"  title="Ampliar (+25%)">+</button>
    <span class="iic-sep"></span>
    <button type="button" class="iic-btn${align==='left'  ?' activo':''}" onclick="imgInlineAlign(this,'left')"   title="Alinear izquierda">⬅</button>
    <button type="button" class="iic-btn${align==='center'?' activo':''}" onclick="imgInlineAlign(this,'center')" title="Centrar">⬌</button>
    <button type="button" class="iic-btn${align==='right' ?' activo':''}" onclick="imgInlineAlign(this,'right')"  title="Alinear derecha">➡</button>
    <span class="iic-sep"></span>
    <button type="button" class="iic-btn iic-del" onclick="this.closest('.img-inline').remove()" title="Eliminar imagen">✕</button>
  `;
  return div;
}

function insertarImgEnEditor(url) {
  restaurarRangoSeleccion();

  const wrapper = document.createElement('div');
  wrapper.className        = 'img-inline';
  wrapper.contentEditable  = 'false';
  wrapper.style.textAlign  = 'center';
  wrapper.dataset.size     = '100';
  wrapper.dataset.align    = 'center';
  wrapper.appendChild(crearControlesImg(100, 'center'));

  const img = document.createElement('img');
  img.src             = url;
  img.style.cssText   = 'width:100%;max-width:100%;border-radius:6px;display:block;margin:0 auto;';
  wrapper.appendChild(img);

  if (rangoGuardado) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rangoGuardado);
    rangoGuardado.deleteContents();
    rangoGuardado.insertNode(wrapper);
    const range = document.createRange();
    range.setStartAfter(wrapper);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else if (editorCapturado) {
    editorCapturado.appendChild(wrapper);
  }
}

window.imgInlineSize = function(btn, delta) {
  const wrapper = btn.closest('.img-inline');
  let size = parseInt(wrapper.dataset.size || '100');
  size = Math.min(100, Math.max(10, size + delta));
  wrapper.dataset.size = size;
  wrapper.querySelector('img').style.width = size + '%';
  wrapper.querySelector('.img-size-label').textContent = size + '%';
};

window.imgInlineAlign = function(btn, align) {
  const wrapper = btn.closest('.img-inline');
  wrapper.dataset.align   = align;
  wrapper.style.textAlign = align;
  // Actualizar el margen de la imagen para que la alineación surta efecto
  const img = wrapper.querySelector('img');
  if (img) {
    if      (align === 'left')   { img.style.margin = '0 auto 0 0'; }
    else if (align === 'right')  { img.style.margin = '0 0 0 auto'; }
    else                         { img.style.margin = '0 auto'; }
  }
  wrapper.querySelectorAll('.iic-btn').forEach(b => {
    if (['⬅','⬌','➡'].includes(b.textContent.trim())) b.classList.remove('activo');
  });
  btn.classList.add('activo');
};

// Elimina los controles del HTML antes de guardar en Firestore
function limpiarEditorHTML(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('.img-inline-controls').forEach(el => el.remove());
  tmp.querySelectorAll('.table-controls').forEach(el => el.remove());
  tmp.querySelectorAll('.block-code-del').forEach(el => el.remove());
  return tmp.innerHTML;
}

// Reinyecta los controles al cargar un editor en modo edición
function reinjectImgControls(editorEl) {
  editorEl.querySelectorAll('.img-inline').forEach(wrapper => {
    wrapper.querySelectorAll('.img-inline-controls').forEach(c => c.remove());
    const size  = parseInt(wrapper.dataset.size  || '100');
    const align = wrapper.dataset.align || 'center';
    wrapper.insertBefore(crearControlesImg(size, align), wrapper.firstChild);
    wrapper.contentEditable = 'false';
    // Sync image width in case it was saved with a specific width
    const img = wrapper.querySelector('img');
    if (img) {
      img.style.width  = size + '%';
      img.style.display = 'block';
      if      (align === 'left')  { img.style.margin = '0 auto 0 0'; }
      else if (align === 'right') { img.style.margin = '0 0 0 auto'; }
      else                        { img.style.margin = '0 auto'; }
    }
  });

  // Reinyectar controles de tabla
  editorEl.querySelectorAll('.editor-table-wrap').forEach(wrapper => {
    wrapper.querySelectorAll('.table-controls').forEach(c => c.remove());
    wrapper.insertBefore(crearControlesTabla(), wrapper.firstChild);
    wrapper.contentEditable = 'false';
    wrapper.querySelectorAll('td, th').forEach(cell => { cell.contentEditable = 'true'; });
  });

  // Reinyectar botón eliminar en bloques de código
  editorEl.querySelectorAll('.block-code-wrap').forEach(wrapper => {
    wrapper.querySelectorAll('.block-code-del').forEach(b => b.remove());
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'block-code-del';
    delBtn.innerHTML = '✕';
    delBtn.title = 'Eliminar bloque de código';
    delBtn.onclick = () => wrapper.remove();
    wrapper.insertBefore(delBtn, wrapper.firstChild);
    wrapper.contentEditable = 'false';
    const pre = wrapper.querySelector('pre');
    if (pre) pre.contentEditable = 'true';
  });
}

// ══════════════════════════════
//  COLOR DE TEXTO Y RESALTADO
// ══════════════════════════════

const COLORES_PALETA = [
  '#ffffff','#d4d4d4','#a3a3a3','#525252','#171717','#000000',
  '#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6',
  '#ec4899','#14b8a6','#06b6d4','#f59e0b','#10b981','#6366f1',
  '#fca5a5','#fdba74','#fde68a','#86efac','#93c5fd','#c4b5fd',
  '#fce7f3','#ccfbf1','#cffafe','#fef9c3','#dcfce7','#dbeafe',
  '#7f1d1d','#7c2d12','#713f12','#14532d','#1e3a5f','#4c1d95',
  '#9f1239','#134e4a','#164e63','#78350f','#052e16','#1e1b4b',
  'transparent',
];

let colorPickerActual = null;

function cerrarColorPicker() {
  if (colorPickerActual) { colorPickerActual.remove(); colorPickerActual = null; }
}

function crearColorPickerPopup(anchorRect, onSelect) {
  cerrarColorPicker();
  const popup = document.createElement('div');
  popup.className = 'color-picker-popup';

  COLORES_PALETA.forEach(color => {
    const sw = document.createElement('div');
    sw.className = 'color-swatch';
    if (color === 'transparent') {
      sw.style.cssText = 'background:none;border:1px dashed #555;display:flex;align-items:center;justify-content:center;';
      sw.innerHTML = '<span style="font-size:0.65rem;color:#888;line-height:1;">∅</span>';
    } else {
      sw.style.background = color;
    }
    sw.title = color === 'transparent' ? 'Sin color' : color;
    sw.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(color === 'transparent' ? null : color);
      cerrarColorPicker();
    });
    popup.appendChild(sw);
  });

  // Input color personalizado
  const customRow = document.createElement('div');
  customRow.className = 'color-custom-row';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#ffffff';
  colorInput.title = 'Color personalizado';
  colorInput.addEventListener('change', e => { onSelect(e.target.value); cerrarColorPicker(); });
  const customLabel = document.createElement('span');
  customLabel.textContent = 'Personalizado';
  customRow.appendChild(colorInput);
  customRow.appendChild(customLabel);
  popup.appendChild(customRow);

  document.body.appendChild(popup);

  // Posicionar bajo el botón
  const pw = popup.offsetWidth || 218;
  const ph = popup.offsetHeight || 180;
  let left = anchorRect.left;
  let top  = anchorRect.bottom + 4;
  if (left + pw > window.innerWidth - 8)  left = window.innerWidth - pw - 8;
  if (top  + ph > window.innerHeight - 8) top  = anchorRect.top - ph - 4;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';

  colorPickerActual = popup;
  setTimeout(() => { document.addEventListener('mousedown', cerrarColorPicker, { once: true }); }, 0);
}

window.abrirColorTexto = function(btn) {
  if (!editorActivo) { alert('Haz clic primero dentro del editor de texto.'); return; }
  guardarRangoSeleccion();
  const rect = btn.getBoundingClientRect();
  crearColorPickerPopup(rect, color => {
    restaurarRangoSeleccion();
    if (color) {
      document.execCommand('foreColor', false, color);
      btn.querySelector('.color-preview-texto').style.background = color;
    } else {
      document.execCommand('removeFormat', false, null);
    }
  });
};

window.abrirColorFondo = function(btn) {
  if (!editorActivo) { alert('Haz clic primero dentro del editor de texto.'); return; }
  guardarRangoSeleccion();
  const rect = btn.getBoundingClientRect();
  crearColorPickerPopup(rect, color => {
    restaurarRangoSeleccion();
    if (color) {
      document.execCommand('hiliteColor', false, color);
      btn.querySelector('.color-preview-fondo').style.background = color;
    } else {
      document.execCommand('hiliteColor', false, 'transparent');
      btn.querySelector('.color-preview-fondo').style.background = '';
    }
  });
};

// ══════════════════════════════
//  CÓDIGO INLINE Y EN BLOQUE
// ══════════════════════════════

let codigoMenuActual = null;

function cerrarMenuCodigo() {
  if (codigoMenuActual) { codigoMenuActual.remove(); codigoMenuActual = null; }
}

window.abrirMenuCodigo = function(btn) {
  if (!editorActivo) { alert('Haz clic primero dentro del editor de texto.'); return; }
  guardarRangoSeleccion();
  cerrarMenuCodigo();

  const rect  = btn.getBoundingClientRect();
  const popup = document.createElement('div');
  popup.className = 'codigo-menu-popup';

  const b1 = document.createElement('button');
  b1.type = 'button';
  b1.innerHTML = '<code class="inline-code" style="pointer-events:none;font-size:0.8rem">` `</code>&nbsp; Código en línea';
  b1.addEventListener('mousedown', e => { e.preventDefault(); cerrarMenuCodigo(); insertarCodigoInline(); });

  const b2 = document.createElement('button');
  b2.type = 'button';
  b2.innerHTML = '<code class="inline-code" style="pointer-events:none;font-size:0.8rem">```</code>&nbsp; Bloque de código';
  b2.addEventListener('mousedown', e => { e.preventDefault(); cerrarMenuCodigo(); insertarCodigoBloque(); });

  popup.appendChild(b1);
  popup.appendChild(b2);
  document.body.appendChild(popup);

  let left = rect.left;
  let top  = rect.bottom + 4;
  const pw = popup.offsetWidth || 190;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';

  codigoMenuActual = popup;
  setTimeout(() => { document.addEventListener('mousedown', cerrarMenuCodigo, { once: true }); }, 0);
};

function insertarCodigoInline() {
  restaurarRangoSeleccion();
  if (!rangoGuardado || !editorCapturado) return;

  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(rangoGuardado);

  const texto = rangoGuardado.toString() || 'código';
  const code = document.createElement('code');
  code.className = 'inline-code';
  code.contentEditable = 'true';
  code.textContent = texto;

  rangoGuardado.deleteContents();
  rangoGuardado.insertNode(code);

  const range = document.createRange();
  range.setStartAfter(code);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function insertarCodigoBloque() {
  restaurarRangoSeleccion();
  if (!editorCapturado) return;

  const sel = window.getSelection();
  let textoSeleccionado = '';
  if (rangoGuardado) {
    sel.removeAllRanges();
    sel.addRange(rangoGuardado);
    textoSeleccionado = rangoGuardado.toString();
    rangoGuardado.deleteContents();
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'block-code-wrap';
  wrapper.contentEditable = 'false';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'block-code-del';
  delBtn.innerHTML = '✕';
  delBtn.title = 'Eliminar bloque de código';
  delBtn.onclick = () => wrapper.remove();

  const pre = document.createElement('pre');
  pre.className = 'block-code';
  pre.contentEditable = 'true';
  pre.textContent = textoSeleccionado || 'código aquí';

  wrapper.appendChild(delBtn);
  wrapper.appendChild(pre);

  if (rangoGuardado) {
    rangoGuardado.insertNode(wrapper);
    const range = document.createRange();
    range.setStartAfter(wrapper);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editorCapturado.appendChild(wrapper);
  }
  pre.focus();
}

// ══════════════════════════════
//  TABLAS EN EL EDITOR
// ══════════════════════════════

function crearControlesTabla() {
  const bar = document.createElement('div');
  bar.className = 'table-controls';
  bar.innerHTML = `
    <button type="button" class="table-ctrl-btn" onclick="tablaAddFila(this)">+ Fila</button>
    <button type="button" class="table-ctrl-btn" onclick="tablaAddColumna(this)">+ Col</button>
    <button type="button" class="table-ctrl-btn danger" onclick="tablaDelFila(this)">− Fila</button>
    <button type="button" class="table-ctrl-btn danger" onclick="tablaDelColumna(this)">− Col</button>
    <button type="button" class="table-ctrl-btn danger" onclick="this.closest('.editor-table-wrap').remove()" title="Eliminar tabla">🗑️</button>
  `;
  return bar;
}

window.abrirModalTabla = function() {
  if (!editorActivo) { alert('Haz clic primero dentro del editor de texto.'); return; }
  guardarRangoSeleccion();

  const overlay = document.createElement('div');
  overlay.id = 'modal-tabla-insert';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9998;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#16213e;border:2px solid #4285F4;border-radius:14px;padding:28px;width:90%;max-width:300px;">
      <h3 style="color:#4285F4;margin-bottom:18px;font-size:1.1rem;">⊞ Insertar tabla</h3>
      <label style="display:block;color:#999;font-size:0.85rem;margin-bottom:5px;">Filas</label>
      <input type="number" id="tabla-filas" min="1" max="30" value="3"
        style="width:100%;background:#0f3460;border:1px solid #1a4a8a;border-radius:7px;color:#fff;padding:9px 11px;font-size:0.92rem;outline:none;margin-bottom:14px;" />
      <label style="display:block;color:#999;font-size:0.85rem;margin-bottom:5px;">Columnas</label>
      <input type="number" id="tabla-cols" min="1" max="20" value="3"
        style="width:100%;background:#0f3460;border:1px solid #1a4a8a;border-radius:7px;color:#fff;padding:9px 11px;font-size:0.92rem;outline:none;margin-bottom:20px;" />
      <div style="display:flex;gap:8px;">
        <button id="btn-confirmar-tabla"
          style="flex:1;background:#4285F4;color:#fff;border:none;padding:11px;border-radius:9px;font-size:0.95rem;font-weight:bold;cursor:pointer;">
          Insertar
        </button>
        <button onclick="document.getElementById('modal-tabla-insert').remove()"
          style="flex:1;background:transparent;border:1px solid #444;color:#888;padding:11px;border-radius:9px;font-size:0.92rem;cursor:pointer;">
          Cancelar
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('tabla-filas').focus();

  document.getElementById('btn-confirmar-tabla').addEventListener('click', () => {
    const filas = Math.max(1, parseInt(document.getElementById('tabla-filas').value) || 3);
    const cols  = Math.max(1, parseInt(document.getElementById('tabla-cols').value)  || 3);
    overlay.remove();
    insertarTabla(filas, cols);
  });
};

function insertarTabla(filas, cols) {
  restaurarRangoSeleccion();

  const wrapper = document.createElement('div');
  wrapper.className = 'editor-table-wrap';
  wrapper.contentEditable = 'false';
  wrapper.appendChild(crearControlesTabla());

  const table = document.createElement('table');
  table.className = 'editor-table';

  for (let r = 0; r < filas; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const td = document.createElement('td');
      td.contentEditable = 'true';
      td.addEventListener('focus', () => {
        const edParent = wrapper.closest('.editor-content');
        if (edParent) editorActivo = edParent;
      });
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrapper.appendChild(table);

  if (rangoGuardado) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rangoGuardado);
    rangoGuardado.deleteContents();
    rangoGuardado.insertNode(wrapper);
    const range = document.createRange();
    range.setStartAfter(wrapper);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else if (editorCapturado) {
    editorCapturado.appendChild(wrapper);
  }

  const firstCell = wrapper.querySelector('td');
  if (firstCell) firstCell.focus();
}

window.tablaAddFila = function(btn) {
  const table = btn.closest('.editor-table-wrap').querySelector('.editor-table');
  const cols  = table.rows[0]?.cells.length || 1;
  const tr    = document.createElement('tr');
  for (let c = 0; c < cols; c++) {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    tr.appendChild(td);
  }
  table.appendChild(tr);
};

window.tablaDelFila = function(btn) {
  const table = btn.closest('.editor-table-wrap').querySelector('.editor-table');
  if (table.rows.length > 1) table.deleteRow(table.rows.length - 1);
};

window.tablaAddColumna = function(btn) {
  const table = btn.closest('.editor-table-wrap').querySelector('.editor-table');
  [...table.rows].forEach(row => {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    row.appendChild(td);
  });
};

window.tablaDelColumna = function(btn) {
  const table = btn.closest('.editor-table-wrap').querySelector('.editor-table');
  [...table.rows].forEach(row => {
    if (row.cells.length > 1) row.deleteCell(row.cells.length - 1);
  });
};


// ══════════════════════════════
//  MODAL NUEVA MARCA
// ══════════════════════════════

window.abrirModal = function() {
  const tipo = tipoCreacion || 'marca';
  const cats = tipo === 'evento' ? CATEGORIAS_EVENTOS : CATEGORIAS;

  // Título + Categoría
  const titBody = document.getElementById('wnd-titulo-body');
  titBody.innerHTML = '';

  const inp = document.createElement('input');
  inp.type = 'text'; inp.id = 'input-nombre'; inp.className = 'crear-input';
  inp.placeholder = 'Título...';
  titBody.appendChild(inp);

  const filaSel = document.createElement('div');
  filaSel.style.cssText = 'display:flex;gap:6px;margin-top:6px';
  const sel = document.createElement('select');
  sel.id = 'input-categoria'; sel.className = 'crear-select';
  sel.style.flex = '7';
  cats.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
  filaSel.appendChild(sel);
  sel.value = cats[0];

  const selTipo = document.createElement('select');
  selTipo.id = 'input-tipo';
  selTipo.className = 'crear-select';
  selTipo.style.cssText = 'width:auto;flex:3;margin-right:17px';
  ['marca','evento'].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v.charAt(0).toUpperCase() + v.slice(1); selTipo.appendChild(o); });
  selTipo.value = tipoCreacion || 'marca';
  filaSel.appendChild(selTipo);
  titBody.appendChild(filaSel);

  selTipo.addEventListener('change', function() {
    const nuevoTipo = this.value;
    tipoCreacion = nuevoTipo;
    const nuevasCats = nuevoTipo === 'evento' ? CATEGORIAS_EVENTOS : CATEGORIAS;
    const catSelect = document.getElementById('input-categoria');
    catSelect.innerHTML = '';
    nuevasCats.forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c; catSelect.appendChild(o);
    });
    catSelect.value = nuevasCats[0];
  });

  // Editor de descripción
  document.getElementById('wnd-texto-body').innerHTML = `
    <div class="toolbar-caja"><div class="editor-toolbar">
      <button type="button" onclick="formatText('bold')"      title="Negrita"><b>N</b></button>
      <button type="button" onclick="formatText('italic')"    title="Cursiva"><i>C</i></button>
      <button type="button" onclick="formatText('underline')" title="Subrayado"><u>S</u></button>
      <div class="toolbar-sep"></div>
      <select onchange="formatSize(this)" title="Tamaño de texto">
        <option value="3">Normal</option>
        <option value="1">Pequeño</option>
        <option value="5">Grande</option>
        <option value="7">Muy grande</option>
      </select>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="insertarImagenEditor()" title="Insertar imagen en el texto">🖼️</button>
      <div class="toolbar-sep"></div>
      <button type="button" class="btn-color-texto" onclick="abrirColorTexto(this)" title="Color de texto"><span class="color-preview-texto"></span></button>
      <button type="button" class="btn-color-fondo" onclick="abrirColorFondo(this)" title="Resaltar texto"><span class="color-preview-fondo"></span></button>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="abrirMenuCodigo(this)" title="Código inline o bloque"><span class="ico-code">&lt;/&gt;</span></button>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="abrirModalTabla()" title="Insertar tabla">⊞</button>
    </div></div>
    <div id="input-descripcion-editor" class="editor-content" contenteditable="true"
         data-placeholder="Escribe lo que quieras..."></div>
    <div id="nuevas-subcats-wrap" style="margin-top:8px"></div>
    <button type="button" class="btn-añadir-subcat" onclick="añadirSubcatForm('nuevo')" style="margin-bottom:8px">Añadir Subcategoría</button>
  `;

  // Foto
  document.getElementById('wnd-imagen-body').innerHTML = `
    <div id="preview-fotos" style="margin-bottom:10px"></div>
    <label class="crear-label">Foto Principal:</label>
    <input type="file" id="input-fotos" accept="image/*" />
    <div id="progreso-caja" class="oculto">
      <div id="progreso-barra"></div>
      <span id="progreso-texto">Subiendo fotos...</span>
    </div>
  `;
  document.getElementById('input-fotos').addEventListener('change', function() {
    const preview = document.getElementById('preview-fotos');
    preview.innerHTML = '';
    Array.from(this.files).forEach(file => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      preview.appendChild(img);
    });
  });

  // Botones + subcategorías
  document.getElementById('wnd-botones-body').innerHTML = `
    <div class="crear-btns">
      <button id="btn-guardar" class="crear-btn" onclick="guardarPin()">Guardar cambios</button>
      <button class="crear-btn" onclick="cerrarModal()">Cancelar</button>
    </div>
  `;

  // Aplicar posiciones de creación
  if (window.aplicarCrearPos) window.aplicarCrearPos();

  // Mostrar ventanas
  document.querySelectorAll('.ventana-panel').forEach(w => w.classList.remove('oculto'));
  document.getElementById('wnd-cerrar').classList.remove('oculto');
};

window.cerrarModal = function() {
  cerrarPanel();
};


// ══════════════════════════════
//  SUBIR FOTO A CLOUDINARY
// ══════════════════════════════

async function subirFotoCloudinary(archivo, indice, total, barraId = 'progreso-barra', textoId = 'progreso-texto') {
  const formData = new FormData();
  formData.append('file', archivo);
  formData.append('upload_preset', CLOUDINARY_PRESET);

  document.getElementById(textoId).textContent = `Subiendo foto ${indice + 1} de ${total}...`;
  document.getElementById(barraId).style.width  = Math.round((indice / total) * 100) + '%';

  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const res  = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Error Cloudinary: ${res.status}`);
  const data = await res.json();
  return data.secure_url;
}

// ══════════════════════════════
//  GUARDAR MARCA
// ══════════════════════════════

window.guardarPin = async function() {
  const nombre      = document.getElementById('input-nombre').value.trim();
  const categoria   = document.getElementById('input-categoria').value;
  const descripcion = limpiarEditorHTML(document.getElementById('input-descripcion-editor').innerHTML.trim());
  const archivos    = document.getElementById('input-fotos').files;
  const btnGuardar  = document.getElementById('btn-guardar');
  const tipo        = document.getElementById('input-tipo').value;

  if (!nombre)        { alert('Escribe un nombre para el lugar.'); return; }
  if (!usuarioActual) { alert('Debes iniciar sesión.'); return; }

  btnGuardar.disabled = true;
  btnGuardar.textContent = 'Guardando...';

  try {
    const urlsFotos = [];
    if (archivos.length > 0) {
      document.getElementById('progreso-caja').classList.remove('oculto');
      for (let i = 0; i < archivos.length; i++) {
        urlsFotos.push(await subirFotoCloudinary(archivos[i], i, archivos.length));
      }
      document.getElementById('progreso-barra').style.width = '100%';
      document.getElementById('progreso-texto').textContent = 'Fotos subidas ✓';
    }

    const subcategorias = await recogerSubcats('nuevas-subcats-wrap');

    await addDoc(pinsCol, {
      nombre, categoria, descripcion,
      lat: coordsNuevoPin.lat, lng: coordsNuevoPin.lng,
      fotos: urlsFotos,
      subcategorias,
      autor: usuarioActual.displayName || usuarioActual.email,
      region: regionActiva,
      tipo,
      creadoEn:  new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    cerrarModal();
  } catch (err) {
    console.error('Error al guardar:', err);
    alert(err.code === 'permission-denied'
      ? 'No tienes permiso. Pide al administrador que añada tu UID a las reglas.'
      : 'Error al guardar. Abre la consola (F12) para ver el detalle.');
  } finally {
    btnGuardar.disabled = false;
    btnGuardar.textContent = 'Guardar cambios';
  }
};

// ══════════════════════════════
//  BORRAR MARCA
// ══════════════════════════════

window.borrarMarca = async function(id) {
  if (!confirm('¿Seguro que quieres borrarla?')) return;
  try {
    await deleteDoc(doc(db, 'pins', id));
    cerrarPanel();
    // El listener onSnapshot (removed) limpiará las capas automáticamente
  } catch (err) {
    console.error('Error al borrar:', err);
    alert(err.code === 'permission-denied'
      ? 'No tienes permiso para borrar esta marca.'
      : 'Error al borrar. Abre la consola (F12) para ver el detalle.');
  }
};

// ══════════════════════════════
//  PANEL LATERAL
// ══════════════════════════════

let marcaAbierta = null;

window.abrirPanel = function(marca) {
  marcaAbierta = marca;
  marcarComoLeido(marca.id);

  // Soporte legacy: si la descripción es texto plano (sin etiquetas HTML), convertir saltos
  const desc = marca.descripcion || '';
  const descHTML = desc.startsWith('<') ? desc : desc.replace(/\n/g, '<br>');

  const fotosHTML = (marca.fotos || []).length > 0
    ? `<div class="fotos-grid">${marca.fotos.map(url =>
        `<img src="${url}" onclick="abrirLightbox('${url}')" />`).join('')}</div>`
    : '';

  const btnsAccion = usuarioActual
    ? `<div class="btns-accion">
        <button class="btn-editar" onclick="abrirModalEdicion()">Editar</button>
        <button class="btn-tamaño" onclick="abrirModalTamaño()">Tamaño</button>
        <button class="btn-mover"  onclick="activarModoMover()">Mover</button>
        <button class="btn-borrar" onclick="borrarMarca('${marca.id}')">Borrar</button>
      </div>`
    : '';

  const subcatsHTML = renderSubcatsEnPanel(marca.subcategorias || []);

  // --- Poblar ventanas independientes ---
  document.getElementById('wnd-titulo-body').innerHTML = `
    <h2>${marca.nombre}</h2>
    ${marca.categoria ? `<p class="categoria"><strong>Categoría:</strong> ${marca.categoria}</p>` : ''}
  `;

  document.getElementById('wnd-texto-body').innerHTML = `
    <div class="descripcion">${descHTML || '<em>Sin descripción</em>'}</div>
    ${subcatsHTML}
  `;

  document.getElementById('wnd-imagen-body').innerHTML = fotosHTML;

  document.getElementById('wnd-botones-body').innerHTML = `
    ${marca.autor ? `<p class="autor">✍️ ${marca.autor.split(' ')[0]}</p>` : ''}
    ${btnsAccion}
  `;

  // Mostrar todas las ventanas
  document.querySelectorAll('.ventana-panel').forEach(w => w.classList.remove('oculto'));
  document.getElementById('wnd-cerrar').classList.remove('oculto');
};

window.cerrarPanel = function() {
  document.querySelectorAll('.ventana-panel').forEach(w => w.classList.add('oculto'));
  document.getElementById('wnd-cerrar').classList.add('oculto');
  marcaAbierta = null;
  coordsNuevoPin = null;
  const wrap = document.getElementById('nuevas-subcats-wrap');
  if (wrap) wrap.innerHTML = '';
  // Limpiar posiciones de creación
  if (window.limpiarCrearPos) window.limpiarCrearPos();
};

// ── ARRASTRE DE VENTANAS ──
window.iniciarArrastre = function(wnd, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const rect = wnd.getBoundingClientRect();
  const dx = e.clientX - rect.left;
  const dy = e.clientY - rect.top;
  const onMove = (ev) => {
    wnd.style.left = (ev.clientX - dx) + 'px';
    wnd.style.top  = (ev.clientY - dy) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
};

// ══════════════════════════════
//  MODO CAMBIAR POSICIÓN
// ══════════════════════════════

let modoMover = false;
let marcaParaMover = null;

window.activarModoMover = function() {
  if (!marcaAbierta) return;
  marcaParaMover = marcaAbierta;
  modoMover = true;

  // Cerrar panel y mostrar instrucción
  document.querySelectorAll('.ventana-panel').forEach(w => w.classList.add('oculto'));
  document.getElementById('wnd-cerrar').classList.add('oculto');

  const instrEl = document.getElementById('instruccion');
  instrEl.innerHTML = `Haz clic en el mapa para mover <strong>${marcaParaMover.nombre}</strong> <button onclick="cancelarModoMover()">Cancelar</button>`;
  instrEl.classList.remove('oculto');
  mapa.getContainer().style.cursor = 'crosshair';
};

window.cancelarModoMover = function() {
  modoMover = false;
  marcaParaMover = null;
  document.getElementById('instruccion').classList.add('oculto');
  mapa.getContainer().style.cursor = '';
  if (marcaAbierta) abrirPanel(marcaAbierta);
};

mapa.on('click', function(e) {
  if (modoMover && marcaParaMover) {
    const { lat, lng } = e.latlng;
    const id = marcaParaMover.id;

    // Mover el marcador visualmente de inmediato
    if (markersPorId[id]) markersPorId[id].setLatLng([lat, lng]);
    if (tooltipsPorId[id]) tooltipsPorId[id].setLatLng([lat, lng]);

    // Actualizar datos locales
    datosPorId[id].lat = lat;
    datosPorId[id].lng = lng;
    marcaParaMover.lat = lat;
    marcaParaMover.lng = lng;

    // Guardar en Firestore
    updateDoc(doc(db, 'pins', id), { lat, lng }).catch(err => {
      console.error('Error al mover marca:', err);
      alert('No se pudo guardar la nueva posición.');
    });

    // Salir del modo y reabrir el panel
    modoMover = false;
    document.getElementById('instruccion').classList.add('oculto');
    mapa.getContainer().style.cursor = '';
    abrirPanel(datosPorId[id]);
    marcaParaMover = null;
    return;
  }

  if (!modoAñadirPin) return;
  coordsNuevoPin = e.latlng;
  cancelarModoPin();
  abrirModal();
});

let fotosExistentes = [];

window.abrirModalEdicion = function() {
  const marca = marcaAbierta;
  if (!marca) return;

  fotosExistentes = [...(marca.fotos || [])];

  const tipo   = marca.tipo || 'marca';
  const cats   = tipo === 'evento' ? CATEGORIAS_EVENTOS : CATEGORIAS;

  // Título + Categoría (same as create, pre-filled)
  const titBody = document.getElementById('wnd-titulo-body');
  titBody.innerHTML = '';

  const inp = document.createElement('input');
  inp.type = 'text'; inp.id = 'input-nombre'; inp.className = 'crear-input';
  inp.placeholder = 'Título...';
  inp.value = marca.nombre;
  titBody.appendChild(inp);

  const filaSel = document.createElement('div');
  filaSel.style.cssText = 'display:flex;gap:6px;margin-top:6px';
  const sel = document.createElement('select');
  sel.id = 'input-categoria'; sel.className = 'crear-select';
  sel.style.flex = '7';
  cats.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c; sel.appendChild(o);
  });
  filaSel.appendChild(sel);
  sel.value = cats.includes(marca.categoria) ? marca.categoria : cats[0];

  const selTipo = document.createElement('select');
  selTipo.id = 'input-tipo';
  selTipo.className = 'crear-select';
  selTipo.style.cssText = 'width:auto;flex:3;margin-right:17px';
  ['marca','evento'].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v.charAt(0).toUpperCase() + v.slice(1); selTipo.appendChild(o); });
  selTipo.value = tipo;
  filaSel.appendChild(selTipo);
  titBody.appendChild(filaSel);

  selTipo.addEventListener('change', function() {
    const nuevoTipo = this.value;
    const nuevasCats = nuevoTipo === 'evento' ? CATEGORIAS_EVENTOS : CATEGORIAS;
    const catSelect = document.getElementById('input-categoria');
    catSelect.innerHTML = '';
    nuevasCats.forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c; catSelect.appendChild(o);
    });
    catSelect.value = nuevasCats[0];
  });

  // Editor (same as create, pre-filled)
  document.getElementById('wnd-texto-body').innerHTML = `
    <div class="toolbar-caja"><div class="editor-toolbar">
      <button type="button" onclick="formatText('bold')"      title="Negrita"><b>N</b></button>
      <button type="button" onclick="formatText('italic')"    title="Cursiva"><i>C</i></button>
      <button type="button" onclick="formatText('underline')" title="Subrayado"><u>S</u></button>
      <div class="toolbar-sep"></div>
      <select onchange="formatSize(this)" title="Tamaño de texto">
        <option value="3">Normal</option>
        <option value="1">Pequeño</option>
        <option value="5">Grande</option>
        <option value="7">Muy grande</option>
      </select>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="insertarImagenEditor()" title="Insertar imagen en el texto">🖼️</button>
      <div class="toolbar-sep"></div>
      <button type="button" class="btn-color-texto" onclick="abrirColorTexto(this)" title="Color de texto"><span class="color-preview-texto"></span></button>
      <button type="button" class="btn-color-fondo" onclick="abrirColorFondo(this)" title="Resaltar texto"><span class="color-preview-fondo"></span></button>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="abrirMenuCodigo(this)" title="Código inline o bloque"><span class="ico-code">&lt;/&gt;</span></button>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="abrirModalTabla()" title="Insertar tabla">⊞</button>
    </div></div>
    <div id="input-descripcion-editor" class="editor-content" contenteditable="true"
         data-placeholder="Escribe lo que quieras..."></div>
    <div id="nuevas-subcats-wrap" style="margin-top:8px"></div>
    <button type="button" class="btn-añadir-subcat" onclick="añadirSubcatForm('nuevo')" style="margin-bottom:8px">Añadir Subcategoría</button>
  `;

  // Pre-fill description
  const desc = marca.descripcion || '';
  document.getElementById('input-descripcion-editor').innerHTML =
    desc.startsWith('<') ? desc : desc.replace(/\n/g, '<br>');
  reinjectImgControls(document.getElementById('input-descripcion-editor'));

  // Pre-fill subcategorías
  const wrap = document.getElementById('nuevas-subcats-wrap');
  (marca.subcategorias || []).forEach((sub, i) => {
    wrap.appendChild(crearFormSubcat('nuevo', { ...sub, fotos: sub.fotos || [], dataId: i }));
  });

  // Foto (same as create, show existing)
  document.getElementById('wnd-imagen-body').innerHTML = `
    <div id="preview-fotos" style="margin-bottom:10px">${(marca.fotos || []).map(url =>
      `<img src="${url}" style="width:65px;height:65px;object-fit:cover;border-radius:5px;" />`
    ).join('')}</div>
    <label class="crear-label">Foto Principal:</label>
    <input type="file" id="input-fotos" accept="image/*" />
    <div id="progreso-caja" class="oculto">
      <div id="progreso-barra"></div>
      <span id="progreso-texto">Subiendo fotos...</span>
    </div>
  `;

  document.getElementById('input-fotos').addEventListener('change', function() {
    const preview = document.getElementById('preview-fotos');
    preview.innerHTML = '';
    Array.from(this.files).forEach(file => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.style.cssText = 'width:65px;height:65px;object-fit:cover;border-radius:5px;';
      preview.appendChild(img);
    });
  });

  // Botones
  document.getElementById('wnd-botones-body').innerHTML = `
    <div class="crear-btns">
      <button id="btn-guardar" class="crear-btn" onclick="guardarEdicion()">Guardar cambios</button>
      <button class="crear-btn" onclick="cerrarModalEdicion()">Cancelar</button>
    </div>
  `;

  // Aplicar posiciones
  if (window.aplicarCrearPos) window.aplicarCrearPos();

  // Mostrar ventanas
  document.querySelectorAll('.ventana-panel').forEach(w => w.classList.remove('oculto'));
  document.getElementById('wnd-cerrar').classList.remove('oculto');
};

window.cerrarModalEdicion = function() {
  const marca = marcaAbierta;
  fotosExistentes = [];
  document.getElementById('nuevas-subcats-wrap').innerHTML = '';
  cerrarPanel();
  if (marca) abrirPanel(marca);
};

window.guardarEdicion = async function() {
  const nombre      = document.getElementById('input-nombre').value.trim();
  const categoria   = document.getElementById('input-categoria').value;
  const descripcion = limpiarEditorHTML(document.getElementById('input-descripcion-editor').innerHTML.trim());
  const archivos    = document.getElementById('input-fotos').files;
  const btnGuardar  = document.getElementById('btn-guardar');
  const tipo        = document.getElementById('input-tipo').value;

  if (!nombre)        { alert('Escribe un nombre para el lugar.'); return; }
  if (!usuarioActual) { alert('Debes iniciar sesión.'); return; }

  btnGuardar.disabled = true;
  btnGuardar.textContent = 'Guardando...';

  try {
    const urlsNuevas = [];
    if (archivos.length > 0) {
      document.getElementById('progreso-caja').classList.remove('oculto');
      for (let i = 0; i < archivos.length; i++) {
        urlsNuevas.push(await subirFotoCloudinary(archivos[i], i, archivos.length));
      }
      document.getElementById('progreso-barra').style.width = '100%';
      document.getElementById('progreso-texto').textContent = 'Fotos subidas ✓';
    }

    const subcategorias = await recogerSubcats('nuevas-subcats-wrap');
    const todasLasFotos = [...fotosExistentes, ...urlsNuevas];

    await updateDoc(doc(db, 'pins', marcaAbierta.id), {
      nombre, categoria, descripcion, tipo,
      fotos: todasLasFotos,
      subcategorias,
      updatedAt: new Date().toISOString(),
    });

    marcaAbierta.nombre      = nombre;
    marcaAbierta.categoria   = categoria;
    marcaAbierta.tipo        = tipo;
    marcaAbierta.descripcion = descripcion;
    marcaAbierta.fotos       = todasLasFotos;
    marcaAbierta.subcategorias = subcategorias;

    cerrarModalEdicion();
    abrirPanel(marcaAbierta);

  } catch (err) {
    console.error('Error al editar:', err);
    alert(err.code === 'permission-denied'
      ? 'No tienes permiso para editar esta marca.'
      : 'Error al guardar. Abre la consola (F12) para ver el detalle.');
  } finally {
    btnGuardar.disabled = false;
    btnGuardar.textContent = 'Guardar cambios';
  }
};

// ══════════════════════════════
//  MODAL TAMAÑO DE ICONO
// ══════════════════════════════

window.abrirModalTamaño = function() {
  if (!marcaAbierta) return;
  const escalaActual = marcaAbierta.escala || 1;
  const slider = document.getElementById('tamaño-slider');
  const label  = document.getElementById('tamaño-valor');
  slider.value = escalaActual;
  label.textContent = parseFloat(escalaActual).toFixed(1) + '×';

  // Preview en tiempo real
  slider.oninput = () => {
    const v = parseFloat(slider.value);
    label.textContent = v.toFixed(1) + '×';
    if (markersPorId[marcaAbierta.id]) {
      markersPorId[marcaAbierta.id].setIcon(iconoPorCategoria(marcaAbierta.categoria, v));
    }
  };

  document.getElementById('modal-tamaño').classList.remove('oculto');
};

window.cerrarModalTamaño = function() {
  // Revertir preview al valor guardado si cancela
  if (marcaAbierta && markersPorId[marcaAbierta.id]) {
    markersPorId[marcaAbierta.id].setIcon(iconoPorCategoria(marcaAbierta.categoria, marcaAbierta.escala || 1));
  }
  document.getElementById('modal-tamaño').classList.add('oculto');
};

window.guardarTamaño = async function() {
  if (!marcaAbierta) return;
  const escala = parseFloat(document.getElementById('tamaño-slider').value);
  const btn = document.getElementById('btn-guardar-tamaño');
  btn.disabled = true;
  btn.textContent = 'Guardando...';
  try {
    await updateDoc(doc(db, 'pins', marcaAbierta.id), { escala });
    marcaAbierta.escala = escala;
    datosPorId[marcaAbierta.id].escala = escala;
    document.getElementById('modal-tamaño').classList.add('oculto');
  } catch (err) {
    console.error('Error al guardar tamaño:', err);
    alert('No se pudo guardar el tamaño.');
    // Revertir icono
    if (markersPorId[marcaAbierta.id]) {
      markersPorId[marcaAbierta.id].setIcon(iconoPorCategoria(marcaAbierta.categoria, marcaAbierta.escala || 1));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Guardar tamaño';
  }
};

// ══════════════════════════════
//  LIGHTBOX
// ══════════════════════════════

window.abrirLightbox = function(url) {
  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.innerHTML = `
    <button id="lightbox-cerrar" onclick="this.parentElement.remove()">✕</button>
    <img src="${url}" />
  `;
  lb.addEventListener('click', e => { if (e.target === lb) lb.remove(); });
  document.body.appendChild(lb);
};

// ══════════════════════════════
//  SUBCATEGORÍAS
// ══════════════════════════════

let subcatCounter = 0;

function crearOpcionesCategorias(valorSeleccionado) {
  return CATEGORIAS.map(c =>
    `<option value="${c}"${c === valorSeleccionado ? ' selected' : ''}>${c}</option>`
  ).join('');
}

function crearFormSubcat(prefijo, datos) {
  const titulo      = datos?.titulo    || '';
  const categoria   = datos?.categoria || CATEGORIAS[0];
  const descripcion = datos?.descripcion || '';
  const fotosExist  = datos?.fotos || [];
  const dataId      = datos?.dataId !== undefined ? datos.dataId : null;

  const wrap = document.createElement('div');
  wrap.className = 'subcat-form';
  if (dataId !== null) wrap.dataset.dataId = dataId;

  // Fotos existentes HTML
  const fotosExistHTML = fotosExist.length > 0
    ? `<label class="subcat-lbl">Fotos actuales</label>
       <div class="subcat-fotos-exist">${fotosExist.map(url => `
         <div class="foto-existente">
           <img src="${url}" />
           <button class="btn-quitar-foto" onclick="this.closest('.foto-existente').remove()">✕</button>
         </div>`).join('')}</div>`
    : '';

  wrap.innerHTML = `
    <div class="subcat-form-cabecera">
      <span class="subcat-form-label">▸ Subcategoría</span>
      <button type="button" class="btn-borrar-subcat-form" onclick="this.closest('.subcat-form').remove()">Borrar subcategoría</button>
    </div>
    <label class="subcat-lbl">Título *</label>
    <input type="text" class="subcat-input-titulo" placeholder="Título de la subcategoría..." value="${titulo.replace(/"/g,'&quot;').replace(/</g,'&lt;')}" />
    <label class="subcat-lbl">Categoría *</label>
    <select class="subcat-input-categoria">${crearOpcionesCategorias(categoria)}</select>
    <label class="subcat-lbl">Tamaño del Icono</label>
    <div class="subcat-tamaño-row">
      <input type="range" class="subcat-tamaño-slider" min="0.5" max="3" step="0.1" value="${datos?.iconoEscala || 1}" />
      <span class="subcat-tamaño-valor">${parseFloat(datos?.iconoEscala || 1).toFixed(1)}×</span>
    </div>
    <label class="subcat-lbl">Descripción</label>
    <div class="editor-toolbar">
      <button type="button" onclick="formatText('bold')" title="Negrita"><b>N</b></button>
      <button type="button" onclick="formatText('italic')" title="Cursiva"><i>C</i></button>
      <button type="button" onclick="formatText('underline')" title="Subrayado"><u>S</u></button>
      <div class="toolbar-sep"></div>
      <select onchange="formatSize(this)" title="Tamaño de texto">
        <option value="3">Normal</option>
        <option value="1">Pequeño</option>
        <option value="5">Grande</option>
        <option value="7">Muy grande</option>
      </select>
      <div class="toolbar-sep"></div>
      <button type="button" class="btn-img-subcat" title="Insertar imagen">🖼️</button>
      <div class="toolbar-sep"></div>
      <button type="button" class="btn-color-texto" onclick="abrirColorTexto(this)" title="Color de texto"><span class="color-preview-texto"></span></button>
      <button type="button" class="btn-color-fondo" onclick="abrirColorFondo(this)" title="Resaltar texto"><span class="color-preview-fondo"></span></button>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="abrirMenuCodigo(this)" title="Código inline o bloque"><span class="ico-code">&lt;/&gt;</span></button>
      <div class="toolbar-sep"></div>
      <button type="button" onclick="abrirModalTabla()" title="Insertar tabla">⊞</button>
    </div>
    <div class="editor-content subcat-editor" contenteditable="true" data-placeholder="Descripción de la subcategoría..."></div>
    ${fotosExistHTML}
  `;

  // Cargar descripción (con o sin HTML)
  const editor = wrap.querySelector('.subcat-editor');
  if (descripcion) {
    editor.innerHTML = descripcion.startsWith('<') ? descripcion : descripcion.replace(/\n/g, '<br>');
    reinjectImgControls(editor);
  }

  // Botón imagen inline en editor de subcategoría
  wrap.querySelector('.btn-img-subcat').addEventListener('click', () => {
    editorActivo = editor;
    editor.focus();
    guardarRangoSeleccion();

    const fi = document.createElement('input');
    fi.type = 'file';
    fi.accept = 'image/*';
    fi.addEventListener('change', async () => {
      const file = fi.files[0];
      if (!file) return;
      try {
        const url = await subirFotoCloudinaryElem(file);
        editorCapturado = editor;
        insertarImgEnEditor(url);
      } catch(err) {
        console.error('Error:', err);
        alert('Error al subir la imagen.');
      }
    });
    fi.click();
  });

  // Slider tamaño icono
  const sliderEl = wrap.querySelector('.subcat-tamaño-slider');
  const sliderValorEl = wrap.querySelector('.subcat-tamaño-valor');
  sliderEl.addEventListener('input', () => {
    sliderValorEl.textContent = parseFloat(sliderEl.value).toFixed(1) + '×';
  });

  return wrap;
}

// Versión de subirFotoCloudinary que acepta elementos DOM en lugar de IDs
async function subirFotoCloudinaryElem(archivo, barraEl, textoEl) {
  const formData = new FormData();
  formData.append('file', archivo);
  formData.append('upload_preset', CLOUDINARY_PRESET);
  if (textoEl) textoEl.textContent = 'Subiendo...';
  if (barraEl) barraEl.style.width = '0%';
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;
  const res  = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) throw new Error(`Error Cloudinary: ${res.status}`);
  const data = await res.json();
  if (barraEl) barraEl.style.width = '100%';
  return data.secure_url;
}

window.añadirSubcatForm = function(prefijo) {
  const containerId = prefijo === 'nuevo' ? 'nuevas-subcats-wrap' : 'edit-subcats-wrap';
  document.getElementById(containerId).appendChild(crearFormSubcat(prefijo, null));
};

// Recoge todas las subcategorías de un contenedor (subiendo fotos si las hay)
async function recogerSubcats(containerId) {
  const container  = document.getElementById(containerId);
  const forms      = container.querySelectorAll('.subcat-form');
  const resultado  = [];

  for (const form of forms) {
    const titulo = form.querySelector('.subcat-input-titulo').value.trim();
    if (!titulo) continue;

    const categoria   = form.querySelector('.subcat-input-categoria').value;
    const descripcion = limpiarEditorHTML(form.querySelector('.subcat-editor').innerHTML.trim());

    // Fotos existentes (las que siguen en el DOM)
    const fotosExistentes = [];
    form.querySelectorAll('.subcat-fotos-exist .foto-existente img').forEach(img => {
      fotosExistentes.push(img.src);
    });

    resultado.push({ titulo, categoria, iconoEscala: parseFloat(form.querySelector('.subcat-tamaño-slider').value) || 1, descripcion, fotos: fotosExistentes });
  }

  return resultado;
}

// Genera el HTML de las franjas de subcategorías para el panel
function renderSubcatsEnPanel(subcats) {
  if (!subcats || subcats.length === 0) return '';

  const puedeEditar = !!usuarioActual;

  return subcats.map((sub, i) => {
    const catEnc  = encodeURIComponent(sub.categoria || 'Sistema Genérico');
    const descHTML = (sub.descripcion || '').startsWith('<')
      ? sub.descripcion
      : (sub.descripcion || '').replace(/\n/g, '<br>');
    const fotosHTML = (sub.fotos || []).length > 0
      ? `<div class="fotos-grid">${sub.fotos.map(url =>
          `<img src="${url}" onclick="abrirLightbox('${url}')" />`).join('')}</div>`
      : '';

    return `
      <div class="subcat-franja" data-index="${i}">
        <div class="subcat-franja-header" onclick="toggleSubcatBody(this)">
          <img class="subcat-franja-icono" src="Iconos/${catEnc}.png" style="width:${Math.round(30*(sub.iconoEscala||1))}px;height:${Math.round(30*(sub.iconoEscala||1))}px;" onerror="this.style.visibility='hidden'" />
          <span class="subcat-franja-titulo"><strong>${sub.titulo}</strong></span>
          <span class="subcat-franja-cat">Categoría: <span>${sub.categoria}</span></span>
          <button type="button" class="btn-subcat-toggle">▼</button>
        </div>
        <div class="subcat-franja-cuerpo oculto">
          <div class="descripcion">${descHTML || '<em>Sin descripción</em>'}</div>
          ${fotosHTML}
        </div>
      </div>`;
  }).join('');
}

window.toggleSubcatBody = function(header) {
  const franja = header.closest('.subcat-franja');
  const cuerpo = franja.querySelector('.subcat-franja-cuerpo');
  const btn    = franja.querySelector('.btn-subcat-toggle');
  const abierto = !cuerpo.classList.contains('oculto');
  cuerpo.classList.toggle('oculto', abierto);
  if (btn) btn.textContent = abierto ? '▼' : '▲';
};

window.abrirEditarSubcat = function(index) {
  if (!marcaAbierta) return;
  const sub = (marcaAbierta.subcategorias || [])[index];
  if (!sub) return;

  let modal = document.getElementById('modal-subcat-edit');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-subcat-edit';
    modal.innerHTML = `
      <div id="modal-subcat-edit-caja">
        <h2>✏️ Editar subcategoría</h2>
        <div id="modal-subcat-edit-inner"></div>
        <button id="btn-guardar-subcat-edit" onclick="guardarSubcatEdit()">💾 Guardar subcategoría</button>
        <button class="btn-secundario" onclick="cerrarModalSubcatEdit()">Cancelar</button>
      </div>`;
    document.body.appendChild(modal);
  }

  modal._subcatIndex = index;
  const inner = document.getElementById('modal-subcat-edit-inner');
  inner.innerHTML = '';
  inner.appendChild(crearFormSubcat('subcat-edit', { ...sub, fotos: sub.fotos || [], dataId: index }));
  modal.classList.remove('oculto');
};

window.cerrarModalSubcatEdit = function() {
  const modal = document.getElementById('modal-subcat-edit');
  if (modal) modal.classList.add('oculto');
};

window.guardarSubcatEdit = async function() {
  const modal     = document.getElementById('modal-subcat-edit');
  const index     = modal._subcatIndex;
  const btnGuardar = document.getElementById('btn-guardar-subcat-edit');

  btnGuardar.disabled = true;
  btnGuardar.textContent = 'Guardando...';

  try {
    const form = document.querySelector('#modal-subcat-edit-inner .subcat-form');
    const titulo = form.querySelector('.subcat-input-titulo').value.trim();
    if (!titulo) { alert('El título es obligatorio.'); return; }

    const categoria   = form.querySelector('.subcat-input-categoria').value;
    const descripcion = limpiarEditorHTML(form.querySelector('.subcat-editor').innerHTML.trim());

    const fotosExistentes = [];
    form.querySelectorAll('.subcat-fotos-exist .foto-existente img').forEach(img => {
      fotosExistentes.push(img.src);
    });

    const fileInput = form.querySelector('.subcat-input-fotos');
    const barraEl   = form.querySelector('.subcat-progreso-barra');
    const textoEl   = form.querySelector('.subcat-progreso-texto');
    const cajaEl    = form.querySelector('.subcat-progreso-caja');
    const urlsNuevas = [];

    if (fileInput.files.length > 0) {
      cajaEl.classList.remove('oculto');
      for (let i = 0; i < fileInput.files.length; i++) {
        if (textoEl) textoEl.textContent = `Subiendo foto ${i+1}/${fileInput.files.length}...`;
        urlsNuevas.push(await subirFotoCloudinaryElem(fileInput.files[i], barraEl, textoEl));
      }
    }

    const subcatActualizada = { titulo, categoria, iconoEscala: parseFloat(form.querySelector('.subcat-tamaño-slider').value) || 1, descripcion, fotos: [...fotosExistentes, ...urlsNuevas] };
    const subcats = [...(marcaAbierta.subcategorias || [])];
    subcats[index] = subcatActualizada;

    await updateDoc(doc(db, 'pins', marcaAbierta.id), { subcategorias: subcats });
    marcaAbierta.subcategorias = subcats;
    datosPorId[marcaAbierta.id].subcategorias = subcats;

    cerrarModalSubcatEdit();
    abrirPanel(marcaAbierta);

  } catch(err) {
    console.error('Error al guardar subcategoría:', err);
    alert('Error al guardar la subcategoría.');
  } finally {
    btnGuardar.disabled  = false;
    btnGuardar.textContent = '💾 Guardar subcategoría';
  }
};

window.borrarSubcatPanel = async function(index) {
  if (!confirm('¿Borrar esta subcategoría?')) return;
  const subcats = [...(marcaAbierta.subcategorias || [])];
  subcats.splice(index, 1);
  await updateDoc(doc(db, 'pins', marcaAbierta.id), { subcategorias: subcats });
  marcaAbierta.subcategorias = subcats;
  datosPorId[marcaAbierta.id].subcategorias = subcats;
  abrirPanel(marcaAbierta);
};
