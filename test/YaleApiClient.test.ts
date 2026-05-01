import { YaleApiClient } from '../src/yale/YaleApiClient';
import { PanelState, ContactSensorState, MotionSensorState } from '../src/yale/YaleModels';

// Replace global fetch with a jest mock
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const AUTH_RESPONSE = {
  access_token: 'test-token-abc',
  expires_in: 3600,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('authenticate', () => {
  it('sends form-encoded body with Basic auth to token endpoint', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))   // authenticate
      .mockResolvedValueOnce(makeResponse({ data: [{ mode: 'disarm', name: 'Panel' }] })); // getPanel

    const client = new YaleApiClient('user@example.com', 'pass123');
    await client.getPanel();

    const authCall = mockFetch.mock.calls[0];
    expect(authCall[0]).toContain('/o/token/');
    expect(authCall[1].method).toBe('POST');
    expect(authCall[1].headers['Authorization']).toMatch(/^Basic /);
    expect(authCall[1].headers['Content-Type']).toMatch(/application\/x-www-form-urlencoded/);
    expect(authCall[1].body).toContain('grant_type=password');
    expect(authCall[1].body).toContain('username=user%40example.com');
  });

  it('throws if authentication fails', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ error: 'invalid_grant' }, 401));

    const client = new YaleApiClient('user@example.com', 'wrong');
    await expect(client.getPanel()).rejects.toThrow('Authentication failed');
  });

  it('reuses token on subsequent calls without re-authenticating', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: [{ mode: 'disarm', name: 'Panel' }] }))
      .mockResolvedValueOnce(makeResponse({ data: [{ mode: 'arm', name: 'Panel' }] }));

    const client = new YaleApiClient('user@example.com', 'pass123');
    await client.getPanel();
    await client.getPanel();

    // Only one auth call for two getPanel calls
    const authCalls = mockFetch.mock.calls.filter(c => (c[0] as string).includes('/o/token/'));
    expect(authCalls).toHaveLength(1);
  });
});

describe('getPanel', () => {
  it('reads panel state from nested data[0].mode', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: [{ mode: 'arm', name: 'Main Panel' }] }));

    const client = new YaleApiClient('u', 'p');
    const panel = await client.getPanel();

    expect(panel.state).toBe(PanelState.Armed);
    expect(panel.name).toBe('Main Panel');
  });

  it('handles flat response shape as fallback', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ mode: 'home', name: 'Panel' }));

    const client = new YaleApiClient('u', 'p');
    const panel = await client.getPanel();
    expect(panel.state).toBe(PanelState.Home);
  });

  it('sends Bearer token in Authorization header', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: [{ mode: 'disarm' }] }));

    const client = new YaleApiClient('u', 'p');
    await client.getPanel();

    const panelCall = mockFetch.mock.calls[1];
    expect(panelCall[1].headers['Authorization']).toBe('Bearer test-token-abc');
  });

  it('throws if panel fetch fails', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ error: 'forbidden' }, 403));

    const client = new YaleApiClient('u', 'p');
    await expect(client.getPanel()).rejects.toThrow('Failed to fetch panel state');
  });
});

describe('setPanelState', () => {
  it('sends form-encoded body with correct mode string', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: { cmd_ack: 'OK' } }));

    const client = new YaleApiClient('u', 'p');
    const result = await client.setPanelState(PanelState.Armed);

    const setCall = mockFetch.mock.calls[1];
    expect(setCall[1].method).toBe('POST');
    expect(setCall[1].headers['Content-Type']).toMatch(/application\/x-www-form-urlencoded/);
    expect(setCall[1].body).toBe('area=1&mode=arm');
    expect(result.state).toBe(PanelState.Armed);
  });

  it('sends "disarm" for Disarmed state', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: { cmd_ack: 'OK' } }));

    const client = new YaleApiClient('u', 'p');
    await client.setPanelState(PanelState.Disarmed);

    expect(mockFetch.mock.calls[1][1].body).toBe('area=1&mode=disarm');
  });

  it('throws if API rejects the state change', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: { cmd_ack: 'FAIL' } }));

    const client = new YaleApiClient('u', 'p');
    await expect(client.setPanelState(PanelState.Armed)).rejects.toThrow('Yale panel rejected state change');
  });

  it('does not send a duplicate Authorization header', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse({ data: { cmd_ack: 'OK' } }));

    const client = new YaleApiClient('u', 'p');
    await client.setPanelState(PanelState.Home);

    // Only one Authorization key in headers (not duplicated)
    const headers = mockFetch.mock.calls[1][1].headers;
    const authKeys = Object.keys(headers).filter(k => k.toLowerCase() === 'authorization');
    expect(authKeys).toHaveLength(1);
  });
});

describe('getSensors', () => {
  const DEVICES_RESPONSE = {
    data: [
      {
        device_id: 'door-001',
        name: 'Front Door',
        type: 'device_type.door_contact',
        status1: 'device_status.dc_open',
      },
      {
        device_id: 'pir-001',
        name: 'Hallway PIR',
        type: 'device_type.pir',
        status1: 'device_status.pir_triggered',
      },
      {
        device_id: 'door-002',
        name: 'Back Door',
        type: 'device_type.door_contact',
        status1: 'device_status.dc_close',
      },
      {
        device_id: 'pir-002',
        name: 'Lounge PIR',
        type: 'device_type.pir',
        status1: 'device_status.pir_untracked',
      },
      {
        device_id: 'unknown-001',
        name: 'Unknown Device',
        type: 'device_type.something_else',
        status1: '',
      },
    ],
  };

  let client: YaleApiClient;

  beforeEach(async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(AUTH_RESPONSE))
      .mockResolvedValueOnce(makeResponse(DEVICES_RESPONSE));
    client = new YaleApiClient('u', 'p');
  });

  it('parses open contact sensor correctly', async () => {
    const sensors = await client.getSensors();
    const frontDoor = sensors.find(s => s.identifier === 'door-001');
    expect(frontDoor).toBeDefined();
    expect(frontDoor!.state).toBe(ContactSensorState.Open);
  });

  it('parses closed contact sensor correctly', async () => {
    const sensors = await client.getSensors();
    const backDoor = sensors.find(s => s.identifier === 'door-002');
    expect(backDoor).toBeDefined();
    expect(backDoor!.state).toBe(ContactSensorState.Closed);
  });

  it('parses triggered motion sensor correctly', async () => {
    const sensors = await client.getSensors();
    const hallway = sensors.find(s => s.identifier === 'pir-001');
    expect(hallway).toBeDefined();
    expect(hallway!.state).toBe(MotionSensorState.Triggered);
  });

  it('parses untriggered motion sensor correctly', async () => {
    const sensors = await client.getSensors();
    const lounge = sensors.find(s => s.identifier === 'pir-002');
    expect(lounge).toBeDefined();
    expect(lounge!.state).toBe(MotionSensorState.None);
  });

  it('ignores unknown device types', async () => {
    const sensors = await client.getSensors();
    const unknown = sensors.find(s => s.identifier === 'unknown-001');
    expect(unknown).toBeUndefined();
    expect(sensors).toHaveLength(4);
  });
});
