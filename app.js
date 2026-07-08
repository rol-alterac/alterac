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
  minZoom: -4, maxZoom: 0, zoomSnap: 0.25,
});
mapa.fitBounds(bounds);
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
    minZoom: -4, maxZoom: 0,
    zIndex, bounds, noWrap: true,
    keepBuffer: 0,
    updateWhenIdle: true,
    updateWhenZooming: false
  });
}
const capaFisico     = crearCapaTiles('Mapas/mapa-fisico',   100); // off por defecto
const capaBase       = crearCapaTiles('Mapas/mapa-base',     101).addTo(mapa);
const capaNodos      = crearCapaTiles('Mapas/mapa-nodos',    102); // off por defecto
const capaNombresImg = crearCapaTiles('Mapas/mapa-nombres',  104).addTo(mapa);

const estadoImagenes = {
  fisico: false, politico: true, nodos: false, nombresImg: true
};

// — Capas de marcas —
const grupoPins    = L.layerGroup().addTo(mapa);
const grupoNombres = L.layerGroup().addTo(mapa);
const estadoCapas  = { marcas: true, nombres: true };

// — Filtro por categoría —
const CATEGORIAS = [
  'La Astralis',
  'Armada',
  'Batalla Naval',
  'Capital',
  'Contaminación',
  'Estación Espacial 1',
  'Estación Espacial 2',
  'Estructura Espacial',
  'Fauna Espacial dócil',
  'Fauna Espacial hostil',
  'Fauna Espacial',
  'Flota Civil',
  'Grieta Astral',
  'Hábitat Orbital',
  'Monstruo Espacial',
  'Nave Civil',
  'Peligro',
  'Planeta Bajo Asedio',
  'Planeta Científico',
  'Planeta Colonizado',
  'Planeta Comercial',
  'Planeta Disponible',
  'Planeta Espiritual',
  'Planeta Industrial',
  'Planeta Minero',
  'Planeta Natural',
  'Planeta Ocio',
  'Planeta Ocupado',
  'Planeta Prisión',
  'Planeta Robot',
  'Planeta Urbano',
  'Radiación',
  'Sistema Agujero Negro',
  'Sistema Binario',
  'Sistema Genérico',
  'Sistema Ocupado',
  'Sistema Primario',
  'Sistema Púlsar',
  'Sistema Trinario',
  'Sonda',
  'Símbolo Genérico 1',
];
const categoriasVisibles = new Set(CATEGORIAS);

function debeEstarVisible(datos) {
  return estadoCapas.marcas && categoriasVisibles.has(datos.categoria || 'Sistema');
}

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

// Helper: fila con botón toggle para imagen de fondo
function crearFilaImagen(emoji, label, estadoKey, capaOverlay, inicialActivo = true) {
  const fila = document.createElement('div');
  fila.className = 'capa-fila';

  const btn = document.createElement('button');
  btn.className = inicialActivo ? 'btn-capa activo' : 'btn-capa inactivo';
  btn.textContent = `${emoji} ${label}`;
  btn.addEventListener('click', () => {
    estadoImagenes[estadoKey] = !estadoImagenes[estadoKey];
    if (estadoImagenes[estadoKey]) {
      capaOverlay.addTo(mapa);
      btn.classList.replace('inactivo', 'activo');
    } else {
      mapa.removeLayer(capaOverlay);
      btn.classList.replace('activo', 'inactivo');
    }
  });

  fila.appendChild(btn);
  return fila;
}

capasControl.appendChild(crearFilaImagen('📜', 'Regiones',         'nombresImg', capaNombresImg, true));
capasControl.appendChild(crearFilaImagen('🔵', 'Nodos Espaciales', 'nodos',      capaNodos,      false));
capasControl.appendChild(crearFilaImagen('🗺️', 'Mapa Político',   'politico',   capaBase,       true));
capasControl.appendChild(crearFilaImagen('🌍', 'Mapa Físico',     'fisico',     capaFisico,     false));

