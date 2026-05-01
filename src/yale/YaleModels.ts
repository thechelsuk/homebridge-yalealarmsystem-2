// Data models and enums for Yale Sync Alarm API

export enum PanelState {
  Armed = 'arm',
  Disarmed = 'disarm',
  Home = 'home',
}

export interface AccessToken {
  token: string;
  expiration: Date;
}

export interface Panel {
  identifier: string;
  name: string;
  state: PanelState;
}

export enum ContactSensorState {
  Closed = 'closed',
  Open = 'open',
}

export interface ContactSensor {
  identifier: string;
  name: string;
  state: ContactSensorState;
}

export enum MotionSensorState {
  None = 'none',
  Triggered = 'triggered',
}

export interface MotionSensor {
  identifier: string;
  name: string;
  state: MotionSensorState;
}

export type Sensor = ContactSensor | MotionSensor;
