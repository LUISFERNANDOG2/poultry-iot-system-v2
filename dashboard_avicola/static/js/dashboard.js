// Dashboard JavaScript - (QUERÉTARO VERSION 1.0)
let temperatureChart, humidityChart, ammoniaChart, coChart, co2Chart;
let lastRealUpdate = null;

// =========================================================
// CONFIGURACIÓN DE CALIBRACIÓN - QUERÉTARO)
// =========================================================

// PARÁMETROS DEL CIRCUITO (MEDIDOS)
const VCC_MQ7 = 5.0;           // Voltaje real en VCC del MQ-7
const VCC_MQ137 = 5.0;         // Voltaje real en VCC del MQ-137
const RL_MQ7 = 9900;           // Resistencia MQ-7 (9.9kΩ medido)
const RL_MQ137 = 9900;         // Resistencia MQ-137 (9.9kΩ medido)
const DIVISOR_FACTOR = 2.0;    // Factor del divisor (10k+10k = 2:1)

// CORRECCIÓN POR ALTITUD PARA QUERÉTARO (1,820m)
const ALTITUDE_METERS = 1820;
const ALTITUDE_FACTOR = 0.79;  // 800 hPa / 1013 hPa (presión relativa)
const CO2_EXTERIOR_REF = 410;  // ppm CO2 en aire exterior Querétaro

// PARÁMETROS DE SENSORES - VALORES CORREGIDOS BASADOS EN TUS LECTURAS
// MQ-7 para CO: ppm = 99.04 * (Rs/R0)^(-1.518)
const MQ7_A = 99.04;
const MQ7_B = -1.518;
let MQ7_R0 = 58000;           // VALOR CORREGIDO (basado en RAW=111, Rs=261kΩ, ratio=4.5)

// MQ-137 para NH3: ppm = 36.665 * (Rs/R0)^(-1.461)
const MQ137_A = 36.665;
const MQ137_B = -1.461;
let MQ137_R0 = 9500;          // VALOR CORREGIDO (basado en RAW=522, Rs=47.7kΩ, ratio=5.0)

// FACTORES EMPÍRICOS DE CALIBRACIÓN (ajustan fórmulas teóricas a la realidad)
const MQ7_EMPIRICAL_FACTOR = 0.5;    // Reduce PPM teóricos a la mitad (más realista)
const MQ137_EMPIRICAL_FACTOR = 0.4;  // Reduce PPM teóricos (más realista)

// OFFSETS DE CALIBRACIÓN (ajustar tras medición en aire exterior)
let CCS811_OFFSET = 0;         // ppm CO2
let MQ7_OFFSET = 0;            // ppm CO
let MQ137_OFFSET = 0;          // ppm NH3

// =========================================================
// FUNCIONES DE CARGA Y GUARDADO DE CALIBRACIÓN
// =========================================================

function loadCalibrationFromStorage() {
  // Cargar R0 de los sensores MQ
  const savedMQ7_R0 = localStorage.getItem('mq7_r0');
  const savedMQ137_R0 = localStorage.getItem('mq137_r0');

  if (savedMQ7_R0) MQ7_R0 = parseFloat(savedMQ7_R0);
  if (savedMQ137_R0) MQ137_R0 = parseFloat(savedMQ137_R0);

  // Cargar offsets de calibración
  const savedCCS811 = localStorage.getItem('ccs811_offset');
  const savedMQ7 = localStorage.getItem('mq7_offset');
  const savedMQ137 = localStorage.getItem('mq137_offset');

  if (savedCCS811) CCS811_OFFSET = parseFloat(savedCCS811);
  if (savedMQ7) MQ7_OFFSET = parseFloat(savedMQ7);
  if (savedMQ137) MQ137_OFFSET = parseFloat(savedMQ137);

  console.log('Calibración cargada:', {
    MQ7_R0: `${MQ7_R0.toFixed(0)}Ω`,
    MQ137_R0: `${MQ137_R0.toFixed(0)}Ω`,
    CCS811_OFFSET: `${CCS811_OFFSET.toFixed(1)} ppm`,
    MQ7_OFFSET: `${MQ7_OFFSET.toFixed(2)} ppm`,
    MQ137_OFFSET: `${MQ137_OFFSET.toFixed(2)} ppm`
  });
}

function saveCalibrationToStorage() {
  localStorage.setItem('mq7_r0', MQ7_R0);
  localStorage.setItem('mq137_r0', MQ137_R0);
  localStorage.setItem('ccs811_offset', CCS811_OFFSET);
  localStorage.setItem('mq7_offset', MQ7_OFFSET);
  localStorage.setItem('mq137_offset', MQ137_OFFSET);
}

// =========================================================
// FUNCIONES DE CORRECCIÓN POR ALTITUD
// =========================================================

