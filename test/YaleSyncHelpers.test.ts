import { modeToCurrentState, targetStateToMode, targetStateToString, currentStateToString } from '../src/YaleSyncHelpers';
import { PanelState } from '../src/yale/YaleModels';

// Minimal mock of Homebridge Characteristic constants
const Characteristic = {
  SecuritySystemCurrentState: {
    STAY_ARM: 0,
    AWAY_ARM: 1,
    NIGHT_ARM: 2,
    DISARMED: 3,
    ALARM_TRIGGERED: 4,
  },
  SecuritySystemTargetState: {
    STAY_ARM: 0,
    AWAY_ARM: 1,
    NIGHT_ARM: 2,
    DISARM: 3,
  },
};

describe('modeToCurrentState', () => {
  it('maps Armed to AWAY_ARM', () => {
    expect(modeToCurrentState(Characteristic, PanelState.Armed)).toBe(Characteristic.SecuritySystemCurrentState.AWAY_ARM);
  });

  it('maps Disarmed to DISARMED', () => {
    expect(modeToCurrentState(Characteristic, PanelState.Disarmed)).toBe(Characteristic.SecuritySystemCurrentState.DISARMED);
  });

  it('maps Home to NIGHT_ARM', () => {
    expect(modeToCurrentState(Characteristic, PanelState.Home)).toBe(Characteristic.SecuritySystemCurrentState.NIGHT_ARM);
  });

  it('returns DISARMED for unknown state', () => {
    expect(modeToCurrentState(Characteristic, 'unknown' as PanelState)).toBe(Characteristic.SecuritySystemCurrentState.DISARMED);
  });
});

describe('targetStateToMode', () => {
  it('maps STAY_ARM to Home', () => {
    expect(targetStateToMode(Characteristic, Characteristic.SecuritySystemTargetState.STAY_ARM)).toBe(PanelState.Home);
  });

  it('maps AWAY_ARM to Armed', () => {
    expect(targetStateToMode(Characteristic, Characteristic.SecuritySystemTargetState.AWAY_ARM)).toBe(PanelState.Armed);
  });

  it('maps DISARM to Disarmed', () => {
    expect(targetStateToMode(Characteristic, Characteristic.SecuritySystemTargetState.DISARM)).toBe(PanelState.Disarmed);
  });
});

describe('targetStateToString', () => {
  it('returns "home" for STAY_ARM', () => {
    expect(targetStateToString(Characteristic, Characteristic.SecuritySystemTargetState.STAY_ARM)).toBe('home');
  });

  it('returns "away" for AWAY_ARM', () => {
    expect(targetStateToString(Characteristic, Characteristic.SecuritySystemTargetState.AWAY_ARM)).toBe('away');
  });

  it('returns "off" for DISARM', () => {
    expect(targetStateToString(Characteristic, Characteristic.SecuritySystemTargetState.DISARM)).toBe('off');
  });
});

describe('currentStateToString', () => {
  it('returns "home" for STAY_ARM', () => {
    expect(currentStateToString(Characteristic, Characteristic.SecuritySystemCurrentState.STAY_ARM)).toBe('home');
  });

  it('returns "away" for AWAY_ARM', () => {
    expect(currentStateToString(Characteristic, Characteristic.SecuritySystemCurrentState.AWAY_ARM)).toBe('away');
  });

  it('returns "night" for NIGHT_ARM', () => {
    expect(currentStateToString(Characteristic, Characteristic.SecuritySystemCurrentState.NIGHT_ARM)).toBe('night');
  });

  it('returns "off" for DISARMED', () => {
    expect(currentStateToString(Characteristic, Characteristic.SecuritySystemCurrentState.DISARMED)).toBe('off');
  });

  it('returns "unknown" for unrecognised state', () => {
    expect(currentStateToString(Characteristic, 99)).toBe('unknown');
  });
});
