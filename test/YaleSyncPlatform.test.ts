import { PanelState, ContactSensorState, MotionSensorState } from '../src/yale/YaleModels';

// ---- Homebridge mock helpers ----

function makeCharacteristic() {
  const characteristic: any = {
    on: jest.fn((_event: string, _handler: Function) => characteristic),
    setValue: jest.fn(),
    getValue: jest.fn(),
    updateValue: jest.fn(),
  };
  return characteristic;
}

function makeService(name: string) {
  const characteristics: Record<string, ReturnType<typeof makeCharacteristic>> = {};
  return {
    name,
    getCharacteristic: jest.fn((key: string) => {
      if (!characteristics[key]) characteristics[key] = makeCharacteristic();
      return characteristics[key];
    }),
    setCharacteristic: jest.fn().mockReturnThis(),
    _characteristics: characteristics,
  };
}

function makePlatformAccessory(displayName: string, uuid: string) {
  const services: Record<string, ReturnType<typeof makeService>> = {
    AccessoryInformation: makeService('AccessoryInformation'),
  };
  return {
    UUID: uuid,
    displayName,
    context: {} as Record<string, any>,
    getService: jest.fn((key: string) => services[key]),
    addService: jest.fn((key: string) => {
      services[key] = makeService(key);
      return services[key];
    }),
    _services: services,
  };
}

const Characteristic = {
  Name: 'Name',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  SecuritySystemCurrentState: { AWAY_ARM: 1, DISARMED: 3, NIGHT_ARM: 2, STAY_ARM: 0 },
  SecuritySystemTargetState: { STAY_ARM: 0, AWAY_ARM: 1, DISARM: 3 },
  MotionDetected: 'MotionDetected',
  ContactSensorState: 'ContactSensorState',
};

const Service = {
  AccessoryInformation: 'AccessoryInformation',
  SecuritySystem: 'SecuritySystem',
  MotionSensor: 'MotionSensor',
  ContactSensor: 'ContactSensor',
};

let uuidCounter = 0;
const UUIDGenerator = {
  generate: (id: string) => `uuid-${id}`,
};

function makeApi(registerCallback?: jest.Mock) {
  const listeners: Record<string, Function> = {};
  return {
    hap: { Service, Characteristic, uuid: UUIDGenerator },
    platformAccessory: makePlatformAccessory,
    on: jest.fn((event: string, handler: Function) => {
      listeners[event] = handler;
    }),
    registerPlatformAccessories: registerCallback ?? jest.fn(),
    _fire: (event: string) => listeners[event]?.(),
  };
}