function applyAltitudeCorrection(value, type) {
  if (!value || value <= 0) return 0;

  // Solo aplicar a mediciones de gases (afectadas por presión)
  switch (type) {
    case 'CO':
    case 'NH3':
    case 'CO2':
    case 'TVOC':
      return value * ALTITUDE_FACTOR;

    case 'TEMPERATURE':
      // Corrección mínima: -0.65°C cada 100m
      return value + (ALTITUDE_METERS / 100 * 0.65);

    default:
      return value;
  }
}

function applyCalibrationOffset(value, type) {
  if (!value || value <= 0) return 0;

  switch (type) {
    case 'CO2':
      return value + CCS811_OFFSET;
    case 'CO':
      return value + MQ7_OFFSET;
    case 'NH3':
      return value + MQ137_OFFSET;
    default:
      return value;
  }
}

// =========================================================
// FUNCIONES DE CÁLCULO CORREGIDAS PARA SENSORES MQ
// =========================================================

function calculateRs(adcValue, type) {
  if (!adcValue || adcValue <= 0 || adcValue >= 4095) return 0;

  // 1. ADC a voltaje ESP32 (0-3.3V)
  const voltage_esp = (adcValue / 4095.0) * 3.3;

  // 2. Aplicar divisor (2:1)
  const voltage_mq = voltage_esp * DIVISOR_FACTOR;

  // 3. Parámetros según sensor
  let RL, VCC;
  if (type === 'CO') {
    RL = RL_MQ7;
    VCC = VCC_MQ7;
  } else if (type === 'NH3') {
    RL = RL_MQ137;
    VCC = VCC_MQ137;
  } else {
    return 0;
  }

  // 4. Evitar división por cero
  if (voltage_mq <= 0) return 0;

  // 5. Calcular Rs: Rs = RL * ((VCC / Vout) - 1)
  const Rs = RL * ((VCC / voltage_mq) - 1);
  return Rs;
}

function calculatePPM(adcValue, type) {
  if (!adcValue || adcValue <= 0 || adcValue >= 4095) return 0;

  // 1. Calcular Rs
  const Rs = calculateRs(adcValue, type);

  // 2. Parámetros según tipo
  let R0, A, B, empiricalFactor;
  if (type === 'CO') {
    R0 = MQ7_R0;
    A = MQ7_A;
    B = MQ7_B;
    empiricalFactor = MQ7_EMPIRICAL_FACTOR;
  } else if (type === 'NH3') {
    R0 = MQ137_R0;
    A = MQ137_A;
    B = MQ137_B;
    empiricalFactor = MQ137_EMPIRICAL_FACTOR;
  } else {
    return 0;
  }

  // 3. Validaciones
  if (R0 <= 0 || Rs <= 0) return 0;

  // 4. Calcular ratio y PPM base
  const ratio = Rs / R0;
  let ppm = A * Math.pow(ratio, B);

  // 5. Aplicar factor empírico (¡CRÍTICO para valores realistas!)
  ppm = ppm * empiricalFactor;

  // 6. Aplicar corrección por altitud
  ppm = applyAltitudeCorrection(ppm, type);

  // 7. Aplicar offset de calibración
  ppm = applyCalibrationOffset(ppm, type);

  // 8. Limitar valores
  if (ppm < 0) ppm = 0;
  if (ppm > 5000) ppm = 5000;

  // 9. Redondear
  return Math.round(ppm * 10) / 10;
}

// =========================================================
// PROCESAMIENTO ESPECIAL PARA CCS811
// =========================================================

function processCCS811Data(eco2, tvoc, temperature, humidity) {
  if (!eco2 || eco2 <= 0) return { co2: 0, tvoc: 0, isCorrected: false };

  // 1. Aplicar corrección por altitud
  let correctedCO2 = applyAltitudeCorrection(eco2, 'CO2');
  let correctedTVOC = applyAltitudeCorrection(tvoc || 0, 'TVOC');

  // 2. Aplicar offset de calibración
  correctedCO2 = applyCalibrationOffset(correctedCO2, 'CO2');

  return {
    co2: Math.round(correctedCO2),
    tvoc: Math.round(correctedTVOC),
    original: { eco2, tvoc },
    isCorrected: true
  };
}

// =========================================================
// FUNCIONES DE CALIBRACIÓN MEJORADAS
// =========================================================

