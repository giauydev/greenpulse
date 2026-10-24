const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test, beforeEach } = require('node:test');

// These tests exercise the exported Realtime Database trigger without connecting
// to Firebase or sending real FCM notifications.
let state;

function newState() {
  return {
    writes: Object.create(null),
    messages: [],
    users: Object.create(null),
    globalFarms: Object.create(null),
    userFarms: Object.create(null),
    sendError: null,
  };
}

function readDoc(record) {
  return {
    exists: record !== undefined && record !== null,
    data: () => record,
  };
}

function getDocRecord(collectionName, id, parentUserId = null) {
  if (collectionName === 'users') return state.users[id];
  if (collectionName === 'farms') return state.globalFarms[id];
  if (collectionName === 'user_farms') return state.userFarms[`${parentUserId}/${id}`];
  return undefined;
}

const adminMock = {
  initializeApp() {},
  database: Object.assign(
    () => ({
      ref(refPath) {
        return {
          async set(value) {
            state.writes[refPath] = structuredClone(value);
          },
        };
      },
    }),
    { ServerValue: { TIMESTAMP: 'MOCK_SERVER_TIMESTAMP' } },
  ),
  firestore: Object.assign(
    () => ({
      collection(collectionName) {
        return {
          doc(id) {
            const record = getDocRecord(collectionName, id);
            return {
              async get() {
                return readDoc(record);
              },
              collection(subCollectionName) {
                return {
                  doc(childId) {
                    return {
                      async get() {
                        const nested = subCollectionName === 'farms'
                          ? getDocRecord('user_farms', childId, id)
                          : undefined;
                        return readDoc(nested);
                      },
                    };
                  },
                };
              },
              async set(patch, options = {}) {
                if (collectionName !== 'users') return;
                const existing = state.users[id] || {};
                state.users[id] = options.merge ? { ...existing, ...patch } : patch;
              },
            };
          },
        };
      },
    }),
    { FieldValue: { serverTimestamp: () => 'MOCK_SERVER_TIMESTAMP' } },
  ),
  messaging() {
    return {
      async send(message) {
        if (state.sendError) throw state.sendError;
        state.messages.push(structuredClone(message));
        return `mock-message-${state.messages.length}`;
      },
    };
  },
};

const functionsMock = {
  database: {
    ref() {
      return {
        onWrite(handler) {
          return handler;
        },
      };
    },
  },
};

// Intercept Firebase requires only while loading index.js. No production code
// changes or third-party mocking dependency are required.
const originalLoad = Module._load;
Module._load = function mockFirebaseModules(request, parent, isMain) {
  if (request === 'firebase-functions') return functionsMock;
  if (request === 'firebase-admin') return adminMock;
  return originalLoad.call(this, request, parent, isMain);
};
let trigger;
try {
  trigger = require(path.join(__dirname, '..', 'index.js')).onSensorDataUpdated;
} finally {
  Module._load = originalLoad;
}

beforeEach(() => {
  state = newState();
});

const UID = 'test-user';
const FARM_ID = 'farm-01';
const SENSOR_ID = 'sensor-01';

function validSensor(overrides = {}) {
  return {
    soil: 65,
    temperature: 27,
    humidity: 83,
    ph: 5.5,
    light: 65000,
    cropId: 'robusta_coffee',
    stageId: 1,
    ...overrides,
  };
}

function eventFor(sensorData, { exists = true } = {}) {
  return {
    after: {
      exists: () => exists,
      val: () => sensorData,
    },
  };
}

function context() {
  return { params: { uid: UID, farmId: FARM_ID, sensorId: SENSOR_ID } };
}

function evaluation() {
  return state.writes[`/ai_evaluations/${UID}/${FARM_ID}/${SENSOR_ID}`];
}

test('normal readings are evaluated and stored, without sending a push', async () => {
  await trigger(eventFor(validSensor()), context());

  const result = evaluation();
  assert.ok(result, 'expected canonical evaluation to be saved');
  assert.equal(result.overall_status, 'normal');
  assert.equal(result.is_alert_triggered, false);
  assert.equal(result.crop_id, 'robusta_coffee');
  assert.equal(result.stage_id, 1);
  assert.equal(result.algorithm_version, 'mamdani-v1');
  assert.equal(result.evaluated_at, 'MOCK_SERVER_TIMESTAMP');
  assert.equal(state.messages.length, 0);
  assert.equal(Object.keys(state.writes).length, 1, 'only the AI evaluation branch should be written');
});

test('warning readings are stored and send an FCM warning', async () => {
  state.users[UID] = { fcmToken: 'mock-fcm-token' };

  await trigger(eventFor(validSensor({ temperature: 33 })), context());

  const result = evaluation();
  assert.ok(result);
  assert.equal(result.overall_status, 'warning');
  assert.equal(result.is_alert_triggered, true);
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0].notification.title, /CẢNH BÁO/);
  assert.equal(state.messages[0].data.overallStatus, 'warning');
  assert.equal(state.messages[0].data.cropId, 'robusta_coffee');
  assert.ok(Number.isFinite(result.risk_score));
  assert.ok(result.risk_score >= 0 && result.risk_score <= 100);
});