function makeLog() {
  return { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

// ---- Import the platform (after mocking deps) ----

// Mock YaleApiClient so tests don't need real network
jest.mock('../src/yale/YaleApiClient');
import { YaleApiClient } from '../src/yale/YaleApiClient';

// Mock wait so heartbeat doesn't actually sleep
jest.mock('../src/Wait', () => () => Promise.resolve());

// Dynamic require so mocks are in place before module load
let YaleSyncPlatform: any;
beforeAll(() => {
  YaleSyncPlatform = require('../src/YaleSyncPlatform').default;
});

// ---- Tests ----

describe('YaleSyncPlatform', () => {
  let mockYale: jest.Mocked<YaleApiClient>;
  let api: ReturnType<typeof makeApi>;
  let log: ReturnType<typeof makeLog>;
  const config = { platform: 'YaleSyncAlarm', name: 'Yale Alarm', username: 'u', password: 'p', refreshInterval: 10 };

  const PANEL = { identifier: '1', name: 'Yale Panel', state: PanelState.Armed };
  const MOTION_SENSOR = { identifier: 'pir-001', name: 'Hallway', state: MotionSensorState.None };
  const CONTACT_SENSOR = { identifier: 'door-001', name: 'Front Door', state: ContactSensorState.Closed };

  beforeEach(() => {
    jest.clearAllMocks();
    mockYale = new (YaleApiClient as jest.MockedClass<typeof YaleApiClient>)('u', 'p') as jest.Mocked<YaleApiClient>;
    mockYale.getPanel = jest.fn().mockResolvedValue(PANEL);
    mockYale.getSensors = jest.fn().mockResolvedValue([MOTION_SENSOR, CONTACT_SENSOR]);
    (YaleApiClient as jest.MockedClass<typeof YaleApiClient>).mockImplementation(() => mockYale);

    api = makeApi();
    log = makeLog();
  });

  describe('configurePanel', () => {
    it('adds SecuritySystem service and stores accessory', () => {
      const platform = new YaleSyncPlatform(log, config, api);
      const accessory = makePlatformAccessory('Yale Panel', 'uuid-panel');
      accessory.context = { kind: 'panel', identifier: '1' };
      // Return AccessoryInformation service but nothing for SecuritySystem
      const infoService = makeService('AccessoryInformation');
      accessory.getService = jest.fn((key: string) =>
        key === Service.AccessoryInformation ? infoService : undefined
      ) as any;
      accessory.addService = jest.fn().mockReturnValue(makeService('SecuritySystem'));

      platform.configurePanel(accessory);

      expect(accessory.addService).toHaveBeenCalledWith(Service.SecuritySystem);
    });

    it('does not re-configure an already-stored accessory', () => {
      const platform = new YaleSyncPlatform(log, config, api);
      const accessory = makePlatformAccessory('Yale Panel', 'uuid-panel');
      accessory.context = { kind: 'panel', identifier: '1' };
      const infoService = makeService('AccessoryInformation');
      accessory.getService = jest.fn((key: string) =>
        key === Service.AccessoryInformation ? infoService : undefined
      ) as any;
      accessory.addService = jest.fn().mockReturnValue(makeService('SecuritySystem'));

      platform.configurePanel(accessory);
      const firstCallCount = (accessory.addService as jest.Mock).mock.calls.length;
      platform.configurePanel(accessory);
      expect((accessory.addService as jest.Mock).mock.calls.length).toBe(firstCallCount);
    });
  });

  describe('configureMotionSensor', () => {
    it('adds MotionSensor service and stores accessory', () => {
      const platform = new YaleSyncPlatform(log, config, api);
      const accessory = makePlatformAccessory('Hallway PIR', 'uuid-pir-001');
      accessory.context = { kind: 'motionSensor', identifier: 'pir-001' };
      const infoService = makeService('AccessoryInformation');
      accessory.getService = jest.fn((key: string) =>
        key === Service.AccessoryInformation ? infoService : undefined
      ) as any;
      accessory.addService = jest.fn().mockReturnValue(makeService('MotionSensor'));

      platform.configureMotionSensor(accessory);

      expect(accessory.addService).toHaveBeenCalledWith(Service.MotionSensor);
    });
  });

  describe('configureContactSensor', () => {
    it('adds ContactSensor service and stores accessory', () => {
      const platform = new YaleSyncPlatform(log, config, api);
      const accessory = makePlatformAccessory('Front Door', 'uuid-door-001');
      accessory.context = { kind: 'contactSensor', identifier: 'door-001' };
      const infoService = makeService('AccessoryInformation');
      accessory.getService = jest.fn((key: string) =>
        key === Service.AccessoryInformation ? infoService : undefined
      ) as any;
      accessory.addService = jest.fn().mockReturnValue(makeService('ContactSensor'));

      platform.configureContactSensor(accessory);

      expect(accessory.addService).toHaveBeenCalledWith(Service.ContactSensor);
    });
  });

  describe('heartbeat', () => {
    it('registers panel and sensor accessories on first run', async () => {
      const registerMock = jest.fn();
      api.registerPlatformAccessories = registerMock;
      const platform = new YaleSyncPlatform(log, config, api);

      // Run just one iteration by making getPanel throw on second call
      mockYale.getPanel
        .mockResolvedValueOnce(PANEL)
        .mockRejectedValue(new Error('stop'));

      await platform.heartbeat(0).catch(() => {});

      expect(registerMock).toHaveBeenCalledTimes(1);
      const registered: any[] = registerMock.mock.calls[0][2];
      const names = registered.map((a: any) => a.displayName);
      expect(names).toContain('Yale Panel');
      expect(names).toContain('Hallway');
      expect(names).toContain('Front Door');
    });

    it('does not re-register accessories already cached', async () => {
      const registerMock = jest.fn();
      api.registerPlatformAccessories = registerMock;
      const platform = new YaleSyncPlatform(log, config, api);

      mockYale.getPanel
        .mockResolvedValueOnce(PANEL)
        .mockResolvedValueOnce(PANEL)
        .mockRejectedValue(new Error('stop'));
      mockYale.getSensors
        .mockResolvedValueOnce([MOTION_SENSOR, CONTACT_SENSOR])
        .mockResolvedValueOnce([MOTION_SENSOR, CONTACT_SENSOR])
        .mockRejectedValue(new Error('stop'));

      await platform.heartbeat(0).catch(() => {});

      // First iteration registers 3; second iteration should register 0
      expect(registerMock).toHaveBeenCalledTimes(1);
    });

    it('logs error and continues looping on API failure', async () => {
      const platform = new YaleSyncPlatform(log, config, api);

      mockYale.getPanel
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(PANEL)
        .mockRejectedValue(new Error('stop'));
      mockYale.getSensors.mockResolvedValue([]).mockRejectedValue(new Error('stop'));

      await platform.heartbeat(0).catch(() => {});

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('Heartbeat error'),
        expect.any(Error),
      );
    });
  });
});