function calibrateR0FromCleanAir(adcCO, adcNH3) {
  // Esta función calcula R0 a partir de lecturas en aire limpio
  if (adcCO && adcCO > 0) {
    const Rs_CO = calculateRs(adcCO, 'CO');
    MQ7_R0 = Rs_CO / 4.5;  // En aire limpio, Rs/R0 ≈ 4.5 para MQ-7
    console.log(`MQ-7 R0 calibrado: ${MQ7_R0.toFixed(0)}Ω (de Rs=${Rs_CO.toFixed(0)}Ω)`);
  }

  if (adcNH3 && adcNH3 > 0) {
    const Rs_NH3 = calculateRs(adcNH3, 'NH3');
    MQ137_R0 = Rs_NH3 / 5.0;  // En aire limpio, Rs/R0 ≈ 5.0 para MQ-137
    console.log(`MQ-137 R0 calibrado: ${MQ137_R0.toFixed(0)}Ω (de Rs=${Rs_NH3.toFixed(0)}Ω)`);
  }

  saveCalibrationToStorage();
}

function calibrateWithOutsideAir(co2Reading, coReading, nh3Reading) {
  // Valores de referencia para aire exterior Querétaro (más realistas)
  const REF_CO2 = CO2_EXTERIOR_REF;      // 410 ppm CO2
  const REF_CO = 0.5;                    // ~0.5 ppm CO (más realista para urbano)
  const REF_NH3 = 0.1;                   // ~0.1 ppm NH3 (más realista)

  // Calcular offsets
  if (co2Reading && co2Reading > 0) {
    CCS811_OFFSET = REF_CO2 - co2Reading;
    console.log(`CCS811: Offset calculado = ${CCS811_OFFSET.toFixed(1)} ppm`);
  }

  if (coReading && coReading > 0) {
    const coPPM = calculatePPM(coReading, 'CO');
    MQ7_OFFSET = REF_CO - coPPM;
    console.log(`MQ-7: Offset calculado = ${MQ7_OFFSET.toFixed(2)} ppm`);
  }

  if (nh3Reading && nh3Reading > 0) {
    const nh3PPM = calculatePPM(nh3Reading, 'NH3');
    MQ137_OFFSET = REF_NH3 - nh3PPM;
    console.log(`MQ-137: Offset calculado = ${MQ137_OFFSET.toFixed(2)} ppm`);
  }

  saveCalibrationToStorage();

  alert(`✅ Calibración completada para Querétaro (${ALTITUDE_METERS}m)\n` +
    `CCS811: ${CCS811_OFFSET > 0 ? '+' : ''}${CCS811_OFFSET.toFixed(1)} ppm\n` +
    `MQ-7: ${MQ7_OFFSET > 0 ? '+' : ''}${MQ7_OFFSET.toFixed(2)} ppm\n` +
    `MQ-137: ${MQ137_OFFSET > 0 ? '+' : ''}${MQ137_OFFSET.toFixed(2)} ppm`);
}

// =========================================================
// ACTUALIZACIÓN DE TARJETAS (ESTRUCTURA CORREGIDA)
// =========================================================

