
const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const ALGORITHM_VERSION = 'mamdani-v1';
const ALERT_COOLDOWN_MS = 3 * 60 * 1000;

const PARAM_WEIGHTS = Object.freeze({
  soil: 0.25,
  temperature: 0.25,
  humidity: 0.20,
  ph: 0.15,
  light: 0.15,
});

const DEFAULT_STAGE = Object.freeze({
  temp_min: 24.0,
  temp_max: 30.0,
  soil_moisture_min: 60.0,
  soil_moisture_max: 80.0,
  air_humidity_min: 70.0,
  air_humidity_max: 85.0,
  lux_min: 50000.0,
  lux_max: 80000.0,
});

function makeStage(stageId, stageName, values = {}) {
  // Explicit defaults reproduce GrowthStage.fromMap() where null/missing
  // preset fields are replaced by generic values.
  return {
    stage_id: stageId,
    stage_name: stageName,
    temp_min: values.temp_min ?? DEFAULT_STAGE.temp_min,
    temp_max: values.temp_max ?? DEFAULT_STAGE.temp_max,
    soil_moisture_min: values.soil_moisture_min ?? DEFAULT_STAGE.soil_moisture_min,
    soil_moisture_max: values.soil_moisture_max ?? DEFAULT_STAGE.soil_moisture_max,
    air_humidity_min: values.air_humidity_min ?? DEFAULT_STAGE.air_humidity_min,
    air_humidity_max: values.air_humidity_max ?? DEFAULT_STAGE.air_humidity_max,
    lux_min: values.lux_min ?? DEFAULT_STAGE.lux_min,
    lux_max: values.lux_max ?? DEFAULT_STAGE.lux_max,
  };
}

// Mirrored from assets/plant_presets.txt. Do not silently change thresholds
// here without applying the same change to the Flutter preset asset.
const CROP_PRESETS = [
  {
    crop_id: 'robusta_coffee',
    crop_name: 'Cà phê vối',
    soil_ph_min: 4.5,
    soil_ph_max: 6.0,
    growth_stages: [
      makeStage(1, 'Sinh trưởng', {
        temp_min: 20, temp_max: 30,
        soil_moisture_min: 30,
        air_humidity_min: 80, air_humidity_max: 90,
      }),
      makeStage(2, 'Ra hoa - đậu quả', {
        temp_min: 20, temp_max: 30,
        soil_moisture_min: 30,
        air_humidity_min: 80, air_humidity_max: 90,
      }),
      makeStage(3, 'Quả phát triển - chín', {
        temp_min: 20, temp_max: 30,
        air_humidity_min: 80, air_humidity_max: 90,
      }),
    ],
  },
  {
    crop_id: 'black_pepper',
    crop_name: 'Hồ tiêu',
    soil_ph_min: 5.0,
    soil_ph_max: 7.0,
    growth_stages: [
      makeStage(1, 'Sinh trưởng', {
        temp_min: 23, temp_max: 32,
        soil_moisture_min: 28, soil_moisture_max: 30,
        air_humidity_min: 60, air_humidity_max: 95,
      }),
      makeStage(2, 'Ra hoa - đậu quả', {
        temp_min: 23, temp_max: 32,
        air_humidity_min: 60, air_humidity_max: 95,
      }),
      makeStage(3, 'Quả phát triển - chín', {
        temp_min: 23, temp_max: 32,
        air_humidity_min: 60, air_humidity_max: 95,
      }),
    ],
  },
  {
    crop_id: 'cashew',
    crop_name: 'Điều',
    soil_ph_min: 4.5,
    soil_ph_max: 6.5,
    growth_stages: [
      makeStage(1, 'Sinh trưởng', { temp_min: 25, temp_max: 35 }),
      makeStage(2, 'Ra hoa - đậu quả', { temp_min: 25, temp_max: 35 }),
      makeStage(3, 'Quả phát triển - chín', { temp_min: 25, temp_max: 35 }),
    ],
  },
  {
    crop_id: 'durian',
    crop_name: 'Sầu riêng',
    soil_ph_min: 5.5,
    soil_ph_max: 6.5,
    growth_stages: [
      makeStage(1, 'Sinh trưởng', {
        temp_min: 24, temp_max: 30,
        air_humidity_min: 75, air_humidity_max: 90,
      }),
      makeStage(2, 'Tạo mầm - ra hoa', {
        temp_min: 24, temp_max: 30,
        air_humidity_min: 75, air_humidity_max: 90,
      }),
      makeStage(3, 'Đậu quả - phát triển quả', {
        temp_min: 24, temp_max: 30,
        air_humidity_min: 75, air_humidity_max: 90,
      }),
    ],
  },
];

