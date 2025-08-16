// PDF.js worker (necessario quando pdf.min.js è caricato via CDN)
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

// ===== Config iniziale =====
const params = new URLSearchParams(location.search);
const srcParam  = params.get('src');
const pageParam = parseInt(params.get('page') || '1', 10);

// IMPORTANTE: qui uso il nome esatto del tuo file (V maiuscola)
const FALLBACK_PDF_URL = './Volantino.pdf';

const ORIGINAL_URL = srcParam || FALLBACK_PDF_URL || '';

// Normalizza URL Drive/Dropbox in diretto scaricabile (utile se userai ?src=)
function normalizeUrl(u){
  try{
    const url = new URL(u);
    if(url.hostname.includes('drive.google.com')){
      const m = url.pathname.match(/\/file\/d\/([^/]+)/);
      if(m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
      if(url.pathname.includes('/open') && url.searchParams.get('id'))
        return `https://drive.google.com/uc?export=download&id=${url.searchParams.get('id')}`;
      if(url.pathname.includes('/uc')) return u;
    }
    if(url.hostname.includes('dropbox.com')){
      url.searchParams.set('raw','1'); url.searchParams.delete('dl'); return url.toString();
    }
    return u;
  }catch{ return u; }
}

const PDF_URL = ORIGINAL_URL ? normalizeUrl(ORIGINAL_URL) : '';

// ===== Stato / riferimenti DOM =====
const stage   = document.getElementById('stage');
const sheets  = { A: document.getElementById('sheetA'), B: document.getElementById('sheetB') };
const canvases= { A: document.getElementById('canvasA'), B: document.getElementById('canvasB') };

const pageCountEl = document.getElementById('pageCount');
const pageInput   = document.getElementById('pageInput');

const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

const fsBtn      = document.getElementById('fullscreenBtn');
const zoomInBtn  = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomLabel  = document.getElementById('zoomLabel');
const fitModeSel = document.getElementById('fitMode');

const loadingEl = document.getElementById('loading');
const errorBox  = document.getElementById('errorBox');
const envHint   = document.getElementById('envHint');

let pdfDoc=null, currentPage=1, totalPages=0, active='A', animating=false;
let zoom=1;                 // zoom utente
let fitMode='fit-width';
let resizeRaf=null;

if (window.matchMedia('(pointer: coarse)').matches) { fitMode='fit-width'; }
fitModeSel.value = fitMode;

if (location.protocol === 'file:') {
  envHint.innerHTML = 'Stai aprendo la pagina da <b>file://</b>. Per link remoti usa un server locale (es. <code>npx serve</code>) o pubblica online.';
}

function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }

// Calcolo scala: adatta + zoom, con limite sicurezza pixel
function computeScale(page){
  const containerW = stage.clientWidth;
  const containerH = stage.clientHeight;
  const baseViewport = page.getViewport({ scale: 1 });
  let fit = 1;
  if(fitMode==='fit-width'){
    fit = containerW / baseViewport.width;
  } else {
    fit = Math.min(containerW / baseViewport.width, containerH / baseViewport.height);
  }
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  let scale = fit * zoom * dpr;

  // limita pixel totali per evitare glitch/memoria
  const maxPixels = 8e6; // ~8MP
  const estW = baseViewport.width * scale;
  const estH = baseViewport.height * scale;
  if(estW*estH > maxPixels){
    const factor = Math.sqrt(maxPixels / (estW*estH));
    scale *= factor;
  }
  return { scale, cssW: baseViewport.width*fit, cssH: baseViewport.height*fit };
}

async function renderPageToCanvas(pageNumber, canvasEl){
  const page = await pdfDoc.getPage(pageNumber);
  const { scale, cssW, cssH } = computeScale(page);
  const viewport = page.getViewport({ scale });
  const ctx = canvasEl.getContext('2d', { alpha:false });

  canvasEl.width = Math.floor(viewport.width);
  canvasEl.height = Math.floor(viewport.height);
  canvasEl.style.width = `${Math.floor(cssW)}px`;
  canvasEl.style.height = `${Math.floor(cssH)}px`;

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Aggiorna aspect ratio dello stage alla prima render (aiuta layout stabile)
  stage.style.aspectRatio = `${Math.floor(viewport.width)}/${Math.floor(viewport.height)}`;
}

function updateUi(){
  prevBtn.disabled = currentPage<=1 || animating;
  nextBtn.disabled = currentPage>=totalPages || animating;
  pageInput.value  = String(currentPage);
  pageCountEl.textContent = String(totalPages||'–');
  zoomLabel.textContent   = `${Math.round(zoom*100)}%`;
}

async function goTo(pageNumber, direction){
  if(!pdfDoc) return;
  const target = clamp(pageNumber,1,totalPages);
  if(target===currentPage || animating) return;
  animating = true; updateUi();

  const nextKey   = active==='A' ? 'B' : 'A';
  const currSheet = sheets[active];
  const nextSheet = sheets[nextKey];

  currSheet.classList.add('current');
  nextSheet.classList.add('next');

  await renderPageToCanvas(target, canvases[nextKey]);

  stage.classList.remove('anim-left','anim-right');
  stage.classList.add(direction==='forward' ? 'anim-left' : 'anim-right');

  const onAnimEnd = () =>{
    stage.removeEventListener('animationend', onAnimEnd, true);
    currSheet.classList.remove('current');
    nextSheet.classList.remove('next');
    stage.classList.remove('anim-left','anim-right');
    active = nextKey; currentPage = target; animating = false; updateUi(); preloadAround();

    // aggiorna URL (pagina) senza ricaricare
    const q = new URLSearchParams(location.search);
    q.set('page', String(currentPage));
    history.replaceState(null,'', `${location.pathname}?${q.toString()}`);
  };
  stage.addEventListener('animationend', onAnimEnd, true);
}