function updateMetricCards(data) {
  if (!data) return;

  // 1. Procesar datos básicos
  const tempVal = data.temperatura;
  const humVal = data.humedad;
  const nh3Raw = data.amoniaco;
  const coRaw = data.co;
  const co2Val = data.co2;

  // 2. Procesar CCS811 con correcciones
  const ccs811Data = processCCS811Data(co2Val, data.tvoc || 0, tempVal, humVal);

  // 3. Calcular PPM para MQ (con fórmulas corregidas)
  const nh3PPM = nh3Raw !== null ? calculatePPM(nh3Raw, 'NH3') : 0;
  const coPPM = coRaw !== null ? calculatePPM(coRaw, 'CO') : 0;

  // 4. Actualizar DOM con NUEVA ESTRUCTURA

  // Temperatura (1 línea)
  document.getElementById('temp').textContent =
    (tempVal !== null && tempVal !== undefined) ? tempVal.toFixed(1) + ' °C' : '-- °C';

  // Humedad (1 línea)
  document.getElementById('hum').textContent =
    (humVal !== null && humVal !== undefined) ? humVal.toFixed(1) + ' %' : '-- %';

  // CO₂ (1 línea grande + info pequeña opcional)
  const co2Element = document.getElementById('co2');
  const co2InfoElement = document.getElementById('co2_info');

  if (co2Val !== null) {
    const corrected = ccs811Data.co2;
    const original = Math.round(co2Val);

    // Línea GRANDE: PPM corregido
    co2Element.textContent = corrected + ' ppm';

    // Línea PEQUEÑA: Info de corrección (solo si hay)
    if (ccs811Data.isCorrected) {
      const diff = Math.abs(original - corrected);

      if (diff > 10 || CCS811_OFFSET !== 0) {
        let infoText = `Original: ${original} ppm`;

        co2InfoElement.textContent = infoText;
        co2InfoElement.style.display = 'block';
      } else {
        co2InfoElement.textContent = '';
        co2InfoElement.style.display = 'none';
      }
    } else {
      co2InfoElement.textContent = '';
      co2InfoElement.style.display = 'none';
    }
  } else {
    co2Element.textContent = '-- ppm';
    co2InfoElement.textContent = '';
    co2InfoElement.style.display = 'none';
  }

  // NH₃ - NUEVA ESTRUCTURA: RAW arriba, PPM abajo
  const nh3RawElement = document.getElementById('ammonia_raw');
  const nh3PPMElement = document.getElementById('ammonia_ppm');

  if (nh3Raw !== null) {
    // Línea GRANDE: Valor ADC (RAW)
    nh3RawElement.textContent = nh3Raw.toFixed(0) + ' ADC';

    // Línea PEQUEÑA: PPM calculado
    if (nh3PPM > 0) {
      nh3PPMElement.textContent = nh3PPM.toFixed(2) + ' ppm';
      nh3PPMElement.style.display = 'block';
    } else {
      nh3PPMElement.textContent = 'Calculando...';
      nh3PPMElement.style.display = 'block';
    }
  } else {
    nh3RawElement.textContent = '-- ADC';
    nh3PPMElement.textContent = '-- ppm';
    nh3PPMElement.style.display = 'block';
  }

  // CO - NUEVA ESTRUCTURA: RAW arriba, PPM abajo
  const coRawElement = document.getElementById('co_raw');
  const coPPMElement = document.getElementById('co_ppm');

  if (coRaw !== null) {
    // Línea GRANDE: Valor ADC (RAW)
    coRawElement.textContent = coRaw.toFixed(0) + ' ADC';

    // Línea PEQUEÑA: PPM calculado
    if (coPPM > 0) {
      coPPMElement.textContent = coPPM.toFixed(2) + ' ppm';
      coPPMElement.style.display = 'block';
    } else {
      coPPMElement.textContent = 'Calculando...';
      coPPMElement.style.display = 'block';
    }
  } else {
    coRawElement.textContent = '-- ADC';
    coPPMElement.textContent = '-- ppm';
    coPPMElement.style.display = 'block';
  }

  // Calibración automática en primera ejecución
  if (!sessionStorage.getItem('auto_calibrated') && coRaw && nh3Raw) {
    calibrateR0FromCleanAir(coRaw, nh3Raw);
    sessionStorage.setItem('auto_calibrated', 'true');
    console.log('Calibración automática de R0 completada');
  }
}

// =========================================================
// INICIALIZACIÓN DEL DASHBOARD
// =========================================================

function initializeDashboard() {
  // Cargar calibración desde localStorage
  loadCalibrationFromStorage();

  // Mostrar valores de calibración
  console.log('✅ Dashboard inicializado con calibración:');
  console.log(`   MQ-7 R0: ${MQ7_R0.toFixed(0)}Ω (RAW=111 → ${calculatePPM(111, 'CO').toFixed(1)} ppm)`);
  console.log(`   MQ-137 R0: ${MQ137_R0.toFixed(0)}Ω (RAW=522 → ${calculatePPM(522, 'NH3').toFixed(1)} ppm)`);
  console.log(`   Altitud: ${ALTITUDE_METERS}m (Factor: ${ALTITUDE_FACTOR})`);

  // Configurar selector de rango
  setupRangeSelector();

  // Inicializar gráficas
  temperatureChart = initChart(document.getElementById('temperatureChart'), "Temperature (°C)", "#43a047");
  humidityChart = initChart(document.getElementById('humidityChart'), "Humidity (%)", "#1e88e5");
  ammoniaChart = initChart(document.getElementById('ammoniaChart'), "NH₃ (ADC)", "#fb8c00");
  coChart = initChart(document.getElementById('coChart'), "CO (ADC)", "#43a047");
  co2Chart = initChart(document.getElementById('co2Chart'), "CO₂ (raw ppm)", "#e53935");

  // Cargar datos iniciales
  loadHistorical("24h");
}

// =========================================================
// FUNCIONES DE GRÁFICAS
// =========================================================

// Colores para diferentes módulos
const MODULE_COLORS = {
  'M1': { primary: '#43a047', secondary: '#43a04733' },
  'M2': { primary: '#1e88e5', secondary: '#1e88e533' },
  'M3': { primary: '#fb8c00', secondary: '#fb8c0033' },
  'M4': { primary: '#e53935', secondary: '#e5393533' },
  'M5': { primary: '#8e24aa', secondary: '#8e24aa33' }
};

function initChart(ctx, label, color) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label,
        data: [],
        borderColor: color,
        backgroundColor: color + "33",
        fill: false,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 15
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleColor: '#fff',
          bodyColor: '#fff',
          borderColor: '#ddd',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: 'hour',
            displayFormats: {
              hour: 'HH:mm',
              minute: 'HH:mm'
            }
          },
          adapters: { date: { locale: 'es' } },
          bounds: 'data',
          grid: {
            display: true,
            color: 'rgba(0,0,0,0.1)'
          }
        },
        y: { 
          beginAtZero: false,
          grid: {
            display: true,
            color: 'rgba(0,0,0,0.1)'
          }
        }
      }
    }
  });
}