const farmContextCache = new Map();
const FARM_CONTEXT_CACHE_TTL_MS = 60 * 1000;

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function parseStageId(value) {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function extractCropContext(data = {}) {
  const crop = data.crop && typeof data.crop === 'object' ? data.crop : {};
  const plant = data.plant && typeof data.plant === 'object' ? data.plant : {};
  const cropId = firstDefined(
    data.cropId, data.crop_id, data.plantName,
    crop.cropId, crop.crop_id, crop.id, crop.name,
    plant.cropId, plant.crop_id, plant.id, plant.name
  );
  const stageId = parseStageId(firstDefined(
    data.stageId, data.stage_id, data.growthStageId,
    crop.stageId, crop.stage_id, crop.growthStageId,
    plant.stageId, plant.stage_id, plant.growthStageId
  ));
  return {
    cropId: cropId === undefined ? null : String(cropId),
    stageId,
  };
}

/**
 * Firestore schema fallback. The code first looks in farms/{farmId}, then in
 * users/{uid}/farms/{farmId}. If the actual app schema stores crop settings at
 * another path, update this one function instead of duplicating lookup logic.
 */
async function loadFarmContextFromFirestore(uid, farmId) {
  const cacheKey = `${uid}/${farmId}`;
  const cached = farmContextCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < FARM_CONTEXT_CACHE_TTL_MS) {
    return cached.value;
  }

  const firestore = admin.firestore();
  const candidates = [
    firestore.collection('farms').doc(farmId),
    firestore.collection('users').doc(uid).collection('farms').doc(farmId),
  ];

  let result = { cropId: null, stageId: null };
  for (const ref of candidates) {
    try {
      const snap = await ref.get();
      if (!snap.exists) continue;
      const candidate = extractCropContext(snap.data() || {});
      if (candidate.cropId !== null) result.cropId = candidate.cropId;
      if (candidate.stageId !== null) result.stageId = candidate.stageId;
      if (result.cropId !== null && result.stageId !== null) break;
    } catch (error) {
      // A missing/unreadable optional metadata path should not stop telemetry
      // evaluation. Log it so the schema can be corrected during deployment.
      console.warn('[GreenPulse] Không đọc được metadata farm:', error.message);
    }
  }

  farmContextCache.set(cacheKey, { value: result, cachedAt: Date.now() });
  return result;
}

async function resolveCropContext(uid, farmId, sensorData) {
  const fromSensor = extractCropContext(sensorData);
  if (fromSensor.cropId !== null && fromSensor.stageId !== null) {
    return { ...fromSensor, source: 'sensor_payload' };
  }

  const fromFarm = await loadFarmContextFromFirestore(uid, farmId);
  const cropId = fromSensor.cropId ?? fromFarm.cropId;
  const stageId = fromSensor.stageId ?? fromFarm.stageId ?? 1;
  const source = fromSensor.cropId !== null || fromSensor.stageId !== null
    ? 'sensor_payload+firestore'
    : (fromFarm.cropId !== null || fromFarm.stageId !== null ? 'firestore_farm' : 'default');

  return { cropId, stageId, source };
}