// Separador
const capasHr = document.createElement('hr');
capasHr.className = 'capas-sep';
capasControl.appendChild(capasHr);

// — Fila Marcas con desplegable de categorías —
const filaMarcas = document.createElement('div');
filaMarcas.className = 'capa-fila capa-fila-marcas';

const btnMarcas = document.createElement('button');
btnMarcas.className = 'btn-capa activo';
btnMarcas.textContent = '📌 Marcas';
btnMarcas.addEventListener('click', () => {
  estadoCapas.marcas = !estadoCapas.marcas;
  btnMarcas.classList.toggle('activo',   estadoCapas.marcas);
  btnMarcas.classList.toggle('inactivo', !estadoCapas.marcas);
  actualizarVisibilidadMarcas();
});

const btnExpandirCats = document.createElement('button');
btnExpandirCats.className = 'btn-expandir-cats';
btnExpandirCats.textContent = '▾';
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

btnExpandirCats.addEventListener('click', () => {
  const abierto = !dropdownCats.classList.contains('oculto');
  dropdownCats.classList.toggle('oculto', abierto);
  btnExpandirCats.textContent = abierto ? '▾' : '▴';
});

filaMarcas.appendChild(btnMarcas);
filaMarcas.appendChild(btnExpandirCats);
capasControl.appendChild(filaMarcas);
capasControl.appendChild(dropdownCats);

// — Fila Etiquetas —
const filaEtiquetas = document.createElement('div');
filaEtiquetas.className = 'capa-fila';

const btnEtiquetas = document.createElement('button');
btnEtiquetas.className = 'btn-capa activo';
btnEtiquetas.textContent = '🏷️ Etiquetas';
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

filaEtiquetas.appendChild(btnEtiquetas);
capasControl.appendChild(filaEtiquetas);

document.body.appendChild(capasControl);

// ══════════════════════════════
//  AUTENTICACIÓN
// ══════════════════════════════

let usuarioActual = null;