function clearAllCharts() {
  // Limpiar completamente todas las gráficas
  const charts = [temperatureChart, humidityChart, ammoniaChart, coChart, co2Chart];
  
  charts.forEach(chart => {
    if (chart) {
      // Limpiar datos
      chart.data.labels = [];
      chart.data.datasets[0].data = [];
      
      // Resetear escalas
      if (chart.options.scales && chart.options.scales.x) {
        chart.options.scales.x.min = null;
        chart.options.scales.x.max = null;
      }
      
      // Actualizar gráfica vacía
      chart.update('none');
    }
  });
}


function updateChart(chart, labels, data) {
  if (!chart || !labels || !data || labels.length === 0) return;

  const dataPoints = labels.map((ts, index) => ({
    x: parseTimestamp(ts),
    y: data[index] !== null ? data[index] : null
  })).filter(point => point.y !== null);

  if (dataPoints.length === 0) return;

  const minTime = Math.min(...dataPoints.map(p => p.x.getTime()));
  const maxTime = Math.max(...dataPoints.map(p => p.x.getTime()));
  const margin = (maxTime - minTime) * 0.05 || 1000;

  if (chart.options.scales && chart.options.scales.x) {
    chart.options.scales.x.min = new Date(minTime - margin);
    chart.options.scales.x.max = new Date(maxTime + margin);
  }

  chart.data.datasets[0].data = dataPoints;
  chart.update('none');
}

// =========================================================
// FUNCIONES UTILITARIAS
// =========================================================

function setupRangeSelector() {
  const rangeSelect = document.getElementById('rangeSelect');
  const customContainer = document.getElementById('customRangeContainer');
  const moduleSelect = document.getElementById('moduleSelect');

  if (!rangeSelect || !customContainer) return;

  const updateVisibility = () => {
    const isCustom = rangeSelect.value === 'custom';
    customContainer.classList.toggle('d-none', !isCustom);
    customContainer.classList.toggle('d-flex', isCustom);
  };

  rangeSelect.addEventListener('change', () => {
    updateVisibility();
    if (rangeSelect.value !== 'custom') {
      loadHistorical(rangeSelect.value);
    }
  });

  // Add module selector event listener
  if (moduleSelect) {
    moduleSelect.addEventListener('change', () => {
      // Update live data immediately
      updateLiveData();
      
      // Update historical data
      const range = rangeSelect.value;
      if (range === 'custom') {
        const from = document.getElementById('fromDate').value;
        const to = document.getElementById('toDate').value;
        if (from && to) loadHistorical("custom", from, to);
      } else {
        loadHistorical(range);
      }
    });
  }

  updateVisibility();
}

function getBaseUrl() {
  const currentPort = window.location.port;
  return currentPort === '5001'
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : window.location.origin;
}

async function fetchHistoricalData(range, from = null, to = null) {
  let url = `${getBaseUrl()}/api/historical?range=${range}`;
  if (from && to) url += `&from=${from}&to=${to}`;

  // Add module parameter
  const moduleSelect = document.getElementById('moduleSelect');
  if (moduleSelect) {
    const module = moduleSelect.value;
    url += `&house=${module}`;
    console.log(`Fetching data for range: ${range}, module: ${module}`);
  }

  console.log(`Final URL: ${url}`);
  
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`Data received:`, data);
    return data;
  } catch (err) {
    console.error("Error fetching data:", err);
    return null;
  }
}

function parseTimestamp(ts) {
  let date = null;
  if (typeof ts === 'string') date = new Date(ts);
  else if (typeof ts === 'number') {
    if (ts < 10000000000) ts *= 1000;
    date = new Date(ts);
  }
  return isNaN(date) ? new Date() : date;
}

function formatTimeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'Hace ' + seconds + ' segundos';
  if (minutes < 60) return 'Hace ' + minutes + ' minuto' + (minutes > 1 ? 's' : '');
  if (hours < 24) return 'Hace ' + hours + ' hora' + (hours > 1 ? 's' : '');
  return 'Hace ' + days + ' día' + (days > 1 ? 's' : '');
}