function getCropById(cropId) {
  if (!CROP_PRESETS.length) return null;
  if (cropId === null || cropId === undefined || cropId === '') return CROP_PRESETS[0];
  const requested = String(cropId).toLowerCase();
  return CROP_PRESETS.find((crop) =>
    crop.crop_id.toLowerCase() === requested || crop.crop_name.toLowerCase() === requested
  ) || CROP_PRESETS[0];
}

function getStageById(crop, stageId) {
  if (!crop || !Array.isArray(crop.growth_stages) || crop.growth_stages.length === 0) {
    return makeStage(1, 'Mặc định');
  }
  return crop.growth_stages.find((stage) => stage.stage_id === stageId) || crop.growth_stages[0];
}

// The functions below intentionally mirror fuzzy_logic_engine.dart.
function trapezoid(x, a, b, c, d) {
  if (a === b && x <= b) return 1.0;
  if (c === d && x >= c) return 1.0;
  if (x <= a || x >= d) return 0.0;
  if (x >= b && x <= c) return 1.0;
  if (x > a && x < b) return (x - a) / (b - a);
  if (x > c && x < d) return (d - x) / (d - c);
  return 0.0;
}

function triangle(x, a, b, c) {
  if (x <= a || x >= c) return 0.0;
  if (x === b) return 1.0;
  if (x > a && x < b) return b === a ? 1.0 : (x - a) / (b - a);
  if (x > b && x < c) return c === b ? 1.0 : (c - x) / (c - b);
  return 0.0;
}

function getDeviation(value, minValue, maxValue) {
  if (value >= minValue && value <= maxValue) {
    return { deviation: 0.0, direction: 'binh_thuong' };
  }
  let span = maxValue - minValue;
  if (span <= 0) span = Math.max(1.0, Math.abs(minValue) * 0.2);
  if (value < minValue) {
    return { deviation: (minValue - value) / span, direction: 'thap' };
  }
  return { deviation: (value - maxValue) / span, direction: 'cao' };
}

function fuzzify(deviation) {
  const d = Math.max(0.0, Math.min(1.0, deviation));
  return {
    normal: trapezoid(d, 0, 0, 0.15, 0.40),
    warning: triangle(d, 0.25, 0.50, 0.80),
    danger: trapezoid(d, 0.60, 0.85, 1.0, 1.0),
  };
}

function formatFixed(value, digits = 1) {
  return Number(value).toFixed(digits);
}

