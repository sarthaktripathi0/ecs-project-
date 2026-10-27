'use strict';
/* ================= config & state ================= */
const CFG = { step: 0.5, capMAh: 4000, iCC: 2000, ocMA: 3000, ovV: 5.25, idleMA: 400,
  eff: 0.92, sampleS: 5, histMax: 720, logMax: 300, statusS: 60 };
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const S = {}; // the single state object
S.ports = [{}, {}, {}]; // placeholder so the builders below can iterate before fresh() runs

function fresh() {
  Object.assign(S, {
    t: 0, acc: 0, samp: 0, stat: 0, paused: S.paused ?? false, speed: S.speed ?? 1,
    mode: S.mode ?? 'health', hi: S.hi ?? 80, lo: S.lo ?? 20, timerMin: S.timerMin ?? 30, cutMA: S.cutMA ?? 150,
    faults: { brown: false, nocc: false, oc: false, miscal: false },
    mcu: true, vin: 12, vout: 5, hist: [], log: [], logDirty: true, tab: S.tab ?? 'chart',
    ports: [0, 1, 2].map(k => ({ pin: 'D' + (k + 2), phone: k < 2, soc: [35, 72, 50][k], relay: false,
      manual: false, i: 0, wh: 0, hold: false, done: false, trip: '', timer: 1800, warned: false, status: 'IDLE' }))
  });
  S.ports.forEach(p => p.timer = S.timerMin * 60);
  log('Charging station v1.0 boot, VIN=12.00V');
  log(`INA219 x3 OK (0x40,0x41,0x44), relays LOW, mode=${S.mode.toUpperCase()}`);
}

/* ================= pure model functions ================= */
// Constant current to 80 %, then power-law taper toward 0 mA at 100 % (like a Li-ion CV phase).
const chargeCurrent = soc => soc >= 100 ? 0 : soc < 80 ? CFG.iCC : CFG.iCC * Math.pow((100 - soc) / 20, 1.2);
const socGain = (mA, dt) => mA * dt / 3600 / CFG.capMAh * 100 * CFG.eff;
const socDrain = dt => CFG.idleMA * dt / 3600 / CFG.capMAh * 100;
// LM2596 needs ~1.5 V headroom; Nano VIN needs >= 7 V.
const supply = f => { const vin = f.brown ? 6.2 : 12, set = f.miscal ? 5.4 : 5;
  return { vin, mcu: vin >= 7, vout: Math.max(0, Math.min(set, vin - 1.5)) }; };
const total = k => S.ports.reduce((a, p) => a + p[k], 0);

function log(m) {
  S.log.push(`[${String(Math.round(S.t)).padStart(8)}] ${m}`);
  if (S.log.length > CFG.logMax) S.log.shift();
  S.logDirty = true;
}
function resetPort(p) { p.hold = false; p.done = false; p.trip = ''; p.warned = false; p.timer = S.timerMin * 60; }

/* ================= simulation step (fixed dt, no rendering) ================= */
function step(dt) {
  S.t += dt * 1000;
  const sp = supply(S.faults), was = S.mcu;
  S.vin = sp.vin; S.vout = sp.vout;
  if (was && !sp.mcu) { // brownout: Nano resets, relay coils lose drive
    log(`!! VIN=${sp.vin.toFixed(1)}V < 7V: Nano brownout reset, relays drop out`);
    S.ports.forEach(p => { p.relay = false; p.i = 0; });
  }
  if (!was && sp.mcu) { log(`BOOT ok, VIN=${sp.vin.toFixed(2)}V, mode=${S.mode.toUpperCase()}`); S.ports.forEach(resetPort); }
  S.mcu = sp.mcu;
  S.ports.forEach((p, k) => { if (S.mcu) control(p, k, dt); physics(p, k, dt); });

  S.samp += dt;
  if (S.samp >= CFG.sampleS) { S.samp = 0;
    S.hist.push({ t: S.t / 1000, soc: S.ports.map(p => p.soc), i: total('i') });
    if (S.hist.length > CFG.histMax) S.hist.shift(); }
  S.stat += dt;
  if (S.stat >= CFG.statusS) { S.stat = 0;
    if (S.mcu) S.ports.forEach((p, k) => p.phone && log(`P${k + 1} soc~${p.soc.toFixed(1)}% I=${Math.round(p.i)}mA V=${S.vout.toFixed(2)} ${p.status}`)); }
}