async function loadHistorical(range, from = null, to = null) {
  const historicalStatus = document.getElementById('historicalStatus') || createHistoricalStatus();
  historicalStatus.textContent = 'Cargando...';
  historicalStatus.className = 'badge bg-info';

  // Limpiar completamente las gráficas antes de cargar nuevos datos
  clearAllCharts();

  const data = await fetchHistoricalData(range, from, to);
  if (!data || !data.timestamps || data.timestamps.length === 0) {
    historicalStatus.textContent = 'Sin datos';
    historicalStatus.className = 'badge bg-warning';
    return;
  }

  const lastTimestamp = parseTimestamp(data.timestamps[data.timestamps.length - 1]);

  if (!lastRealUpdate || lastTimestamp > lastRealUpdate) {
    lastRealUpdate = lastTimestamp;
    const dateStr = lastRealUpdate.toLocaleDateString('es-MX', {
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const timeStr = lastRealUpdate.toLocaleTimeString('es-MX', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    document.getElementById('lastUpdate').textContent = `${dateStr} ${timeStr}`;
  }

  const diff = lastRealUpdate ? (Date.now() - lastRealUpdate.getTime()) / 1000 : 999999;
  const timeAgoEl = document.getElementById('lastUpdateTime');
  timeAgoEl.textContent = diff > 20 ? `(${formatTimeAgo(lastRealUpdate)})` : '';

  // Actualizar gráficas con datos del módulo seleccionado
  if (temperatureChart && humidityChart && ammoniaChart && coChart && co2Chart) {
    updateChart(temperatureChart, data.timestamps, data.temperature);
    updateChart(humidityChart, data.timestamps, data.humidity);
    updateChart(ammoniaChart, data.timestamps, data.ammonia);
    updateChart(coChart, data.timestamps, data.co);
    updateChart(co2Chart, data.timestamps, data.co2);
  }

  setTimeout(() => {
    historicalStatus.textContent = 'Gráficas actualizadas';
    historicalStatus.className = 'badge bg-success';
    setTimeout(() => historicalStatus.style.display = 'none', 2000);
  }, 1000);
}

// New function to fetch data for all modules
async function fetchAllModulesData(range, from = null, to = null) {
  const modules = ['M1', 'M2', 'M3', 'M4', 'M5'];
  const allData = {};
  
  for (const module of modules) {
    let url = `${getBaseUrl()}/api/historical?range=${range}&house=${module}`;
    if (from && to) url += `&from=${from}&to=${to}`;
    
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && data.timestamps && data.timestamps.length > 0) {
          allData[module] = data;
        }
      }
    } catch (err) {
      console.error(`Error fetching data for module ${module}:`, err);
    }
  }
  
  return allData;
}

function applyCustomRange() {
  const from = document.getElementById('fromDate').value;
  const to = document.getElementById('toDate').value;

  if (!from || !to) {
    alert('Por favor selecciona ambas fechas (desde y hasta)');
    return;
  }

  loadHistorical("custom", from, to);
}

// =========================================================
// DATOS EN TIEMPO REAL
// =========================================================