function evaluateMamdani(sensorData, cropContext) {
  const readings = {
    soil: parseNumber(firstDefined(sensorData.soil, sensorData.soilMoisture, sensorData.soil_moisture)),
    temperature: parseNumber(firstDefined(sensorData.temperature, sensorData.temp)),
    humidity: parseNumber(firstDefined(sensorData.humidity, sensorData.airHumidity, sensorData.air_humidity)),
    ph: parseNumber(firstDefined(sensorData.ph, sensorData.pH)),
    light: parseNumber(firstDefined(sensorData.light, sensorData.lux)),
  };
  const available = Object.fromEntries(
    Object.entries(readings).filter(([, value]) => value !== null)
  );

  if (Object.keys(available).length === 0) {
    return {
      algorithm_version: ALGORITHM_VERSION,
      risk_score: 0.0,
      overall_status: 'normal',
      is_alert_triggered: false,
      param_statuses: {},
      advice_list: ['Chưa có dữ liệu cảm biến hợp lệ gửi về từ nông trại.'],
      crop_name: 'Cây trồng',
      stage_name: 'Giai đoạn sinh trưởng',
      crop_context_source: cropContext.source,
      is_offline_fallback: false,
    };
  }

  const crop = getCropById(cropContext.cropId);
  const stage = getStageById(crop, cropContext.stageId ?? 1);
  const cropName = crop?.crop_name || 'Cây trồng';
  const stageName = stage?.stage_name || 'Giai đoạn sinh trưởng';

  const ranges = {
    ph: [crop?.soil_ph_min ?? 5.5, crop?.soil_ph_max ?? 6.5],
    temperature: [stage.temp_min ?? 24.0, stage.temp_max ?? 30.0],
    humidity: [stage.air_humidity_min ?? 70.0, stage.air_humidity_max ?? 85.0],
    soil: [stage.soil_moisture_min ?? 60.0, stage.soil_moisture_max ?? 80.0],
    light: [stage.lux_min ?? 50000.0, stage.lux_max ?? 80000.0],
  };

  const deviations = {};
  for (const [name, value] of Object.entries(available)) {
    deviations[name] = getDeviation(value, ranges[name][0], ranges[name][1]);
  }

  let onlineWeightTotal = 0.0;
  for (const name of Object.keys(deviations)) onlineWeightTotal += PARAM_WEIGHTS[name] ?? 0.2;
  if (onlineWeightTotal <= 0) onlineWeightTotal = 1.0;

  const GRID_SIZE = 200;
  const riskGrid = Array.from({ length: GRID_SIZE }, (_, i) => i * (100.0 / (GRID_SIZE - 1)));
  const aggregate = Array(GRID_SIZE).fill(0.0);
  const outputLow = riskGrid.map((x) => trapezoid(x, 0, 0, 20, 35));
  const outputMedium = riskGrid.map((x) => triangle(x, 25, 50, 75));
  const outputHigh = riskGrid.map((x) => trapezoid(x, 65, 80, 100, 100));
  const paramStatuses = {};

  for (const [name, deviationInfo] of Object.entries(deviations)) {
    const memberships = fuzzify(deviationInfo.deviation);
    const normalizedWeight = (PARAM_WEIGHTS[name] ?? 0.2) / onlineWeightTotal;
    const activationLow = memberships.normal * normalizedWeight;
    const activationMedium = memberships.warning * normalizedWeight;
    const activationHigh = memberships.danger * normalizedWeight;

    for (let i = 0; i < GRID_SIZE; i++) {
      const cutLow = Math.min(activationLow, outputLow[i]);
      const cutMedium = Math.min(activationMedium, outputMedium[i]);
      const cutHigh = Math.min(activationHigh, outputHigh[i]);
      const aggregatedForParam = Math.max(cutLow, cutMedium, cutHigh);
      aggregate[i] = Math.max(aggregate[i], aggregatedForParam);
    }

    if (memberships.danger >= Math.max(memberships.normal, memberships.warning)
        && deviationInfo.deviation >= 0.6) {
      paramStatuses[name] = 'danger';
    } else if (memberships.warning > memberships.normal || deviationInfo.deviation >= 0.25) {
      paramStatuses[name] = 'warning';
    } else {
      paramStatuses[name] = 'normal';
    }
  }

  const advice = [];
  if (deviations.ph) {
    if (deviations.ph.direction === 'thap') {
      advice.push(`Đất bị chua (pH = ${formatFixed(readings.ph)} < ${ranges.ph[0]}). Khuyến nghị bón vôi nông nghiệp (CaCO3) để nâng pH.`);
    } else if (deviations.ph.direction === 'cao') {
      advice.push(`Đất bị kiềm hóa (pH = ${formatFixed(readings.ph)} > ${ranges.ph[1]}). Bổ sung phân hữu cơ hoai mục để hạ pH.`);
    }
  }
  if (deviations.temperature) {
    if (deviations.temperature.direction === 'cao') {
      advice.push(`Nhiệt độ (${formatFixed(readings.temperature)}°C) cao hơn ngưỡng tối ưu (${ranges.temperature[1]}°C). Bật hệ thống phun sương làm mát.`);
    } else if (deviations.temperature.direction === 'thap') {
      advice.push(`Nhiệt độ (${formatFixed(readings.temperature)}°C) thấp hơn mức sinh trưởng (${ranges.temperature[0]}°C). Cần che chắn gió cho cây.`);
    }
  }
  if (deviations.soil) {
    if (deviations.soil.direction === 'thap') {
      advice.push(`Độ ẩm đất (${formatFixed(readings.soil)}%) quá khô so với nhu cầu giai đoạn này (${ranges.soil[0]}%). Kiểm tra hệ thống và cân nhắc tưới nước.`);
    } else if (deviations.soil.direction === 'cao' && readings.soil > 90.0) {
      advice.push(`Đất đang bị úng nước (${formatFixed(readings.soil)}% > ${ranges.soil[1]}%). Tạm ngưng tưới và kiểm tra thoát nước.`);
    }
  }
  if (deviations.humidity) {
    if (deviations.humidity.direction === 'thap') {
      advice.push(`Độ ẩm không khí (${formatFixed(readings.humidity)}%) quá khô. Kiểm tra điều kiện thông thoáng và nhu cầu tạo ẩm.`);
    } else if (deviations.humidity.direction === 'cao' && readings.humidity > 90.0) {
      advice.push(`Ẩm độ không khí quá cao (${formatFixed(readings.humidity)}%). Tăng thông thoáng vườn để giảm nguy cơ nấm bệnh.`);
    }
  }
  if (deviations.light) {
    if (deviations.light.direction === 'thap') {
      advice.push(`Cường độ ánh sáng (${formatFixed(readings.light, 0)} lux) thấp hơn khoảng đang cấu hình (${ranges.light[0]} lux). Kiểm tra điều kiện che phủ và cảm biến.`);
    } else if (deviations.light.direction === 'cao') {
      advice.push(`Cường độ ánh sáng (${formatFixed(readings.light, 0)} lux) cao hơn khoảng đang cấu hình (${ranges.light[1]} lux). Kiểm tra điều kiện che nắng của vườn.`);
    }
  }
  if (advice.length === 0) {
    advice.push(`Tất cả chỉ số cảm biến đang ở trạng thái tối ưu cho giai đoạn '${stageName}'.`);
  }

  let numerator = 0.0;
  let denominator = 0.0;
  for (let i = 0; i < GRID_SIZE; i++) {
    numerator += riskGrid[i] * aggregate[i];
    denominator += aggregate[i];
  }
  let riskScore = denominator > 0 ? numerator / denominator : 0.0;
  riskScore = Math.round(Math.max(0.0, Math.min(100.0, riskScore)) * 10) / 10;

  let overallStatus = 'normal';
  if (Object.values(paramStatuses).includes('danger') || riskScore >= 50.0) {
    overallStatus = 'danger';
  } else if (Object.values(paramStatuses).includes('warning') || riskScore >= 25.0) {
    overallStatus = 'warning';
  }

  return {
    algorithm_version: ALGORITHM_VERSION,
    risk_score: riskScore,
    overall_status: overallStatus,
    is_alert_triggered: overallStatus !== 'normal',
    param_statuses: paramStatuses,
    advice_list: advice,
    crop_name: cropName,
    stage_name: stageName,
    crop_id: crop?.crop_id || 'default',
    stage_id: stage?.stage_id || 1,
    crop_context_source: cropContext.source,
    is_offline_fallback: false,
  };
}