onAuthStateChanged(auth, (usuario) => {
  usuarioActual = usuario;

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
  const infoEl    = document.getElementById('info-usuario');
  const btnLogin  = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  const btnAñadir = document.getElementById('btn-añadir');

  if (usuario) {
    const nombreCompleto = usuario.displayName || '';
    const soloNombre = nombreCompleto.split(' ')[0];

    infoEl.textContent = `👤 ${soloNombre || usuario.email}`;

    btnLogin.classList.add('oculto');
    btnLogout.classList.remove('oculto');
    btnAñadir.classList.remove('oculto');
  } else {
    infoEl.textContent = '👁️ Solo lectura';
    btnLogin.classList.remove('oculto');
    btnLogout.classList.add('oculto');
    btnAñadir.classList.add('oculto');
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

window.activarModoPin = function() {
  if (!usuarioActual) { alert('Debes iniciar sesión.'); return; }
  modoAñadirPin = true;
  document.getElementById('btn-añadir').classList.add('oculto');
  document.getElementById('instruccion').classList.remove('oculto');
  mapa.getContainer().style.cursor = 'crosshair';
};

window.cancelarModoPin = function() {
  modoAñadirPin = false;
  if (usuarioActual) document.getElementById('btn-añadir').classList.remove('oculto');
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

    const isEdit  = editorCapturado && editorCapturado.id === 'edit-descripcion-editor';
    const barraId = isEdit ? 'edit-progreso-barra' : 'progreso-barra';
    const textoId = isEdit ? 'edit-progreso-texto' : 'progreso-texto';
    const cajaEl  = document.getElementById(isEdit ? 'edit-progreso-caja' : 'progreso-caja');

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
  document.getElementById('modal').classList.remove('oculto');
  document.getElementById('input-nombre').value = '';
  document.getElementById('input-categoria').value = 'Sistema';
  document.getElementById('input-descripcion-editor').innerHTML = '';
  document.getElementById('input-fotos').value = '';
  document.getElementById('preview-fotos').innerHTML = '';
  document.getElementById('progreso-caja').classList.add('oculto');
  document.getElementById('progreso-barra').style.width = '0%';
  document.getElementById('nuevas-subcats-wrap').innerHTML = '';
};

window.cerrarModal = function() {
  document.getElementById('modal').classList.add('oculto');
  coordsNuevoPin = null;
  document.getElementById('nuevas-subcats-wrap').innerHTML = '';
};

document.getElementById('input-fotos').addEventListener('change', function() {
  const preview = document.getElementById('preview-fotos');
  preview.innerHTML = '';
  Array.from(this.files).forEach(file => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    preview.appendChild(img);
  });
});

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
    btnGuardar.textContent = '💾 Guardar marca';
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
  const contenido = document.getElementById('panel-contenido');

  // Soporte legacy: si la descripción es texto plano (sin etiquetas HTML), convertir saltos
  const desc = marca.descripcion || '';
  const descHTML = desc.startsWith('<') ? desc : desc.replace(/\n/g, '<br>');

  const fotosHTML = (marca.fotos || []).length > 0
    ? `<div class="fotos-grid">${marca.fotos.map(url =>
        `<img src="${url}" onclick="abrirLightbox('${url}')" />`).join('')}</div>`
    : '';

  const btnsAccion = usuarioActual
    ? `<div class="btns-accion">
        <button class="btn-editar" onclick="abrirModalEdicion()">✏️ Editar</button>
        <button class="btn-mover"  onclick="activarModoMover()">📍 Cambiar Posición</button>
        <button class="btn-tamaño" onclick="abrirModalTamaño()">🔍 Tamaño</button>
        <button class="btn-borrar" onclick="borrarMarca('${marca.id}')">🗑️ Borrar</button>
      </div>`
    : '';

  const subcatsHTML = renderSubcatsEnPanel(marca.subcategorias || []);

  contenido.innerHTML = `
    <h2>${marca.nombre}</h2>
    ${marca.categoria ? `<p class="categoria"><strong>Categoría:</strong> ${marca.categoria}</p>` : ''}
    <div class="descripcion">${descHTML || '<em>Sin descripción</em>'}</div>
    ${fotosHTML}
    ${subcatsHTML}
	${marca.autor ? `<p class="autor">✍️ ${marca.autor.split(' ')[0]}</p>` : ''}
    ${btnsAccion}
  `;

  // Iconos de subcategorías en el encabezado del panel (a la izquierda de la X)
  const iconsEl = document.getElementById('panel-subcat-icons');
  iconsEl.innerHTML = '';
  const subcats = marca.subcategorias || [];
  if (subcats.length > 0) {
    const uniqueCats = [...new Set(subcats.map(s => s.categoria).filter(Boolean))].slice(0, 4);
    uniqueCats.forEach(cat => {
      const img = document.createElement('img');
      img.src = `Iconos/${encodeURIComponent(cat)}.png`;
      img.className = 'panel-subcat-icon';
      img.title = cat;
      img.onerror = () => { img.style.display = 'none'; };
      iconsEl.appendChild(img);
    });
  }

  document.getElementById('panel').classList.remove('oculto');
};

window.cerrarPanel = function() {
  document.getElementById('panel').classList.add('oculto');
  document.getElementById('panel-subcat-icons').innerHTML = '';
  marcaAbierta = null;
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
  document.getElementById('panel').classList.add('oculto');

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

  document.getElementById('edit-nombre').value = marca.nombre;
  document.getElementById('edit-categoria').value = marca.categoria || 'Sistema';

  // Cargar HTML rico (o convertir texto plano legacy)
  const desc = marca.descripcion || '';
  document.getElementById('edit-descripcion-editor').innerHTML =
    desc.startsWith('<') ? desc : desc.replace(/\n/g, '<br>');
  reinjectImgControls(document.getElementById('edit-descripcion-editor'));

  document.getElementById('edit-fotos-nuevas').value = '';
  document.getElementById('edit-preview-nuevas').innerHTML = '';
  document.getElementById('edit-progreso-caja').classList.add('oculto');
  document.getElementById('edit-progreso-barra').style.width = '0%';

  renderizarFotosExistentes();

  // Cargar subcategorías existentes
  const editWrap = document.getElementById('edit-subcats-wrap');
  editWrap.innerHTML = '';
  (marca.subcategorias || []).forEach((sub, i) => {
    editWrap.appendChild(crearFormSubcat('edit', { ...sub, fotos: sub.fotos || [], dataId: i }));
  });

  document.getElementById('modal-edicion').classList.remove('oculto');
};

function renderizarFotosExistentes() {
  const container = document.getElementById('edit-fotos-existentes');
  if (fotosExistentes.length === 0) {
    container.innerHTML = '<p style="color:#555;font-size:0.82rem;margin-top:4px;">Sin fotos</p>';
    return;
  }
  container.innerHTML = fotosExistentes.map((url, i) => `
    <div class="foto-existente">
      <img src="${url}" />
      <button class="btn-quitar-foto" onclick="quitarFotoExistente(${i})">✕</button>
    </div>
  `).join('');
}

window.quitarFotoExistente = function(indice) {
  fotosExistentes.splice(indice, 1);
  renderizarFotosExistentes();
};

window.cerrarModalEdicion = function() {
  document.getElementById('modal-edicion').classList.add('oculto');
  fotosExistentes = [];
  document.getElementById('edit-subcats-wrap').innerHTML = '';
};

document.getElementById('edit-fotos-nuevas').addEventListener('change', function() {
  const preview = document.getElementById('edit-preview-nuevas');
  preview.innerHTML = '';
  Array.from(this.files).forEach(file => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    preview.appendChild(img);
  });
});