async function updateLiveData() {
  try {
    // Get selected module
    const moduleSelect = document.getElementById('moduleSelect');
    const module = moduleSelect ? moduleSelect.value : 'M1';
    
    // Fetch live data with module parameter
    const res = await fetch(`${getBaseUrl()}/api/live-data?modulo=${module}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    updateMetricCards(data);

    if (data && data.timestamp) {
      const lastTs = parseTimestamp(data.timestamp);
      lastRealUpdate = lastTs;

      const dateStr = lastTs.toLocaleDateString('es-MX', {
        year: 'numeric', month: '2-digit', day: '2-digit'
      });
      const timeStr = lastTs.toLocaleTimeString('es-MX', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });

      document.getElementById('lastUpdate').textContent = `${dateStr} ${timeStr}`;

      const timeAgoEl = document.getElementById('lastUpdateTime');
      const diff = (Date.now() - lastTs.getTime()) / 1000;
      timeAgoEl.textContent = diff > 5 ? `(${formatTimeAgo(lastTs)})` : '';
    }
  } catch (err) {
    console.error('Error actualizando live data:', err);
  }
}

// =========================================================
// MONITOREO DE CONEXIÓN
// =========================================================

setInterval(() => {
  const status = document.getElementById("connectionStatus");
  const timeAgoEl = document.getElementById("lastUpdateTime");

  if (!lastRealUpdate) {
    status.className = 'badge bg-danger';
    status.textContent = 'Desconectado';
    if (timeAgoEl) timeAgoEl.textContent = "";
    return;
  }

  const diff = (Date.now() - lastRealUpdate.getTime()) / 1000;

  if (diff > 15) {
    status.className = 'badge bg-danger';
    status.textContent = 'Desconectado';
  } else {
    status.className = 'badge bg-success';
    status.textContent = 'Conectado';
  }

  if (timeAgoEl && diff > 5) {
    timeAgoEl.textContent = `(${formatTimeAgo(lastRealUpdate)})`;
  }
}, 2000);

function createHistoricalStatus() {
  const statusEl = document.createElement('span');
  statusEl.id = 'historicalStatus';
  statusEl.className = 'badge';
  statusEl.style.marginLeft = '10px';

  const connectionStatus = document.getElementById('connectionStatus');
  if (connectionStatus && connectionStatus.parentNode) {
    connectionStatus.parentNode.insertBefore(statusEl, connectionStatus.nextSibling);
  }

  return statusEl;
}

// =========================================================
// INICIALIZACIÓN Y INTERVALOS
// =========================================================

document.addEventListener('DOMContentLoaded', initializeDashboard);

// Live data cada 1 segundo
// La actualización coincide con el firmware (5s) para ahorrar recursos
setInterval(updateLiveData, 5000); // 5000ms = 5 segundos

// Histórico cada 10 segundos
setInterval(() => {
  const range = document.getElementById('rangeSelect').value;
  if (range === 'custom') {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    if (from && to) loadHistorical("custom", from, to);
  } else {
    loadHistorical(range);
  }
}, 10000);
// =========================================================
// FUNCIONES DE CALIBRACIÓN MANUAL (para consola)
// =========================================================

function calibrateMQ7(adcValue) {
  if (adcValue && adcValue > 0) {
    const Rs = calculateRs(adcValue, 'CO');
    MQ7_R0 = Rs / 4.5;
    console.log(`MQ-7 R0 calibrado: ${MQ7_R0.toFixed(0)}Ω (de ADC=${adcValue})`);
    saveCalibrationToStorage();
    alert(`MQ-7 calibrado: R0 = ${MQ7_R0.toFixed(0)}Ω (ADC: ${adcValue})`);
  }
}

function calibrateMQ137(adcValue) {
  if (adcValue && adcValue > 0) {
    const Rs = calculateRs(adcValue, 'NH3');
    MQ137_R0 = Rs / 5.0;
    console.log(`MQ-137 R0 calibrado: ${MQ137_R0.toFixed(0)}Ω (de ADC=${adcValue})`);
    saveCalibrationToStorage();
    alert(`MQ-137 calibrado: R0 = ${MQ137_R0.toFixed(0)}Ω (ADC: ${adcValue})`);
  }
}

// =========================================================
// EXPORTAR FUNCIONES PARA CONSOLA DEL NAVEGADOR
// =========================================================

// Para usar desde consola del navegador:
window.calibrateWithOutsideAir = calibrateWithOutsideAir;
window.calibrateMQ7 = calibrateMQ7;
window.calibrateMQ137 = calibrateMQ137;
window.calibrateR0FromCleanAir = calibrateR0FromCleanAir;
window.getCalibrationValues = () => ({
  MQ7_R0, MQ137_R0,
  CCS811_OFFSET, MQ7_OFFSET, MQ137_OFFSET,
  ALTITUDE_METERS, ALTITUDE_FACTOR,
  MQ7_EMPIRICAL_FACTOR: MQ7_EMPIRICAL_FACTOR,
  MQ137_EMPIRICAL_FACTOR: MQ137_EMPIRICAL_FACTOR
});

window.adjustEmpiricalFactors = (mq7Factor, mq137Factor) => {
  if (mq7Factor > 0) MQ7_EMPIRICAL_FACTOR = mq7Factor;
  if (mq137Factor > 0) MQ137_EMPIRICAL_FACTOR = mq137Factor;
  console.log(`Factores empíricos ajustados: MQ-7=${MQ7_EMPIRICAL_FACTOR}, MQ-137=${MQ137_EMPIRICAL_FACTOR}`);
};
// GESTIÓN DE UMBRALES
// =========================================================

// Configuración de rangos para sliders de umbrales
const THRESHOLD_SLIDER_CONFIG = {
  temperatura: { min: 0, max: 100, step: 0.5 },     // °C (0-100)
  humedad: { min: 0, max: 100, step: 1 },           // %  (0-100)
  co: { min: 0, max: 10000, step: 10 },             // ppm CO (0-10,000)
  co2: { min: 0, max: 10000, step: 10 },            // ppm CO2 (0-10,000)
  amoniaco: { min: 0, max: 10000, step: 10 }        // ppm NH3 (0-10,000)
};

function getThresholdSliderConfig(variable) {
  return THRESHOLD_SLIDER_CONFIG[variable] || { min: 0, max: 100, step: 1 };
}

// ... rest of the code remains the same ...
function syncThresholdSlider(variable, level, value) {
  const slider = document.getElementById(`${variable}_${level}_slider`);
  if (!slider) return;
  const num = parseFloat(value);
  if (!isNaN(num)) slider.value = num;
}

// Sincronizar input numérico cuando cambia el slider
function syncThresholdInput(variable, level, value) {
  const input = document.getElementById(`${variable}_${level}_input`);
  if (!input) return;
  input.value = value;
}

async function loadThresholds() {
  try {
    const res = await fetch(`${getBaseUrl()}/api/umbrales`);
    if (!res.ok) throw new Error('Error loading thresholds');
    const data = await res.json();

    const tbody = document.getElementById('thresholdsTableBody');
    tbody.innerHTML = '';

    // Order: temp, hum, co, co2, ammonia
    const order = ['temperatura', 'humedad', 'co', 'co2', 'amoniaco'];

    let items = data;

    // If there are no thresholds yet, create empty rows so the user can define them
    if (!Array.isArray(items) || items.length === 0) {
      items = order.map(variable => ({
        variable,
        valor_medio: '',
        valor_alto: '',
        valor_grave: ''
      }));
    } else {
      // Sort data based on preferred order
      items.sort((a, b) => order.indexOf(a.variable) - order.indexOf(b.variable));
    }

    items.forEach(item => {
      const row = document.createElement('tr');
      const label = item.variable.charAt(0).toUpperCase() + item.variable.slice(1);

      const cfg = getThresholdSliderConfig(item.variable);

      const medioVal = item.valor_medio !== '' && item.valor_medio != null ? item.valor_medio : cfg.min;
      const altoVal = item.valor_alto !== '' && item.valor_alto != null ? item.valor_alto : cfg.min;
      const graveVal = item.valor_grave !== '' && item.valor_grave != null ? item.valor_grave : cfg.min;

      row.innerHTML = `
            <td>${label}</td>
            <td>
              <div class="d-flex flex-column">
                <input
                  id="${item.variable}_medio_input"
                  type="number"
                  step="${cfg.step}"
                  class="form-control form-control-sm mb-1"
                  name="${item.variable}_medio"
                  value="${medioVal}"
                  oninput="syncThresholdSlider('${item.variable}','medio', this.value)">
                <input
                  id="${item.variable}_medio_slider"
                  type="range"
                  class="form-range"
                  min="${cfg.min}"
                  max="${cfg.max}"
                  step="${cfg.step}"
                  value="${medioVal}"
                  oninput="syncThresholdInput('${item.variable}','medio', this.value)">
              </div>
            </td>
            <td>
              <div class="d-flex flex-column">
                <input
                  id="${item.variable}_alto_input"
                  type="number"
                  step="${cfg.step}"
                  class="form-control form-control-sm mb-1"
                  name="${item.variable}_alto"
                  value="${altoVal}"
                  oninput="syncThresholdSlider('${item.variable}','alto', this.value)">
                <input
                  id="${item.variable}_alto_slider"
                  type="range"
                  class="form-range"
                  min="${cfg.min}"
                  max="${cfg.max}"
                  step="${cfg.step}"
                  value="${altoVal}"
                  oninput="syncThresholdInput('${item.variable}','alto', this.value)">
              </div>
            </td>
            <td>
              <div class="d-flex flex-column">
                <input
                  id="${item.variable}_grave_input"
                  type="number"
                  step="${cfg.step}"
                  class="form-control form-control-sm mb-1"
                  name="${item.variable}_grave"
                  value="${graveVal}"
                  oninput="syncThresholdSlider('${item.variable}','grave', this.value)">
                <input
                  id="${item.variable}_grave_slider"
                  type="range"
                  class="form-range"
                  min="${cfg.min}"
                  max="${cfg.max}"
                  step="${cfg.step}"
                  value="${graveVal}"
                  oninput="syncThresholdInput('${item.variable}','grave', this.value)">
              </div>
            </td>
        `;
      tbody.appendChild(row);
    });
  } catch (err) {
    console.error('Error loading thresholds:', err);
    alert('Error cargando umbrales');
  }
}

async function saveThresholds() {
  // Solo leer los inputs numéricos (los sliders son solo para ajuste visual)
  const inputs = document.querySelectorAll('#thresholdsTableBody input[type="number"]');
  const updates = {};

  inputs.forEach(input => {
    const [variable, type] = input.name.split('_');
    if (!updates[variable]) updates[variable] = { variable: variable };

    if (type === 'medio') updates[variable].valor_medio = parseFloat(input.value);
    if (type === 'alto') updates[variable].valor_alto = parseFloat(input.value);
    if (type === 'grave') updates[variable].valor_grave = parseFloat(input.value);
  });

  const payload = Object.values(updates);

  try {
    const res = await fetch(`${getBaseUrl()}/api/umbrales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      alert('Umbrales actualizados correctamente');
      const modal = bootstrap.Modal.getInstance(document.getElementById('thresholdsModal'));
      modal.hide();
    } else {
      throw new Error('Error saving thresholds');
    }
  } catch (err) {
    console.error('Error saving thresholds:', err);
    alert('Error guardando cambios');
  }
}

// Expose to window
window.saveThresholds = saveThresholds;

// Add event listener for modal open
document.addEventListener('DOMContentLoaded', () => {
  const modalEl = document.getElementById('thresholdsModal');
  if (modalEl) {
    modalEl.addEventListener('show.bs.modal', loadThresholds);
  }
});