// What the Arduino sketch would do: decide relay state from mode + INA219 readings.
function control(p, k, dt) {
  const n = k + 1;
  if (S.vout > CFG.ovV && !p.trip) { p.trip = 'OVERVOLT';
    log(`P${n} INA219 bus ${S.vout.toFixed(2)}V > ${CFG.ovV}V -> relay OPEN, latched`); }
  let want = false;
  if (!p.trip) {
    if (S.mode === 'manual') want = p.manual;
    else if (p.phone) {
      if (S.mode === 'health') { // hysteresis band
        const h = p.hold;
        if (p.soc >= S.hi) p.hold = true; else if (p.soc <= S.lo) p.hold = false;
        if (h !== p.hold) log(`P${n} soc ${p.soc.toFixed(0)}% -> ${p.hold ? 'HOLD (cut)' : 'RESUME'}`);
        want = !p.hold;
      } else if (S.mode === 'timer') {
        if (p.timer > 0) { p.timer -= dt; if (p.timer <= 0) { p.timer = 0; log(`P${n} timer elapsed -> relay OPEN`); } }
        want = p.timer > 0;
      } else if (S.mode === 'full') { // auto cut-off at end of taper
        if (!p.done && p.relay && p.soc >= 90 && p.i < S.cutMA) { p.done = true;
          log(`P${n} I=${Math.round(p.i)}mA < ${S.cutMA}mA -> taper cut-off, DONE`); }
        want = !p.done;
      }
    }
  }
  if (want !== p.relay) { p.relay = want;
    log(`P${n} digitalWrite(${p.pin}, ${want ? 'HIGH' : 'LOW'}) relay ${want ? 'CLOSED' : 'OPEN'}`); }
}

// What the hardware does: current draw, overcurrent trip, battery change.
function physics(p, k, dt) {
  const n = k + 1; let i = 0;
  if (p.relay && S.mcu) {
    if (S.faults.oc) i = 3600; // short on VBUS
    else if (p.phone && !S.faults.nocc && S.vout >= 4.5) i = chargeCurrent(p.soc);
  }
  if (i > CFG.ocMA) { p.trip = 'OVERCURRENT'; p.relay = false;
    log(`P${n} INA219 I=${Math.round(i)}mA > ${CFG.ocMA}mA -> relay OPEN, latched`); i = 0; }
  if (i > 0) i *= 1 + (Math.random() - 0.5) * 0.01; // sensor noise
  p.i = i;
  if (p.relay && p.phone && S.faults.nocc && !p.warned) { p.warned = true;
    log(`P${n} WARN I=0mA with relay closed: check 5.1k CC pull-downs`); }
  if (!p.relay || !S.faults.nocc) p.warned = false;
  if (p.phone) {
    p.soc = i > 0 ? Math.min(100, p.soc + socGain(i, dt)) : Math.max(0, p.soc - socDrain(dt));
    p.wh += S.vout * i / 1000 * dt / 3600;
  }
  p.status = statusOf(p);
}

function statusOf(p) {
  if (!S.mcu) return p.phone ? 'MCU OFF' : 'EMPTY';
  if (p.trip) return p.trip;
  if (!p.phone) return p.relay ? 'LIVE NO LOAD' : 'EMPTY';
  if (p.relay) return p.i === 0 ? 'NO CC' : p.soc >= 80 ? 'TAPER' : 'CC CHARGE';
  if (S.mode === 'health') return p.hold ? 'HOLD' : 'IDLE';
  if (S.mode === 'timer') return 'TIMER END';
  if (S.mode === 'full') return p.done ? 'DONE' : 'IDLE';
  return 'RELAY OFF';
}

/* ================= schematic (built once, updated per frame) ================= */
const svg = $('#sch'), W = {}, T = {}, ARM = [], PH = [];
const el = (t, a, p = svg, x) => { const e = document.createElementNS('http://www.w3.org/2000/svg', t);
  for (const k in a) e.setAttribute(k, a[k]); if (x != null) e.textContent = x; p.appendChild(e); return e; };
const wire = (id, d, c = '') => W[id] = el('path', { d, class: 'wire ' + c });
const txt = (x, y, s, c = 'lbl') => el('text', { x, y, class: c }, svg, s);
const part = (x, y, w, h, s) => { el('rect', { x, y, width: w, height: h, class: 'part' }); if (s) txt(x + w / 2, y + 13, s, 'lbl c b'); };
const dot = (x, y) => el('circle', { cx: x, cy: y, r: 2.5, class: 'dot' });
const gnd = (x, y) => el('path', { d: `M${x} ${y}v5M${x - 7} ${y + 5}h14M${x - 4} ${y + 8}h8M${x - 1.5} ${y + 11}h3`, class: 'sym' });