function next(){ goTo(currentPage+1,'forward'); }
function prev(){ goTo(currentPage-1,'back'); }

let preloadTimeout; 
async function preloadAround(){
  clearTimeout(preloadTimeout);
  preloadTimeout = setTimeout(async()=>{
    try{
      const ni = currentPage+1; const other = active==='A'?'B':'A';
      if(ni<=totalPages) await renderPageToCanvas(ni, canvases[other]);
    }catch{}
  }, 250);
}

// === Eventi UI ===
prevBtn.addEventListener('click', prev);
nextBtn.addEventListener('click', next);

pageInput.addEventListener('change', ()=>{
  const val = clamp(parseInt(pageInput.value||'1',10),1,totalPages);
  goTo(val, val>currentPage?'forward':'back');
});

window.addEventListener('keydown', e=>{
  if(e.key==='ArrowRight'){ e.preventDefault(); next(); }
  if(e.key==='ArrowLeft'){  e.preventDefault(); prev(); }
  if(e.key==='+'){ zoomIn(); }
  if(e.key==='-'){ zoomOut(); }
  if(e.key==='0'){ resetZoom(); }
});

fsBtn.addEventListener('click', ()=>{
  const el = document.documentElement;
  if(!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
});

function zoomIn(){ zoom = clamp(zoom*1.15, 0.5, 3); rerenderActive(); }
function zoomOut(){ zoom = clamp(zoom/1.15, 0.5, 3); rerenderActive(); }
function resetZoom(){ zoom = 1; rerenderActive(); }
zoomInBtn.addEventListener('click', zoomIn);
zoomOutBtn.addEventListener('click', zoomOut);
fitModeSel.addEventListener('change', ()=>{ fitMode = fitModeSel.value; rerenderActive(); });

function rerenderActive(){
  updateUi();
  renderPageToCanvas(currentPage, canvases[active]);
}

function onResize(){
  if(resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(()=>{ if(pdfDoc) rerenderActive(); });
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);

// === Caricamento PDF ===
async function loadFromUrl(url){
  if(!url){ showError('Nessun URL PDF impostato.'); return; }
  try{
    showLoading(true);
    // Probe HEAD (stesso dominio -> ok), mostra 404 se percorso errato
    try{
      const head = await fetch(url,{method:'HEAD',cache:'no-store'});
      if(!head.ok) throw new Error(`HTTP ${head.status} ${head.statusText}`);
    }catch{ /* alcuni host non consentono HEAD; si tenta comunque */ }

    const doc = await pdfjsLib.getDocument({
      url, withCredentials:false,
      disableRange:true, disableStream:true // compatibilità più ampia
    }).promise;

    pdfDoc = doc; totalPages = doc.numPages; currentPage = clamp(pageParam||1,1,totalPages);
    pageCountEl.textContent = String(totalPages);
    await renderPageToCanvas(currentPage, canvases[active]);
    showLoading(false); updateUi(); preloadAround();
  }catch(err){ console.error(err); showError(formatError(err, url)); }
}

function showLoading(v){ loadingEl.hidden = !v; if(v) errorBox.hidden=true; }
function showError(html){ errorBox.innerHTML = html; errorBox.hidden = false; showLoading(false); }

function formatError(err,url){
  const isFetch = /Failed to fetch/i.test(String(err?.message||err));
  const tips = [];
  if(isFetch) tips.push('Problema di rete o CORS durante il download.');
  tips.push('Verifica che <code>Volantino.pdf</code> sia nello stesso percorso di <code>index.html</code> e che il nome coincida (maiuscole/minuscole).');
  return `Errore nel caricamento del PDF. ${tips.join(' ')}`;
}

// === Test normalizer (opzionale, visibile in <details>) ===
(function runTests(){
  const ul = document.getElementById('testResults');
  if(!ul) return;
  const cases=[
    {name:'Drive /file/d/ID/view', in:'https://drive.google.com/file/d/1TESTID234/view?usp=sharing', out:'https://drive.google.com/uc?export=download&id=1TESTID234'},
    {name:'Drive open?id=ID', in:'https://drive.google.com/open?id=ABCDEF', out:'https://drive.google.com/uc?export=download&id=ABCDEF'},
    {name:'Dropbox dl=0', in:'https://www.dropbox.com/s/xyz/file.pdf?dl=0', out:'https://www.dropbox.com/s/xyz/file.pdf?raw=1'},
    {name:'Già /uc?export=download', in:'https://drive.google.com/uc?export=download&id=SAME', out:'https://drive.google.com/uc?export=download&id=SAME'}
  ];
  let pass=0; const li=s=>{const el=document.createElement('li'); el.innerHTML=s; return el;};
  cases.forEach(tc=>{ const got=normalizeUrl(tc.in); const ok=got===tc.out; if(ok) pass++; ul.appendChild(li(`${ok?'✅':'❌'} <b>${tc.name}</b> → <code>${got}</code>`)); });
  ul.appendChild(li(`<b>Totale:</b> ${pass}/${cases.length} passati`));
})();

// Avvio
loadFromUrl(PDF_URL);