window.guardarEdicion = async function() {
  const nombre         = document.getElementById('edit-nombre').value.trim();
  const categoria      = document.getElementById('edit-categoria').value;
  const descripcion    = limpiarEditorHTML(document.getElementById('edit-descripcion-editor').innerHTML.trim());
  const archivosNuevos = document.getElementById('edit-fotos-nuevas').files;
  const btnGuardar     = document.getElementById('btn-guardar-edicion');

  if (!nombre)        { alert('Escribe un nombre para el lugar.'); return; }
  if (!usuarioActual) { alert('Debes iniciar sesión.'); return; }

  btnGuardar.disabled = true;
  btnGuardar.textContent = 'Guardando...';

  try {
    const urlsFotosNuevas = [];
    if (archivosNuevos.length > 0) {
      document.getElementById('edit-progreso-caja').classList.remove('oculto');
      for (let i = 0; i < archivosNuevos.length; i++) {
        urlsFotosNuevas.push(await subirFotoCloudinary(
          archivosNuevos[i], i, archivosNuevos.length,
          'edit-progreso-barra', 'edit-progreso-texto'
        ));
      }
      document.getElementById('edit-progreso-barra').style.width = '100%';
      document.getElementById('edit-progreso-texto').textContent = 'Fotos subidas ✓';
    }

    const todasLasFotos = [...fotosExistentes, ...urlsFotosNuevas];
    const subcategorias = await recogerSubcats('edit-subcats-wrap');

    await updateDoc(doc(db, 'pins', marcaAbierta.id), { nombre, categoria, descripcion, fotos: todasLasFotos, subcategorias, updatedAt: new Date().toISOString() });

    marcaAbierta.nombre      = nombre;
    marcaAbierta.categoria   = categoria;
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
    btnGuardar.textContent = '💾 Guardar cambios';
  }
};

// ══════════════════════════════
//  RESIZE DEL PANEL
// ══════════════════════════════