test('danger readings are stored and send an FCM danger notification', async () => {
  state.users[UID] = { fcmToken: 'mock-fcm-token' };

  await trigger(eventFor(validSensor({ temperature: 40 })), context());

  const result = evaluation();
  assert.ok(result);
  assert.equal(result.overall_status, 'danger');
  assert.equal(result.is_alert_triggered, true);
  assert.equal(result.param_statuses.temperature, 'danger');
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0].notification.title, /NGUY HIỂM/);
  assert.equal(state.messages[0].data.overallStatus, 'danger');
});

test('crop preset changes the result for the same temperature', async () => {
  // 33°C is outside the coffee preset (20–30°C), but within the cashew preset (25–35°C).
  await trigger(eventFor(validSensor({ temperature: 33, cropId: 'robusta_coffee' })), context());
  const coffeeResult = evaluation();

  state = newState();
  await trigger(eventFor(validSensor({ temperature: 33, cropId: 'cashew' })), context());
  const cashewResult = evaluation();

  assert.equal(coffeeResult.overall_status, 'warning');
  assert.equal(cashewResult.overall_status, 'normal');
  assert.equal(coffeeResult.crop_id, 'robusta_coffee');
  assert.equal(cashewResult.crop_id, 'cashew');
});

test('missing or invalid sensor values do not throw and do not send a push', async () => {
  await trigger(eventFor({ soil: 'not-a-number', temperature: null, humidity: '' }), context());

  const result = evaluation();
  assert.ok(result);
  assert.equal(result.risk_score, 0);
  assert.equal(result.overall_status, 'normal');
  assert.equal(result.is_alert_triggered, false);
  assert.deepEqual(result.param_statuses, {});
  assert.ok(result.advice_list.length > 0);
  assert.equal(state.messages.length, 0);
});

test('numeric strings with comma decimal separators are accepted', async () => {
  await trigger(eventFor(validSensor({ temperature: '27,5', ph: '5,5' })), context());

  const result = evaluation();
  assert.ok(result);
  assert.equal(result.input_snapshot.temperature, 27.5);
  assert.equal(result.input_snapshot.ph, 5.5);
  assert.equal(result.overall_status, 'normal');
});

test('cooldown suppresses duplicate FCM notifications but keeps evaluation', async () => {
  state.users[UID] = {
    fcmToken: 'mock-fcm-token',
    lastFcmAlertTime: { toMillis: () => Date.now() - 30_000 },
  };

  await trigger(eventFor(validSensor({ temperature: 33 })), context());

  assert.ok(evaluation(), 'evaluation should be persisted even during cooldown');
  assert.equal(evaluation().overall_status, 'warning');
  assert.equal(state.messages.length, 0);
});


test('FCM failures are caught and do not erase the saved evaluation', async () => {
  state.users[UID] = { fcmToken: 'mock-fcm-token' };
  state.sendError = new Error('mock FCM unavailable');

  await trigger(eventFor(validSensor({ temperature: 33 })), context());

  assert.ok(evaluation(), 'evaluation should still be saved if push delivery fails');
  assert.equal(evaluation().overall_status, 'warning');
  assert.equal(state.messages.length, 0);
});

test('alerts are not sent when the user has no FCM token', async () => {
  state.users[UID] = {};
  await trigger(eventFor(validSensor({ temperature: 40 })), context());

  assert.equal(evaluation().overall_status, 'danger');
  assert.equal(state.messages.length, 0);
});

test('deleted sensor records are ignored', async () => {
  await trigger(eventFor(null, { exists: false }), context());
  assert.equal(Object.keys(state.writes).length, 0);
  assert.equal(state.messages.length, 0);
});

test('farm metadata can provide crop and stage when the sensor payload omits them', async () => {
  // Use a unique farm id so the production 60-second context cache from other
  // tests cannot affect this case.
  const metadataContext = { params: { uid: 'metadata-user', farmId: 'metadata-farm', sensorId: 'metadata-sensor' } };
  state.globalFarms['metadata-farm'] = { cropId: 'cashew', stageId: 1 };
  await trigger(eventFor(validSensor({ cropId: undefined, stageId: undefined, temperature: 33 })), metadataContext);

  const result = state.writes['/ai_evaluations/metadata-user/metadata-farm/metadata-sensor'];
  assert.ok(result);
  assert.equal(result.crop_id, 'cashew');
  assert.equal(result.crop_context_source, 'firestore_farm');
  assert.equal(result.overall_status, 'normal');
});