function toFcmStringMap(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null) result[key] = String(item);
  }
  return result;
}

/**
 * Runs on the sensor data path, writes the canonical server evaluation to a
 * separate RTDB path, and sends FCM from that same evaluation.
 */
exports.onSensorDataUpdated = functions.database
  .ref('/sensors/{uid}/{farmId}/{sensorId}')
  .onWrite(async (change, context) => {
    if (!change.after.exists()) return null;

    const { uid, farmId, sensorId } = context.params;
    const sensorData = change.after.val();
    if (!sensorData || typeof sensorData !== 'object') return null;

    try {
      const cropContext = await resolveCropContext(uid, farmId, sensorData);
      const evaluation = evaluateMamdani(sensorData, cropContext);
      const evaluatedAt = admin.database.ServerValue.TIMESTAMP;

      // Separate branch avoids retriggering /sensors/... onWrite.
      await admin.database().ref(`/ai_evaluations/${uid}/${farmId}/${sensorId}`).set({
        ...evaluation,
        uid,
        farm_id: farmId,
        sensor_id: sensorId,
        evaluated_at: evaluatedAt,
        input_snapshot: {
          soil: parseNumber(firstDefined(sensorData.soil, sensorData.soilMoisture, sensorData.soil_moisture)),
          temperature: parseNumber(firstDefined(sensorData.temperature, sensorData.temp)),
          humidity: parseNumber(firstDefined(sensorData.humidity, sensorData.airHumidity, sensorData.air_humidity)),
          ph: parseNumber(firstDefined(sensorData.ph, sensorData.pH)),
          light: parseNumber(firstDefined(sensorData.light, sensorData.lux)),
        },
      }).catch((error) => {
        console.error('[GreenPulse] Không lưu được AI evaluation:', error);
        throw error;
      });

      console.log('[GreenPulse] Mamdani evaluation', {
        uid,
        farmId,
        sensorId,
        riskScore: evaluation.risk_score,
        status: evaluation.overall_status,
        crop: evaluation.crop_name,
        stage: evaluation.stage_name,
        cropContextSource: evaluation.crop_context_source,
      });

      // Match Flutter's isAlertTriggered: both Warning and Danger can alert.
      if (!evaluation.is_alert_triggered) return null;

      const userRef = admin.firestore().collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        console.log(`[FCM] Không tìm thấy users/${uid}.`);
        return null;
      }

      const userData = userDoc.data() || {};
      const fcmToken = userData.fcmToken;
      if (!fcmToken) {
        console.log(`[FCM] User ${uid} chưa có FCM token.`);
        return null;
      }

      // Preserve the existing 3-minute user-level cooldown.
      const lastAlertTime = userData.lastFcmAlertTime?.toMillis?.() || 0;
      const now = Date.now();
      if (now - lastAlertTime < ALERT_COOLDOWN_MS) {
        console.log('[FCM] Cooldown: đã gửi cảnh báo trong vòng 3 phút gần đây.');
        return null;
      }

      const isDanger = evaluation.overall_status === 'danger';
      const title = isDanger
        ? `🚨 [NGUY HIỂM] ${evaluation.crop_name}`
        : `⚠️ [CẢNH BÁO] ${evaluation.crop_name}`;
      const bodyParts = [
        `${evaluation.stage_name} · Rủi ro ${evaluation.risk_score}/100`,
        ...evaluation.advice_list.slice(0, 2),
      ];
      const message = {
        token: fcmToken,
        notification: {
          title,
          body: bodyParts.join(' '),
        },
        data: toFcmStringMap({
          farmId,
          sensorId,
          cropId: evaluation.crop_id,
          stageId: evaluation.stage_id,
          riskScore: evaluation.risk_score,
          overallStatus: evaluation.overall_status,
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        }),
        android: {
          priority: 'high',
          notification: {
            channelId: 'greenpulse_alerts_channel',
            sound: 'default',
            priority: 'max',
          },
        },
        apns: {
          payload: {
            aps: { sound: 'default', badge: 1 },
          },
        },
      };

      try {
        const response = await admin.messaging().send(message);
        console.log(`[FCM] Gửi thành công tới user ${uid}: ${response}`);
        await userRef.set({
          lastFcmAlertTime: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (error) {
        console.error('[FCM Error] Không gửi được push notification:', error);
      }

      return null;
    } catch (error) {
      console.error('[GreenPulse] Lỗi xử lý dữ liệu cảm biến:', error);
      return null;
    }
  });