(function buildSchematic() {
  wire('p12', 'M80 160H110V60H140M110 160V250H140');
  wire('pg', 'M80 200H100V100H140M100 200V290H140');
  wire('p5', 'M230 250H290M290 50V300');
  el('path', { d: 'M230 290H250', class: 'wire' }); gnd(250, 290);
  part(10, 140, 70, 80, '12V DC'); part(140, 40, 90, 120, 'ARDUINO NANO'); part(140, 230, 90, 80, 'LM2596');
  [[110, 160], [100, 200], [290, 250], [140, 60], [140, 100], [140, 250], [140, 290], [230, 250], [230, 290]].forEach(([x, y]) => dot(x, y));
  txt(86, 154, '+12V'); txt(86, 214, 'GND'); txt(112, 54, '+12V'); txt(236, 244, '+5V'); txt(296, 44, '+5V'); txt(256, 304, 'GND');
  txt(146, 64, 'VIN'); txt(146, 104, 'GND'); txt(146, 254, 'IN+'); txt(146, 294, 'IN-');
  txt(224, 254, 'OUT+', 'lbl e'); txt(224, 294, 'OUT-', 'lbl e');
  ['D2', 'D3', 'D4'].forEach((d, i) => { txt(224, 64 + 20 * i, d, 'lbl e'); dot(230, 60 + 20 * i); });
  T.vin = txt(45, 200, '', 'lbl c'); T.vout = txt(185, 326, '', 'lbl c'); T.mcu = txt(185, 150, '', 'lbl c');

  S.ports.forEach((p, k) => {
    const sy = 50 + 125 * k, c = k + 1;
    wire('b' + k, `M290 ${sy}H330`); wire('v' + k, `M400 ${sy}H520`);
    wire('d' + k, `M230 ${60 + 20 * k}H${300 + 6 * k}V${sy + 28}H320`, 'sig');
    dot(290, sy); dot(330, sy); dot(400, sy);
    const a = el('g', { class: 'arm', style: `transform-origin:330px ${sy}px` });
    el('line', { x1: 330, y1: sy, x2: 398, y2: sy }, a); ARM.push(a);
    txt(324, sy - 8, 'COM'); txt(398, sy - 8, 'NO');
    part(320, sy + 16, 52, 24, 'K' + c); el('path', { d: `M372 ${sy + 28}H384`, class: 'wire' }); gnd(384, sy + 28);
    part(520, sy - 14, 110, 84, 'USB-C J' + c);
    [['VBUS', 0], ['CC1', 20], ['CC2', 40], ['GND', 60]].forEach(([n, o]) => { txt(526, sy + o + 3, n); dot(520, sy + o); });
    [20, 40].forEach(o => { const y = sy + o;
      el('path', { d: `M520 ${y}H500M460 ${y}H446`, class: 'wire' });
      el('rect', { x: 460, y: y - 4, width: 40, height: 8, class: 'part res' }); txt(463, y - 7, '5.1k'); gnd(446, y);
      el('path', { d: `M474 ${y - 7}l12 14M486 ${y - 7}l-12 14`, class: 'xmark' }); });
    el('path', { d: `M520 ${sy + 60}H500`, class: 'wire' }); gnd(500, sy + 60);
    el('path', { d: `M630 ${sy + 28}H656`, class: 'wire' });
    const g = el('g', { tabindex: 0, role: 'button', 'aria-label': `Plug or unplug phone on port ${c}`, class: 'phone' });
    el('rect', { x: 656, y: sy - 14, width: 56, height: 84, rx: 6, class: 'part pr' }, g);
    el('rect', { x: 664, y: sy - 6, width: 40, height: 52, class: 'bar0' }, g);
    const f = el('rect', { x: 664, y: sy + 46, width: 40, height: 0, class: 'fill' }, g);
    const pt = el('text', { x: 684, y: sy + 62, class: 'lbl c' }, g, '');
    g.onclick = () => togglePhone(k);
    g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePhone(k); } };
    PH.push({ g, f, pt, sy });
    T['i' + k] = txt(520, sy - 20, '');
  });
})();