(function iniciarResize() {
  const panel  = document.getElementById('panel');
  const handle = document.getElementById('panel-resize-handle');
  let arrastrando = false;

  handle.addEventListener('mousedown', (e) => {
    arrastrando = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!arrastrando) return;
    const rect     = panel.getBoundingClientRect();
    const newWidth = e.clientX - rect.left;
    if (newWidth >= 260 && newWidth <= 860) {
      panel.style.width = newWidth + 'px';
    }
  });

  document.addEventListener('mouseup', () => {
    if (!arrastrando) return;
    arrastrando = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

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
      <button type="button" class="btn-borrar-subcat-form" onclick="this.closest('.subcat-form').remove()">🗑️ Borrar subcategoría</button>
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
    <label class="subcat-lbl">Fotos de pie de página</label>
    <input type="file" class="subcat-input-fotos" accept="image/*" multiple />
    <div class="subcat-preview-fotos"></div>
    <div class="subcat-progreso-caja oculto">
      <div class="subcat-progreso-barra"></div>
      <span class="subcat-progreso-texto">Subiendo...</span>
    </div>
    <div class="subcat-orden-btns">
      <button type="button" class="btn-subcat-orden btn-subcat-subir" title="Subir subcategoría">▲</button>
      <button type="button" class="btn-subcat-orden btn-subcat-bajar" title="Bajar subcategoría">▼</button>
    </div>
  `;

  // Cargar descripción (con o sin HTML)
  const editor = wrap.querySelector('.subcat-editor');
  if (descripcion) {
    editor.innerHTML = descripcion.startsWith('<') ? descripcion : descripcion.replace(/\n/g, '<br>');
    reinjectImgControls(editor);
  }

  // Preview fotos nuevas
  wrap.querySelector('.subcat-input-fotos').addEventListener('change', function() {
    const preview = wrap.querySelector('.subcat-preview-fotos');
    preview.innerHTML = '';
    Array.from(this.files).forEach(file => {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      preview.appendChild(img);
    });
  });

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
      const cajaEl  = wrap.querySelector('.subcat-progreso-caja');
      const barraEl = wrap.querySelector('.subcat-progreso-barra');
      const textoEl = wrap.querySelector('.subcat-progreso-texto');
      cajaEl.classList.remove('oculto');
      try {
        const url = await subirFotoCloudinaryElem(file, barraEl, textoEl);
        textoEl.textContent = 'Imagen insertada ✓';
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

  // Botones orden arriba/abajo
  wrap.querySelector('.btn-subcat-subir').addEventListener('click', () => {
    const container = wrap.parentElement;
    const forms = [...container.querySelectorAll(':scope > .subcat-form')];
    const i = forms.indexOf(wrap);
    if (i > 0) container.insertBefore(wrap, forms[i - 1]);
  });
  wrap.querySelector('.btn-subcat-bajar').addEventListener('click', () => {
    const container = wrap.parentElement;
    const forms = [...container.querySelectorAll(':scope > .subcat-form')];
    const i = forms.indexOf(wrap);
    if (i < forms.length - 1) container.insertBefore(forms[i + 1], wrap);
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

    // Subir fotos nuevas
    const fileInput = form.querySelector('.subcat-input-fotos');
    const barraEl   = form.querySelector('.subcat-progreso-barra');
    const textoEl   = form.querySelector('.subcat-progreso-texto');
    const cajaEl    = form.querySelector('.subcat-progreso-caja');
    const urlsNuevas = [];

    if (fileInput.files.length > 0) {
      cajaEl.classList.remove('oculto');
      for (let i = 0; i < fileInput.files.length; i++) {
        if (textoEl) textoEl.textContent = `Subiendo foto ${i+1}/${fileInput.files.length}...`;
        if (barraEl) barraEl.style.width = Math.round((i / fileInput.files.length) * 100) + '%';
        urlsNuevas.push(await subirFotoCloudinaryElem(fileInput.files[i], barraEl, textoEl));
      }
      if (textoEl) textoEl.textContent = 'Fotos subidas ✓';
    }

    resultado.push({ titulo, categoria, iconoEscala: parseFloat(form.querySelector('.subcat-tamaño-slider').value) || 1, descripcion, fotos: [...fotosExistentes, ...urlsNuevas] });
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