function togglePhone(k) {
  const p = S.ports[k]; p.phone = !p.phone; resetPort(p);
  log(`P${k + 1} phone ${p.phone ? 'attached, CC1/CC2 sense' + (S.faults.nocc ? ' FAILED' : ' 5.1k OK') : 'removed'}`);
}

function drawSch() {
  const live = S.vin > 1, flow = (id, on) => W[id].classList.toggle('flow', on);
  svg.classList.toggle('nocc', S.faults.nocc);
  flow('p12', live); flow('pg', live); flow('p5', total('i') > 0);
  T.vin.textContent = S.vin.toFixed(1) + ' V';
  T.vout.textContent = S.vout.toFixed(2) + ' V';
  T.vout.classList.toggle('bad', S.vout > CFG.ovV);
  T.mcu.textContent = S.mcu ? 'RUN' : 'RESET';
  S.ports.forEach((p, k) => {
    const on = p.i > 0, { g, f, pt, sy } = PH[k];
    flow('b' + k, on); flow('v' + k, on); flow('d' + k, p.relay && S.mcu);
    ARM[k].classList.toggle('closed', p.relay);
    T['i' + k].textContent = `${(p.i / 1000).toFixed(2)} A  ${(p.relay && S.mcu ? S.vout : 0).toFixed(2)} V`;
    g.classList.toggle('empty', !p.phone);
    const h = p.phone ? 52 * p.soc / 100 : 0;
    f.setAttribute('y', sy + 46 - h); f.setAttribute('height', h);
    f.setAttribute('class', 'fill' + (on ? ' chg' : ''));
    pt.textContent = p.phone ? Math.round(p.soc) + '%' : 'EMPTY';
  });
}

/* ================= ports UI ================= */
const portsEl = $('#ports');
for (let k = 0; k < 3; k++) portsEl.insertAdjacentHTML('beforeend', `
  <article class="port"><header><b>PORT ${k + 1}</b><span class="mono dim">D${k + 2}</span><span class="badge" id="st${k}"></span></header>
  <label class="line"><span>Phone connected</span><input type="checkbox" class="sw" id="ph${k}"></label>
  <label class="line rng"><span>Battery</span><input type="range" id="sc${k}" min="0" max="100"><output id="so${k}"></output></label>
  <label class="line"><span>Manual relay</span><input type="checkbox" class="sw" id="mn${k}"></label>
  <dl class="mini"><div><dt>V</dt><dd id="pv${k}"></dd></div><div><dt>mA</dt><dd id="pi${k}"></dd></div><div><dt>W</dt><dd id="pw${k}"></dd></div><div><dt>Wh</dt><dd id="pe${k}"></dd></div></dl></article>`);
for (let k = 0; k < 3; k++) {
  $('#ph' + k).onchange = e => { if (S.ports[k].phone !== e.target.checked) togglePhone(k); };
  $('#sc' + k).oninput = e => { S.ports[k].soc = +e.target.value; };
  $('#mn' + k).onchange = e => { S.ports[k].manual = e.target.checked; };
}

/* ================= chart (hand-drawn canvas) ================= */
function drawChart() {
  const c = $('#chart'), r = c.getBoundingClientRect(), d = devicePixelRatio || 1;
  if (!r.width) return;
  if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); }
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
  const w = r.width, h = r.height, L = 32, R = 44, Tp = 8, B = 18, pw = w - L - R, ph = h - Tp - B;
  const cs = getComputedStyle(document.documentElement), col = n => cs.getPropertyValue(n).trim();
  g.clearRect(0, 0, w, h); g.font = '10px "IBM Plex Mono",monospace'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = Tp + ph * i / 4;
    g.strokeStyle = col('--line'); g.beginPath(); g.moveTo(L, y + .5); g.lineTo(w - R, y + .5); g.stroke();
    g.fillStyle = col('--muted'); g.textAlign = 'right'; g.fillText(100 - 25 * i, L - 4, y + 3);
    g.textAlign = 'left'; g.fillText(3000 - 750 * i, w - R + 4, y + 3); }
  const H = S.hist; if (H.length < 2) { g.fillStyle = col('--muted'); g.textAlign = 'center'; g.fillText('collecting samples...', w / 2, h / 2); return; }
  const t0 = H[0].t, t1 = Math.max(H[H.length - 1].t, t0 + 60), X = t => L + pw * (t - t0) / (t1 - t0);
  g.fillStyle = col('--muted'); g.textAlign = 'left'; g.fillText((t0 / 60).toFixed(1) + 'm', L, h - 4);
  g.textAlign = 'right'; g.fillText((t1 / 60).toFixed(1) + 'm', w - R, h - 4);
  const plot = (fn, max, color, dash) => { g.strokeStyle = col(color); g.lineWidth = 1.5; g.setLineDash(dash); g.beginPath();
    H.forEach((s, i) => { const x = X(s.t), y = Tp + ph * (1 - fn(s) / max); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke(); g.setLineDash([]); };
  plot(s => s.i, 3000, '--muted', [4, 3]);
  ['--ink', '--accent', '--ok'].forEach((cc, k) => plot(s => s.soc[k], 100, cc, []));
}

/* ================= Arduino sketch generator ================= */
function sketch() {
  const consts = {
    health: `const float SOC_CUT = ${S.hi}, SOC_RESUME = ${S.lo};   // hysteresis, percent\nbool hold[3];`,
    timer: `const unsigned long CHARGE_MS = ${S.timerMin}UL * 60000UL;   // charge window\nunsigned long startMs[3];            // set when a phone is plugged`,
    full: `const float CUTOFF_MA = ${S.cutMA};   // end of taper\nbool done[3];`,
    manual: `bool manual[3];   // set these from your own Serial/button handler`
  }[S.mode];
  const logic = {
    health: `    if (soc[i] >= SOC_CUT) hold[i] = true;\n    else if (soc[i] <= SOC_RESUME) hold[i] = false;\n    want = !hold[i];`,
    timer: `    want = (millis() - startMs[i]) < CHARGE_MS;`,
    full: `    if (soc[i] >= 90 && mA < CUTOFF_MA) done[i] = true;   // taper finished\n    want = !done[i];`,
    manual: `    want = manual[i];`
  }[S.mode];
  return `// Phone charging station - mode: ${S.mode.toUpperCase()}
#include <Wire.h>
#include <Adafruit_INA219.h>

const uint8_t RELAY[3] = {2, 3, 4};          // relay IN, active HIGH
// High-side INA219 sits ahead of each relay, so it also sees rail voltage
Adafruit_INA219 ina[3] = {Adafruit_INA219(0x40), Adafruit_INA219(0x41), Adafruit_INA219(0x44)};
const float OVER_V = ${CFG.ovV}, OVER_MA = ${CFG.ocMA};   // protection limits
const float CAP_MAH = ${CFG.capMAh}, IDLE_MA = ${CFG.idleMA};     // assumed phone battery
${consts}
float soc[3] = {50, 50, 50};   // coulomb-counted estimate (phone % is not readable)
bool latched[3];
unsigned long last;

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 3; i++) {
    pinMode(RELAY[i], OUTPUT); digitalWrite(RELAY[i], LOW); ina[i].begin();
  }
  last = millis();
}

void loop() {
  float dtH = (millis() - last) / 3600000.0; last = millis();
  for (uint8_t i = 0; i < 3; i++) {
    float v = ina[i].getBusVoltage_V(), mA = ina[i].getCurrent_mA();
    soc[i] = constrain(soc[i] + (mA > 20 ? mA * 0.92 : -IDLE_MA) * dtH / CAP_MAH * 100, 0, 100);
    if (v > OVER_V || mA > OVER_MA) latched[i] = true;   // trip until power-cycle
    bool want;
${logic}
    digitalWrite(RELAY[i], (want && !latched[i]) ? HIGH : LOW);
  }
  delay(100);
}`;
}

/* ================= render ================= */
let lastSketch = '';
function render() {
  const I = total('i'), cls = { 'CC CHARGE': 'acc', TAPER: 'acc', HOLD: 'ok', DONE: 'ok' };
  $('#clock').textContent = 'millis() ' + Math.round(S.t);
  $('#r-vin').textContent = S.vin.toFixed(2) + ' V';
  $('#r-vout').textContent = S.vout.toFixed(2) + ' V';
  $('#r-i').textContent = (I / 1000).toFixed(2) + ' A';
  $('#r-p').textContent = (S.vout * I / 1000).toFixed(2) + ' W';
  $('#r-e').textContent = total('wh').toFixed(3) + ' Wh';
  $('#r-mcu').textContent = S.mcu ? 'RUN' : 'RESET';
  S.ports.forEach((p, k) => {
    const b = $('#st' + k), v = p.relay && S.mcu ? S.vout : 0;
    b.textContent = p.status;
    b.className = 'badge ' + (cls[p.status] || (p.trip || p.status === 'NO CC' || p.status === 'MCU OFF' ? 'bad' : ''));
    $('#ph' + k).checked = p.phone;
    const sc = $('#sc' + k); if (document.activeElement !== sc) sc.value = Math.round(p.soc);
    $('#so' + k).textContent = Math.round(p.soc) + '%';
    const mn = $('#mn' + k); mn.checked = p.manual; mn.disabled = S.mode !== 'manual';
    $('#pv' + k).textContent = v.toFixed(2); $('#pi' + k).textContent = Math.round(p.i);
    $('#pw' + k).textContent = (v * p.i / 1000).toFixed(2); $('#pe' + k).textContent = p.wh.toFixed(3);
  });
  drawSch();
  if (S.tab === 'chart') drawChart();
  if (S.tab === 'serial' && S.logDirty) { const e = $('#serial'), near = e.scrollHeight - e.scrollTop - e.clientHeight < 30;
    e.textContent = S.log.join('\n'); if (near) e.scrollTop = e.scrollHeight; S.logDirty = false; }
  if (S.tab === 'code') { const s = sketch(); if (s !== lastSketch) { $('#sketch').textContent = s; lastSketch = s; } }
}

/* ================= main loop: fixed-step sim, decoupled from rendering ================= */
let last = performance.now();
function frame(now) {
  const real = Math.min(0.25, (now - last) / 1000); last = now;
  if (!S.paused) { S.acc += real * S.speed; let n = 0;
    while (S.acc >= CFG.step && n++ < 400) { step(CFG.step); S.acc -= CFG.step; } }
  render(); requestAnimationFrame(frame);
}

/* ================= UI wiring ================= */
function syncUI() {
  $$('input[name=mode]').forEach(r => r.checked = r.value === S.mode);
  $$('input[name=speed]').forEach(r => r.checked = +r.value === S.speed);
  [['hi', 'hi', '%'], ['lo', 'lo', '%'], ['tm', 'timerMin', ' min'], ['cut', 'cutMA', ' mA']].forEach(([id, k, u]) => {
    $('#' + id).value = S[k]; $('#' + id + '-o').textContent = S[k] + u; });
  $$('[data-fault]').forEach(i => i.checked = S.faults[i.dataset.fault]);
  $$('[data-for]').forEach(r => r.hidden = r.dataset.for !== S.mode);
  $('#pause span').textContent = S.paused ? 'Resume' : 'Pause';
  $$('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === S.tab));
  ['chart', 'serial', 'code'].forEach(n => $('#tab-' + n).hidden = n !== S.tab);
  S.logDirty = true; lastSketch = '';
}
$$('input[name=mode]').forEach(r => r.onchange = () => { S.mode = r.value; S.ports.forEach(resetPort);
  log('MODE -> ' + S.mode.toUpperCase()); syncUI(); });
$$('input[name=speed]').forEach(r => r.onchange = () => { S.speed = +r.value; });
[['hi', 'hi'], ['lo', 'lo'], ['tm', 'timerMin'], ['cut', 'cutMA']].forEach(([id, k]) =>
  $('#' + id).addEventListener('input', e => { S[k] = +e.target.value;
    if (k === 'timerMin') S.ports.forEach(p => p.timer = S.timerMin * 60); syncUI(); }));
$$('[data-fault]').forEach(i => i.onchange = () => {
  const f = i.dataset.fault; S.faults[f] = i.checked;
  log(`FAULT ${f} ${i.checked ? 'INJECTED' : 'CLEARED'}`);
  if (!i.checked) S.ports.forEach(p => { // clearing a fault releases its latched trip
    if ((f === 'oc' && p.trip === 'OVERCURRENT') || (f === 'miscal' && p.trip === 'OVERVOLT')) p.trip = ''; });
});
$('#pause').onclick = () => { S.paused = !S.paused; syncUI(); };
$('#reset').onclick = () => { fresh(); syncUI(); };
$('#clear').onclick = () => { S.log = []; S.logDirty = true; };
$$('.tab').forEach(t => t.onclick = () => { S.tab = t.dataset.tab; syncUI(); });
$('#theme').onclick = () => { const d = document.documentElement;
  d.dataset.theme = d.dataset.theme === 'dark' ? 'light' : 'dark'; };
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

fresh(); syncUI(); requestAnimationFrame(frame);
